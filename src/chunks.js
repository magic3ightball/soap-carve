// 덩어리 자르기: 평면으로 비누를 잘라 작은 쪽을 떼어 낸다. 떼어 낸 덩어리는 자기 거리장을 가진 강체로
// 작업대에 떨어지고(그리기는 render.js의 레이마칭), 멈추면 작아지며 사라진다.
import { v3, rng } from './math.js';
import { stepRigid, settle } from './physics.js';
import { f16 } from './sdf.js';

export class Chunks {
  constructor(sdf, device) {
    this.sdf = sdf; this.device = device;
    this.list = [];
    this.rand = rng(11);
    this.events = [];               // 소리용: { type: 'hit', pos, v }
  }

  // 평면 s(p) = dot(p - e, n) 기준 양쪽 비누 부피(cm³, 2칸 건너 표본)
  sideVolumes(n, e) {
    const sdf = this.sdf, [nx, ny, nz] = sdf.dims, h = sdf.h, st = 2;
    let pos = 0, neg = 0;
    for (let k = 0; k < nz; k += st) for (let j = 0; j < ny; j += st) {
      let idx = nx * (j + ny * k);
      const py = sdf.min[1] + (j + 0.5) * h, pz = sdf.min[2] + (k + 0.5) * h;
      const base = (py - e[1]) * n[1] + (pz - e[2]) * n[2];
      for (let i = 0; i < nx; i += st, idx += st) {
        if (sdf.d[idx] >= 0) continue;
        const s = base + (sdf.min[0] + (i + 0.5) * h - e[0]) * n[0];
        if (s > 0) pos++; else neg++;
      }
    }
    const v = h * h * h * st * st * st;
    return [pos * v, neg * v];
  }

  // 작은 쪽을 떼어 낸다. 돌려주는 값: 떼어 낸 부피(cm³), 아무것도 안 잘렸으면 0
  slice(n, e, stroke) {
    const [vp, vn] = this.sideVolumes(n, e);
    if (Math.min(vp, vn) < 0.02) return 0;
    if (vn < vp) n = v3.mul(n, -1);                          // 떼어 낼 쪽이 s > 0 이 되게
    const sdf = this.sdf, [nx, ny, nz] = sdf.dims, h = sdf.h, d = sdf.d;
    const old = d.slice();
    let lo = [nx, ny, nz], hi = [0, 0, 0], removed = 0;
    const dl = [nx, ny, nz], dh = [0, 0, 0];               // 바뀐 복셀 범위 (이만큼만 GPU로 올린다)
    const frac = x => Math.min(1, Math.max(0, 0.5 - x / h));
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      let idx = nx * (j + ny * k);
      const py = sdf.min[1] + (j + 0.5) * h, pz = sdf.min[2] + (k + 0.5) * h;
      const base = (py - e[1]) * n[1] + (pz - e[2]) * n[2];
      for (let i = 0; i < nx; i++, idx++) {
        const s = base + (sdf.min[0] + (i + 0.5) * h - e[0]) * n[0];
        // 남는 쪽 깊은 안쪽(-0.3 cm보다 안)은 안 건드린다: 거리가 과대평가돼도 바깥에서 행진·깎기엔 영향 없음
        if (s <= d[idx] || s < -0.3) continue;
        if (i < dl[0]) dl[0] = i; if (j < dl[1]) dl[1] = j; if (k < dl[2]) dl[2] = k;
        if (i > dh[0]) dh[0] = i; if (j > dh[1]) dh[1] = j; if (k > dh[2]) dh[2] = k;
        if (d[idx] < 0 && s > 0) {                            // 떼어 낼 덩어리 범위
          if (i < lo[0]) lo[0] = i; if (j < lo[1]) lo[1] = j; if (k < lo[2]) lo[2] = k;
          if (i > hi[0]) hi[0] = i; if (j > hi[1]) hi[1] = j; if (k > hi[2]) hi[2] = k;
        }
        removed += frac(d[idx]) - frac(s);
        if (d[idx] < h * 2) { sdf.mark[idx] = 150; sdf.frost(idx, s - d[idx]); }   // 한 번에 자른 넓은 단면: 결 없이 매끈
        d[idx] = s;
      }
    }
    if (dh[0] >= dl[0]) sdf.markDirty(dl[0], dl[1], dl[2], dh[0] + 1, dh[1] + 1, dh[2] + 1);
    if (hi[0] < lo[0]) return 0;
    this.spawn((idx, p) => Math.max(old[idx], -v3.dot(v3.sub(p, e), n)), lo, hi, stroke, v3.add(v3.mul(n, 9 + 4 * this.rand()), [0, 3, 0]));
    return removed * h * h * h;
  }

  // 본체에서 끊어진 조각을 떨어뜨린다. 가장 큰 덩어리(본체)만 남긴다 (작업대가 없어 '바닥에 닿은 것'이란 기준이 없다).
  // 연결 검사는 1 mm 칸(2×2×2 복셀 중 하나라도 비누면 '찬 칸')에서 6방향으로 한다 — 0.5 mm 그대로면 획마다 340 ms 걸렸다.
  // (1 mm보다 가는 다리로 붙은 조각은 붙어 있는 걸로 본다.) 돌려주는 값: 떨어뜨린 부피(cm³)
  dropIslands(stroke) {
    const sdf = this.sdf, [nx, ny, nz] = sdf.dims, d = sdf.d, h = sdf.h;
    const mx = nx >> 1, my = ny >> 1, mz = nz >> 1, M = mx * my * mz;
    const solid = this.solid || (this.solid = new Uint8Array(M));
    const label = this.label || (this.label = new Int32Array(M));
    const stack = this.stack || (this.stack = new Int32Array(M));
    solid.fill(0); label.fill(0);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      let v = nx * (j + ny * k);
      const row = mx * ((j >> 1) + my * (k >> 1));
      for (let i = 0; i < nx; i++, v++) if (d[v] < 0) solid[row + (i >> 1)] = 1;
    }
    let id = 0;
    const islands = [];
    for (let s0 = 0; s0 < M; s0++) {
      if (!solid[s0] || label[s0]) continue;
      id++;
      let sp = 0, cnt = 0;
      const lo = [mx, my, mz], hi = [0, 0, 0];
      stack[sp++] = s0; label[s0] = id;
      while (sp) {
        const v = stack[--sp]; cnt++;
        const i = v % mx, j = ((v / mx) | 0) % my, k = (v / (mx * my)) | 0;
        if (i < lo[0]) lo[0] = i; if (j < lo[1]) lo[1] = j; if (k < lo[2]) lo[2] = k;
        if (i > hi[0]) hi[0] = i; if (j > hi[1]) hi[1] = j; if (k > hi[2]) hi[2] = k;
        const nb = [i > 0 ? v - 1 : -1, i < mx - 1 ? v + 1 : -1, j > 0 ? v - mx : -1, j < my - 1 ? v + mx : -1,
          k > 0 ? v - mx * my : -1, k < mz - 1 ? v + mx * my : -1];
        for (const u of nb) if (u >= 0 && solid[u] && !label[u]) { label[u] = id; stack[sp++] = u; }
      }
      islands.push({ id, cnt, lo, hi });
    }
    let main = 0;
    for (let q = 1; q < islands.length; q++) if (islands[q].cnt > islands[main].cnt) main = q;
    islands.splice(main, 1);
    let dropped = 0;
    for (const isl of islands) {
      const tiny = isl.cnt < 2;                               // 아주 작은 부스러기는 그냥 지운다
      const keep = tiny ? null : d.slice();
      const lo = isl.lo.map(x => x * 2), hi = isl.hi.map(x => x * 2 + 1);
      const inIsl = v => { const i = v % nx, j = ((v / nx) | 0) % ny, k = (v / (nx * ny)) | 0;
        return label[(i >> 1) + mx * ((j >> 1) + my * (k >> 1))] === isl.id; };
      // 조각 자리를 비운다: 안쪽 값을 뒤집으면(|d|) 남은 본체까지의 거리를 과소평가 → 레이마칭엔 안전
      let cnt = 0;
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) {
        let v = lo[0] + nx * (j + ny * k);
        for (let i = lo[0]; i <= hi[0]; i++, v++) if (d[v] < 0 && inIsl(v)) { d[v] = Math.max(-d[v], h * 0.5); cnt++; }
      }
      sdf.markDirty(lo[0], lo[1], lo[2], hi[0] + 1, hi[1] + 1, hi[2] + 1);
      dropped += cnt * h * h * h;
      if (!tiny) this.spawn((idx) => (keep[idx] < 0 && inIsl(idx)) ? keep[idx] : h, lo, hi, stroke, [0, 0, 0]);
    }
    this.dropSlivers();                                       // 보이지도 않을 만큼 작아 소리(쿵)는 내지 않는다
    return dropped;
  }

  // 1 mm 칸 검사는 본체에서 1 mm 안에 떠 있는 0.5 mm 부스러기를 본체에 붙은 걸로 본다 → 허공에 점처럼 남았다.
  // 이번 획이 바꾼 범위(sdf.touched)만 0.5 mm로 다시 연결 검사해, 범위 안에 갇힌 작은 묶음(SLIVER_MAX 복셀 이하)을 지운다.
  // 범위의 안쪽 면에 닿는 묶음은 밖으로 이어질 수 있으니 그대로 둔다.
  dropSlivers() {
    const sdf = this.sdf, t = sdf.touched, d = sdf.d, h = sdf.h, [nx, ny, nz] = sdf.dims;
    sdf.touched = null;
    if (!t) return 0;
    const SLIVER_MAX = 64;
    const i0 = Math.max(0, t[0] - 2), j0 = Math.max(0, t[1] - 2), k0 = Math.max(0, t[2] - 2);
    const i1 = Math.min(nx, t[3] + 2), j1 = Math.min(ny, t[4] + 2), k1 = Math.min(nz, t[5] + 2);
    const bx = i1 - i0, by = j1 - j0, bz = k1 - k0, B = bx * by * bz;
    if (B <= 0) return 0;
    const seen = new Uint8Array(B), stack = new Int32Array(B), group = [];
    const gid = (a, b, c) => (i0 + a) + nx * ((j0 + b) + ny * (k0 + c));
    let removed = 0, li = [1e9, 1e9, 1e9], hi = [-1, -1, -1];
    for (let s0 = 0; s0 < B; s0++) {
      if (seen[s0]) continue;
      const a0 = s0 % bx, b0 = ((s0 / bx) | 0) % by, c0 = (s0 / (bx * by)) | 0;
      if (d[gid(a0, b0, c0)] >= 0) continue;
      let sp = 0, open = false, big = false;
      group.length = 0;
      stack[sp++] = s0; seen[s0] = 1;
      while (sp) {
        const v = stack[--sp];
        const a = v % bx, b = ((v / bx) | 0) % by, c = (v / (bx * by)) | 0;
        if (!big) { group.push(v); if (group.length > SLIVER_MAX) big = true; }
        // 범위 면에 닿았는데 그 면이 격자 끝이 아니면 밖으로 이어질 수 있다
        if ((a === 0 && i0 > 0) || (a === bx - 1 && i1 < nx) || (b === 0 && j0 > 0) || (b === by - 1 && j1 < ny) ||
            (c === 0 && k0 > 0) || (c === bz - 1 && k1 < nz)) open = true;
        const nb = [a > 0 ? v - 1 : -1, a < bx - 1 ? v + 1 : -1, b > 0 ? v - bx : -1, b < by - 1 ? v + bx : -1,
          c > 0 ? v - bx * by : -1, c < bz - 1 ? v + bx * by : -1];
        for (const u of nb) {
          if (u < 0 || seen[u]) continue;
          const ua = u % bx, ub = ((u / bx) | 0) % by, uc = (u / (bx * by)) | 0;
          if (d[gid(ua, ub, uc)] < 0) { seen[u] = 1; stack[sp++] = u; }
        }
      }
      if (open || big) continue;
      for (const v of group) {
        const a = v % bx, b = ((v / bx) | 0) % by, c = (v / (bx * by)) | 0, g = gid(a, b, c);
        d[g] = Math.max(-d[g], h * 0.5); removed++;
        const p = [i0 + a, j0 + b, k0 + c];
        for (let q = 0; q < 3; q++) { li[q] = Math.min(li[q], p[q]); hi[q] = Math.max(hi[q], p[q]); }
      }
    }
    // 유령 표면: 얇은 판을 칼이 관통하면 max(old,-tool)이 허공에 '칼 면까지 거리'(0~0.1 mm대 양수)를 남긴다.
    // 렌더러는 스치는 광선용으로 0.012 cm 안이면 맞은 걸로 쳐서 이게 점으로 보였다 → 근처(±2칸)에 비누가 없으면 반 칸 거리로 올린다.
    let ghosts = 0;
    for (let c = 0; c < bz; c++) for (let b = 0; b < by; b++) for (let a = 0; a < bx; a++) {
      const g = gid(a, b, c), dv = d[g];
      if (dv < 0 || dv >= h * 0.5) continue;
      let solid = false;
      const I = i0 + a, J = j0 + b, K = k0 + c;
      for (let z = Math.max(0, K - 2); z <= Math.min(nz - 1, K + 2) && !solid; z++)
        for (let y = Math.max(0, J - 2); y <= Math.min(ny - 1, J + 2) && !solid; y++)
          for (let x = Math.max(0, I - 2); x <= Math.min(nx - 1, I + 2); x++) if (d[x + nx * (y + ny * z)] < 0) { solid = true; break; }
      if (solid) continue;
      d[g] = h * 0.5; ghosts++;
      li[0] = Math.min(li[0], I); li[1] = Math.min(li[1], J); li[2] = Math.min(li[2], K);
      hi[0] = Math.max(hi[0], I); hi[1] = Math.max(hi[1], J); hi[2] = Math.max(hi[2], K);
    }
    if (removed || ghosts) { sdf.markDirty(li[0], li[1], li[2], hi[0] + 1, hi[1] + 1, hi[2] + 1); sdf.touched = null; }
    return removed * h * h * h;
  }

  // 떼어 낸 덩어리: 자기 거리장(0.5 mm, 원래 좌표)을 3D 텍스처로 올려 본체처럼 레이마칭으로 그리고, 강체로 떨어뜨린다.
  // (예전엔 1 mm 격자 표면 메시(surface nets)로 그려서, 비스듬한 모서리가 0.4 mm 톱니로 깨져 보였다)
  // fieldAt(복셀 번호, 위치) = 덩어리의 거리값(안 < 0)
  spawn(fieldAt, lo, hi, stroke, vel) {
    const sdf = this.sdf, [nx, ny] = sdf.dims, h = sdf.h;
    const i0 = Math.max(0, lo[0] - 2), j0 = Math.max(0, lo[1] - 2), k0 = Math.max(0, lo[2] - 2);
    const i1 = Math.min(sdf.dims[0] - 1, hi[0] + 2), j1 = Math.min(sdf.dims[1] - 1, hi[1] + 2), k1 = Math.min(sdf.dims[2] - 1, hi[2] + 2);
    const gx = i1 - i0 + 1, gy = j1 - j0 + 1, gz = k1 - k0 + 1;
    const org = sdf.pos(i0, j0, k0);
    const f = new Float32Array(gx * gy * gz);
    let com = [0, 0, 0], cnt = 0;
    const surf = [];
    for (let c = 0; c < gz; c++) for (let b = 0; b < gy; b++) for (let a = 0; a < gx; a++) {
      const p = [org[0] + a * h, org[1] + b * h, org[2] + c * h];
      // 가장자리 한 겹은 바깥으로 둬서 거리장이 닫히게
      const edge = a === 0 || b === 0 || c === 0 || a === gx - 1 || b === gy - 1 || c === gz - 1;
      const v = edge ? h : fieldAt((i0 + a) + nx * ((j0 + b) + ny * (k0 + c)), p);
      f[a + gx * (b + gy * c)] = v;
      if (v < 0) { com = v3.add(com, p); cnt++; if (v > -h) surf.push(p); }
    }
    if (cnt < 8) return;
    com = v3.mul(com, 1 / cnt);
    // 부딪힘 점: 표면 바로 안쪽 복셀에서 고르게 최대 200개
    const cstep = Math.max(1, Math.floor(surf.length / 200)), contacts = [];
    let k2 = 0;
    for (let q = 0; q < surf.length; q += cstep) { const r = v3.sub(surf[q], com); contacts.push({ r, half: 0.02 }); k2 += v3.dot(r, r); }
    if (!contacts.length) return;
    const dev = this.device;
    const tex = dev.createTexture({ size: [gx, gy, gz], dimension: '3d', format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const half = new Uint16Array(f.length);
    for (let q = 0; q < f.length; q++) half[q] = f16(f[q]);
    dev.queue.writeTexture({ texture: tex }, half, { bytesPerRow: gx * 2, rowsPerImage: gy }, [gx, gy, gz]);
    const ubuf = dev.createBuffer({ size: 64 * 2 + 16 * 3, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const r = this.rand;
    const body = { stroke, tex, ubuf, com, contacts,
      tmin: [org[0] - h / 2, org[1] - h / 2, org[2] - h / 2], tsize: [gx * h, gy * h, gz * h],
      k2: k2 / contacts.length * 0.6 + 1e-3, pos: com.slice(), q: [0, 0, 0, 1],
      v: vel, w: [(r() - 0.5) * 3, (r() - 0.5) * 3, (r() - 0.5) * 3],
      calm: 0, asleep: false, fade: 0, scale: 1, impact: 0, hitT: 0 };
    this.list.push(body);
  }

  step(dt) {
    const sub = 3, hh = dt / sub;
    for (const b of [...this.list]) {
      if (!b.asleep) {
        b.impact = 0;
        for (let s = 0; s < sub; s++) stepRigid(b, this.sdf, hh);
        b.hitT += dt;
        if (b.impact > 20 && b.hitT > 0.12) { this.events.push({ type: 'hit', pos: b.pos, v: b.impact }); b.hitT = 0; }
        settle(b, dt);
      }
      // 떨어진 지 잠깐 뒤(또는 비누 위에 멈춘 뒤) 작아지며 사라진다. 비누 아래로 멀리 떨어진 것은 바로 지운다.
      b.fade += dt;
      if (b.fade > 0.9) b.scale = Math.max(0, 1 - (b.fade - 0.9) / 0.6);
      if (b.scale <= 0 || b.pos[1] < -12) { this.remove(b); continue; }
    }
  }

  remove(b) { this.list.splice(this.list.indexOf(b), 1); b.tex.destroy(); b.ubuf.destroy(); }
  removeStroke(id) { for (const b of this.list.filter(b => b.stroke === id)) this.remove(b); }
  clear() { for (const b of [...this.list]) this.remove(b); }
}
