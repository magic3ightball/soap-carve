// 소리 (Web Audio 합성, ASMR 쪽으로 가깝고 바삭하게, 이어폰 기준 스테레오)
//  깎기 = 깎인 부피가 쌓일 때마다 "사각" 한 번(짧은 잡음 알갱이 여러 개의 묶음) + 칼이 미끄러지는 "쓱" 바탕음
//  칩 떨어짐 "톡", 칩·덩어리 부딪힘 "톡/쿵", 덩어리 자르기 "썩"
export const SOUND_DEFAULTS = {
  master: 0.85,       // 전체 음량
  burstVol: 0.006,    // "사각" 한 번에 해당하는 깎인 부피 (cm³). 작을수록 촘촘
  grains: 5,          // "사각" 한 번 안의 알갱이 수 (평균)
  burstMs: 38,        // "사각" 한 번의 길이
  freq: 3600,         // 알갱이 중심 주파수 (얇게 깎을 때). 깊게 깎으면 내려간다
  q: 2.2,             // 알갱이 공명 (클수록 '틱', 작을수록 '쉭')
  decayMs: 9,         // 알갱이 하나의 꼬리
  crisp: 0.55,        // 고음 클릭 섞는 양 (ASMR 바삭함)
  scrape: 0.18,       // 칼이 미끄러지는 바탕음 크기
  width: 0.35,        // 좌우 퍼짐 (칼 위치 따라감)
  room: 0.12,         // 작은 방 울림
};

export class Sound {
  constructor(ctxFactory = () => new (window.AudioContext || window.webkitAudioContext)()) {
    this.ctxFactory = ctxFactory;
    this.ctx = null;
    this.P = { ...SOUND_DEFAULTS };
    this.muted = false;
    this.acc = 0;                // 아직 소리로 안 나간 깎인 부피
    this.pan = 0;
    this.depth = 0.08;
    this.stats = { bursts: 0, grains: 0, hits: 0 };
  }

  now() { return this.clock ?? this.ctx.currentTime; }   // 테스트(오프라인 렌더)에서 clock으로 시간을 넘긴다

  // 브라우저 정책상 첫 클릭·키 입력 때 만든다
  unlock() {
    if (!this.ctx) this.build(this.ctxFactory());
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  build(ctx) {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.003; comp.release.value = 0.12;
    this.out = ctx.createGain(); this.out.gain.value = this.muted ? 0 : this.P.master;
    comp.connect(this.out).connect(ctx.destination);
    // 비누는 나무보다 무르다: 아주 높은 쪽은 살짝 깎는다
    this.bus = ctx.createBiquadFilter(); this.bus.type = 'lowpass'; this.bus.frequency.value = 9000; this.bus.Q.value = 0.5;
    this.bus.connect(comp);
    // 작은 방 울림 (짧게 감쇠하는 잡음 임펄스)
    const len = Math.floor(ctx.sampleRate * 0.35), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    this.verb = ctx.createConvolver(); this.verb.buffer = ir;
    this.wet = ctx.createGain(); this.wet.gain.value = this.P.room;
    this.verb.connect(this.wet).connect(comp);
    // 잡음 원본
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noise = nb;
    // "쓱" 바탕음: 계속 도는 잡음 → 넓은 대역 → 음량은 깎는 속도로
    const src = ctx.createBufferSource(); src.buffer = nb; src.loop = true;
    this.scrapeF = ctx.createBiquadFilter(); this.scrapeF.type = 'bandpass'; this.scrapeF.frequency.value = 1400; this.scrapeF.Q.value = 0.7;
    this.scrapeG = ctx.createGain(); this.scrapeG.gain.value = 0;
    this.scrapeP = ctx.createStereoPanner();
    src.connect(this.scrapeF).connect(this.scrapeG).connect(this.scrapeP).connect(this.bus);
    src.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.out.gain.setTargetAtTime(m ? 0 : this.P.master, this.now(), 0.02);
  }
  applyParams() {
    if (!this.ctx) return;
    this.out.gain.value = this.muted ? 0 : this.P.master;
    this.wet.gain.value = this.P.room;
  }

  // 알갱이 하나: 잡음 조각 → 공명 필터 → 짧은 감쇠, 가끔 고음 클릭을 얹는다
  grain(t, freq, amp, pan) {
    const ctx = this.ctx, P = this.P;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = P.q;
    const g = ctx.createGain(), dec = P.decayMs / 1000 * (0.7 + Math.random() * 0.6);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.0012); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.0012 + dec * 3);
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
    s.connect(f).connect(g).connect(p);
    p.connect(this.bus); p.connect(this.verb);
    s.start(t, Math.random() * 0.9, dec * 3 + 0.01);
    if (Math.random() < P.crisp) {                            // 바삭한 클릭
      const c = ctx.createBufferSource(); c.buffer = this.noise;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(amp * 0.6, t); cg.gain.exponentialRampToValueAtTime(0.0005, t + 0.004);
      c.connect(hp).connect(cg).connect(p);
      c.start(t, Math.random() * 0.9, 0.006);
    }
    this.stats.grains++;
  }

  // 깎기: 구간마다 깎인 부피를 넣는다. depth(cm), pan(-1..1)
  cut(vol, depth, pan) {
    this.depth = depth; this.pan = pan;
    if (!this.ctx || vol <= 0) return;
    this.acc = Math.min(this.acc + vol, this.P.burstVol * 40);   // 너무 밀리면 버린다
    const P = this.P, ctx = this.ctx;
    // 깊게 깎으면 "사각" 한 번이 더 큰 덩어리 → 덜 촘촘하지만 크고 낮게
    const unit = P.burstVol * (0.6 + depth * 5);
    let t = this.now() + 0.005;
    let n = 0;
    while (this.acc >= unit && n < 6) {
      this.acc -= unit; n++;
      const thin = 1 - Math.min(1, depth / 0.4);
      const fc = P.freq * (0.45 + 0.55 * thin) * (0.8 + Math.random() * 0.4);
      const amp = 0.36 * Math.sqrt(unit / P.burstVol) * (0.75 + Math.random() * 0.5);
      const k = Math.max(2, Math.round(P.grains * (0.7 + Math.random() * 0.6)));
      for (let i = 0; i < k; i++) {
        const tt = t + Math.random() * P.burstMs / 1000;
        this.grain(tt, fc * (0.75 + Math.random() * 0.5), amp * (0.6 + Math.random() * 0.4), pan + (Math.random() - 0.5) * P.width);
      }
      t += P.burstMs / 1000 * (0.5 + Math.random() * 0.4);
      this.stats.bursts++;
    }
  }

  // 다듬기(사포) "스윽": 깎인 양만큼 아주 작고 높은 알갱이 + 바탕음을 부드럽게
  sand(vol, pan) {
    this.pan = pan;
    this.sandLvl = Math.min(1, (this.sandLvl || 0) * 0.6 + vol * 400);
    if (!this.ctx || vol <= 0) return;
    this.sandAcc = (this.sandAcc || 0) + vol;
    const unit = 0.0006, t = this.now() + 0.005;
    for (let n = 0; this.sandAcc >= unit && n < 8; n++) {
      this.sandAcc -= unit;
      this.grain(t + Math.random() * 0.016, 5200 + Math.random() * 2600, 0.09 + Math.random() * 0.06, pan + (Math.random() - 0.5) * this.P.width);
    }
    this.sandAcc = Math.min(this.sandAcc, unit * 20);
  }

  // 매 프레임: "쓱" 바탕음 크기 (깎는 중일 때만, 속도 cm/s). 다듬는 중엔 높고 부드러운 "스윽"
  // area = 이번 프레임 평균 깎인 단면적 (cm²): 바탕음은 실제로 깎이는 양에 비례 (얇게 스치면 작게)
  update(cutting, speed, sanding = false, area = 0) {
    if (!this.ctx) return;
    const t = this.now(), P = this.P;
    if (sanding) {
      this.scrapeG.gain.setTargetAtTime(P.scrape * 1.4 * (this.sandLvl || 0), t, 0.04);
      this.scrapeP.pan.setTargetAtTime(this.pan * P.width * 2, t, 0.05);
      this.scrapeF.frequency.setTargetAtTime(4200, t, 0.05);
      return;
    }
    this.sandLvl = 0;
    const lvl = cutting ? P.scrape * Math.min(1, speed / 8) * (0.5 + this.depth * 3) * Math.sqrt(Math.min(1, area / 0.012)) : 0;
    this.scrapeG.gain.setTargetAtTime(lvl, t, 0.03);
    this.scrapeP.pan.setTargetAtTime(this.pan * P.width * 2, t, 0.05);
    this.scrapeF.frequency.setTargetAtTime(900 + 2200 * (1 - Math.min(1, this.depth / 0.4)), t, 0.05);
  }

  // 짧은 "톡"/"쿵": 높은 톡(잡음) + 낮은 몸통(사인)
  knock(t, amp, hiFreq, loFreq, loDecay, pan) {
    const ctx = this.ctx;
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.bus); p.connect(this.verb);
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = hiFreq; f.Q.value = 1.4;
    // 좁은 대역 잡음은 많이 작아지므로 크게 넣는다 (오프라인 측정에서 칩 톡이 -73 dB였다)
    const g = ctx.createGain(); g.gain.setValueAtTime(amp * 3, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.03);
    s.connect(f).connect(g).connect(p); s.start(t, Math.random() * 0.9, 0.04);
    if (loFreq) {
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(loFreq * 1.4, t); o.frequency.exponentialRampToValueAtTime(loFreq, t + 0.03);
      const og = ctx.createGain(); og.gain.setValueAtTime(amp * 0.9, t); og.gain.exponentialRampToValueAtTime(0.0005, t + loDecay);
      o.connect(og).connect(p); o.start(t); o.stop(t + loDecay + 0.02);
    }
  }

  // 물방울 "똑": 높은 톡 + 위로 미끄러지는 짧은 사인
  drip(pan) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.now() + 0.005;
    const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(this.bus); p.connect(this.verb);
    const o = ctx.createOscillator(), f0 = 900 + Math.random() * 500;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 2.2, t + 0.05);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
    o.connect(g).connect(p); o.start(t); o.stop(t + 0.1);
  }

  chipOff(pan) { if (this.ctx) this.knock(this.now() + 0.01, 0.25, 2400, 0, 0, pan); }

  // 부딪힘: v = 접근 속도 (cm/s), big = 덩어리면 true
  hit(v, big, pan) {
    if (!this.ctx) return;
    const a = Math.min(1, v / 120);
    if (big) this.knock(this.now() + 0.005, 0.7 * a + 0.2, 1100, 140, 0.16, pan);
    else this.knock(this.now() + 0.005, 0.3 * a + 0.06, 3200 + Math.random() * 1500, 0, 0, pan);
    this.stats.hits++;
  }

  // 덩어리 자르기 "썩": 위에서 아래로 쓸리는 잡음 + 낮은 몸통
  slice(vol, pan) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.now() + 0.005, dur = 0.16 + Math.min(0.15, vol * 0.01);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    p.connect(this.bus); p.connect(this.verb);
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
    f.frequency.setValueAtTime(4200, t); f.frequency.exponentialRampToValueAtTime(700, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1.1, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(f).connect(g).connect(p); s.start(t, Math.random() * 0.5, dur + 0.02);
    // 칼이 끊고 지나가는 순간의 사각 묶음
    for (let i = 0; i < 12; i++) this.grain(t + Math.random() * dur * 0.7, 2500 + Math.random() * 2500, 0.35, pan + (Math.random() - 0.5) * 0.3);
  }
}
