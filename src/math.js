// 작은 벡터·행렬 유틸 (배열 [x,y,z], 열 우선 4x4 Float32Array)
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  madd: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
};

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = far / (near - far); m[11] = -1; m[14] = near * far / (near - far);
  return m;  // WebGPU 깊이 0..1
}

export function lookAt(eye, target, up) {
  const z = v3.norm(v3.sub(eye, target)), x = v3.norm(v3.cross(up, z)), y = v3.cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -v3.dot(x, eye); m[13] = -v3.dot(y, eye); m[14] = -v3.dot(z, eye); m[15] = 1;
  return m;
}

export function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

export function invert4(m) {
  const a = m, o = new Float32Array(16);
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const id = 1 / det;
  o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * id; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * id;
  o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * id; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * id;
  o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * id; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * id;
  o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * id; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * id;
  o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * id; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * id;
  o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * id; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * id;
  o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * id; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * id;
  o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * id; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * id;
  return o;
}

// 쿼터니언 [x,y,z,w]
export const quat = {
  mul: (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]],
  rot: (q, v) => {
    const u = [q[0], q[1], q[2]], s = q[3];
    const t = v3.mul(v3.cross(u, v), 2);
    return v3.add(v3.add(v, v3.mul(t, s)), v3.cross(u, t));
  },
  norm: q => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
  // 각속도 w로 dt만큼 적분
  integrate: (q, w, dt) => {
    const dq = quat.mul([w[0] * dt * 0.5, w[1] * dt * 0.5, w[2] * dt * 0.5, 0], q);
    return quat.norm([q[0] + dq[0], q[1] + dq[1], q[2] + dq[2], q[3] + dq[3]]);
  },
};

// 결정적 난수
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}
