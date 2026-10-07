// 칼 상태: 끝은 커서 아래 비누 표면에 붙고, 스크롤=깊이, Q/E=기울기, 날 방향=드래그 방향
import { v3 } from './math.js';

export class Knife {
  constructor() {
    this.depth = 0.08;                // cm
    this.tilt = 25 * Math.PI / 180;   // 날 면과 표면 사이 각
    this.visible = false;
    this.cutting = false;
    this.E = [0, 0, 0]; this.n = [0, 1, 0]; this.u = [1, 0, 0]; this.l = [0, 0, 1]; this.f = [-1, 0, 0]; this.m = [0, 1, 0];
    this.speed = 0;
    this.last = null;                 // 깎는 중 직전 표면점
  }
  // 둥근 날끝이 깊이 d만큼 들어갈 때 닿는 폭 (끝 반지름 0.6 cm 원호)
  get width() { return Math.min(1.8, 2 * Math.sqrt(2 * 0.6 * this.depth)); }
  setDepth(d) { this.depth = Math.min(0.6, Math.max(0.02, d)); }
  setTilt(a) { this.tilt = Math.min(60, Math.max(10, a)) * Math.PI / 180; }
  get tiltDeg() { return Math.round(this.tilt * 180 / Math.PI); }

  // 칼 자세 갱신: 표면점 P, 법선 n, 진행 방향 dir(표면 접평면으로 투영)
  pose(P, n, dir, below) {
    let u = v3.sub(dir, v3.mul(n, v3.dot(dir, n)));
    if (v3.len(u) < 1e-4) u = v3.cross(n, [0, 0, 1]);
    u = v3.norm(u);
    this.n = n; this.u = u;
    this.l = v3.norm(v3.cross(n, u));
    const c = Math.cos(this.tilt), s = Math.sin(this.tilt);
    this.f = v3.add(v3.mul(u, -c), v3.mul(n, s));          // 날 면을 따라 뒤·위로 (칩이 타고 오르는 쪽)
    this.m = v3.add(v3.mul(u, s), v3.mul(n, c));           // 날 면의 바깥 법선
    this.E = v3.madd(P, n, below ? -this.depth : 0.02);     // 날끝
  }
}
