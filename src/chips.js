// 깎인 부스러기(칩). 깎아 낸 부피를 칼날 뿌리에서 얇은 리본으로 내보내고, 칼에 붙어 있는 동안은
// 칼날 면을 따라 올라가다 감기는 나선(운동학적 모양), 떨어지면 강체로 천천히 돌며 떨어지다 작아지며 사라진다 (작업대 없음).
import { v3, quat, rng } from './math.js';
import { stepRigid, settle } from './physics.js';

export const MAXN = 128;           // 칩 하나의 최대 마디 수
export const DS = 0.05;            // 마디 간격 cm (최대 길이 6.4 cm)
export const VPN = 8;              // 마디당 정점 수
export const SLOTS = 160;          // 동시에 보이는 칩 수
export const MIN_AREA = 0.0004;    // 깎인 단면적(cm²)이 이보다 작으면 허공·스치기: 칩도 소리도 없다
const FADE_AT = 0.8, FADE_LEN = 0.7;  // 떨어진 뒤 이 시간(s)부터 작아지기 시작해 이만큼 걸려 사라진다
const AIR_DRAG = 3.0;              // 얇은 리본의 공기 저항 (1/s): 가볍게 팔랑이며 떨어지게

export class Chips {
  constructor(sdf) {
    this.sdf = sdf;
    this.list = [];
    this.active = null;
    this.rand = rng(7);
    this.freeSlots = [];
    for (let i = SLOTS - 1; i >= 0; i--) this.freeSlots.push(i);
    this.dirtySlots = new Set();
    this.vdata = new Float32Array(MAXN * VPN * 11);
    this.uploads = [];              // [slot, Float32Array]
    this.stats = { emitted: 0, released: 0, maxNodes: 0 };
    this.events = [];               // 소리용: { type: 'off' | 'hit', pos, v }
  }

  takeSlot() {
    if (!this.freeSlots.length) {
      // 가장 오래된 잠든 칩을 치운다
      const victim = this.list.find(c => !c.attached && c.asleep) || this.list.find(c => !c.attached);
      if (victim) this.remove(victim);
    }
    return this.freeSlots.pop();
  }
  remove(c) {
    this.list.splice(this.list.indexOf(c), 1);
    if (c.slot !== undefined) this.freeSlots.push(c.slot);
    if (this.active === c) this.active = null;
  }
  clear() { for (const c of [...this.list]) this.remove(c); }
  removeStroke(id) { for (const c of this.list.filter(c => c.stroke === id)) this.remove(c); }

  // 칼이 한 구간을 깎을 때마다 호출. len: 이동 거리, vol: 깎인 부피, width: 날 폭
  feed(knife, len, vol, width, strokeId) {
    const area = vol / Math.max(len, 1e-6);
    if (area < MIN_AREA) {                                // 허공·스치기
      if (this.active) { this.active.air += len; if (this.active.air > 0.25) this.release(knife); }
      return;
    }
    let c = this.active;
    if (!c) {
      const slot = this.takeSlot();
      if (slot === undefined) return;
      // 한 번 밀 때 큰 리본 1~3개: 2.2~3.8 cm 감기면 끊어 떨어뜨린다 (예전엔 6.4 cm까지 길게 붙어 얼음 조각처럼 컸다)
      c = { slot, stroke: strokeId, attached: true, nodes: [], acc: 0, air: 0, maxN: Math.round((2.2 + 1.6 * this.rand()) / DS),
        rScale: 0.85 + 0.35 * this.rand(), helix: (this.rand() < 0.5 ? -1 : 1) * (0.08 + 0.18 * this.rand()),
        phase: this.rand() * 6.28, asleep: false };
      this.list.push(c); this.active = c; this.stats.emitted++;
    }
    c.air = 0;
    // 보기 좋은 쪽으로 과장: 칩은 홈보다 살짝 넓고 얇게 편다 (부피는 정확히 보존하지 않음)
    // 리본은 날 폭보다 좁고 얇게 (예전 날 폭 그대로·두께 ×0.6은 두꺼운 흰 덩어리로 보였다)
    const w = Math.min(width * 0.7, Math.max(0.1, area / 0.004));      // 얕게 스치면 폭도 좁다
    const k = c.nodes.length;
    const wob = 1 + 0.12 * Math.sin(k * 0.55 + c.phase) + 0.06 * Math.sin(k * 1.7 + c.phase * 2);
    const t = Math.min(0.12, Math.max(0.005, area / w * 0.35)) * (0.9 + 0.2 * this.rand());
    c.acc += len * 0.9;                                                   // 칩은 깎은 길이보다 조금 짧다
    while (c.acc >= DS) {
      c.acc -= DS;
      // o: 이 마디가 깎여 나온 자리 (비누 재질을 그 위치 그대로 칠하려고)
      c.nodes.push({ t, w: w * wob, o: v3.madd(knife.E, knife.n, knife.depth * 0.5) });
      if (c.nodes.length >= Math.min(MAXN, c.maxN)) { this.release(knife); break; }
    }
    this.stats.maxNodes = Math.max(this.stats.maxNodes, c.nodes.length);
  }

  // 칼에 붙은 칩의 모양 (월드 좌표 마디 + 틀)
  shape(c, k) {
    const n = c.nodes.length, tilt = k.tilt;
    const tf = 1.35 - tilt / (Math.PI / 4) * 0.55;                       // 칼을 세울수록 촘촘히 말림
    const root = c.nodes[n - 1] || { t: 0.05, w: 0.3 };
    let R = (0.18 + 2.5 * root.t) * tf * c.rScale;
    // 처음엔 날 면을 타고 올라가다가 말린다: 말린 고리가 앞쪽 표면을 뚫지 않을 만큼 띄운다
    const s0 = Math.max(0.1, (k.depth + R * (1 - Math.cos(tilt)) + 0.03) / Math.sin(tilt));
    let x = 0, y = root.t * 0.5, phi = 0, lat = 0;
    const pts = new Array(n), T = new Array(n), N = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      const s = (n - 1 - i) * DS;
      const nd = c.nodes[i];
      if (s > s0) {
        const Rmin = 1.6 * nd.t + 0.03;
        const Rt = Math.max(Rmin, (0.18 + 2.5 * nd.t) * tf * c.rScale * (1 + 0.08 * Math.sin(s * 3 + c.phase)));
        R = Math.max(Rmin, Math.min(R - DS * 1.15 * nd.t / (2 * Math.PI * R), Rt));
        phi += DS / R;
        lat += c.helix * DS;
      }
      const cp = Math.cos(phi), sp = Math.sin(phi);
      x += cp * DS; y += sp * DS;
      pts[i] = v3.add(v3.add(v3.add(k.E, v3.mul(k.f, x)), v3.mul(k.m, y)), v3.mul(k.l, lat));
      T[i] = v3.add(v3.mul(k.f, -cp), v3.mul(k.m, -sp));                // 오래된 쪽(i 감소) 방향
      N[i] = v3.add(v3.mul(k.m, cp), v3.mul(k.f, -sp));
    }
    return { pts, T, N, L: k.l };
  }

  release(k) {
    const c = this.active;
    if (!c) return;
    this.active = null;
    if (c.nodes.length < 3) { this.remove(c); return; }
    const sh = this.shape(c, k);
    let com = [0, 0, 0], mass = 0;
    sh.pts.forEach((p, i) => { const m = c.nodes[i].t * c.nodes[i].w; com = v3.madd(com, p, m); mass += m; });
    com = v3.mul(com, 1 / mass);
    c.local = sh.pts.map(p => v3.sub(p, com));
    c.lT = sh.T; c.lN = sh.N; c.lL = sh.pts.map(() => sh.L);
    c.k2 = c.local.reduce((a, r) => a + v3.dot(r, r), 0) / c.local.length + 1e-4;
    c.pos = com; c.q = [0, 0, 0, 1];
    const sp = k.speed || 0;
    c.v = v3.add(v3.mul(k.u, sp * 0.15), v3.mul(k.n, 4 + 3 * this.rand()));
    // 천천히 돈다 (초당 반 바퀴 안팎): 가볍고 얇은 느낌
    c.w = v3.add(v3.mul(k.l, -(1.2 + 1.3 * this.rand())), [(this.rand() - 0.5) * 1.2, (this.rand() - 0.5) * 1.2, (this.rand() - 0.5) * 1.2]);
    const stride = Math.max(1, Math.floor(c.local.length / 24));
    c.contacts = c.local.filter((_, i) => i % stride === 0).map((r, j) => ({ r, half: c.nodes[j * stride].t * 0.5 + 0.005 }));
    c.attached = false; c.calm = 0; c.impact = 0; c.hitT = 0; c.age = 0; c.scale = 1;
    this.events.push({ type: 'off', pos: com });
    this.stats.released++;
  }

  // 칼 끝에서 부서진 잔 부스러기 몇 개 (짧고 아주 작은 조각): c 위치, n 표면 법선, u 진행 방향
  crumbs(p, n, u, count) {
    const l = v3.norm(v3.cross(n, u));
    for (let q = 0; q < count; q++) {
      const slot = this.takeSlot();
      if (slot === undefined) return;
      const m = 3 + Math.floor(this.rand() * 2), t = 0.01 + 0.012 * this.rand(), w = 0.05 + 0.05 * this.rand();
      const bend = (this.rand() - 0.5) * 1.6;
      const local = [], T = [], N = [], nodes = [];
      for (let i = 0; i < m; i++) {
        const a = (i - (m - 1) / 2) * 0.04;                       // 0.4 mm 간격, 살짝 휜 짧은 조각
        local.push(v3.add(v3.mul(u, a), v3.mul(n, bend * a * a * 8)));
        T.push(u); N.push(n);
        nodes.push({ t, w, o: p });
      }
      const pos = v3.add(p, v3.add(v3.mul(l, (this.rand() - 0.5) * 0.4), v3.mul(n, 0.03)));
      const c = { slot, stroke: -1, attached: false, nodes, local, lT: T, lN: N, lL: local.map(() => l),
        k2: 0.002, pos, q: [0, 0, 0, 1], v: v3.add(v3.mul(n, 5 + 4 * this.rand()), v3.mul(u, 3 + 3 * this.rand())),
        w: [(this.rand() - 0.5) * 4, (this.rand() - 0.5) * 4, (this.rand() - 0.5) * 4],
        contacts: [{ r: [0, 0, 0], half: t * 0.5 + 0.005 }], calm: 0, impact: 0, hitT: 0, age: 0, scale: 1, asleep: false };
      this.list.push(c);
      this.writeSlot(c);
    }
  }

  step(dt, knife) {
    // 떨어진 칩: 강체 + 공기 저항. 떨어진 지 잠깐 뒤(비누 위에 멈췄어도) 작아지며 사라진다
    const sub = 3, h = dt / sub, drag = Math.exp(-AIR_DRAG * dt);
    for (const c of [...this.list]) {
      if (c.attached) continue;
      c.age += dt;
      if (c.age > FADE_AT) c.scale = Math.max(0, 1 - (c.age - FADE_AT) / FADE_LEN);
      if (c.scale <= 0 || c.pos[1] < -12) { this.remove(c); continue; }
      if (!c.asleep) {
        c.impact = 0;
        for (let s = 0; s < sub; s++) stepRigid(c, this.sdf, h);
        c.v = v3.mul(c.v, drag);
        c.hitT += dt;
        if (c.impact > 25 && c.hitT > 0.08) { this.events.push({ type: 'hit', pos: c.pos, v: c.impact }); c.hitT = 0; }
        settle(c, dt);
      }
      this.writeSlot(c);
    }
    if (this.active) this.writeSlot(this.active, knife);
  }

  // 정점 채우기: 마디마다 단면 사각형(윗면·아랫면·양 옆면 각 2정점), 정점 = pos3 normal3 thick1 shade1 origin3
  writeSlot(c, knife) {
    const n = c.nodes.length;
    if (n < 2) return;
    let P, T, N, L;
    if (c.attached) { const sh = this.shape(c, knife); P = sh.pts; T = sh.T; N = sh.N; L = n => sh.L; }
    else {
      P = c.local.map(r => v3.add(c.pos, quat.rot(c.q, v3.mul(r, c.scale))));
      N = c.lN.map(x => quat.rot(c.q, x)); L = i => quat.rot(c.q, c.lL[i]);
    }
    const d = this.vdata;
    let o = 0;
    for (let i = 0; i < n; i++) {
      const nd = c.nodes[i];
      const taper = Math.min(1, (i + 1) / 4, (n - i) / 3);
      const sc = c.attached ? 1 : c.scale;
      const hw = nd.w * 0.5 * (0.55 + 0.45 * taper) * sc, ht = nd.t * 0.5 * (0.6 + 0.4 * taper) * sc;
      const Li = L(i), Ni = N[i], p = P[i];
      const shade = 0.92 + 0.08 * Math.sin(i * 0.9 + c.slot);
      const put = (q, nn) => { d[o++] = q[0]; d[o++] = q[1]; d[o++] = q[2]; d[o++] = nn[0]; d[o++] = nn[1]; d[o++] = nn[2]; d[o++] = nd.t; d[o++] = shade;
        d[o++] = nd.o[0]; d[o++] = nd.o[1]; d[o++] = nd.o[2]; };
      const a = v3.madd(p, Li, hw), b = v3.madd(p, Li, -hw);
      const top = v3.mul(Ni, ht), nNi = v3.mul(Ni, -1), nLi = v3.mul(Li, -1);
      // 가장자리는 얇게(깃털처럼): 옆면 높이를 줄인다
      const at = v3.madd(a, Ni, ht * 0.35), ab = v3.madd(a, Ni, -ht * 0.35), bt = v3.madd(b, Ni, ht * 0.35), bb = v3.madd(b, Ni, -ht * 0.35);
      const ct = v3.add(p, top), cb = v3.sub(p, top);
      // 윗면: 가장자리→가운데가 볼록하도록 법선을 약간 기울인다
      put(v3.lerp(at, ct, 0.0), v3.norm(v3.madd(Ni, Li, 0.35))); put(v3.lerp(bt, ct, 0.0), v3.norm(v3.madd(Ni, Li, -0.35)));
      put(bb, v3.norm(v3.madd(nNi, Li, -0.35))); put(ab, v3.norm(v3.madd(nNi, Li, 0.35)));
      put(ab, Li); put(at, Li);
      put(bt, nLi); put(bb, nLi);
    }
    this.uploads.push([c.slot, d.slice(0, o), n]);
    c.drawN = n;
  }
}
