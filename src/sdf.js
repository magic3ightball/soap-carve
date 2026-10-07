// 비누 몸체 = 부호 거리장(SDF) 복셀. CPU 배열이 기준이고, 바뀐 영역만 GPU 3D 텍스처(rg16float: r=거리, g=깎인 자국)로 올린다.
// 깎기 = 칼날이 지나간 공간(둥근 상자)을 빼는 연산: new = max(old, -tool)
import { v3 } from './math.js';
const FLAT_CORE = 0.45;    // 곧은 칼 단면에서 평평한 가운데 비율 (나머지는 양옆 경사)
const SMOOTH_LAP = 7;
const FROST_FULL = 0.02;   // 이만큼(cm) 넘게 깎이면 깎인 면이 완전히 뿌옇다. 경사 끝처럼 얕게 깎인 곳은 그만큼 옅다      // 물로 문질러 맑아지는 면의 곡률 한도 (1/cm, 반지름 ≈ 3 mm보다 완만)

export const SOAP = { center: [0, 1.5, 0], half: [4, 1.5, 2.5], round: 0.4 };   // 단위 cm, 바닥이 y=0(작업대)

export class SoapSDF {
  constructor(device) {
    this.h = 0.05;                                   // 복셀 0.5 mm
    this.min = [-4.4, -0.2, -2.9];
    this.dims = [176, 72, 116];
    const [nx, ny, nz] = this.dims;
    this.n = nx * ny * nz;
    this.d = new Float32Array(this.n);
    this.mark = new Uint8Array(this.n);      // 깎인 면 종류: 0 원래 겉면, 255 칼(결 있음), 150 U자 끌, 100 물로 녹은 면
    this.dirX = new Int8Array(this.n);       // 칼이 지나간 결의 옆 방향 l (x, z 성분, y ≥ 0 으로 맞춰 저장)
    this.dirZ = new Int8Array(this.n);
    // 뿌연 정도 0~255: 깎인 깊이에 비례하는 연속값. 종류(mark)처럼 복셀마다 켜짐/꺼짐이면
    // 0.5 mm 계단 테두리가 생겨서(찢긴 종이처럼 보임) 따로 둔다. GPU에선 r8unorm 텍스처로 보간된다.
    this.cov = new Uint8Array(this.n);
    this.device = device;
    this.tex = device.createTexture({ size: this.dims, dimension: '3d', format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    // 목표 모양 SDF (가이드 색칠용). 자유 조각이면 멀리(+) 채워 둔다
    this.covTex = device.createTexture({ size: this.dims, dimension: '3d', format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.tgtTex = device.createTexture({ size: this.dims, dimension: '3d', format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.setTarget(null);
    this.dirty = null;
    this.reset();
  }

  setTarget(arr) {
    const out = new Uint16Array(this.n);
    if (arr) for (let i = 0; i < this.n; i++) out[i] = f16(arr[i]);
    else out.fill(f16(9));
    const [nx, ny, nz] = this.dims;
    this.device.queue.writeTexture({ texture: this.tgtTex }, out, { bytesPerRow: nx * 2, rowsPerImage: ny }, this.dims);
  }

  reset() {
    const [nx, ny, nz] = this.dims, { center: c, half: hb, round: r } = SOAP;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = this.pos(i, j, k);
      const q = [Math.abs(p[0] - c[0]) - hb[0] + r, Math.abs(p[1] - c[1]) - hb[1] + r, Math.abs(p[2] - c[2]) - hb[2] + r];
      const out = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
      this.d[i + nx * (j + ny * k)] = out + Math.min(Math.max(q[0], q[1], q[2]), 0) - r;
    }
    this.mark.fill(0); this.dirX.fill(0); this.dirZ.fill(0); this.cov.fill(0);
    this.dirty = [0, 0, 0, nx, ny, nz];
    this.upload();
  }

  pos(i, j, k) { const h = this.h; return [this.min[0] + (i + 0.5) * h, this.min[1] + (j + 0.5) * h, this.min[2] + (k + 0.5) * h]; }

  // 삼선형 보간 (배열 arr 기준, 기본은 현재 SDF)
  sample(p, arr = this.d) {
    const [nx, ny, nz] = this.dims, h = this.h;
    let gx = (p[0] - this.min[0]) / h - 0.5, gy = (p[1] - this.min[1]) / h - 0.5, gz = (p[2] - this.min[2]) / h - 0.5;
    if (gx < -1 || gy < -1 || gz < -1 || gx > nx || gy > ny || gz > nz) return 1;
    // 격자 가장자리 반 칸은 끝 값으로 (예전엔 1을 돌려줘서 광선이 비누 윗면을 건너뛰고 속으로 들어갔다)
    gx = Math.min(Math.max(gx, 0), nx - 1); gy = Math.min(Math.max(gy, 0), ny - 1); gz = Math.min(Math.max(gz, 0), nz - 1);
    const i = Math.min(Math.floor(gx), nx - 2), j = Math.min(Math.floor(gy), ny - 2), k = Math.min(Math.floor(gz), nz - 2);
    const fx = gx - i, fy = gy - j, fz = gz - k;
    const o = i + nx * (j + ny * k), sy = nx, sz = nx * ny;
    const c00 = arr[o] * (1 - fx) + arr[o + 1] * fx, c10 = arr[o + sy] * (1 - fx) + arr[o + sy + 1] * fx;
    const c01 = arr[o + sz] * (1 - fx) + arr[o + sz + 1] * fx, c11 = arr[o + sz + sy] * (1 - fx) + arr[o + sz + sy + 1] * fx;
    return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }

  normal(p, arr = this.d, e = this.h) {
    return v3.norm([
      this.sample([p[0] + e, p[1], p[2]], arr) - this.sample([p[0] - e, p[1], p[2]], arr),
      this.sample([p[0], p[1] + e, p[2]], arr) - this.sample([p[0], p[1] - e, p[2]], arr),
      this.sample([p[0], p[1], p[2] + e], arr) - this.sample([p[0], p[1], p[2] - e], arr)]);
  }

  // 광선 → 첫 표면. 없으면 null
  raycast(ro, rd, arr = this.d) {
    const lo = this.min, hi = this.min.map((m, a) => m + this.dims[a] * this.h);
    let t0 = 0, t1 = 1e9;
    for (let a = 0; a < 3; a++) {
      const inv = 1 / (rd[a] || 1e-12);
      let ta = (lo[a] - ro[a]) * inv, tb = (hi[a] - ro[a]) * inv;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t0 > t1) return null;
    let t = t0 + 1e-4;
    for (let s = 0; s < 600 && t < t1; s++) {
      const p = v3.madd(ro, rd, t), d = this.sample(p, arr);
      if (d < 0.002) {
        // 한 번 되짚어 표면에 붙인다
        const tb = t - Math.max(d, -0.05);
        const ph = v3.madd(ro, rd, Math.min(t, tb));
        // 칼 방향용 법선은 넓게(1.5 mm) 재서 홈 가장자리 같은 작은 모양에 칼이 휘청이지 않게
        return { point: ph, normal: this.normal(ph, arr, 0.15), t };
      }
      t += Math.min(Math.max(d * 0.9, 0.01), 0.2);
    }
    return null;
  }

  snapshot() { return this.d.slice(); }

  // 칼날 한 구간 깎기. A→B: 표면 위 두 점, n: 표면 법선, depth: 깊이, width: 날이 닿는 폭 (cm)
  // profile: 'flat' 곧은 칼(가운데 평평·양옆 완만한 경사·끝이 각짐) | 'round' U자 끌(반타원 단면)
  // 돌려주는 값: 깎여 나간 부피(cm³)
  carve(A, B, n, depth, width, profile = 'flat') {
    let u = v3.sub(B, A);
    u = v3.sub(u, v3.mul(n, v3.dot(u, n)));
    const len = v3.len(u);
    if (len < 1e-5) return 0;
    u = v3.mul(u, 1 / len);
    const l = v3.norm(v3.cross(n, u));
    const H = Math.max(depth * 3, 0.12);                   // 날 위쪽(칩이 넘어가는 쪽)도 같이 비운다
    const hw = width / 2, hx = hw, hy = len / 2 + hw, hz = (H + depth) / 2;
    const M = v3.lerp(A, B, 0.5), half = len / 2, mn = Math.min(hw, depth);
    const flat = profile === 'flat';
    // 칼 결 방향 l을 y ≥ 0 쪽으로 (부호는 결 무늬에 상관없다)
    const ls = l[1] < 0 ? -1 : 1, lx = Math.round(l[0] * ls * 127), lz = Math.round(l[2] * ls * 127);
    const markV = flat ? 255 : 150;
    const C = v3.add(M, v3.mul(n, (H - depth) / 2));
    // 영역 AABB
    const ext = [0, 1, 2].map(a => Math.abs(l[a]) * hx + Math.abs(u[a]) * hy + Math.abs(n[a]) * hz + this.h * 2);
    const [nx, ny, nz] = this.dims, h = this.h;
    const i0 = Math.max(0, Math.floor((C[0] - ext[0] - this.min[0]) / h)), i1 = Math.min(nx, Math.ceil((C[0] + ext[0] - this.min[0]) / h));
    const j0 = Math.max(0, Math.floor((C[1] - ext[1] - this.min[1]) / h)), j1 = Math.min(ny, Math.ceil((C[1] + ext[1] - this.min[1]) / h));
    const k0 = Math.max(0, Math.floor((C[2] - ext[2] - this.min[2]) / h)), k1 = Math.min(nz, Math.ceil((C[2] + ext[2] - this.min[2]) / h));
    if (i0 >= i1 || j0 >= j1 || k0 >= k1) return 0;
    let removed = 0;
    const frac = s => Math.min(1, Math.max(0, 0.5 - s / h));
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) {
      let idx = i0 + nx * (j + ny * k);
      for (let i = i0; i < i1; i++, idx++) {
        // 날 단면 = 둥근 끌(gouge): 표면 아래는 반타원(폭 hw, 깊이 depth), 위는 칩이 넘어가는 기둥.
        // (예전 바닥 평평+벽 수직 단면은 획 사이에 턱이 남아 둥글게 다듬기 어려웠다)
        const px = this.min[0] + (i + 0.5) * h - M[0], py = this.min[1] + (j + 0.5) * h - M[1], pz = this.min[2] + (k + 0.5) * h - M[2];
        const a = px * l[0] + py * l[1] + pz * l[2];
        const bb = Math.max(Math.abs(px * u[0] + py * u[1] + pz * u[2]) - half, 0);
        const c = px * n[0] + py * n[1] + pz * n[2];
        const aa = Math.hypot(a, bb);
        let tool;
        if (flat) {
          // 곧은 칼을 비스듬히 밀어 깎은 면: 가운데는 평평하고 양옆은 완만한 경사로 0까지 얇아진다.
          // 예전 단면(평평한 바닥 + 거의 수직인 0.2 mm 모서리 벽)은 홈이 '파인 틈·단차'로 보였고,
          // 0.5 mm 격자보다 날카로운 벽 모서리가 톱니처럼 지글거렸다.
          // 구간 끝은 날 폭의 절반만큼 더 늘려 겹치게: 딱 맞추면 방향이 꺾일 때 구간 사이에 쐐기 틈이 남아 가는 기둥이 섰다
          const sN = Math.abs(a) / hw, t = Math.min(1, Math.max(0, (sN - FLAT_CORE) / (1 - FLAT_CORE)));
          const dep = depth * (1 - t * t * (3 - 2 * t));
          const slope = depth * 6 * t * (1 - t) / ((1 - FLAT_CORE) * hw);           // 경사 기울기 → 거리 보정
          const qb = Math.abs(px * u[0] + py * u[1] + pz * u[2]) - (half + Math.min(hw * 0.5, 0.12));
          tool = Math.max((-c - dep) / Math.sqrt(1 + slope * slope), c - H, qb, Math.abs(a) - hw);
        } else tool = c < 0 ? (Math.hypot(aa / hw, c / depth) - 1) * mn : Math.max(aa - hw, c - H);
        const old = this.d[idx];
        if (-tool > old) {
          this.d[idx] = -tool;
          removed += frac(old) - frac(-tool);
          if (old < h * 2) { this.mark[idx] = markV; this.dirX[idx] = lx; this.dirZ[idx] = lz; this.frost(idx, -tool - old); }
        }
      }
    }
    this.markDirty(i0, j0, k0, i1, j1, k1);
    return removed * h * h * h;
  }

  // 마른 비누가 칼 끝에서 부스러진 자리: 끝 모서리 근처를 작은 구슬로 몇 군데 떼어 낸다 (c: 끝점, n: 법선, u: 진행 방향)
  crumble(c, n, u, width, depth, rand) {
    const l = v3.norm(v3.cross(n, u));
    const k = 2 + Math.floor(rand() * 3);
    for (let q = 0; q < k; q++) {
      const r = 0.025 + rand() * 0.035;
      const p = v3.add(v3.add(c, v3.mul(l, (rand() - 0.5) * width)), v3.add(v3.mul(u, 0.01 + rand() * 0.04), v3.mul(n, -rand() * depth * 0.5)));
      this.bite(p, r);
    }
  }
  bite(p, r) {
    const [nx, ny, nz] = this.dims, h = this.h, e = r + 2 * h;
    const lo = [0, 1, 2].map(a => Math.max(0, Math.floor((p[a] - e - this.min[a]) / h)));
    const hi = [0, 1, 2].map(a => Math.min(this.dims[a], Math.ceil((p[a] + e - this.min[a]) / h)));
    for (let k = lo[2]; k < hi[2]; k++) for (let j = lo[1]; j < hi[1]; j++) for (let i = lo[0]; i < hi[0]; i++) {
      const q = this.pos(i, j, k), idx = i + nx * (j + ny * k);
      const v = r - Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (v > this.d[idx]) { if (this.d[idx] < h * 2) { this.mark[idx] = 120; this.frost(idx, v - this.d[idx]); } this.d[idx] = v; }
    }
    this.markDirty(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
  }

  // 다듬기(사포): 붓 안의 거리장을 흐리게 한 값과 비교해 '깎는 쪽'으로만 바꾼다.
  // 볼록한 모서리·홈 사이 턱은 깎여 둥글어지고, 오목한 곳은 채우지 않으며, 평평한 곳은 그대로다.
  // c: 붓 중심(표면점), R: 붓 반지름(cm), amt: 이번 프레임 세기(0..1). 돌려주는 값: 깎인 부피
  sand(c, R, amt) {
    const [nx, ny, nz] = this.dims, h = this.h;
    // 흐림 폭을 붓 크기에 비례시킨다: 고정 폭(≈1 mm)이면 그 크기까지만 둥글어지고 더 문질러도 그대로였다
    const rk = Math.max(1, Math.round(R / h / 2.5)), B = 2 * rk + 2;
    const ri = Math.ceil(R / h) + B;
    const ci = [0, 1, 2].map(a => Math.round((c[a] - this.min[a]) / h - 0.5));
    const lo = ci.map((v, a) => Math.max(0, v - ri)), hi = ci.map((v, a) => Math.min(this.dims[a], v + ri + 1));
    const sx = hi[0] - lo[0], sy = hi[1] - lo[1], sz = hi[2] - lo[2];
    if (sx < 3 || sy < 3 || sz < 3) return 0;
    let a = new Float32Array(sx * sy * sz), b = new Float32Array(a.length);
    for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) {
      const src = lo[0] + nx * (lo[1] + j + ny * (lo[2] + k));
      a.set(this.d.subarray(src, src + sx), sx * (j + sy * k));
    }
    // 폭 (2rk+1) 상자 흐림을 축마다 두 번 (≈ 가우시안), 줄마다 누적합으로
    const strides = [1, sx, sx * sy], sizes = [sx, sy, sz];
    const line = new Float32Array(Math.max(sx, sy, sz) + 1);
    for (let pass = 0; pass < 2; pass++) for (let ax = 0; ax < 3; ax++) {
      const st = strides[ax], n = sizes[ax];
      const o1 = strides[(ax + 1) % 3], n1 = sizes[(ax + 1) % 3], o2 = strides[(ax + 2) % 3], n2 = sizes[(ax + 2) % 3];
      for (let q = 0; q < n2; q++) for (let p = 0; p < n1; p++) {
        const base = p * o1 + q * o2;
        line[0] = 0;
        for (let c = 0; c < n; c++) line[c + 1] = line[c] + a[base + c * st];
        for (let c = 0; c < n; c++) {
          const lo2 = Math.max(0, c - rk), hi2 = Math.min(n, c + rk + 1);
          b[base + c * st] = (line[hi2] - line[lo2]) / (hi2 - lo2);
        }
      }
      [a, b] = [b, a];
    }
    let removed = 0;
    const frac = s => Math.min(1, Math.max(0, 0.5 - s / h));
    for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
      const gi = lo[0] + i, gj = lo[1] + j, gk = lo[2] + k;
      const dist = Math.hypot(this.min[0] + (gi + 0.5) * h - c[0], this.min[1] + (gj + 0.5) * h - c[1], this.min[2] + (gk + 0.5) * h - c[2]);
      if (dist > R) continue;
      const idx = gi + nx * (gj + ny * gk), old = this.d[idx];
      if (Math.abs(old) > 0.4) continue;
      const t = Math.min(1, Math.max(0, (R - dist) / (R * 0.6)));
      const w = amt * t * t * (3 - 2 * t);
      const nv = old + (a[i + sx * (j + sy * k)] - old) * w;
      if (nv > old) {
        this.d[idx] = nv;
        removed += frac(old) - frac(nv);
      }
    }
    // 물로 문질러 '매끈해진' 면만 맑아진다 (결 없는 녹은 면 표시).
    // 예전엔 물이 닿기만 하면 표시해서, 칼 턱·부스러진 끝이 거친 채로 맑은 유리처럼 굴절돼 바닥·배경이 얼룩덜룩 비쳤다.
    for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
      const gi = lo[0] + i, gj = lo[1] + j, gk = lo[2] + k, idx = gi + nx * (gj + ny * gk);
      if (Math.abs(this.d[idx]) >= h * 2 || (this.mark[idx] === 100 && this.cov[idx] === 0)) continue;
      const dist = Math.hypot(this.min[0] + (gi + 0.5) * h - c[0], this.min[1] + (gj + 0.5) * h - c[1], this.min[2] + (gk + 0.5) * h - c[2]);
      if (dist < R * 0.8 && this.smoothAt(gi, gj, gk)) {
        // 문지를수록 뿌연 막이 붓 가장자리부터 부드럽게 걷힌다 (붓 세기 그대로 곱해서 테두리가 계단지지 않게)
        const t = Math.min(1, Math.max(0, (R * 0.8 - dist) / (R * 0.5))), w = amt * t * t * (3 - 2 * t);
        this.mark[idx] = 100;
        this.cov[idx] = Math.floor(this.cov[idx] * (1 - w));
      }
    }
    this.markDirty(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    return removed * h * h * h;
  }

  // 이 칸 둘레 면이 1 mm 규모에서 매끈한가: 2칸 간격 라플라시안(≈ 곡률 합, 1/cm)이 작으면 매끈.
  // 평면 0, 반지름 r 공 2/r. 칼 턱 모서리·부스러기는 14~20, 원래 비누 모서리 대부분 10 이하.
  smoothAt(i, j, k) {
    const [nx, ny, nz] = this.dims, d = this.d, h = this.h;
    if (i < 2 || j < 2 || k < 2 || i > nx - 3 || j > ny - 3 || k > nz - 3) return true;
    const idx = i + nx * (j + ny * k), sy = nx * 2, sz = nx * ny * 2;
    const lap = (d[idx + 2] + d[idx - 2] + d[idx + sy] + d[idx - sy] + d[idx + sz] + d[idx - sz] - 6 * d[idx]) / (4 * h * h);
    return Math.abs(lap) < SMOOTH_LAP;
  }

  markDirty(i0, j0, k0, i1, j1, k1) {
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], i0), Math.min(d[1], j0), Math.min(d[2], k0), Math.max(d[3], i1), Math.max(d[4], j1), Math.max(d[5], k1)]
      : [i0, j0, k0, i1, j1, k1];
  }

  // 깎인 깊이 amount(cm)만큼 뿌옇게 (더 옅게는 안 바꾼다)
  frost(idx, amount) {
    const v = Math.min(255, Math.round(amount / FROST_FULL * 255));
    if (v > this.cov[idx]) this.cov[idx] = v;
  }

  // 전체 배열 교체 (되돌리기)
  restore(arr, mark, cov) { this.d.set(arr); this.mark.set(mark); this.cov.set(cov); this.dirty = [0, 0, 0, ...this.dims]; }

  upload() {
    if (!this.dirty) return;
    const [i0, j0, k0, i1, j1, k1] = this.dirty, [nx, ny] = this.dims;
    const sx = i1 - i0, sy = j1 - j0, sz = k1 - k0;
    const out = new Uint16Array(sx * sy * sz * 4);
    let o = 0;
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) {
      let idx = i0 + nx * (j + ny * k);
      for (let i = 0; i < sx; i++, idx++) {
        out[o++] = f16(this.d[idx]); out[o++] = f16(this.mark[idx] / 255);
        out[o++] = f16(this.dirX[idx] / 127); out[o++] = f16(this.dirZ[idx] / 127);
      }
    }
    this.device.queue.writeTexture({ texture: this.tex, origin: [i0, j0, k0] }, out,
      { bytesPerRow: sx * 8, rowsPerImage: sy }, [sx, sy, sz]);
    const cv = new Uint8Array(sx * sy * sz);
    o = 0;
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) { const idx = i0 + nx * (j + ny * k); cv.set(this.cov.subarray(idx, idx + sx), o); o += sx; }
    this.device.queue.writeTexture({ texture: this.covTex, origin: [i0, j0, k0] }, cv,
      { bytesPerRow: sx, rowsPerImage: sy }, [sx, sy, sz]);
    this.dirty = null;
  }

  // 남은 비누 부피 (cm³) — 테스트용
  volume() {
    const h = this.h; let s = 0;
    for (let i = 0; i < this.n; i++) s += Math.min(1, Math.max(0, 0.5 - this.d[i] / h));
    return s * h * h * h;
  }
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function f16(v) {
  f32[0] = v;
  const x = u32[0], sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) return sign;                              // 아주 작은 값은 0
  if (e >= 31) return sign | 0x7bff;                    // 큰 값은 최대값으로
  return sign | (e << 10) | ((m + 0x1000) >>> 13 > 0x3ff ? 0x3ff : (m + 0x1000) >>> 13);
}
