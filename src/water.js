// 물 묻히기의 물: 비누 표면에 붙은 젖음 정도 W (1 mm 칸, 비누 격자의 절반 해상도).
//  - 문지른 곳에 물이 묻는다
//  - 기울어진 면에선 중력의 접선 성분 방향으로 흘러내리고, 아래가 비어 있으면 똑 떨어진다
//  - 젖은 만큼 아주 천천히 녹아(거리장 += 녹는 속도) 물길 자국이 남는다
//  - 시간이 지나면 마른다
// 렌더는 W를 r8unorm 3D 텍스처로 올려 젖은 광택을 그린다.
import { v3 } from './math.js';

const FLOW = 4.0;       // 수직면에서 초당 흘러가는 비율
const DRY = 0.1;        // 초당 마르는 양 (가득 젖은 곳이 약 10초)
const MELT = 0.02;      // 가득 젖었을 때 녹는 깊이 cm/s
const SURF = 0.09;      // 표면 칸 판정 |거리| < SURF

export class Water {
  constructor(sdf, device) {
    this.sdf = sdf; this.device = device;
    this.c = sdf.h * 2;
    this.dims = sdf.dims.map(n => n / 2);
    const [hx, hy, hz] = this.dims;
    this.n = hx * hy * hz;
    this.W = new Float32Array(this.n);
    this.inAct = new Uint8Array(this.n);
    this.nrm = new Float32Array(this.n * 3);
    this.act = [];
    this.tex = device.createTexture({ size: this.dims, dimension: '3d', format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.bytes = new Uint8Array(this.n);
    this.dirty = true;
    this.version = 0;             // GPU로 올릴 때마다 +1
    this.events = [];             // 소리용: { type: 'drip', pos }
    this.dripT = 0;
    this.upload();
  }

  center(idx) {
    const [hx, hy] = this.dims, i = idx % hx, j = ((idx / hx) | 0) % hy, k = (idx / (hx * hy)) | 0;
    const c = this.c, m = this.sdf.min;
    return [m[0] + (i + 0.5) * c, m[1] + (j + 0.5) * c, m[2] + (k + 0.5) * c];
  }
  surface(p) { return Math.abs(this.sdf.sample(p)) < SURF && p[1] > 0.05; }

  activate(idx, p) {
    if (this.inAct[idx]) return;
    const n = this.sdf.normal(p, this.sdf.d, 0.1);
    this.nrm.set(n, idx * 3);
    this.inAct[idx] = 1;
    this.act.push(idx);
  }

  // 문지른 곳에 물을 묻힌다 (c: 표면점, R: 범위 반지름 cm, amt: 한 번에 묻는 양)
  add(c, R, amt) {
    const [hx, hy, hz] = this.dims, cs = this.c, m = this.sdf.min, r = Math.ceil(R / cs);
    const ci = [0, 1, 2].map(a => Math.floor((c[a] - m[a]) / cs));
    for (let k = Math.max(0, ci[2] - r); k <= Math.min(hz - 1, ci[2] + r); k++)
      for (let j = Math.max(0, ci[1] - r); j <= Math.min(hy - 1, ci[1] + r); j++)
        for (let i = Math.max(0, ci[0] - r); i <= Math.min(hx - 1, ci[0] + r); i++) {
          const p = [m[0] + (i + 0.5) * cs, m[1] + (j + 0.5) * cs, m[2] + (k + 0.5) * cs];
          const dd = v3.len(v3.sub(p, c));
          if (dd > R || !this.surface(p)) continue;
          const idx = i + hx * (j + hy * k);
          this.W[idx] = Math.min(1, this.W[idx] + amt * (1 - dd / R * 0.5));
          this.activate(idx, p);
        }
    this.dirty = true;
  }

  step(dt) {
    if (!this.act.length) return;
    const [hx, hy, hz] = this.dims, W = this.W, sdf = this.sdf;
    const moved = [];
    const next = [];
    this.dripT += dt;
    for (const idx of this.act) {
      let w = W[idx] - DRY * dt;
      const p = this.center(idx);
      if (w < 0.004 || !this.surface(p)) { W[idx] = 0; this.inAct[idx] = 0; continue; }
      const n = [this.nrm[idx * 3], this.nrm[idx * 3 + 1], this.nrm[idx * 3 + 2]];
      // 중력의 접선 성분
      const gt = [n[0] * n[1], -1 + n[1] * n[1], n[2] * n[1]], mag = v3.len(gt);
      if (mag > 0.15) {
        const f = w * Math.min(0.9, FLOW * mag * dt);
        const dir = v3.mul(gt, 1 / mag);
        // 26 이웃 중 흐르는 방향과 가장 맞고 표면인 칸으로
        let best = -1, bestDot = 0.35, bestP = null;
        const i = idx % hx, j = ((idx / hx) | 0) % hy, k = (idx / (hx * hy)) | 0;
        for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj && !dk) continue;
          const a = i + di, b = j + dj, cc = k + dk;
          if (a < 0 || b < 0 || cc < 0 || a >= hx || b >= hy || cc >= hz) continue;
          const dot = (di * dir[0] + dj * dir[1] + dk * dir[2]) / Math.hypot(di, dj, dk);
          if (dot <= bestDot) continue;
          const q = [p[0] + di * this.c, p[1] + dj * this.c, p[2] + dk * this.c];
          if (!this.surface(q)) continue;
          best = a + hx * (b + hy * cc); bestDot = dot; bestP = q;
        }
        if (best >= 0) { moved.push(best, f); if (!this.inAct[best]) { this.activate(best, bestP); next.push(best); } }
        else if (f > 0.01 && this.dripT > 0.22) { this.events.push({ type: 'drip', pos: p }); this.dripT = 0; }   // 아래가 비었다: 똑
        w -= f;
      }
      // 젖은 만큼 녹는다: 이 칸(비누 복셀 2×2×2)의 표면 근처 거리값을 늘린다
      if (w > 0.12) this.melt(idx, MELT * w * dt);
      W[idx] = w;
    }
    for (let q = 0; q < moved.length; q += 2) W[moved[q]] = Math.min(1, W[moved[q]] + moved[q + 1]);
    this.act = this.act.filter(idx => this.inAct[idx]);
    this.dirty = true;
  }

  melt(idx, amount) {
    const [hx, hy] = this.dims, sdf = this.sdf, [nx, ny] = sdf.dims, d = sdf.d;
    const i = (idx % hx) * 2, j = (((idx / hx) | 0) % hy) * 2, k = ((idx / (hx * hy)) | 0) * 2;
    for (let c = 0; c < 2; c++) for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
      const v = (i + a) + nx * ((j + b) + ny * (k + c));
      // 흘러내린 물은 겉을 고르게 조금 녹일 뿐 요철은 그대로라 맑게(녹은 면 표시) 바꾸지 않는다 → 문질러야 맑아진다
      if (Math.abs(d[v]) < 0.1) d[v] += amount;
    }
    sdf.markDirty(i, j, k, i + 2, j + 2, k + 2);
  }

  clear() { this.W.fill(0); this.inAct.fill(0); this.act.length = 0; this.dirty = true; }

  upload() {
    if (!this.dirty) return;
    const b = this.bytes, W = this.W;
    if (this.act.length || this.wasWet) for (let i = 0; i < this.n; i++) b[i] = W[i] * 255;
    this.wasWet = this.act.length > 0;
    const [hx, hy] = this.dims;
    this.device.queue.writeTexture({ texture: this.tex }, b, { bytesPerRow: hx, rowsPerImage: hy }, this.dims);
    this.dirty = false;
    this.version++;
  }
}
