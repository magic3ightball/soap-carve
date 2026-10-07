// 칩·덩어리 공용 강체 한 스텝: 접촉점(지역 좌표 r, 반두께 half)이 비누 SDF와 부딪히면 충격량으로 밀어낸다.
// 작업대는 없다 (비누가 허공에 떠 있다): 비누에 안 걸린 것은 계속 떨어지고, 각자 작아지며 사라진다.
import { v3, quat } from './math.js';

export const G = 600;          // 중력 cm/s² (실제 981보다 살짝 느리게: 떨어지는 걸 보이게)

export function stepRigid(b, sdf, h) {
  b.v[1] -= G * h;
  b.v = v3.mul(b.v, 0.998); b.w = v3.mul(b.w, 0.995);
  b.pos = v3.madd(b.pos, b.v, h);
  b.q = quat.integrate(b.q, b.w, h);
  b.touching = false;
  for (const c of b.contacts) {
    const r = quat.rot(b.q, c.r), p = v3.add(b.pos, r), half = c.half;
    let nrm = null, pen = 0;
    const s = sdf.sample(p);
    if (s < half) { nrm = sdf.normal(p); pen = half - s; }
    if (!nrm) continue;
    if (!b.touching) { b.v = v3.mul(b.v, 0.97); b.w = v3.mul(b.w, 0.9); }   // 닿아 있으면 흔들림을 빨리 죽인다
    b.touching = true;
    b.pos = v3.madd(b.pos, nrm, pen * 0.6);
    const vp = v3.add(b.v, v3.cross(b.w, r)), vn = v3.dot(vp, nrm);
    if (vn >= 0) continue;
    if (-vn > b.impact) b.impact = -vn;                      // 소리용: 이번 프레임 가장 센 충돌
    const rn = v3.cross(r, nrm);
    // 놓여 있는 접촉(느린 충돌)은 튕김 0, 회전 충격도 줄인다: 중력 한 스텝마다 비스듬한 충격이 회전을 계속 넣어 영원히 흔들렸다
    const resting = vn > -15;
    const e = resting ? 0 : 0.25, ang = resting ? 0.25 : 1;
    const jn = -(1 + e) * vn / (1 + ang * v3.dot(rn, rn) / b.k2);
    b.v = v3.madd(b.v, nrm, jn);
    b.w = v3.madd(b.w, rn, ang * jn / b.k2);
    const vp2 = v3.add(b.v, v3.cross(b.w, r));
    const vt = v3.sub(vp2, v3.mul(nrm, v3.dot(vp2, nrm))), tl = v3.len(vt);
    if (tl > 1e-5) {
      const td = v3.mul(vt, 1 / tl), rt = v3.cross(r, td);
      const jt = Math.min(tl / (1 + v3.dot(rt, rt) / b.k2), 0.6 * jn);
      b.v = v3.madd(b.v, td, -jt);
      b.w = v3.madd(b.w, rt, -jt / b.k2);
    }
  }
}

// 잠들기 판정 (dt마다)
export function settle(b, dt) {
  const slow = v3.len(b.v) < 1.5 && v3.len(b.w) < 2.5;
  b.calm = slow && b.touching ? b.calm + dt : b.calm * 0.5;   // 낀 물체의 잔떨림 한 번에 리셋하지 않게
  if (b.calm > 0.35) b.asleep = true;
}
