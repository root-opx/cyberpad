/* Synthesized mechanical-keyboard clicks and a timer chime (Web Audio, no files). */
(function (root) {
  'use strict';

  let ctx = null;
  let noise = null;

  function ensure() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const len = Math.floor(ctx.sampleRate * 0.06);
      noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function key(kind) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.4;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = kind === 'enter' ? 700 : kind === 'space' ? 1300 : 2100 + Math.random() * 1400;
    filter.Q.value = 3;
    const gain = c.createGain();
    const peak = kind === 'enter' ? 0.55 : 0.3;
    const decay = kind === 'enter' ? 0.09 : 0.035;
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(filter).connect(gain).connect(c.destination);
    src.start(t);
    src.stop(t + 0.08);

    if (kind === 'enter') {
      const osc = c.createOscillator();
      const og = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(55, t + 0.08);
      og.gain.setValueAtTime(0.25, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      osc.connect(og).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.11);
    }
  }

  function chime() {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime;
    [880, 1318.5, 1760].forEach((f, i) => {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'square';
      osc.frequency.value = f;
      const s = t + i * 0.14;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.07, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.13);
      osc.connect(g).connect(c.destination);
      osc.start(s);
      osc.stop(s + 0.14);
    });
  }

  (root.NP = root.NP || {}).sound = { key, chime };
})(self);
