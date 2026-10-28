// 그리기: 비누·작업대는 SDF 레이마칭(깊이도 기록), 칩·칼은 메시, 칩·칼 그림자는 작업대 평면 투영
import { MAXN, VPN, SLOTS } from './chips.js';
import { perspective, lookAt, mul4, invert4, quat } from './math.js';

const FRAME_WGSL = /* wgsl */`
struct Frame {
  vp: mat4x4f, ivp: mat4x4f, knifeM: mat4x4f,
  eye: vec4f, light: vec4f, gmin: vec4f, gsize: vec4f,
  toolP: vec4f, toolU: vec4f, toolL: vec4f,
  view: vec4f,      // 뷰포트 w, h, 가이드(0/1), 미리보기(0/1)
  vorg: vec4f,      // 뷰포트 원점 x, y, 자르기 미리보기(0/1)
  slice: vec4f,     // 자르기 평면: 떼어 낼 쪽 법선 xyz, w = -dot(n, 평면 위 점)
  look: vec4f,      // 비누 대표색 rgb (칩·덩어리), w = 비누 종류 번호
  jit: vec4f,       // 가만히 있을 때 여러 장을 겹쳐 쌓기 위한 서브픽셀 흔들기 (x, y 픽셀)
};
@group(0) @binding(0) var<uniform> U: Frame;
fn hash3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn noise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y),
             mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
fn fbm(p: vec3f) -> f32 {
  var a = 0.5; var s = 0.0; var q = p;
  for (var i = 0; i < 4; i++) { s += a * noise3(q); q = q * 2.03 + vec3f(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
// 비누 바탕색 (U.look.rgb, 선형)
fn soapColor(p: vec3f) -> vec3f { return U.look.rgb; }
fn toScreen(c: vec3f) -> vec3f { return pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)); }
`;

// 비누 재질 (본체·떨어진 조각·칩이 같이 쓴다): 배경·주변광·불투명 비누 색과 조명
const MATERIAL_WGSL = /* wgsl */`
// 허공 스튜디오 (작업대 없음): 어두운 단색에 아주 약한 위아래 그라데이션 — 비누만 돋보이게
fn bgColor(rd: vec3f) -> vec3f { return mix(vec3f(0.075, 0.075, 0.088), vec3f(0.15, 0.15, 0.168), clamp(rd.y * 0.9 + 0.5, 0.0, 1.0)); }
// 림 라이트: 키 라이트 반대편 뒤쪽 약간 위에서 윤곽을 비춘다
fn rimDir() -> vec3f { return normalize(vec3f(-U.light.x, 0.35, -U.light.z)); }
// 반사·굴절로 비치는 주변: 배경 + 키 라이트·림 라이트의 넓은 소프트박스 (반사광이 생기게)
fn envColor(rd: vec3f) -> vec3f {
  return bgColor(rd) + vec3f(1.0, 0.97, 0.92) * pow(max(dot(rd, U.light.xyz), 0.0), 6.0) * 0.55
                     + vec3f(0.75, 0.82, 1.0) * pow(max(dot(rd, rimDir()), 0.0), 10.0) * 0.3;
}
// 가장자리를 따라 비추는 약한 역광: 배경과 비누를 갈라 놓는다 (빛 쪽을 향한 윤곽일수록 밝게)
fn rimLight(n: vec3f, V: vec3f) -> vec3f {
  let e = pow(1.0 - max(dot(n, V), 0.0), 2.5);
  return vec3f(0.62, 0.70, 0.85) * e * (0.25 + 0.75 * max(dot(n, rimDir()), 0.0)) * 0.55;
}
// ── v2 불투명 비누 ──
// 비누 바깥 상자(sdf.js SOAP)에서 안쪽으로 들어간 깊이(cm). 떨어진 조각·칩은 깎인 면 종류 텍스처가 없어서 이걸로 겉/속을 가른다
fn origDepth(q: vec3f) -> f32 {
  let a = abs(q - vec3f(0.0, 1.5, 0.0)) - vec3f(4.0, 1.5, 2.5) + 0.4;
  return -(length(max(a, vec3f(0.0))) + min(max(a.x, max(a.y, a.z)), 0.0) - 0.4);
}
// 색: 겉면(마른 껍질)은 살짝 어둡고 채도 높게 + 가루 얼룩, 깎인 면(cut = 1)은 하얀 쪽으로 밝게
fn soapAlb(base: vec3f, p: vec3f, cut: f32) -> vec3f {
  let lum = dot(base, vec3f(0.2126, 0.7152, 0.0722));
  let skin = mix(vec3f(lum), base, 1.12) * 0.88 * (0.95 + 0.05 * noise3(p * 22.0)) * (0.96 + 0.04 * fbm(p * 2.5));
  let fresh = mix(base, vec3f(1.0, 0.99, 0.97), 0.16) * 1.03 * (0.985 + 0.015 * noise3(p * 40.0));
  return mix(skin, fresh, cut);
}
// 무광 왁스 조명 (GPU Gems 16장 wrap 조명 + 그림자 경계의 따뜻한 번짐 + 얇은 곳 뒤 빛).
// cut: 깎인 면 정도(넓고 약한 광택 → 은은한 왁스 광택), thin: 얇은 정도(0~1)
fn soapLight(alb: vec3f, n: vec3f, V: vec3f, L: vec3f, sh: f32, ao: f32, cut: f32, thin: f32) -> vec3f {
  let nl = dot(n, L);
  let lam = max(nl, 0.0);
  let wrapT = max((nl + 0.45) / 1.45, 0.0);
  let scatter = alb * alb * vec3f(1.15, 0.95, 0.85);                   // 속에서 번져 나온 빛: 채도 높고 따뜻하게
  let key = vec3f(1.0, 0.96, 0.9);
  var c = alb * key * lam * sh * 0.85 + scatter * key * max(wrapT - lam, 0.0) * mix(0.5, 1.0, sh);
  let sky = mix(vec3f(0.30, 0.28, 0.33), vec3f(0.55, 0.55, 0.60), n.y * 0.5 + 0.5);
  c += alb * sky * 0.4 * ao;
  let ndh = max(dot(n, normalize(L + V)), 0.0);
  c += key * pow(ndh, mix(6.0, 36.0, cut)) * mix(0.035, 0.11, cut) * sh;
  let fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
  c += envColor(reflect(-V, n)) * fres * mix(0.04, 0.10, cut);
  c += scatter * key * thin * 0.35 * (0.35 + 0.65 * max(-nl, 0.0));
  return c;
}
`;
const MARCH_WGSL = FRAME_WGSL + /* wgsl */`
@group(0) @binding(1) var sdfTex: texture_3d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tgtTex: texture_3d<f32>;
@group(0) @binding(4) var wetTex: texture_3d<f32>;
@group(0) @binding(5) var covTex: texture_3d<f32>;   // 뿌연 정도 (깎인 깊이에 비례하는 연속값)

fn uvw(p: vec3f) -> vec3f { return (p - U.gmin.xyz) / U.gsize.xyz; }
fn S(p: vec3f) -> f32 {
  let q = uvw(p);
  var d: f32;
  if (U.view.w > 0.5) { d = textureSampleLevel(tgtTex, smp, q, 0.0).r; }      // 미리보기: 목표 모양을 그린다
  else { d = textureSampleLevel(sdfTex, smp, q, 0.0).r; }
  // 상자 경계에서 들어온 광선은 반올림으로 살짝 밖이 될 수 있다 → 여유를 두고 판정
  // (경계 바로 밖을 '멀다(1.0)'로 보면 광선이 0.95 cm 건너뛰어 비누 속에 꽂히며 점무늬가 됐다)
  let outside = any(q < vec3f(-0.02)) || any(q > vec3f(1.02));
  return select(d, 1.0, outside);
}
${MATERIAL_WGSL}
fn Tm(p: vec3f) -> f32 {
  let q = uvw(p);
  if (any(q < vec3f(0.0)) || any(q > vec3f(1.0))) { return 9.0; }
  return textureSampleLevel(tgtTex, smp, q, 0.0).r;
}
fn N(p: vec3f) -> vec3f {
  let e = U.gmin.w;
  return normalize(vec3f(S(p + vec3f(e, 0, 0)) - S(p - vec3f(e, 0, 0)), S(p + vec3f(0, e, 0)) - S(p - vec3f(0, e, 0)),
                         S(p + vec3f(0, 0, e)) - S(p - vec3f(0, 0, e))));
}
fn boxT(ro: vec3f, rd: vec3f) -> vec2f {
  let lo = U.gmin.xyz; let hi = U.gmin.xyz + U.gsize.xyz;
  let inv = 1.0 / select(rd, vec3f(1e-9), abs(rd) < vec3f(1e-9));
  let a = (lo - ro) * inv; let b = (hi - ro) * inv;
  let t0 = max(max(min(a.x, b.x), min(a.y, b.y)), min(a.z, b.z));
  let t1 = min(min(max(a.x, b.x), max(a.y, b.y)), max(a.z, b.z));
  return vec2f(max(t0, 0.0), t1);
}
fn softShadow(p: vec3f, L: vec3f) -> f32 {
  var res = 1.0; var t = 0.06;
  for (var i = 0; i < 48; i++) {
    let h = S(p + L * t);
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.02, 0.35);
    if (res < 0.02 || t > 9.0) { break; }
  }
  return clamp(res, 0.0, 1.0);
}

struct VOut { @builtin(position) pos: vec4f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VOut; o.pos = vec4f(p[i], 0.0, 1.0); return o;
}
struct FOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };

@fragment fn fsMarch(@builtin(position) fc: vec4f) -> FOut {
  let preview = U.view.w > 0.5;
  let fp = fc.xy + U.jit.xy;
  let ndc = vec2f((fp.x - U.vorg.x) / U.view.x * 2.0 - 1.0, 1.0 - (fp.y - U.vorg.y) / U.view.y * 2.0);
  let far = U.ivp * vec4f(ndc, 1.0, 1.0);
  let ro = U.eye.xyz;
  let rd = normalize(far.xyz / far.w - ro);
  let L = U.light.xyz;
  var out: FOut;
  // 배경
  var col = bgColor(rd);
  if (preview) { col = vec3f(0.11, 0.10, 0.13); }
  var hitP = vec3f(0.0); var hit = 0;
  // 비누
  let bt = boxT(ro, rd);
  if (bt.x < bt.y) {
    var t = bt.x; var bestD = 1e9; var bestT = 0.0;
    for (var i = 0; i < 260; i++) {
      if (t > bt.y) { break; }
      let d = S(ro + rd * t);
      if (d < bestD) { bestD = d; bestT = t; }
      if (d < 0.0012) { t += d; hit = 1; break; }
      t += clamp(d * 0.95, 0.004, 0.3);
    }
    // 모서리를 스치는 광선은 수렴 전에 끝나 검은 점이 됐다 → 충분히 가까웠으면 맞은 걸로
    if (hit == 0 && bestD < 0.012) { t = bestT; hit = 1; }
    if (hit == 1) { hitP = ro + rd * t; }
  }
  if (hit == 1) {
    let p = hitP;
    // 법선 요철(bump)은 넣지 않는다: 깎은 홈 가장자리에서 점무늬가 생겼다. 결은 알베도 얼룩으로만
    var n = N(p);
    let nGeo = n;                                   // 칼 결로 흔들기 전 법선 (림 라이트에 쓴다)
    let tx = textureSampleLevel(sdfTex, smp, uvw(p), 0.0);
    // g = 깎인 면 종류 (1 칼, 0.59 U자 끌·자른 면, 0.47 부스러짐, 0.39 물로 녹음, 0 원래 겉면)
    var kind = tx.g;
    if (preview) { kind = 0.0; }
    // 뿌연 정도: 깎인 깊이에 비례해 저장한 연속값이라 보간만으로 테두리가 매끈하다
    // (예전엔 종류 값을 복셀마다 켜짐/꺼짐으로 보고 다섯 점 평균으로 계단을 흐렸다)
    var frostCov = 0.0;
    if (!preview) { frostCov = textureSampleLevel(covTex, smp, uvw(p), 0.0).r; }
    let cut = smoothstep(0.2, 0.4, kind);
    let grain = smoothstep(0.85, 0.97, kind) * smoothstep(0.0, 0.5, frostCov);   // 얕게 스친 경사 끝은 결도 옅게
    let crumb = (1.0 - smoothstep(0.02, 0.06, abs(kind - 0.47))) * cut;
    // 칼 결: 칼이 지나간 방향을 따라 0.45 mm 간격의 가는 평행선 (멀어서 한 픽셀보다 촘촘해지면 흐리게)
    if (grain > 0.01) {
      let lv = normalize(vec3f(tx.b, sqrt(max(0.0, 1.0 - tx.b * tx.b - tx.a * tx.a)), tx.a));
      let lt = lv - n * dot(lv, n);
      let pix = length(p - ro) * 0.62 / U.view.y;
      let fade = 1.0 - smoothstep(0.012, 0.03, pix);
      let ph = dot(p, lv) * 6.2832 / 0.045 + noise3(p * 9.0) * 2.0;
      n = normalize(n + lt * cos(ph) * 0.035 * grain * fade);
    }
    // 부스러진 곳: 거칠고 탁하게
    if (crumb > 0.01) { n = normalize(n + (vec3f(noise3(p * 60.0), noise3(p * 60.0 + 5.0), noise3(p * 60.0 + 9.0)) - 0.5) * 0.5 * crumb); }
    let V = -rd;
    // 그림자 광선은 빛 방향으로 떼고 시작 (반정밀도 SDF라 가까이서 시작하면 점무늬가 생긴다).
    // 법선 방향으로 크게 떼면 홈 가장자리에서 시작점이 홈 위로 넘어가 가장자리에 스스로 가려졌다.
    let ndl = dot(n, L);
    var sh = 0.0;
    if (ndl > -0.35) { sh = softShadow(p + n * 0.015 + L * 0.12, L); }
    var ao = 0.0;
    for (var k = 1; k <= 4; k++) { let hk = f32(k) * 0.08; ao += (hk - S(p + n * hk)) / hk; }
    ao = clamp(1.0 - ao * 0.22, 0.0, 1.0);
    // v2 불투명 비누: 겉면은 무광·살짝 어둡게, 깎인 면은 밝게 + 은은한 왁스 광택 (부스러진 곳은 광택 없이)
    let speck = 0.97 + 0.03 * step(0.985, hash3(floor(p * 40.0)));
    var alb = soapAlb(soapColor(p), p, cut) * speck * (1.0 - crumb * 0.12);
    let fresh = cut * (1.0 - crumb);
    // 젖은 곳: 조금 진하고 번들거린다 (날카로운 하이라이트 + 하늘 반사)
    var wet = 0.0;
    if (!preview) { wet = smoothstep(0.02, 0.35, textureSampleLevel(wetTex, smp, uvw(p), 0.0).r); }
    alb = mix(alb, alb * vec3f(0.80, 0.77, 0.84), wet);
    // 얇은 곳은 빛이 비친다 (안쪽 깊이로 근사)
    let inner = -S(p - n * 0.35);
    let thin = 1.0 - smoothstep(0.0, 0.3, inner);
    col = soapLight(alb, n, V, L, sh, ao, fresh, thin);
    // 거친 깎은 면(칼·끌·부스러짐)의 물기는 날카로운 점 반짝임 대신 퍼진 광택으로 (요철 법선에서 흰 점이 튀었다)
    let Hh = normalize(L + V);
    let roughW = smoothstep(0.42, 0.46, kind);
    col += wet * pow(max(dot(n, Hh), 0.0), mix(160.0, 50.0, roughW)) * mix(1.1, 0.45, roughW) * max(sh, 0.3);
    let fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
    col += wet * (0.10 + fres * 0.45) * mix(vec3f(0.35, 0.34, 0.38), vec3f(0.85, 0.86, 0.9), smoothstep(-0.2, 0.8, reflect(-V, n).y));
    if (!preview) {
      // 덩어리감: 깎인 홈 안쪽(오목한 곳)은 조금 어둡게(AO, 비누에만), 윤곽은 림 라이트로 배경과 떼어 낸다
      col *= mix(0.68, 1.0, ao);
      col += rimLight(nGeo, V);
    }
    // 목표 모양 가이드: 남은 군살은 주황 + 2 mm 등고선, 목표면 근처는 초록, 너무 깎은 곳은 빨강
    if (U.view.z > 0.5 && !preview) {
      let td = textureSampleLevel(tgtTex, smp, uvw(p), 0.0).r;
      let near = 1.0 - smoothstep(0.05, 0.11, abs(td));
      let over = smoothstep(0.06, 0.14, -td);
      let excess = smoothstep(0.08, 0.9, td);
      let band = abs(fract(td / 0.2 + 0.5) - 0.5) * 0.2;                 // 가장 가까운 등고선까지(cm)
      let lines = (1.0 - smoothstep(0.004, 0.012, band)) * step(0.12, td);
      col = mix(col, col * vec3f(1.12, 0.86, 0.72), excess * 0.65);
      col = mix(col, vec3f(0.50, 0.80, 0.55), near * 0.5);
      col = mix(col, vec3f(0.92, 0.32, 0.30), over * 0.65);
      col *= 1.0 - lines * 0.22;
    }
    // 자르기 미리보기: 떼어 낼 쪽을 붉게, 자르는 선은 밝게
    if (U.vorg.z > 0.5 && !preview) {
      let sd = dot(p, U.slice.xyz) + U.slice.w;
      col = mix(col, col * vec3f(1.25, 0.55, 0.55), step(0.0, sd) * 0.7);
      col = mix(col, vec3f(1.0, 0.95, 0.85), 1.0 - smoothstep(0.01, 0.035, abs(sd)));
    }
    // 칼끝 미리보기 선
    if (U.toolU.w > 0.5 && !preview) {
      let q = p - U.toolP.xyz;
      let along = abs(dot(q, U.toolU.xyz)); let lat = abs(dot(q, U.toolL.xyz));
      var line = (1.0 - smoothstep(0.012, 0.03, along)) * (1.0 - smoothstep(U.toolP.w * 0.5 - 0.02, U.toolP.w * 0.5, lat));
      if (U.toolU.w > 1.5) { line = 0.0; }                        // 다듬기 붓: 동그라미만
      let ring = (1.0 - smoothstep(0.0, 0.025, abs(length(q) - U.toolP.w * 0.5))) * select(0.5, 1.1, U.toolU.w > 1.5);
      col = mix(col, vec3f(1.0, 0.55, 0.35), clamp(line * 0.85 + ring * 0.6, 0.0, 1.0));
    }
  }
  // 비네트
  var vig = 1.0 - 0.25 * dot(ndc * 0.7, ndc * 0.7);
  if (preview) { vig = 1.0; }
  out.color = vec4f(toScreen(col * vig), 1.0);
  if (hit > 0) { let c = U.vp * vec4f(hitP, 1.0); out.depth = clamp(c.z / c.w, 0.0, 0.9999); }
  else { out.depth = 0.99999; }
  return out;
}
`;

// 떨어진 조각: 조각을 감싼 상자를 그리고, 그 안에서 조각 자기 거리장을 레이마칭한다 (본체와 같은 투명 재질).
// 계산은 '원래 좌표'(잘려 나오기 전 비누 속 위치)에서 한다 → 무늬가 잘린 자리 그대로 이어진다.
const CHUNK_WGSL = FRAME_WGSL + /* wgsl */`
struct ChunkU {
  m: mat4x4f,       // 원래 좌표 → 현재 월드
  inv: mat4x4f,     // 현재 월드 → 원래 좌표
  tmin: vec4f,      // 텍스처 상자 시작 (원래 좌표), w = 칸 크기
  tsize: vec4f,     // 텍스처 상자 크기
};
@group(1) @binding(0) var<uniform> K: ChunkU;
@group(1) @binding(1) var ctex: texture_3d<f32>;
@group(1) @binding(2) var csmp: sampler;
${MATERIAL_WGSL}
fn Sc(p: vec3f) -> f32 {
  let q = (p - K.tmin.xyz) / K.tsize.xyz;
  let d = textureSampleLevel(ctex, csmp, q, 0.0).r;
  return select(d, 1.0, any(q < vec3f(-0.02)) || any(q > vec3f(1.02)));
}
fn Nc(p: vec3f) -> vec3f {
  let e = K.tmin.w;
  return normalize(vec3f(Sc(p + vec3f(e, 0, 0)) - Sc(p - vec3f(e, 0, 0)), Sc(p + vec3f(0, e, 0)) - Sc(p - vec3f(0, e, 0)),
                         Sc(p + vec3f(0, 0, e)) - Sc(p - vec3f(0, 0, e))));
}
@group(1) @binding(3) var ttex: texture_3d<f32>;
fn Tc(p: vec3f) -> f32 {        // 목표 모양 (원래 좌표 = 비누 격자 좌표)
  let q = (p - U.gmin.xyz) / U.gsize.xyz;
  if (any(q < vec3f(0.0)) || any(q > vec3f(1.0))) { return 9.0; }
  return textureSampleLevel(ttex, csmp, q, 0.0).r;
}

struct BOut { @builtin(position) pos: vec4f, @location(0) op: vec3f };
@vertex fn vsChunk(@builtin(vertex_index) vi: u32) -> BOut {
  // 상자 36개 꼭짓점 (뒷면만 그린다: 카메라가 상자 안에 있어도 보이게)
  var f = array<vec3f, 8>(vec3f(0, 0, 0), vec3f(1, 0, 0), vec3f(1, 1, 0), vec3f(0, 1, 0), vec3f(0, 0, 1), vec3f(1, 0, 1), vec3f(1, 1, 1), vec3f(0, 1, 1));
  var idx = array<u32, 36>(0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5);
  let op = K.tmin.xyz + f[idx[vi]] * K.tsize.xyz;
  var o: BOut; o.pos = U.vp * (K.m * vec4f(op, 1.0)); o.op = op; return o;
}
struct COut2 { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };
@fragment fn fsChunk(i: BOut) -> COut2 {
  let ro = (K.inv * vec4f(U.eye.xyz, 1.0)).xyz;
  let rd = normalize(i.op - ro);
  // 상자 들어가는 지점부터 행진
  let lo = K.tmin.xyz; let hi = K.tmin.xyz + K.tsize.xyz;
  let inv = 1.0 / select(rd, vec3f(1e-9), abs(rd) < vec3f(1e-9));
  let a = (lo - ro) * inv; let b = (hi - ro) * inv;
  let t1 = min(min(max(a.x, b.x), max(a.y, b.y)), max(a.z, b.z));
  var t = max(max(max(min(a.x, b.x), min(a.y, b.y)), min(a.z, b.z)), 0.0);
  var hit = false;
  for (var k = 0; k < 200; k++) {
    if (t > t1) { break; }
    let d = Sc(ro + rd * t);
    if (d < 0.0012) { t += d; hit = true; break; }
    t += clamp(d * 0.95, 0.004, 0.3);
  }
  if (!hit) { discard; }
  let p = ro + rd * t;
  let n = Nc(p);
  let L = normalize((K.inv * vec4f(U.light.xyz, 0.0)).xyz);
  let V = -rd;
  let Hh = normalize(L + V);
  // 불투명 비누: 원래 비누 겉면 근처(0.3 mm 안)만 껍질 색, 나머지(잘린 면·속)는 밝은 깎인 면 색
  let cutC = smoothstep(0.015, 0.04, origDepth(p));
  var col = soapLight(soapAlb(U.look.rgb, p, cutC), n, V, L, 1.0, 1.0, cutC, 0.0);
  col += rimLight(normalize((K.m * vec4f(n, 0.0)).xyz), normalize((K.m * vec4f(V, 0.0)).xyz));
  var o: COut2;
  o.color = vec4f(toScreen(col), 1.0);
  let c = U.vp * (K.m * vec4f(p, 1.0));
  o.depth = clamp(c.z / c.w, 0.0, 0.9999);
  return o;
}
`;

const MESH_WGSL = FRAME_WGSL + /* wgsl */`
@group(0) @binding(1) var tgtM: texture_3d<f32>;
@group(0) @binding(2) var smpM: sampler;
${MATERIAL_WGSL}
struct CIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) th: f32, @location(3) shade: f32, @location(4) orig: vec3f };
struct COut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) th: f32, @location(3) shade: f32, @location(4) orig: vec3f };
@vertex fn vsChip(i: CIn) -> COut {
  var o: COut; o.pos = U.vp * vec4f(i.pos, 1.0); o.wp = i.pos; o.n = i.nrm; o.th = i.th; o.shade = i.shade; o.orig = i.orig; return o;
}
// 칩 = 비누를 얇게 깎은 리본: 불투명 비누의 깎인 면 색, 얇을수록 뒤에서 빛이 비친다
@fragment fn fsChip(i: COut) -> @location(0) vec4f {
  let V = normalize(U.eye.xyz - i.wp);
  var n = normalize(i.n);
  if (dot(n, V) < 0.0) { n = -n; }
  let alb = soapAlb(U.look.rgb, i.orig, 1.0) * i.shade;
  let c = soapLight(alb, n, V, U.light.xyz, 1.0, 1.0, 1.0, exp(-i.th / 0.03));
  return vec4f(toScreen(c), 1.0);
}

struct KIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) mat: f32 };
struct KOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) lp: vec3f, @location(3) mat: f32 };
@vertex fn vsKnife(i: KIn) -> KOut {
  var o: KOut;
  let w = U.knifeM * vec4f(i.pos, 1.0);
  o.pos = U.vp * w; o.wp = w.xyz; o.n = (U.knifeM * vec4f(i.nrm, 0.0)).xyz; o.lp = i.pos; o.mat = i.mat; return o;
}
@fragment fn fsKnife(i: KOut) -> @location(0) vec4f {
  let V = normalize(U.eye.xyz - i.wp);
  var n = normalize(i.n);
  if (dot(n, V) < 0.0) { n = -n; }
  let L = U.light.xyz;
  var c: vec3f;
  if (i.mat < 0.5) {
    // 강철: 하늘 반사 + 하이라이트
    let r = reflect(-V, n);
    let env = mix(vec3f(0.16, 0.16, 0.18), vec3f(0.85, 0.86, 0.9), smoothstep(-0.3, 0.7, r.y));
    let spec = pow(max(dot(r, L), 0.0), 60.0);
    c = env * 0.75 + vec3f(spec) + vec3f(0.06);
  } else {
    let g = noise3(vec3f(i.lp.x * 3.0, i.lp.y * 0.6, i.lp.z * 3.0)) * 0.5 + noise3(i.lp * vec3f(20.0, 1.5, 20.0)) * 0.5;
    let wood = mix(vec3f(0.30, 0.18, 0.10), vec3f(0.48, 0.30, 0.17), g);
    let wrap = max((dot(n, L) + 0.3) / 1.3, 0.0);
    c = wood * (wrap * 0.9 + 0.3) + pow(max(dot(n, normalize(L + V)), 0.0), 30.0) * 0.12;
  }
  return vec4f(toScreen(c), U.toolL.w);              // 겨누는 중엔 반투명, 깎을 땐 불투명
}

`;

export class Renderer {
  constructor(device, ctx, format, sdf, water) {
    this.device = device; this.ctx = ctx; this.format = format; this.sdf = sdf; this.water = water;
    this.ubuf = device.createBuffer({ size: 64 * 3 + 16 * 12, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pbuf = device.createBuffer({ size: 64 * 3 + 16 * 12, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // 미리보기용
    this.look = { id: 0, base: [0.86, 0.80, 0.92] };
    this.slice = null;            // { n, w } 자르기 미리보기 평면
    const march = device.createShaderModule({ code: MARCH_WGSL });
    const mesh = device.createShaderModule({ code: MESH_WGSL });
    this.modules = [march, mesh];
    const depth = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' };
    this.marchPipe = device.createRenderPipeline({ layout: 'auto',
      vertex: { module: march, entryPoint: 'vsFull' },
      fragment: { module: march, entryPoint: 'fsMarch', targets: [{ format }] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' } });
    const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const marchBG = buf => device.createBindGroup({ layout: this.marchPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: buf } }, { binding: 1, resource: sdf.tex.createView() },
      { binding: 2, resource: smp }, { binding: 3, resource: sdf.tgtTex.createView() },
      { binding: 4, resource: water.tex.createView() }, { binding: 5, resource: sdf.covTex.createView() }] });
    this.marchBG = marchBG(this.ubuf);
    this.previewBG = marchBG(this.pbuf);
    this.guide = false;
    this.ring = 0;                // 다듬기 붓 지름 (0이면 칼 미리보기)
    this.preview = null;          // { x, y, w, h } (장치 픽셀) 또는 null

    const chipLayout = { arrayStride: 44, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32' }, { shaderLocation: 3, offset: 28, format: 'float32' },
      { shaderLocation: 4, offset: 32, format: 'float32x3' }] };
    const knifeLayout = { arrayStride: 28, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32' }] };
    const meshBGL = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },    // 목표 모양 (칩 색)
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    const meshLayout = device.createPipelineLayout({ bindGroupLayouts: [meshBGL] });
    this.meshBG = device.createBindGroup({ layout: meshBGL, entries: [{ binding: 0, resource: { buffer: this.ubuf } },
      { binding: 1, resource: sdf.tgtTex.createView() }, { binding: 2, resource: smp }] });
    const mk = (vs, fs, layout, extra = {}) => device.createRenderPipeline({ layout: meshLayout,
      vertex: { module: mesh, entryPoint: vs, buffers: [layout] },
      fragment: { module: mesh, entryPoint: fs, targets: [{ format, ...(extra.blend ? { blend: extra.blend } : {}) }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: extra.depth || depth });
    // 칩은 불투명 비누: 깊이를 쓰며 그린다
    this.chipPipe = mk('vsChip', 'fsChip', chipLayout);
    // 떨어진 조각: 상자 뒷면을 그려 그 안을 레이마칭 (group 1 = 조각 uniform·거리장 텍스처)
    const chunkMod = device.createShaderModule({ code: CHUNK_WGSL });
    this.modules.push(chunkMod);
    this.chunkBGL = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } }] });
    const chunkLayout = device.createPipelineLayout({ bindGroupLayouts: [meshBGL, this.chunkBGL] });
    this.chunkPipe = device.createRenderPipeline({ layout: chunkLayout,
      vertex: { module: chunkMod, entryPoint: 'vsChunk' },
      fragment: { module: chunkMod, entryPoint: 'fsChunk', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'front' },
      depthStencil: depth });
    this.smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.cu = new Float32Array(16 * 2 + 4 * 3);
    this.knifePipe = mk('vsKnife', 'fsKnife', knifeLayout, { blend: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } });

    // 칩 정점 버퍼 (슬롯마다 MAXN×VPN 정점) + 공용 인덱스 패턴
    this.chipVB = device.createBuffer({ size: SLOTS * MAXN * VPN * 44, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const idx = new Uint16Array((MAXN - 1) * 24);
    let o = 0;
    for (let k = 0; k < MAXN - 1; k++) for (let f = 0; f < 4; f++) {
      const a0 = k * VPN + 2 * f, a1 = a0 + 1, b0 = a0 + VPN, b1 = b0 + 1;
      idx.set([a0, a1, b1, a0, b1, b0], o); o += 6;
    }
    this.chipIB = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.chipIB, 0, idx);

    // 칼 모양 두 가지: 곧은 날(칼) / 둥근 날끝(U자 끌)
    this.knives = {};
    for (const shape of ['flat', 'round']) {
      const km = knifeMesh(shape === 'round');
      const vb = device.createBuffer({ size: km.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(vb, 0, km);
      this.knives[shape] = { vb, count: km.length / 7 };
    }
    this.knifeShape = 'flat';
    this.depthTex = null;
    // 3D 장면은 줄인 해상도의 텍스처에 그리고 화면으로 늘려 붙인다 (느린 기기에서 자동으로 해상도를 낮추기 위해)
    // 화면으로 늘려 붙이면서, 움직이는 중(쌓인 장 수가 적을 때)엔 FXAA로 모서리 계단을 누그러뜨린다
    // (FXAA 3.11 '품질 낮음' 계열을 줄인 것: 밝기 대비가 큰 곳만 가장자리 방향을 따라 섞는다)
    const blitMod = device.createShaderModule({ code: /* wgsl */`
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var s: sampler;
      @group(0) @binding(2) var<uniform> P: vec4f;     // xy = 원본 텍셀 크기, z = FXAA 세기(0..1)
      struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f };
      @vertex fn vs(@builtin(vertex_index) i: u32) -> O {
        var q = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        var o: O; o.p = vec4f(q[i], 0.0, 1.0); o.uv = vec2f(q[i].x * 0.5 + 0.5, 0.5 - q[i].y * 0.5); return o;
      }
      fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
      @fragment fn fs(i: O) -> @location(0) vec4f {
        let base = textureSampleLevel(src, s, i.uv, 0.0);
        if (P.z <= 0.0) { return base; }
        let t = P.xy;
        let lN = lum(textureSampleLevel(src, s, i.uv + vec2f(0.0, -t.y), 0.0).rgb);
        let lS = lum(textureSampleLevel(src, s, i.uv + vec2f(0.0, t.y), 0.0).rgb);
        let lW = lum(textureSampleLevel(src, s, i.uv + vec2f(-t.x, 0.0), 0.0).rgb);
        let lE = lum(textureSampleLevel(src, s, i.uv + vec2f(t.x, 0.0), 0.0).rgb);
        let lM = lum(base.rgb);
        let lMin = min(lM, min(min(lN, lS), min(lW, lE)));
        let lMax = max(lM, max(max(lN, lS), max(lW, lE)));
        let range = lMax - lMin;
        if (range < max(0.0312, lMax * 0.125)) { return base; }
        let lNW = lum(textureSampleLevel(src, s, i.uv + vec2f(-t.x, -t.y), 0.0).rgb);
        let lNE = lum(textureSampleLevel(src, s, i.uv + vec2f(t.x, -t.y), 0.0).rgb);
        let lSW = lum(textureSampleLevel(src, s, i.uv + vec2f(-t.x, t.y), 0.0).rgb);
        let lSE = lum(textureSampleLevel(src, s, i.uv + vec2f(t.x, t.y), 0.0).rgb);
        var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
        let red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
        let k = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
        dir = clamp(dir * k, vec2f(-8.0), vec2f(8.0)) * t;
        let a = 0.5 * (textureSampleLevel(src, s, i.uv + dir * (1.0 / 3.0 - 0.5), 0.0).rgb + textureSampleLevel(src, s, i.uv + dir * (2.0 / 3.0 - 0.5), 0.0).rgb);
        let b = a * 0.5 + 0.25 * (textureSampleLevel(src, s, i.uv - dir * 0.5, 0.0).rgb + textureSampleLevel(src, s, i.uv + dir * 0.5, 0.0).rgb);
        let lb = lum(b);
        let aa = select(b, a, lb < lMin || lb > lMax);
        return vec4f(mix(base.rgb, aa, P.z), 1.0);
      }` });
    this.blitPipe = device.createRenderPipeline({ layout: 'auto',
      vertex: { module: blitMod, entryPoint: 'vs' }, fragment: { module: blitMod, entryPoint: 'fs', targets: [{ format }] } });
    this.u = new Float32Array(64 * 3 / 4 + 4 * 12);
    this.pu = new Float32Array(64 * 3 / 4 + 4 * 12);
    // 가만히 있으면 서브픽셀만큼 흔들어 그린 비누를 최대 ACC_MAX장 평균 (모서리 계단이 사라지고, 다 쌓이면 비누는 더 안 그린다).
    // 움직이는 동안은 한 장 + FXAA. n = 쌓인 장 수, stillFrames = 장면이 안 바뀐 연속 프레임 수
    this.n = 0; this.stillFrames = 0; this.prevKey = new Float32Array(this.u.length); this.prevVer = '';
    this.forceMoving = false;     // 테스트용: 늘 움직이는 중으로
    this.fxaaOff = false;         // 테스트용: FXAA 끄기 (전후 비교)
    this.cur = 0;
    const rgba16 = 'rgba16float';
    const fsq = /* wgsl */`
      struct O { @builtin(position) p: vec4f };
      @vertex fn vs(@builtin(vertex_index) i: u32) -> O {
        var q = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        var o: O; o.p = vec4f(q[i], 0.0, 1.0); return o;
      }`;
    const accMod = device.createShaderModule({ code: fsq + /* wgsl */`
      @group(0) @binding(0) var cur: texture_2d<f32>;
      @group(0) @binding(1) var prev: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> w: vec4f;     // x = 새 장의 무게 1/(n+1)
      @fragment fn fs(i: O) -> @location(0) vec4f {
        let c = vec2i(i.p.xy);
        return mix(textureLoad(prev, c, 0), textureLoad(cur, c, 0), w.x);
      }` });
    this.accPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: accMod, entryPoint: 'vs' },
      fragment: { module: accMod, entryPoint: 'fs', targets: [{ format: rgba16 }] } });
    const copyMod = device.createShaderModule({ code: fsq + /* wgsl */`
      @group(0) @binding(0) var src: texture_2d<f32>;
      @fragment fn fs(i: O) -> @location(0) vec4f { return textureLoad(src, vec2i(i.p.xy), 0); }` });
    this.copyPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: copyMod, entryPoint: 'vs' },
      fragment: { module: copyMod, entryPoint: 'fs', targets: [{ format }] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' } });
    this.abuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bbuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  resize(w, h) {
    if (this.depthTex && this.depthTex.width === w && this.depthTex.height === h) return;
    for (const t of [this.depthTex, this.marchDepth, this.sceneTex, this.marchTex, ...(this.accTex || [])]) t?.destroy();
    const dev = this.device, RT = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    this.marchDepth = dev.createTexture({ size: [w, h], format: 'depth32float', usage: RT | GPUTextureUsage.COPY_SRC });   // 비누 깊이 (쌓는 동안만 새로 씀)
    this.depthTex = dev.createTexture({ size: [w, h], format: 'depth32float', usage: RT | GPUTextureUsage.COPY_DST });     // 매 프레임 = 비누 깊이 복사 + 칩·칼·덩어리
    this.sceneTex = dev.createTexture({ size: [w, h], format: this.format, usage: RT | TB });
    this.marchTex = dev.createTexture({ size: [w, h], format: this.format, usage: RT | TB });   // 이번 장 (비누·배경만)
    this.accTex = [0, 1].map(() => dev.createTexture({ size: [w, h], format: 'rgba16float', usage: RT | TB }));  // 쌓은 평균 (번갈아 씀)
    this.accBG = [0, 1].map(p => dev.createBindGroup({ layout: this.accPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.marchTex.createView() }, { binding: 1, resource: this.accTex[p].createView() },
      { binding: 2, resource: { buffer: this.abuf } }] }));
    this.copyBG = [0, 1].map(p => dev.createBindGroup({ layout: this.copyPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.accTex[p].createView() }] }));
    this.blitBG = dev.createBindGroup({ layout: this.blitPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.sceneTex.createView() }, { binding: 1, resource: this.smp }, { binding: 2, resource: { buffer: this.bbuf } }] });
    this.size = [w, h];
    this.n = 0;
  }

  // 조각 uniform: 원래 좌표 → 월드 = T(pos)·R(q)·S·T(-com), 역행렬은 그 반대
  writeChunk(b) {
    const s = b.scale, c = b.com, p = b.pos;
    const R = [quat.rot(b.q, [1, 0, 0]), quat.rot(b.q, [0, 1, 0]), quat.rot(b.q, [0, 0, 1])];   // 열 벡터
    const u = this.cu;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) u[j * 4 + i] = R[j][i] * s;
    for (let i = 0; i < 3; i++) u[12 + i] = p[i] - (R[0][i] * c[0] + R[1][i] * c[1] + R[2][i] * c[2]) * s;
    u[3] = u[7] = u[11] = 0; u[15] = 1;
    // 역: 원래 = com + Rᵀ(월드 - pos)/s
    const is = 1 / Math.max(s, 1e-4);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) u[16 + j * 4 + i] = R[i][j] * is;
    for (let i = 0; i < 3; i++) u[28 + i] = c[i] - (R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]) * is;
    u[19] = u[23] = u[27] = 0; u[31] = 1;
    u.set([...b.tmin, this.sdf.h], 32);
    u.set([...b.tsize, 0], 36);
    this.device.queue.writeBuffer(b.ubuf, 0, u);
    if (!b.bg) b.bg = this.device.createBindGroup({ layout: this.chunkBGL, entries: [
      { binding: 0, resource: { buffer: b.ubuf } }, { binding: 1, resource: b.tex.createView() },
      { binding: 2, resource: this.smp }, { binding: 3, resource: this.sdf.tgtTex.createView() }] });
  }

  draw(cam, knife, chips, chunks, size, hover) {
    const { device } = this;
    for (const [slot, data] of chips.uploads) device.queue.writeBuffer(this.chipVB, slot * MAXN * VPN * 44, data);
    chips.uploads.length = 0;
    const m = cam.matrices(), u = this.u, sdf = this.sdf;
    u.set(m.vp, 0); u.set(m.ivp, 16);
    const k = knife;
    u.set([k.l[0], k.l[1], k.l[2], 0, k.f[0], k.f[1], k.f[2], 0, k.m[0], k.m[1], k.m[2], 0, k.E[0], k.E[1], k.E[2], 1], 32);
    const L = normLight;
    u.set([...m.eye, performance.now() / 1000], 48);
    u.set([...L, 0], 52);
    u.set([...sdf.min, sdf.h], 56);
    u.set([sdf.dims[0] * sdf.h, sdf.dims[1] * sdf.h, sdf.dims[2] * sdf.h, 0], 60);
    // 다듬기 붓이면 동그라미(지름 this.ring)만, 칼이면 날 폭 선+동그라미
    const showTool = this.ring ? (hover ? 2 : 0) : (hover && !k.cutting ? 1 : 0);
    u.set([...(hover ? hover.point : [0, 0, 0]), this.ring || k.width], 64);
    u.set([...k.u, showTool], 68);
    u.set([...k.l, k.cutting ? 1 : 0.45], 72);
    u.set([size[0], size[1], this.guide ? 1 : 0, 0], 76);
    const sl = this.slice;
    u.set([0, 0, sl ? 1 : 0, 0], 80);
    u.set(sl ? [...sl.n, sl.w] : [0, 0, 0, 0], 84);
    u.set([...this.look.base, this.look.id], 88);
    // 장면이 그대로인가: 비누를 그리는 데 쓰는 값(카메라·도구 표시·자르기·종류 …) + 비누·물 텍스처 판.
    // 시간(u[51])과 뷰포트 크기(u[76], u[77])는 뺀다: 가만히 → 원래 해상도로 바꾸는 것 자체가 '바뀜'이 되면 둘 사이를 오갔다
    // (크기가 바뀌면 resize가 쌓은 장을 따로 비운다)
    const ver = `${sdf.version}|${this.water.version}`;
    let changed = this.forceMoving || ver !== this.prevVer;
    if (!changed) for (let i = 0; i < 92; i++) if (i !== 51 && i !== 76 && i !== 77 && u[i] !== this.prevKey[i]) { changed = true; break; }
    this.prevKey.set(u); this.prevVer = ver;
    if (changed) { this.n = 0; this.stillFrames = 0; } else this.stillFrames++;
    const marchNow = this.n < ACC_MAX;
    // 첫 장은 흔들지 않고, 그 다음부터 할턴 수열로 픽셀 안을 고르게 훑는다
    u.set(this.n === 0 ? [0, 0, 0, 0] : [halton(this.n, 2) - 0.5, halton(this.n, 3) - 0.5, 0, 0], 92);
    device.queue.writeBuffer(this.ubuf, 0, u);
    const pv = this.preview;
    if (pv) {
      // 목표 모양 미리보기: 천천히 도는 작은 카메라
      const pu = this.pu, a = performance.now() / 1000 * 0.5;
      const pm = previewCam(a, pv.w / pv.h);
      pu.set(u); pu.set(pm.vp, 0); pu.set(pm.ivp, 16);
      pu.set([...pm.eye, 0], 48);
      pu.set([0, 0, 0, 0], 68);
      pu.set([pv.w, pv.h, 0, 1], 76);
      pu.set([pv.x, pv.y, 0, 0], 80);   // 미리보기에선 자르기 표시 끔
      pu.set([0, 0, 0, 0], 92);
      device.queue.writeBuffer(this.pbuf, 0, pu);
    }

    const enc = device.createCommandEncoder();
    if (marchNow) {
      // 1) 비누·배경 한 장 (+ 깊이)
      const p1 = enc.beginRenderPass({
        colorAttachments: [{ view: this.marchTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        depthStencilAttachment: { view: this.marchDepth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
      p1.setPipeline(this.marchPipe); p1.setBindGroup(0, this.marchBG); p1.draw(3); p1.end();
      // 2) 평균에 더하기: 새 장의 무게 1/(n+1)
      device.queue.writeBuffer(this.abuf, 0, new Float32Array([1 / (this.n + 1), 0, 0, 0]));
      const nxt = this.cur ^ 1;
      const p2 = enc.beginRenderPass({ colorAttachments: [{ view: this.accTex[nxt].createView(), loadOp: 'clear', storeOp: 'store' }] });
      p2.setPipeline(this.accPipe); p2.setBindGroup(0, this.accBG[this.cur]); p2.draw(3); p2.end();
      this.cur = nxt; this.n++;
    }
    enc.copyTextureToTexture({ texture: this.marchDepth }, { texture: this.depthTex }, this.size);
    // 3) 쌓은 비누 + 움직이는 것들(덩어리·칩·칼)은 매 프레임 그 위에
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.sceneTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: this.depthTex.createView(), depthLoadOp: 'load', depthStoreOp: 'store' } });
    pass.setPipeline(this.copyPipe); pass.setBindGroup(0, this.copyBG[this.cur]); pass.draw(3);
    pass.setBindGroup(0, this.meshBG);
    const drawChips = () => {
      pass.setVertexBuffer(0, this.chipVB); pass.setIndexBuffer(this.chipIB, 'uint16');
      for (const c of chips.list) if (c.drawN >= 2) pass.drawIndexed((c.drawN - 1) * 24, 1, 0, c.slot * MAXN * VPN);
    };
    for (const b of chunks.list) this.writeChunk(b);
    if (chunks.list.length) {
      pass.setPipeline(this.chunkPipe);
      for (const b of chunks.list) { pass.setBindGroup(1, b.bg); pass.draw(36); }
    }
    const km = this.knives[this.knifeShape];
    // 작업대가 없으니 바닥 그림자(칩·덩어리·칼)는 그리지 않는다
    // 반투명한 것들은 마지막에: 칩 → 칼
    pass.setPipeline(this.chipPipe); drawChips();
    if (k.visible) { pass.setPipeline(this.knifePipe); pass.setVertexBuffer(0, km.vb); pass.draw(km.count); }
    if (pv) {
      pass.setViewport(pv.x, pv.y, pv.w, pv.h, 0, 1);
      pass.setScissorRect(pv.x, pv.y, pv.w, pv.h);
      pass.setPipeline(this.marchPipe); pass.setBindGroup(0, this.previewBG); pass.draw(3);
    }
    pass.end();
    // 화면 크기로 늘려 붙이기
    const out = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    // 4) 화면으로: 쌓인 장이 적을 때(움직이는 중)만 FXAA
    device.queue.writeBuffer(this.bbuf, 0, new Float32Array([1 / this.size[0], 1 / this.size[1], this.fxaaOff ? 0 : this.n <= 2 ? 1 : this.n < 4 ? 0.5 : 0, 0]));
    out.setPipeline(this.blitPipe); out.setBindGroup(0, this.blitBG); out.draw(3); out.end();
    device.queue.submit([enc.finish()]);
  }
}

const ACC_MAX = 16;   // 가만히 있을 때 쌓는 장 수 (다 쌓이면 비누는 더 안 그린다)
function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

function previewCam(a, aspect) {
  const eye = [Math.sin(a) * 11 * 0.82, 6.5, Math.cos(a) * 11 * 0.82];
  const vp = mul4(perspective(0.6, aspect, 0.1, 100), lookAt(eye, [0, 1.3, 0], [0, 1, 0]));
  return { vp, ivp: invert4(vp), eye };
}
const normLight = (() => { const l = [-0.45, 0.85, 0.35], s = Math.hypot(...l); return l.map(x => x / s); })();

// 칼 메시 (지역 좌표: x=날 옆(l), y=날 면을 따라 손잡이 쪽(f), z=날 면 법선(m)). 정점 = pos3 nrm3 mat1
function knifeMesh(round) {
  const tris = [];
  const face = (pts, mat, inside) => {
    const [a, b, c] = pts;
    let n = norm(cross(sub(b, a), sub(c, a)));
    const mid = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
    if (dot(n, sub(mid, inside(mid))) < 0) n = n.map(x => -x);
    for (let i = 1; i + 1 < pts.length; i++) for (const p of [pts[0], pts[i], pts[i + 1]]) tris.push(...p, ...n, mat);
  };
  // 날: 끝이 둥근 판. 윗면(z=0) 외곽 → 아랫면(z=-0.07) 안쪽으로 줄여 날을 세운다
  const R = 0.6, top = 2.8, outline = (r, half) => {
    const pts = [[-half, top, 0]];
    if (round) for (let i = 0; i <= 16; i++) { const a = Math.PI + i / 16 * Math.PI; pts.push([Math.cos(a) * r, R + Math.sin(a) * r, 0]); }
    else { const e = R - r; pts.push([-half, 0.06 + e, 0], [-half + 0.06, e, 0], [half - 0.06, e, 0], [half, 0.06 + e, 0]); }   // 곧은 날
    pts.push([half, top, 0]);
    return pts;
  };
  const up = outline(R, R), dn = outline(R - 0.16, R - 0.16).map(p => [p[0], p[1], -0.07]);
  const bladeIn = p => [0, Math.min(Math.max(p[1], R), top), -0.035];
  for (let i = 1; i + 1 < up.length; i++) face([[0, (R + top) / 2, 0], up[i], up[i + 1]], 0, () => [0, (R + top) / 2, -1]);
  face([[0, (R + top) / 2, 0], up[up.length - 1], up[0]], 0, () => [0, (R + top) / 2, -1]);
  for (let i = 1; i + 1 < dn.length; i++) face([[0, (R + top) / 2, -0.07], dn[i], dn[i + 1]], 0, () => [0, (R + top) / 2, 1]);
  for (let i = 0; i < up.length; i++) {
    const j = (i + 1) % up.length;
    face([up[i], up[j], dn[j], dn[i]], 0, bladeIn);
  }
  // 손잡이
  const box = (x0, x1, y0, y1, z0, z1, mat) => {
    const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], ins = () => c;
    const v = (x, y, z) => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
    face([v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)], mat, ins); face([v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)], mat, ins);
    face([v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], mat, ins); face([v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1)], mat, ins);
    face([v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)], mat, ins); face([v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)], mat, ins);
  };
  box(-0.62, 0.62, top - 0.1, top + 0.35, -0.28, 0.12, 0);       // 쇠 받침
  box(-0.5, 0.5, top + 0.35, top + 4.8, -0.4, 0.16, 1);          // 나무 손잡이
  return new Float32Array(tris);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
