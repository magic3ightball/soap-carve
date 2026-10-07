// 목표 모양(물고기·토끼)을 비누 격자와 같은 SDF로 만들고, 깎은 정도를 채점한다.
// 비누: x∈[-4,4] y∈[0,3] z∈[-2.5,2.5] (cm). 두 모양 모두 이 안에 들어가고 바닥(y=0)에 닿는다.

const len = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
// 타원체 근사 SDF (iq)
function ell(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = px - cx, y = py - cy, z = pz - cz;
  const k0 = len(x / rx, y / ry, z / rz), k1 = len(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 < 1e-9 ? -Math.min(rx, ry, rz) : k0 * (k0 - 1) / k1;
}
function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
const smax = (a, b, k) => -smin(-a, -b, k);
// 납작한 판 (xy 평면 다각형 대신 쓰는 단순형): |z| 두께, xy는 함수로 준 2D 거리
const slab = (d2, pz, th) => Math.max(d2, Math.abs(pz) - th);

export const TARGETS = {
  fish: {
    name: '물고기',
    sdf(x, y, z) {
      // 몸통 (+x가 머리), 받침
      let d = ell(x, y, z, 0.35, 1.5, 0, 2.55, 1.2, 0.78);
      // 꼬리: 초승달 모양 (큰 원 안 - 뒤쪽 원 밖), 끝으로 갈수록 얇게
      const c1 = Math.hypot(x + 2.15, y - 1.55) - 1.25, c2 = 1.05 - Math.hypot(x + 4.05, y - 1.55);
      const th = 0.24 - Math.min(Math.max(-2.2 - x, 0), 1.6) * 0.08;
      const tail = slab(Math.max(c1, c2, x + 2.1), z, th);
      d = smin(d, tail, 0.35);
      // 등지느러미·배지느러미
      const dorsal = slab(Math.max(y - (2.95 - Math.abs(x + 0.1) * 0.55), 2.35 - y, Math.abs(x + 0.1) - 0.95), z, 0.13);
      d = smin(d, dorsal, 0.2);
      const pelvic = slab(Math.max(0.45 - y + Math.abs(x - 0.2) * 0.3, y - 0.75, Math.abs(x - 0.2) - 0.55), z, 0.14);
      d = smin(d, pelvic, 0.15);
      // 받침
      const base = Math.max(ell(x, 0, z, 0.0, 0, 0, 2.9, 1, 1.15), y - 0.32, -y);
      d = smin(d, base, 0.25);
      // 눈 (오목)
      d = smax(d, -ell(x, y, Math.abs(z), 1.95, 1.8, 0.66, 0.16, 0.16, 0.16), 0.04);
      return d;
    },
  },
  rabbit: {
    name: '토끼',
    sdf(x, y, z) {
      // 웅크려 앉은 토끼 (+x가 머리)
      let d = ell(x, y, z, -0.55, 1.12, 0, 2.3, 1.12, 1.6);                   // 몸통
      d = smin(d, ell(x, y, z, 1.75, 1.55, 0, 1.05, 0.95, 0.98), 0.45);       // 머리
      const az = Math.abs(z);
      d = smin(d, ell(x, y, az, 0.85, 2.38, 0.45, 1.15, 0.3, 0.33), 0.25);    // 등으로 눕힌 귀 두 개
      d = smin(d, ell(x, y, z, -2.85, 1.05, 0, 0.45, 0.45, 0.45), 0.2);       // 꼬리
      d = smin(d, ell(x, y, az, 2.05, 0.3, 0.62, 0.55, 0.3, 0.35), 0.2);      // 앞발
      d = smin(d, ell(x, y, az, 2.6, 1.4, 0, 0.22, 0.2, 0.25), 0.1);          // 코
      d = smax(d, -ell(x, y, az, 2.2, 1.8, 0.62, 0.14, 0.14, 0.14), 0.04);    // 눈
      return Math.max(d, -y);                                                // 바닥 평평
    },
  },
};

// 비누 격자 전체에 목표 SDF를 채운다
export function buildTarget(sdf, key) {
  const t = TARGETS[key], [nx, ny, nz] = sdf.dims, out = new Float32Array(sdf.n), h = sdf.h;
  let o = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    out[o++] = t.sdf(sdf.min[0] + (i + 0.5) * h, sdf.min[1] + (j + 0.5) * h, sdf.min[2] + (k + 0.5) * h);
  return out;
}

// 채점: 허용 오차 tol(cm) 바깥만 센다.
//  남은 군살 = 비누 안 && 목표 밖(tol 이상), 과하게 깎음 = 비누 밖 && 목표 안(tol 이상)
//  두꺼운 군살 = 남은 군살 중 목표에서 thick(cm) 넘게 떨어진 것 — 덩어리처럼 보이는 테두리 (복셀 수)
export function score(sdf, tgt, tol = 0.08, thickTol = 0.3) {
  let excess = 0, over = 0, inside = 0, thick = 0;
  const d = sdf.d;
  for (let i = 0; i < d.length; i++) {
    const t = tgt[i];
    if (t < -tol) { inside++; if (d[i] > 0) over++; }
    else if (t > tol && d[i] < 0) { excess++; if (t > thickTol) thick++; }
  }
  return { excess, over, inside, thick };
}
