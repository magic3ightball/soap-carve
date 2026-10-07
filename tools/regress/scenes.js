// 고정 장면 회귀 검사: 같은 깎기·물·자르기를 매번 똑같이 재현해 캡처한다.
// 사용: 수신기(recv.py)를 켜고 http://127.0.0.1:8933/?regress=<이름> 을 연다 → out/<이름>/<장면>.png
// 끝나면 document.title이 'regress done N'으로 바뀐다. 비교는 compare.py.
// 장면 그림은 '가만히 있을 때'(여러 장 쌓은 것), cross_top_moving은 '움직이는 중'(반 해상도 + FXAA).
const RECV = 'http://127.0.0.1:8941';

// 장면마다 같은 난수열 (칼끝 부스러짐 등이 Math.random을 쓴다)
function seed(s) { let x = s; Math.random = () => ((x = (x * 16807) % 2147483647) / 2147483647); }

function reset(C, look = 7) {
  C.newSoap(); C.water.clear(); C.chips.clear(); C.chunks.clear();
  C.setLook(look); C.setTool('knife'); C.knife.setDepth(0.08); C.knife.setTilt(25);
  C.st.cursor = null;
}
function drag(C, pts) {
  C.input.down(...pts[0]); C.frame(1 / 60);
  for (const p of pts.slice(1)) { C.input.move(...p); C.frame(1 / 60); }
  C.input.up(); C.frame(1 / 60);
}
function cam(C, yaw, pitch, dist, target) { Object.assign(C.cam, { yaw, pitch, dist }); C.cam.target = target.slice(); }

// 손으로 여러 번 겹쳐 깎은 윗면 (방향·깊이 섞음)
function crossStrokes(C) {
  cam(C, 0.2, 1.35, 12, [0, 3, 0]);
  const R = Math.random;
  for (let k = 0; k < 14; k++) {
    C.knife.setDepth(0.05 + R() * 0.2);
    const a = R() * Math.PI, cx = (R() - 0.5) * 2.5, cz = (R() - 0.5) * 1.6, L = 1 + R() * 2.5, pts = [];
    for (let i = 0; i <= 24; i++) { const t = -L / 2 + L * i / 24; pts.push(C.project([cx + Math.cos(a) * t + 0.08 * Math.sin(i * 0.5), 3.0, cz + Math.sin(a) * t])); }
    drag(C, pts);
  }
}

export const SCENES = {
  // 1) 겹친 칼 자국을 위에서 가까이 (등고선 흰 줄·뿌연 테두리 톱니 확인)
  cross_top(C) { seed(4242); reset(C); crossStrokes(C); C.settle(150); cam(C, 0.2, 1.35, 7, [0, 3, 0]); },
  // 2) 같은 자국을 비스듬히 멀리서 (전체 인상)
  cross_oblique(C) { seed(4242); reset(C); crossStrokes(C); C.settle(150); cam(C, -0.65, 0.42, 13, [0, 1.3, 0]); },
  // 3) 앞면을 자르고 칼 턱 6줄 + 물 (턱의 회청·갈색 띠, 물 얼룩)
  water_ledges(C) {
    seed(12345); reset(C);
    C.chunks.slice([0, 0, 1], [0, 1.5, 0.95], 3); C.chunks.clear();
    cam(C, 0.25, 0.3, 10, [0, 1.4, 0]); C.knife.setDepth(0.1);
    for (let r = 0; r < 6; r++) drag(C, Array.from({ length: 25 }, (_, i) => C.project([-2.4 + 4.8 * i / 24, 0.8 + r * 0.3, 0.95])));
    C.chips.clear(); C.setTool('sand'); C.st.brush = 0.7;
    for (let r = 0; r < 3; r++) drag(C, Array.from({ length: 20 }, (_, i) => C.project([-1.5 + 3 * i / 19, 1.8 + r * 0.35, 0.85])));
    C.settle(150); cam(C, 0.25, 0.3, 6, [0, 1.6, 0.8]);
  },
  // 4) 속 모양을 가로로 자른 단면 (단면 음영)
  embed_slice(C) { seed(7); reset(C); C.chunks.slice([0, 1, 0], [0, 1.6, 0], 3); C.chunks.clear(); C.settle(5); cam(C, -0.5, 1.0, 10, [0, 1.5, 0]); },
  // 5) 옆면을 깊게 여러 줄 (굴절로 속이 비틀리는 정도)
  side_grooves(C) {
    seed(99); reset(C); cam(C, 0.0, 0.25, 11, [0, 1.5, 0]); C.knife.setDepth(0.25);
    for (const y of [2.4, 1.9, 1.4, 0.9]) drag(C, Array.from({ length: 31 }, (_, i) => C.project([-2.6 + 5.2 * i / 30, y, 2.5])));
    C.settle(150); cam(C, 0.15, 0.2, 9, [0, 1.5, 0]);
  },
  // 6) 깎지 않은 비누 (재질 기준선)
  plain(C) { seed(1); reset(C); C.settle(5); cam(C, -0.65, 0.42, 15, [0, 1.3, 0]); },
};

export async function run(C, label) {
  const cv = document.querySelector('canvas');
  // 창 크기와 무관하게 같은 해상도로
  Object.assign(cv.style, { width: '960px', height: '640px', inset: 'auto', left: '0', top: '0' });
  await new Promise(r => setTimeout(r, 300));
  let n = 0;
  const shoot = async name => {
    const url = cv.toDataURL('image/png');                     // 같은 작업 안에서 읽어야 WebGPU 캔버스가 비어 있지 않다
    await fetch(`${RECV}/${label}/${name}`, { method: 'POST', body: url });
    n++;
  };
  // 가만히 있을 때 보이는 그림: 여러 장이 다 쌓일 때까지 (6프레임 대기 + 16장)
  for (const [name, fn] of Object.entries(SCENES)) {
    fn(C);
    C.st.cursor = null; C.st.hover = null; C.renderScale = 1;
    for (let i = 0; i < 26; i++) C.frame(1 / 60);
    await shoot(name);
    if (name === 'cross_top') {
      // 같은 상태로 '움직이는 중' 그림: 반 해상도 한 장 + FXAA (장면을 다시 깎으면 칼 방향 등 남은 상태 때문에 달라진다)
      C.renderer.forceMoving = true; C.renderScale = 0.5;
      C.frame(1 / 60); C.frame(1 / 60);
      await shoot('cross_top_moving');
      C.renderer.forceMoving = false; C.renderScale = 1;
    }
  }
  document.title = `regress done ${n}`;
}
