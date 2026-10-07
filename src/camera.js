// 비누 둘레를 도는 턴테이블 카메라
import { v3, perspective, lookAt, mul4, invert4 } from './math.js';

export class Camera {
  constructor() {
    this.target = [0, 1.3, 0];
    this.yaw = -0.65; this.pitch = 0.42; this.dist = 15;   // 비스듬히: 윗면과 옆면(두께)이 함께 보이게
    this.fov = 0.6;
    this.aspect = 1;
  }
  get eye() {
    const cp = Math.cos(this.pitch);
    return v3.add(this.target, [Math.sin(this.yaw) * cp * this.dist, Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * cp * this.dist]);
  }
  orbit(dx, dy) {
    this.yaw -= dx * 0.008;
    this.pitch = Math.min(1.45, Math.max(-1.2, this.pitch + dy * 0.008));   // 바닥이 없으니 아래에서도 볼 수 있다
  }
  // 화면 옮기기: 화면 오른쪽·위 방향으로 바라보는 점을 움직인다 (거리에 비례, 비누 근처로 제한)
  pan(dx, dy) {
    const k = this.dist * 0.00092, cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const right = [cy, 0, -sy];
    const up = [-Math.sin(this.pitch) * sy, Math.cos(this.pitch), -Math.sin(this.pitch) * cy];
    const t = this.target;
    for (let a = 0; a < 3; a++) t[a] += (-right[a] * dx + up[a] * dy) * k;
    t[0] = Math.max(-6, Math.min(6, t[0])); t[1] = Math.max(-1, Math.min(5, t[1])); t[2] = Math.max(-5, Math.min(5, t[2]));
  }
  zoom(f) { this.dist = Math.min(30, Math.max(5, this.dist * f)); }
  matrices() {
    const view = lookAt(this.eye, this.target, [0, 1, 0]);
    const proj = perspective(this.fov, this.aspect, 0.1, 200);
    const vp = mul4(proj, view);
    return { view, proj, vp, ivp: invert4(vp), eye: this.eye };
  }
  // 화면 좌표(CSS px) → 광선
  ray(x, y, w, h) {
    const { ivp, eye } = this.matrices();
    const nx = x / w * 2 - 1, ny = 1 - y / h * 2;
    const p = [ivp[0] * nx + ivp[4] * ny + ivp[8] + ivp[12], ivp[1] * nx + ivp[5] * ny + ivp[9] + ivp[13],
      ivp[2] * nx + ivp[6] * ny + ivp[10] + ivp[14]];
    const wv = ivp[3] * nx + ivp[7] * ny + ivp[11] + ivp[15];
    return { ro: eye, rd: v3.norm(v3.sub(v3.mul(p, 1 / wv), eye)) };
  }
}
