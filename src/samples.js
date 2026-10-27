// 녹음 샘플 묶음 (sounds/manifest.json → AudioBuffer). 없거나 못 불러온 종류는 sound.js가 합성음으로 대신한다.
//  manifest: { "cut_thin": ["cut_thin_01.m4a", ...], ... }  — tools/sound_manifest.py가 파일 이름으로 만든다
export const SAMPLE_KINDS = {
  cut_thin: '얇게 깎기 "사각" 한 번',
  cut_deep: '깊게 깎기 "사각" 한 번',
  scrape: '이어서 깎는 긴 녹음 (바탕음 "쓱")',
  sand: '문지르기 짧은 것',
  sand_loop: '이어서 문지르는 긴 녹음 (바탕음 "스윽")',
  chip: '칩 떨어짐·작은 부딪힘 "톡"',
  hit_big: '덩어리 떨어짐 "쿵"',
  slice: '덩어리 자르기 "썩"',
  drip: '물방울 "똑"',
};

export class SampleBank {
  constructor(base = 'sounds/') {
    this.base = base;
    this.buf = {};          // 종류 → AudioBuffer[]
    this.last = {};         // 종류 → 직전에 고른 번호 (같은 게 연달아 나오지 않게)
    this.loading = null;
    this.errors = [];
  }

  has(kind) { return (this.buf[kind]?.length || 0) > 0; }
  counts() { return Object.fromEntries(Object.entries(this.buf).map(([k, v]) => [k, v.length])); }

  // 같은 파일이 두 번 연달아 나오면 바로 기계음처럼 들린다 → 직전 것은 피해서 무작위
  pick(kind) {
    const a = this.buf[kind];
    if (!a?.length) return null;
    let i = Math.floor(Math.random() * a.length);
    if (a.length > 1 && i === this.last[kind]) i = (i + 1 + Math.floor(Math.random() * (a.length - 1))) % a.length;
    this.last[kind] = i;
    return a[i];
  }

  // 테스트나 콘솔에서 직접 넣기
  set(kind, buffers) { this.buf[kind] = buffers; }

  load(ctx) {
    this.loading ??= (async () => {
      let man;
      try {
        const r = await fetch(this.base + 'manifest.json', { cache: 'no-cache' });
        if (!r.ok) return;
        man = await r.json();
      } catch (e) { this.errors.push('manifest: ' + e.message); return; }
      await Promise.all(Object.entries(man).filter(([k]) => k in SAMPLE_KINDS).map(async ([kind, files]) => {
        const got = await Promise.all(files.map(async f => {
          try { return await ctx.decodeAudioData(await (await fetch(this.base + f)).arrayBuffer()); }
          catch (e) { this.errors.push(`${f}: ${e.message}`); return null; }
        }));
        const ok = got.filter(Boolean);
        if (ok.length) this.buf[kind] = ok;
      }));
      if (this.errors.length) console.warn('녹음 샘플 일부를 못 불러옴', this.errors);
    })();
    return this.loading;
  }
}

// 이어지는 소리: 긴 녹음의 무작위 위치에서 짧은 조각을 반씩 겹쳐 튼다 (20초 녹음이 반복되는 티가 안 나게)
//  조각 봉우리는 삼각형 → 반씩 겹치면 합이 일정. 음량은 out.gain을 부르는 쪽이 정한다
export class GrainLoop {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    this.out.connect(dest);
    this.next = 0;
    this.grains = 0;
  }

  // 매 프레임: 앞으로 0.12초 분량을 미리 예약. active가 아니면 예약을 멈춘다 (이미 예약된 것은 out.gain이 줄여 없앤다)
  tick(t, buf, active, lenMs, rate = 1) {
    if (!buf || !active) { this.next = 0; return; }
    const L = lenMs / 1000;
    if (this.next < t) this.next = t + 0.01;
    while (this.next < t + 0.12) {
      const s = this.ctx.createBufferSource(); s.buffer = buf;
      s.playbackRate.value = rate * (0.97 + Math.random() * 0.06);
      const span = L * s.playbackRate.value;
      const g = this.ctx.createGain(), t0 = this.next;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(1, t0 + L / 2); g.gain.linearRampToValueAtTime(0, t0 + L);
      s.connect(g).connect(this.out);
      s.start(t0, Math.random() * Math.max(0, buf.duration - span), span);
      this.next += L / 2;
      this.grains++;
    }
  }
}
