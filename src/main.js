import { v3 } from './math.js';
import { SoapSDF } from './sdf.js';
import { Camera } from './camera.js';
import { Knife } from './knife.js';
import { Chips, MIN_AREA } from './chips.js';
import { Renderer } from './render.js';
import { TARGETS, buildTarget, score } from './targets.js';
import { Chunks } from './chunks.js';
import { Sound, SOUND_DEFAULTS } from './sound.js';
import { Water } from './water.js';

const $ = id => document.getElementById(id);
function fail(msg) { $('err').style.display = 'flex'; $('err').textContent = msg; throw new Error(msg); }

if (!navigator.gpu) fail('이 브라우저는 WebGPU를 지원하지 않습니다. Chrome 또는 Safari 최신 버전에서 열어 주세요.');
// GPU가 멈춘 상태면 requestAdapter가 끝나지 않는다 → 빈 화면 대신 안내
const adapter = await Promise.race([navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
  new Promise(r => setTimeout(() => r('timeout'), 8000))]);
if (adapter === 'timeout') fail('GPU가 응답하지 않습니다. 브라우저를 완전히 껐다 켜거나 잠시 후 새로고침해 주세요.');
if (!adapter) fail('WebGPU 어댑터를 찾지 못했습니다.');
const device = await adapter.requestDevice();
const gpuErrors = [];
device.addEventListener('uncapturederror', e => { if (gpuErrors.length < 20) gpuErrors.push(e.error.message); console.error(e.error.message); });
device.lost.then(info => { if (info.reason !== 'destroyed') fail('GPU 연결이 끊겼습니다. 새로고침해 주세요.'); });

const canvas = $('cv');
const ctx = canvas.getContext('webgpu');
const format = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format, alphaMode: 'opaque' });

const sdf = new SoapSDF(device);
const cam = new Camera();
const knife = new Knife();
const chips = new Chips(sdf);
const chunks = new Chunks(sdf, device);
const sound = new Sound();
try { sound.muted = localStorage.getItem('soapcarve.muted') === '1'; } catch { /* 저장소 막힘 */ }
const water = new Water(sdf, device);
const renderer = new Renderer(device, ctx, format, sdf, water);
for (const m of renderer.modules) {
  const info = await m.getCompilationInfo();
  for (const msg of info.messages) if (msg.type === 'error') gpuErrors.push(`${msg.lineNum}: ${msg.message}`);
}
if (gpuErrors.length) fail('셰이더 오류: ' + gpuErrors.join('\n'));

// ── 상태 ──────────────────────────────────────────────────────────────────
const st = {
  cursor: null,            // CSS px
  mode: null,              // 'cut' | 'orbit'
  samples: [],             // 깎는 중 쌓인 커서 위치
  lastSample: null,
  snap: null,              // 이번 획 시작 시점 SDF (커서→표면 찾기는 이걸로: 깎는 중 같은 자리를 계속 파지 않게)
  stroke: 0,
  nS: null, dir: null, lastDir: null,
  undo: [],
  hover: null,
  moved: 0,
  frameVol: 0,             // 이번 프레임에 깎인 부피 (소리 바탕음용)
  frameLen: 0,             // 그 부피를 깎은 칼 이동 거리 (평균 단면적 = frameVol / frameLen)
  tool: 'knife',           // 'knife' 곧은 칼 | 'gouge' U자 끌 | 'slice' 덩어리 자르기 | 'sand' 물 묻히기 (젖은 비누가 녹아 둥글어짐)
  cutDist: 0,              // 이번 획에서 날이 움직인 거리 (파고드는 깊이 조절용)
  brush: 0.35,             // 물 묻히는 범위 반지름 (cm)
  sandFrameVol: 0,
  sliceA: null, sliceB: null, sliceT: 0,
};
const size = () => [canvas.clientWidth, canvas.clientHeight];

function pick(x, y, arr) {
  const [w, h] = size();
  const { ro, rd } = cam.ray(x, y, w, h);
  return sdf.raycast(ro, rd, arr);
}
function defaultDir(n) {
  // 손이 화면 안쪽으로 미는 방향
  const { ro } = cam.ray(...size().map(v => v / 2), ...size());
  const fwd = v3.norm(v3.sub(cam.target, ro));
  const d = v3.sub(fwd, v3.mul(n, v3.dot(fwd, n)));
  return v3.len(d) > 1e-3 ? v3.norm(d) : v3.norm(v3.cross(n, [1, 0, 0]));
}

function beginCut(x, y) {
  const hit = pick(x, y);
  if (!hit) return false;
  st.mode = 'cut';
  st.stroke++;
  st.snap = sdf.snapshot();
  st.undo.push({ d: st.snap, mark: sdf.mark.slice(), cov: sdf.cov.slice(), stroke: st.stroke });
  if (st.undo.length > 6) st.undo.shift();
  st.nS = hit.normal;
  st.cutDist = 0;
  st.dir = st.lastDir || defaultDir(hit.normal);
  knife.cutting = true;
  knife.last = hit;
  knife.pose(hit.point, hit.normal, st.dir, true);
  st.lastSample = [x, y];
  st.samples.length = 0;
  return true;
}

// 획이 끝날 때마다: 끊어져 공중에 뜬 조각은 떨어뜨린다
function afterStroke() {
  if (chunks.dropIslands(st.stroke) > 0) sound.hit(80, true, 0);
  rescore();
}

function endCut() {
  // 칩이 끊긴 자리: 끝이 각진 턱으로 남고, 곧은 칼이면 모서리가 조금 부스러진다
  if (st.tool === 'knife' && knife.last && st.cutDist > 0.3) {
    sdf.crumble(knife.last.point, st.nS, st.dir, knife.width, knife.depth, Math.random);
    chips.crumbs(knife.last.point, st.nS, st.dir, 1 + Math.floor(Math.random() * 3));   // 잔 부스러기 소량
  }
  afterStroke();
  chips.release(knife);
  knife.cutting = false;
  knife.last = null;
  st.mode = null;
  st.snap = null;
  st.lastDir = st.dir;
}

// 깎는 중 커서 표본 처리: 화면에서 3px 간격으로 쪼개 표면점을 찾고 구간마다 깎는다
function processCut(dt) {
  let dist = 0;
  for (const s of st.samples) {
    const [x0, y0] = st.lastSample, steps = Math.max(1, Math.ceil(Math.hypot(s[0] - x0, s[1] - y0) / 3));
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (s[0] - x0) * i / steps, y = y0 + (s[1] - y0) * i / steps;
      const hit = pick(x, y, st.snap);
      if (!hit) { chips.release(knife); knife.last = null; continue; }
      const last = knife.last;
      knife.last = hit;
      if (!last) continue;
      const seg = v3.sub(hit.point, last.point), len = v3.len(seg);
      if (len < 0.004) { knife.last = last; continue; }
      if (len > 0.6) { chips.release(knife); continue; }          // 모서리 너머로 건너뜀
      st.nS = v3.norm(v3.lerp(st.nS, hit.normal, 0.35));
      st.dir = v3.norm(v3.lerp(st.dir, v3.mul(seg, 1 / len), 0.5));
      knife.pose(hit.point, st.nS, st.dir, true);
      // 날 방향은 다듬은 법선으로: 표면점마다 법선이 흔들리면(홈 바닥↔가장자리) 날이 기울어 가는 조각이 남는다
      const n = st.nS;
      // 날이 칼 기울기만큼 비스듬히 파고든다: 깊이 / tan(기울기) 거리 동안 깊이가 0에서 차오른다
      // (25°·0.8 mm면 약 1.7 mm. 시작점에 구덩이가 안 생기고, 획 머리가 기울기대로 경사진다)
      st.cutDist += len;
      const rampLen = Math.max(0.12, knife.depth / Math.tan(knife.tilt));
      const ramp = Math.min(1, st.cutDist / rampLen), dEff = knife.depth * ramp * ramp * (3 - 2 * ramp);
      const vol = dEff > 0.004 ? sdf.carve(last.point, hit.point, n, dEff, knife.width, st.tool === 'gouge' ? 'round' : 'flat') : 0;
      chips.feed(knife, len, vol, knife.width, st.stroke);
      // 소리는 칩과 같은 기준: 이미 판 홈 위 허공을 긁을 땐(부동소수 찌꺼기 1e-10 cm³ 수준) 조용히
      if (vol / len >= MIN_AREA) {
        sound.cut(vol, knife.depth, panOf(hit.point));
        st.frameVol += vol; st.frameLen += len;
      }
      dist += len;
    }
    st.lastSample = s;
  }
  st.samples.length = 0;
  knife.speed = knife.speed * 0.7 + (dist / Math.max(dt, 1e-3)) * 0.3;
}

// 자르기: 화면에 그은 선 + 눈 위치로 평면을 만든다 (화면에선 곧은 선으로 보이는 단면)
function slicePlane() {
  const [w, h] = size();
  const a = cam.ray(...st.sliceA, w, h), b = cam.ray(...st.sliceB, w, h);
  const n = v3.cross(a.rd, b.rd);
  if (v3.len(n) < 1e-6) return null;
  return { n: v3.norm(n), e: a.ro };
}
function updateSlicePreview(force) {
  const now = performance.now();
  if (!force && now - st.sliceT < 60) return;          // 양쪽 부피 계산은 60 ms에 한 번
  st.sliceT = now;
  const pl = Math.hypot(st.sliceB[0] - st.sliceA[0], st.sliceB[1] - st.sliceA[1]) > 8 && slicePlane();
  if (!pl) { renderer.slice = null; return; }
  const [vp, vn] = chunks.sideVolumes(pl.n, pl.e);
  if (Math.min(vp, vn) < 0.02) { renderer.slice = null; return; }
  const n = vn < vp ? v3.mul(pl.n, -1) : pl.n;
  renderer.slice = { n, w: -v3.dot(n, pl.e) };
}
function doSlice() {
  const pl = Math.hypot(st.sliceB[0] - st.sliceA[0], st.sliceB[1] - st.sliceA[1]) > 8 && slicePlane();
  if (!pl) return;
  st.stroke++;
  const entry = { d: sdf.snapshot(), mark: sdf.mark.slice(), cov: sdf.cov.slice(), stroke: st.stroke };
  const vol = chunks.slice(pl.n, pl.e, st.stroke);
  if (vol > 0) {
    st.undo.push(entry); if (st.undo.length > 6) st.undo.shift(); afterStroke();
    sound.slice(vol, ((st.sliceA[0] + st.sliceB[0]) / 2 / size()[0] * 2 - 1) * 0.7);
  }
}
function drawSliceLine() {
  const ln = $('sline');
  if (st.mode !== 'slice') { ln.style.display = 'none'; return; }
  ln.style.display = 'block';
  ln.setAttribute('x1', st.sliceA[0]); ln.setAttribute('y1', st.sliceA[1]);
  ln.setAttribute('x2', st.sliceB[0]); ln.setAttribute('y2', st.sliceB[1]);
}

// 물 묻히기: 커서 아래 표면을 적셔 문지른다 (가만히 누르고 있어도 계속 녹아 둥글어진다)
function beginSand(x, y) {
  const hit = pick(x, y);
  if (!hit) return false;
  st.mode = 'sand';
  st.stroke++;
  st.undo.push({ d: sdf.snapshot(), mark: sdf.mark.slice(), cov: sdf.cov.slice(), stroke: st.stroke });
  if (st.undo.length > 6) st.undo.shift();
  st.lastSample = [x, y];
  st.samples.length = 0;
  return true;
}
function processSand() {
  const pts = st.samples.length ? st.samples : [st.cursor];
  let vol = 0, applied = 0;
  for (const s of pts) {
    const [x0, y0] = st.lastSample, steps = Math.max(1, Math.ceil(Math.hypot(s[0] - x0, s[1] - y0) / 8));
    for (let i = 1; i <= steps && applied < 12; i++) {
      const hit = pick(x0 + (s[0] - x0) * i / steps, y0 + (s[1] - y0) * i / steps);
      if (!hit) continue;
      vol += sdf.sand(hit.point, st.brush, 0.7);
      water.add(hit.point, st.brush, 0.3);
      applied++;
      st.hover = hit;
    }
    st.lastSample = s;
  }
  st.samples.length = 0;
  if (st.hover) sound.sand(vol, panOf(st.hover.point));
  st.sandFrameVol = vol;
}

function updateHover() {
  if (st.mode === 'sand') { knife.visible = false; return; }   // 다듬는 중엔 processSand가 hover를 정한다
  st.hover = null;
  if (st.tool === 'slice') { knife.visible = false; return; }
  if (st.tool === 'sand') {
    knife.visible = false;
    if (st.cursor && st.mode !== 'orbit') st.hover = pick(...st.cursor);
    return;
  }
  if (st.mode === 'cut') { knife.visible = true; return; }
  if (!st.cursor || st.mode === 'orbit') { knife.visible = false; return; }
  const hit = pick(...st.cursor);
  if (!hit) { knife.visible = false; return; }
  st.hover = hit;
  knife.pose(hit.point, hit.normal, st.lastDir || defaultDir(hit.normal), false);
  knife.visible = true;
}

// ── 입력 ──────────────────────────────────────────────────────────────────
const input = {
  // mod: 'orbit'(스페이스) | 'pan'(⌥) — 어떤 도구에서든 시점 조작이 먼저
  down(x, y, mod = null) {
    sound.unlock();
    st.cursor = [x, y];
    if (mod) { st.mode = mod; st.lastSample = [x, y]; }
    else if (st.tool === 'slice') { st.mode = 'slice'; st.sliceA = [x, y]; st.sliceB = [x, y]; }
    else if (st.tool === 'sand') { if (!beginSand(x, y)) { st.mode = 'orbit'; st.lastSample = [x, y]; } }
    else if (!beginCut(x, y)) { st.mode = 'orbit'; st.lastSample = [x, y]; }   // 칼·U자 끌
    hideHint();
  },
  move(x, y) {
    st.cursor = [x, y];
    if (st.mode === 'slice') { st.sliceB = [x, y]; updateSlicePreview(); }
    else if (st.mode === 'cut' || st.mode === 'sand') st.samples.push([x, y]);
    else if (st.mode === 'orbit') { cam.orbit(x - st.lastSample[0], y - st.lastSample[1]); st.lastSample = [x, y]; }
    else if (st.mode === 'pan') { cam.pan(x - st.lastSample[0], y - st.lastSample[1]); st.lastSample = [x, y]; }
  },
  up() {
    if (st.mode === 'cut') { processCut(1 / 60); endCut(); }
    if (st.mode === 'slice') { doSlice(); renderer.slice = null; }
    if (st.mode === 'sand') { processSand(); afterStroke(); }
    st.mode = null;
  },
};
// offsetX는 환경에 따라 배율이 어긋난 값을 줘서(합성 이벤트에서 절반) 직접 계산한다
const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  input.down(...local(e), st.space ? 'orbit' : e.altKey ? 'pan' : null);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 등 */ }
});
canvas.addEventListener('pointermove', e => input.move(...local(e)));
canvas.addEventListener('pointerup', () => input.up());
canvas.addEventListener('pointercancel', () => input.up());
canvas.addEventListener('pointerleave', () => { if (!st.mode) st.cursor = null; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) { if (!gesturing) cam.zoom(Math.exp(e.deltaY * 0.01)); }   // 트랙패드 핀치 (Chrome)
  else if (st.tool === 'slice') cam.orbit(-e.deltaX * 0.6, -e.deltaY * 0.6);   // 자르기 중엔 드래그가 선이라 스크롤로 돌린다
  else if (st.tool === 'sand') st.brush = Math.min(1.0, Math.max(0.12, st.brush * Math.exp(-e.deltaY * 0.004)));   // 물 범위
  else knife.setDepth(knife.depth * Math.exp(-e.deltaY * 0.004));     // 두 손가락 스크롤 = 깊이
  updateHud();
}, { passive: false });
let gScale = 1, gesturing = false;                                    // Safari 핀치: ctrl+휠과 겹치면 두 번 확대되므로 하나만
canvas.addEventListener('gesturestart', e => { e.preventDefault(); gScale = 1; gesturing = true; });
canvas.addEventListener('gesturechange', e => { e.preventDefault(); cam.zoom(gScale / e.scale); gScale = e.scale; });
canvas.addEventListener('gestureend', e => { e.preventDefault(); gesturing = false; });
// 화면 왼쪽·오른쪽 → 소리 좌우 (이어폰 기준)
function panOf(p) { return Math.max(-1, Math.min(1, (carveProject(p)[0] / size()[0] * 2 - 1) * 0.7)); }
function carveProject(p) {
  const { vp } = cam.matrices(), [w, h] = size();
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const ww = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  return [(x / ww * 0.5 + 0.5) * w, (0.5 - y / ww * 0.5) * h];
}
function setMuted(m) {
  sound.setMuted(m);
  try { localStorage.setItem('soapcarve.muted', m ? '1' : '0'); } catch { /* 저장소 막힘 */ }
  $('b_mute').textContent = m ? '소리 꺼짐 (M)' : '소리 켜짐 (M)';
  $('b_mute').classList.toggle('on', !m);
}
$('b_mute').onclick = () => { sound.unlock(); setMuted(!sound.muted); };
setMuted(sound.muted);
// 스페이스를 누르고 있는 동안 드래그 = 돌려 보기 (모든 도구)
window.addEventListener('keyup', e => { if (e.code === 'Space') { st.space = false; canvas.style.cursor = ''; } });
window.addEventListener('blur', () => { st.space = false; });
window.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); st.space = true; canvas.style.cursor = 'grab'; return; }
  sound.unlock();
  if (e.code === 'KeyM') { setMuted(!sound.muted); return; }
  if (e.code === 'KeyQ') knife.setTilt(knife.tiltDeg - 5);
  else if (e.code === 'KeyE') knife.setTilt(knife.tiltDeg + 5);
  else if (e.code === 'KeyZ' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); undo(); }
  else if (e.code === 'KeyC') { chips.clear(); chunks.clear(); }
  else if (e.code === 'Digit1') setTool('knife');
  else if (e.code === 'Digit2') setTool('slice');
  else if (e.code === 'Digit3') setTool('sand');
  else if (e.code === 'Digit4') setTool('gouge');
  else if (e.code === 'KeyG') $('b_guide').click();
  else return;
  updateHud();
});

function undo() {
  if (st.mode === 'cut') return;
  const u = st.undo.pop();
  if (!u) return;
  sdf.restore(u.d, u.mark, u.cov);
  chips.removeStroke(u.stroke);
  chunks.removeStroke(u.stroke);
  water.clear();
  rescore();
}
function newSoap() { if (st.mode === 'cut') endCut(); sdf.reset(); chips.clear(); chunks.clear(); water.clear(); st.undo.length = 0; tgt.done = false; rescore(true); }

// ── 목표 모양 ──────────────────────────────────────────────────────────────
const tgt = { key: '', arr: null, excess0: 0, progress: 0, over: 0, done: false };
function setTarget(key) {
  tgt.key = key;
  tgt.arr = key ? buildTarget(sdf, key) : null;
  sdf.setTarget(tgt.arr);
  renderer.guide = !!key;
  newSoap();                                   // 목표를 고르면 새 비누에서 시작
  document.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === key));
  $('pv').style.display = key ? 'block' : 'none';
  $('pv_name').textContent = key ? '목표: ' + TARGETS[key].name : '';
  $('prog').style.display = key ? 'block' : 'none';
  syncGuide();
  refreshEmbed();
}
// 완성 기준. 예전(진행 90%·너무 깎음 10%)은 물고기 둘레에 3 mm 넘는 투명 테두리가 1.5 cm³ 남은 '덩어리'에서도 완성이 떴다.
// 자동 플레이로 끝까지 깎으면 진행 96%·3 mm 넘는 군살 0.06 cm³·너무 깎음 1.8%까지 간다 (tools/regress/out/strict1).
const DONE = { progress: 0.95, over: 0.05, thick: 0.1 };
function rescore(base = false) {
  if (!tgt.arr) return;
  const s = score(sdf, tgt.arr);
  if (base) tgt.excess0 = s.excess;
  tgt.progress = tgt.excess0 ? 1 - s.excess / tgt.excess0 : 0;
  tgt.over = s.over / Math.max(s.inside, 1);
  tgt.thick = s.thick * sdf.h ** 3;            // cm³
  $('p_val').textContent = Math.round(tgt.progress * 100) + '%';
  $('o_val').textContent = (tgt.over * 100).toFixed(1) + '%';
  $('t_val').textContent = tgt.thick.toFixed(2) + ' cm³';
  $('p_bar').style.width = Math.max(0, tgt.progress * 100) + '%';
  $('o_val').classList.toggle('warn', tgt.over > DONE.over);
  $('t_val').classList.toggle('warn', tgt.thick >= DONE.thick);
  if (base) tgt.hinted = false;
  if (!tgt.done && !tgt.hinted && tgt.progress >= 0.9) {
    tgt.hinted = true;
    toast(`거의 다 됐어요 · 진행 ${DONE.progress * 100}% 이상, 3 mm 넘게 남은 곳 ${DONE.thick} cm³ 미만, 너무 깎음 ${DONE.over * 100}% 미만이면 완성`);
  }
  if (!tgt.done && tgt.progress >= DONE.progress && tgt.over < DONE.over && tgt.thick < DONE.thick) {
    tgt.done = true;
    toast(`${TARGETS[tgt.key].name} 완성! 정확도 ${Math.round((1 - tgt.over) * 100)}% · G로 가이드를 끄고 감상해 보세요`);
  }
}
function syncGuide() { $('b_guide').classList.toggle('on', renderer.guide); $('b_guide').disabled = !tgt.key; }
let toastTimer = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.opacity = 1; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.opacity = 0, 5000); }
document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => setTarget(b.dataset.t));
$('b_guide').onclick = () => { if (tgt.key) { renderer.guide = !renderer.guide; syncGuide(); } };
$('b_new').onclick = newSoap;
$('b_undo').onclick = undo;
$('b_clear').onclick = () => { chips.clear(); chunks.clear(); };
// 비누 종류 — 모두 투명 녹여 붓기(melt & pour) 비누 레퍼런스: 비누 속 박기(embed), 기울인 층, 버블랩 벌집, 마이카 반짝이.
// id는 셰이더의 비누 번호
const LOOKS = [
  { id: 7, name: '모양 품은 비누', base: [0.90, 0.97, 0.98], sw: 'radial-gradient(ellipse 40% 26% at 50% 55%,#ff9e85 0 90%,transparent 100%),linear-gradient(135deg,rgba(225,250,250,.95),rgba(170,220,225,.7))' },
  { id: 1, name: '젤리 층', base: [0.96, 0.78, 0.84], sw: 'linear-gradient(160deg,#f7b9cc 0 25%,#f4f2fb 25% 50%,#a9e8d2 50% 75%,#ffe39a 75%)' },
  { id: 2, name: '꿀 벌집', base: [0.96, 0.66, 0.24], sw: 'radial-gradient(circle at 35% 35%,#ffe0a0,#e8932a)' },
  { id: 6, name: '반짝이', base: [0.97, 0.84, 0.92], sw: 'radial-gradient(circle at 30% 35%,#fff 0 5%,transparent 6%),radial-gradient(circle at 65% 60%,#ffd27a 0 5%,transparent 6%),radial-gradient(circle at 45% 75%,#ffb3dc 0 4%,transparent 5%),linear-gradient(135deg,#f6d6e8,#e7c2dc)' },
];
let lookId = 7;
function setLook(id) {
  const l = LOOKS.find(x => x.id === id) || LOOKS[0];
  lookId = l.id;
  renderer.look = { id: l.id, base: l.base };
  document.querySelectorAll('[data-look]').forEach(b => b.classList.toggle('on', +b.dataset.look === l.id));
  $('look_name').textContent = l.name;
  try { localStorage.setItem('soapcarve.look', String(l.id)); } catch { /* 저장소 막힘 */ }
  refreshEmbed();
}
// '모양 품은 비누'의 속 모양은 목표 모양 텍스처를 쓴다. 자유 조각이면 물고기를 넣어 둔다 (가이드·채점은 꺼진 채)
let fishArr = null;
function refreshEmbed() {
  if (tgt.key) return;                                   // 목표를 골랐으면 그 모양이 이미 올라가 있다
  if (lookId === 7) sdf.setTarget(fishArr || (fishArr = buildTarget(sdf, 'fish')));
  else sdf.setTarget(null);
}
$('looks').innerHTML = LOOKS.map(l => `<button data-look="${l.id}" title="${l.name}" style="background:${l.sw}"></button>`).join('');
document.querySelectorAll('[data-look]').forEach(b => b.onclick = () => setLook(+b.dataset.look));
let savedLook = 7;
try { savedLook = +(localStorage.getItem('soapcarve.look') ?? 7); } catch { /* 저장소 막힘 */ }
setLook(savedLook);

function setTool(t) {
  if (st.mode) return;
  st.tool = t;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('keys_knife').style.display = t === 'knife' || t === 'gouge' ? '' : 'none';
  renderer.knifeShape = t === 'gouge' ? 'round' : 'flat';
  $('keys_slice').style.display = t === 'slice' ? '' : 'none';
  $('keys_sand').style.display = t === 'sand' ? '' : 'none';
  updateHud();
  canvas.style.cursor = t === 'slice' ? 'cell' : 'crosshair';
}
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
function hideHint() { $('hint').style.opacity = 0; }
function updateHud() {
  const sand = st.tool === 'sand';
  $('hud_depth_l').textContent = sand ? '물 범위' : '깊이';
  $('hud_depth').textContent = sand ? (st.brush * 20).toFixed(0) + ' mm' : (knife.depth * 10).toFixed(1) + ' mm';
  $('hud_tilt').textContent = knife.tiltDeg + '°';
}
updateHud();
syncGuide();

// ── 프레임 ────────────────────────────────────────────────────────────────
let lastT = performance.now();
// 해상도 자동 조절: 프레임 간격(지수 평균)이 19 ms를 넘으면 낮추고, 14 ms 아래면 천천히 올린다.
// 처음엔 그리는 화소를 약 160만으로 맞춰 시작 (투명 비누는 화소마다 비누 속을 수십 걸음 지나므로 화소 수가 곧 비용)
let renderScale = 1, frameEma = 16, lastAdapt = 0, scaleInit = false;
function adaptScale(now) {
  const W = canvas.width, H = canvas.height;
  if (!scaleInit) { renderScale = Math.min(1, Math.sqrt(1.6e6 / (W * H))); scaleInit = true; }
  if (now - lastAdapt < 500) return;
  lastAdapt = now;
  if (frameEma > 19) renderScale = Math.max(0.5, renderScale - 0.1);
  else if (frameEma < 14) renderScale = Math.min(1, renderScale + 0.05);
}
const STILL_AFTER = 6;       // 장면이 이만큼(프레임) 안 바뀌면 원래 해상도로 쌓기 시작
let sliverT = 0;             // 허공 부스러기 치우기 간격 (초)
const perf = { frames: 0, ms: 0 };
function frame(dtOverride) {
  const now = performance.now();
  const dt = dtOverride ?? Math.min(0.05, (now - lastT) / 1000);
  // 장면이 몇 프레임째 그대로면 '가만히' → 화면 해상도 그대로 그리며 여러 장을 쌓아 매끈하게 (renderer.n)
  const still = renderer.stillFrames >= STILL_AFTER;
  // 60 ms 넘게 빈 간격은 탭이 숨었거나 멈춘 것 → 해상도 판단에서 뺀다 (안 그러면 돌아왔을 때 화질이 최저로 떨어져 있다)
  // 가만히 쌓는 프레임(원래 해상도라 느릴 수 있다)도 움직일 때의 해상도 판단에서 뺀다
  if (dtOverride === undefined && now - lastT < 60 && !still) frameEma = frameEma * 0.9 + (now - lastT) * 0.1;
  lastT = now;
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  const [cw, ch] = size();
  if (!cw || !ch) return;
  const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  cam.aspect = W / H;
  const t0 = performance.now();
  if (st.mode === 'cut') processCut(dt);
  if (st.mode === 'sand') processSand();
  renderer.ring = st.tool === 'sand' ? st.brush * 2 : 0;
  updateHover();
  chips.step(dt, knife);
  chunks.step(dt);
  for (const ev of chips.events) ev.type === 'off' ? sound.chipOff(panOf(ev.pos)) : sound.hit(ev.v, false, panOf(ev.pos));
  for (const ev of chunks.events) sound.hit(ev.v, true, panOf(ev.pos));
  water.step(dt);
  // 물이 획 사이에도 계속 녹이며 허공에 0.5 mm 부스러기를 남긴다 → 깎는 중이 아닐 때 0.5초마다 바뀐 범위만 치운다
  sliverT += dt;
  if (sliverT > 0.5 && sdf.touched && st.mode !== 'cut' && st.mode !== 'sand' && st.mode !== 'slice') { sliverT = 0; chunks.dropSlivers(); }
  for (const ev of water.events) sound.drip(panOf(ev.pos));
  chips.events.length = 0; chunks.events.length = 0; water.events.length = 0;
  sound.update(st.mode === 'cut' && st.frameVol > 0, knife.speed, st.mode === 'sand', st.frameLen > 0 ? st.frameVol / st.frameLen : 0);
  st.frameVol = 0; st.frameLen = 0;
  drawSliceLine();
  sdf.upload();
  water.upload();
  // 3D 장면 해상도 = 화면 × renderScale (프레임이 느리면 자동으로 낮춘다)
  if (!still) adaptScale(now);
  const sc = still ? 1 : renderScale;
  const SW = Math.max(1, Math.round(W * sc)), SH = Math.max(1, Math.round(H * sc));
  renderer.resize(SW, SH);
  // 미리보기 창 위치는 CSS 상자(#pv_box)를 따른다
  if (tgt.key) {
    const r = $('pv_box').getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    const k = dpr * sc;
    const x = Math.max(0, Math.round((r.left - cr.left) * k)), y = Math.max(0, Math.round((r.top - cr.top) * k));
    renderer.preview = { x, y, w: Math.min(Math.round(r.width * k), SW - x), h: Math.min(Math.round(r.height * k), SH - y) };
  } else renderer.preview = null;
  renderer.draw(cam, knife, chips, chunks, [SW, SH], st.hover);
  perf.frames++; perf.ms += performance.now() - t0;
}
// ?regress / ?playtest: 테스트가 carve.frame()으로 직접 진행한다. 화면 루프까지 돌면 실제 시계로 칼 자세 등이 바뀌어
// 같은 코드라도 실행마다 결과가 달라진다 (Browser pane이 rAF를 돌릴 때 실제로 겪음) → 테스트 중엔 루프에서 그리지 않는다.
const testMode = /[?&](regress|playtest)=/.test(location.search);
(function loop() { if (!testMode) frame(); requestAnimationFrame(loop); })();

// 테스트 훅
window.carve = {
  sdf, chips, chunks, water, setTool, setLook, get renderScale() { return renderScale; }, set renderScale(v) { renderScale = v; scaleInit = true; }, knife, cam, st, gpuErrors, input, frame, undo, newSoap, renderer, tgt, setTarget, rescore,
  // 화면 좌표 점들을 따라 드래그 (프레임마다 한 점)
  async drag(points, { frames = 1 } = {}) {
    input.down(...points[0]); frame(1 / 60);
    for (const p of points.slice(1)) { input.move(...p); for (let i = 0; i < frames; i++) frame(1 / 60); }
    input.up(); frame(1 / 60);
    await device.queue.onSubmittedWorkDone();
  },
  settle(n = 60) { for (let i = 0; i < n; i++) frame(1 / 60); },
  project: carveProject,
  sound,
  perf,
};

// ?regress=<이름>: 고정 장면 회귀 검사 (tools/regress, 배포에는 없다)
const regressLabel = new URLSearchParams(location.search).get('regress');
if (regressLabel) import('../tools/regress/scenes.js').then(m => m.run(window.carve, regressLabel));
const playLabel = new URLSearchParams(location.search).get('playtest');   // 물고기 깎기 자동 플레이 (tools/regress/playtest.js)
if (playLabel) import('../tools/regress/playtest.js').then(m => m.run(window.carve, playLabel));

// ?debug: 소리 다듬기 패널 (귀로 맞춘 값은 '값 복사'로 가져다 SOUND_DEFAULTS에 넣는다)
if (new URLSearchParams(location.search).has('debug')) {
  const R = { master: [0, 1.5, 0.01], burstVol: [0.001, 0.03, 0.0005], grains: [1, 14, 1], burstMs: [5, 120, 1], freq: [800, 8000, 50],
    q: [0.3, 8, 0.1], decayMs: [2, 40, 1], crisp: [0, 1, 0.05], scrape: [0, 0.6, 0.01], width: [0, 1, 0.05], room: [0, 0.6, 0.01] };
  const box = document.createElement('div');
  box.id = 'sndlab';
  box.innerHTML = '<b>소리 다듬기</b>';
  for (const k of Object.keys(SOUND_DEFAULTS)) {
    const [mn, mx, stp] = R[k];
    const row = document.createElement('label');
    row.innerHTML = `<span>${k}</span><input type="range" min="${mn}" max="${mx}" step="${stp}" value="${sound.P[k]}"><i>${sound.P[k]}</i>`;
    row.querySelector('input').oninput = e => { sound.P[k] = +e.target.value; row.querySelector('i').textContent = e.target.value; sound.applyParams(); };
    box.appendChild(row);
  }
  const btn = document.createElement('button');
  btn.textContent = '값 복사';
  btn.onclick = () => navigator.clipboard?.writeText(JSON.stringify(sound.P, null, 2));
  box.appendChild(btn);
  document.body.appendChild(box);
}
