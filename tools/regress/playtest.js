// 물고기 깎기 자동 플레이 테스트: 사람이 하듯 실제 입력 경로(자르기·칼·U자 끌·물)로 '모양 품은 비누'에서 물고기를 깎는다.
// 사용: 수신기(recv.py)를 켜고 http://127.0.0.1:8933/?playtest=<이름> → out/<이름>/ 에 단계별 캡처 + log.json
// 끝나면 document.title이 'playtest done'으로 바뀐다.
const RECV = 'http://127.0.0.1:8941';

function rng(seed) { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); }
const v = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

export async function run(C, label) {
  const R = rng(20261007);
  Math.random = rng(777);                                   // 부스러짐 등 앱 안의 난수도 고정
  const cv = document.querySelector('canvas');
  const small = () => Object.assign(cv.style, { width: '960px', height: '640px', inset: 'auto', left: '0', top: '0' });
  const big = () => Object.assign(cv.style, { width: '1600px', height: '1000px', inset: 'auto', left: '0', top: '0' });
  small();
  await new Promise(r => setTimeout(r, 300));
  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.message)));
  const post = async (name, body) => { await fetch(`${RECV}/${label}/${name}`, { method: 'POST', body }); };

  const s = C.sdf, h = s.h, [nx, ny, nz] = s.dims;
  C.setLook(7);
  C.setTarget('fish');                                      // 새 비누 + 목표 물고기 (가이드 켜짐)
  const T = C.tgt.arr;
  const log = [];
  let frameMax = 0;
  const frame = () => { const t0 = performance.now(); C.frame(1 / 60); frameMax = Math.max(frameMax, performance.now() - t0); };
  const cam = (yaw, pitch, dist, target) => { Object.assign(C.cam, { yaw, pitch, dist }); C.cam.target = target.slice(); };
  const status = () => ({ progress: +C.tgt.progress.toFixed(3), over: +C.tgt.over.toFixed(4), chips: C.chips.list.length, chunks: C.chunks.list.length, vol: +s.volume().toFixed(2), thick: +(C.tgt.thick ?? 0).toFixed(3), done: C.tgt.done });

  // 진단: 이번 동작에서 칼날이 실제로 지나간 구간 (sdf.carve 호출을 엿본다)
  let segs = [];
  const carve0 = s.carve.bind(s);
  s.carve = (A, B, n, depth, width, profile) => { segs.push({ A: A.slice(), B: B.slice(), n: n.slice(), depth, width }); return carve0(A, B, n, depth, width, profile); };
  const tol = 0.08;
  const overMask = () => { const m = new Uint8Array(s.n); for (let i = 0; i < s.n; i++) if (T[i] < -tol && s.d[i] > 0) m[i] = 1; return m; };
  let prevOver = overMask();
  // 새로 '너무 깎인' 복셀이 칼날 기준 어디에 있나: 날 깊이 안 / 날 위 기둥 / 칼날과 먼 곳(떨어져 나간 조각 등)
  const classify = () => {
    const now = overMask(), out = { blade: 0, column: 0, far: 0, total: 0 };
    for (let idx = 0; idx < s.n; idx++) {
      if (!now[idx] || prevOver[idx]) continue;
      out.total++;
      const k = Math.floor(idx / (nx * ny)), j = Math.floor(idx / nx) % ny, i = idx % nx, p = s.pos(i, j, k);
      let best = 'far', bestD = 9;
      for (const g of segs) {
        const AB = v.sub(g.B, g.A), t = Math.max(0, Math.min(1, v.dot(v.sub(p, g.A), AB) / Math.max(v.dot(AB, AB), 1e-9)));
        const q = v.add(g.A, v.mul(AB, t)), r = v.sub(p, q), c = v.dot(r, g.n);
        const lat = Math.hypot(...v.sub(r, v.mul(g.n, c)));
        if (lat > g.width / 2 + 0.15) continue;
        const dd = Math.abs(c);
        if (dd < bestD) { bestD = dd; best = c < -g.depth - 0.05 ? 'far' : c <= 0.02 ? 'blade' : 'column'; }
      }
      out[best]++;
    }
    prevOver = now;
    return out;
  };

  // 칼날 바닥이 실제로 닿은 곳의 목표 거리: 가운데 / 양 끝 (음수면 날 바닥이 물고기 속) — 깊이 판단 잘못(봇)인지 날 모양 탓인지 가른다
  const bladeCheck = () => {
    let center = 9, edge = 9;
    for (const g of segs) {
      const M = v.mul(v.add(g.A, g.B), 0.5), u = v.norm(v.sub(g.B, g.A)), l = v.norm(v.cross(g.n, u));
      const bot = v.sub(M, v.mul(g.n, g.depth));
      center = Math.min(center, tAt(bot));
      for (const sgn of [-1, 1]) edge = Math.min(edge, tAt(v.add(bot, v.mul(l, sgn * g.width * 0.45))));
    }
    return { tBotCenter: +center.toFixed(3), tBotEdge: +edge.toFixed(3) };
  };

  // 한 동작: 화면 점들을 따라 드래그. 돌려주는 값: 기록 한 줄
  const act = (tool, pts, extra = {}) => {
    frameMax = 0; segs = [];
    const chunks0 = C.chunks.list.length;
    const t0 = performance.now();
    C.input.down(...pts[0]);
    const mode = C.st.mode;                                 // 'cut' | 'sand' | 'slice' | 'orbit'(안 맞음)
    frame();
    for (const p of pts.slice(1)) { C.input.move(...p); frame(); }
    const tu = performance.now();
    C.input.up();
    const upMs = performance.now() - tu;
    frame();
    const row = { i: log.length, tool, mode, ...extra, ms: Math.round(performance.now() - t0), upMs: Math.round(upMs), frameMax: Math.round(frameMax), ...status(),
      dropped: Math.max(0, C.chunks.list.length - chunks0), maxDepthUsed: segs.length ? +Math.max(...segs.map(g => g.depth)).toFixed(3) : 0, newOver: classify(), ...bladeCheck() };
    log.push(row);
    return row;
  };

  // 단계별 캡처: 가만히(쌓은 그림) 개요·옆, 큰 창에서 움직이는 중
  const shots = [];
  const capture = async tag => {
    const keep = { yaw: C.cam.yaw, pitch: C.cam.pitch, dist: C.cam.dist, target: C.cam.target.slice() };
    C.st.cursor = null; C.st.hover = null;
    const still = async (name, y, p, d, t) => { cam(y, p, d, t); for (let i = 0; i < 26; i++) C.frame(1 / 60); await post(`${tag}_${name}`, cv.toDataURL('image/png')); };
    await still('overview', -0.65, 0.55, 12, [0, 1.4, 0]);
    await still('side', 0.0, 0.12, 10, [0, 1.4, 0]);
    await still('top', 0.0, 1.35, 10, [0, 2, 0]);
    big(); await new Promise(r => setTimeout(r, 200));
    cam(-0.65, 0.55, 12, [0, 1.4, 0]);
    C.renderer.forceMoving = true; C.renderScale = Math.min(1, Math.sqrt(1.6e6 / (cv.width * cv.height || 1)));
    C.frame(1 / 60); C.frame(1 / 60); C.frame(1 / 60);
    await post(`${tag}_overview_moving_big`, cv.toDataURL('image/png'));
    C.renderer.forceMoving = false; C.renderScale = 1;
    small(); await new Promise(r => setTimeout(r, 200));
    Object.assign(C.cam, keep);
    // 남은 군살 두께 분포 (목표 밖 거리 t, cm): 얼마나 두꺼운 테두리가 남았나
    const band = { '0.8-1.5mm': 0, '1.5-3mm': 0, '>3mm': 0 };
    for (let i = 0; i < s.n; i++) { if (s.d[i] >= 0) continue; const t = T[i]; if (t > 0.3) band['>3mm']++; else if (t > 0.15) band['1.5-3mm']++; else if (t > 0.08) band['0.8-1.5mm']++; }
    shots.push({ tag, ...status(), at: log.length, band });
  };

  // ── 1) 자르기로 큰 덩어리 덜어내기: 카메라를 자를 평면 위에 두고 그 평면 위 두 점을 잇는 선을 긋는다
  C.setTool('slice');
  const slicePlane = (yaw, pitch, target, a, b) => {
    cam(yaw, pitch, 9, target);
    for (let i = 0; i < 2; i++) C.frame(1 / 60);
    const A = C.project(a), B = C.project(b);
    const pts = Array.from({ length: 12 }, (_, i) => [A[0] + (B[0] - A[0]) * i / 11, A[1] + (B[1] - A[1]) * i / 11]);
    return act('slice', pts, { plane: [a, b].map(p => p.map(x => +x.toFixed(2))) });
  };
  // 앞·뒤 (z = ±1.3): x 방향에서 바라보며 세로선 / 양 끝 (x = 3.0, -3.4): z 방향에서 바라보며 세로선
  slicePlane(Math.PI / 2, 0.3, [0, 1.5, 1.3], [0, -1, 1.3], [0, 4, 1.3]);
  slicePlane(Math.PI / 2, 0.3, [0, 1.5, -1.3], [0, -1, -1.3], [0, 4, -1.3]);
  slicePlane(0, 0.3, [3.0, 1.5, 0], [3.0, -1, 0], [3.0, 4, 0]);
  slicePlane(0, 0.3, [-3.4, 1.5, 0], [-3.4, -1, 0], [-3.4, 4, 0]);
  for (let i = 0; i < 90; i++) frame();                      // 떨어진 덩어리 정리
  await capture('s0_after_slices');

  // ── 2) 칼·U자 끌로 군살 깎기
  // 후보: 비누 겉 바로 안쪽 복셀 중 목표 밖(군살)인 곳. 가장 두꺼운 군살 쪽을 고르되 무작위를 섞는다.
  const candidates = () => {
    const out = [];
    for (let k = 1; k < nz - 1; k += 2) for (let j = 1; j < ny - 1; j += 2) for (let i = 1; i < nx - 1; i += 2) {
      const idx = i + nx * (j + ny * k), d = s.d[idx];
      if (d > 0 || d < -h * 1.5) continue;
      const t = T[idx];
      if (t > 0.1) out.push({ idx, t, p: s.pos(i, j, k) });
    }
    return out;
  };
  const tAt = p => {                                           // 목표 거리장 (삼선형)
    const gx = (p[0] - s.min[0]) / h - 0.5, gy = (p[1] - s.min[1]) / h - 0.5, gz = (p[2] - s.min[2]) / h - 0.5;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(gx))), j = Math.max(0, Math.min(ny - 2, Math.floor(gy))), k = Math.max(0, Math.min(nz - 2, Math.floor(gz)));
    return T[i + nx * (j + ny * k)];
  };
  const milestones = [0.25, 0.5, 0.75, 0.9, 0.95, 0.97, 0.98];
  let nextM = 0, stall = 0, bestP = C.tgt.progress, strokes = 0;
  const MAX_STROKES = 1200;
  while (strokes < MAX_STROKES) {
    const cand = candidates();
    if (!cand.length) break;
    // 군살 두께 상위 15% 중에서 무작위로
    cand.sort((a, b) => b.t - a.t);
    const c = cand[Math.floor(R() * Math.max(1, cand.length * 0.15))];
    const n = s.normal(c.p, s.d, 0.1);
    const P = v.sub(c.p, v.mul(n, s.d[c.idx]));                  // 표면 위 점
    // 표면을 마주 보게 카메라를 돌린다 (사람이 비누를 돌려 가며 깎듯)
    const yaw = Math.atan2(n[0], n[2]), pitch = Math.max(-1.1, Math.min(1.4, Math.asin(Math.max(-1, Math.min(1, n[1])))));
    cam(yaw + (R() - 0.5) * 0.4, pitch + (R() - 0.3) * 0.3, 6 + R() * 3, P);
    C.frame(1 / 60);
    // 획 방향·길이: 접평면 위 무작위. 서툰 획(짧게 찍기·같은 곳 반복·모서리 넘기기)을 섞는다
    const ax = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const a0 = R() * Math.PI, t1 = v.norm(v.cross(n, ax)), t2 = v.cross(n, t1);
    const dir = v.add(v.mul(t1, Math.cos(a0)), v.mul(t2, Math.sin(a0)));
    const clumsy = R();
    const L = clumsy < 0.15 ? 0.25 + R() * 0.2 : clumsy < 0.25 ? 2.5 + R() * 1.5 : 0.8 + R() * 1.4;
    // 깊이: 획을 따라 군살이 가장 얇은 곳에 맞춘다 (넘게 파면 물고기를 깎는다)
    let tMin = 9;
    for (let q = -3; q <= 3; q++) tMin = Math.min(tMin, tAt(v.add(P, v.mul(dir, L * q / 6))));
    if (tMin < 0.06) { stall++; strokes++; if (stall > 120) break; continue; }
    const useGouge = tMin < 0.18 && R() < 0.5;
    C.setTool(useGouge ? 'gouge' : 'knife');
    C.knife.setDepth(Math.min(0.6, Math.max(0.02, (tMin - 0.04) * (0.6 + 0.4 * R()))));
    C.knife.setTilt(15 + R() * 40);
    const N = Math.max(6, Math.round(L / 0.08));
    const wob = clumsy > 0.85 ? 0.06 : 0.015;
    const pts = Array.from({ length: N + 1 }, (_, i) => {
      const u = -L / 2 + L * i / N;
      return C.project(v.add(v.add(P, v.mul(dir, u)), v.mul(v.cross(n, dir), wob * Math.sin(i * 0.9))));
    });
    const [cw, ch] = [cv.clientWidth, cv.clientHeight];
    // 조심스러운 사람처럼: 실제로 칼끝이 닿을 표면점(화면 점 아래 첫 표면)에서 군살 두께를 재고 그보다 얕게 판다.
    // (예전엔 접평면 직선 위에서 재서 굽은 면에서 두께를 부풀렸다 → 너무 깎음 대부분이 봇 잘못이었다)
    const hitPts = () => pts.map(p => { const r = C.cam.ray(p[0], p[1], cw, ch); const hh = s.raycast(r.ro, r.rd); return hh ? hh.point : null; });
    let hp = hitPts();
    let a = hp.findIndex(x => x);
    if (a < 0) { strokes++; stall++; continue; }
    let b = a; while (b + 1 < pts.length && hp[b + 1]) b++;
    pts.splice(b + 1); pts.splice(0, a); hp = hp.slice(a, b + 1);
    if (pts.length < 3) { strokes++; stall++; continue; }
    const safeDepth = (hps, w) => {
      let m = 9;
      for (let q = 0; q < hps.length; q++) {
        const hn = s.normal(hps[q], s.d, 0.1), nxt = hps[Math.min(q + 1, hps.length - 1)], prv = hps[Math.max(q - 1, 0)];
        const lv = v.norm(v.cross(hn, v.sub(nxt, prv)));
        for (const off of [0, -0.45, 0.45]) m = Math.min(m, tAt(v.add(hps[q], v.mul(lv, off * w))));
      }
      return m;
    };
    const tReal = safeDepth(hp, C.knife.width);
    if (tReal < 0.06) { strokes++; stall++; continue; }
    C.knife.setDepth(Math.min(C.knife.depth, Math.max(0.02, tReal - 0.05)));
    const row = act(useGouge ? 'gouge' : 'knife', pts, { depth: +C.knife.depth.toFixed(3), tilt: C.knife.tiltDeg, L: +L.toFixed(2), tMin: +tMin.toFixed(3), tReal: +tReal.toFixed(3), clumsy: +clumsy.toFixed(2) });
    if (clumsy > 0.9) {                                            // 같은 곳 한 번 더 — 깎인 새 표면에서 다시 재고
      const hp2 = hitPts().filter(x => x), t2 = hp2.length > 2 ? safeDepth(hp2, C.knife.width) : 0;
      if (t2 > 0.08) { C.knife.setDepth(Math.max(0.02, Math.min(C.knife.depth, t2 - 0.05))); act(row.tool, pts, { repeat: true, depth: +C.knife.depth.toFixed(3), tReal: +t2.toFixed(3) }); }
    }
    strokes++;
    if (C.tgt.progress > bestP + 0.002) { bestP = C.tgt.progress; stall = 0; } else stall++;
    if (strokes % 25 === 0) { C.chips.clear(); }                // 사람도 가끔 부스러기를 치운다 (C)
    while (nextM < milestones.length && C.tgt.progress >= milestones[nextM]) { await capture(`m${Math.round(milestones[nextM] * 100)}`); nextM++; }
    if (C.tgt.done || C.tgt.progress >= 0.98) break;            // 완성되면 그만 (완성 기준이 닿을 수 있는지 본다)
    if (stall > 120) break;
    if (strokes % 10 === 0) await new Promise(r => setTimeout(r, 0));   // 브라우저에 숨 돌릴 틈
  }

  // ── 3) 물로 마무리: 깎인 면 몇 군데를 문지른다
  C.setTool('sand'); C.st.brush = 0.5;
  for (let q = 0; q < 14; q++) {
    const cand = [];
    for (let i = 0; i < s.n; i += 7) if (s.mark[i] === 255 && Math.abs(s.d[i]) < h) cand.push(i);
    if (!cand.length) break;
    const idx = cand[Math.floor(R() * cand.length)];
    const k = Math.floor(idx / (nx * ny)), j = Math.floor(idx / nx) % ny, i = idx % nx;
    const p = s.pos(i, j, k), n = s.normal(p, s.d, 0.1);
    cam(Math.atan2(n[0], n[2]), Math.max(-1.1, Math.min(1.4, Math.asin(Math.max(-1, Math.min(1, n[1]))))), 6, p);
    C.frame(1 / 60);
    const t1 = v.norm(v.cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    act('water', Array.from({ length: 16 }, (_, i2) => C.project(v.add(p, v.mul(t1, 0.4 * Math.sin(i2 * 0.8))))));
  }
  for (let i = 0; i < 240; i++) frame();                        // 물이 흐르고 마르는 동안
  await capture('final');

  // GPU 포함 프레임 시간: 큰 창, 움직이는 중 / 가만히 다 쌓인 뒤
  big(); await new Promise(r => setTimeout(r, 200));
  cam(-0.65, 0.55, 12, [0, 1.4, 0]);
  const dev = C.renderer.device;
  const tm = async n => { await dev.queue.onSubmittedWorkDone(); const t0 = performance.now(); for (let i = 0; i < n; i++) { C.frame(1 / 60); await dev.queue.onSubmittedWorkDone(); } return +((performance.now() - t0) / n).toFixed(2); };
  C.renderer.forceMoving = true; C.renderScale = Math.min(1, Math.sqrt(1.6e6 / (cv.width * cv.height)));
  const bigMoving = await tm(20);
  C.renderer.forceMoving = false; C.renderScale = 1;
  for (let i = 0; i < 30; i++) C.frame(1 / 60);
  const bigStill = await tm(20);
  small();

  const summary = { strokes, final: status(), shots, errors, gpuErrors: C.gpuErrors, perf: { canvasBig: [cv.width, cv.height], bigMovingMs: bigMoving, bigStillMs: bigStill } };
  await post('log', JSON.stringify({ summary, log }));
  document.title = 'playtest done';
}
