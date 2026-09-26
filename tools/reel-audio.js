#!/usr/bin/env node
// Synthesises the film's soundtrack: room tone and a clock for the wait, then a 96 bpm score (kick, clap, hats, bass,
// plucks, pads) and sound effects on the same cue times as reel.html. Everything is generated here, so there is no
// sample or music licence to clear.
//
//   node tools/reel-audio.js [out.wav]
'use strict';
const fs = require('fs');

const SR = 48000, DUR = 45, N = SR * DUR, BEAT = .625, DT = 1.25;
const U = x => x + DT;                                   // guest act onwards: reel.html's shifted clock
const L = new Float32Array(N), R = new Float32Array(N);   // drums and effects
const mL = new Float32Array(N), mR = new Float32Array(N); // music bus, ducked by the kick
const vL = new Float32Array(N), vR = new Float32Array(N); // reverb send
let seed = 11;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const p = (t, a, b) => clamp((t - a) / (b - a));

function voice(t0, len, fn, { gain = 1, pan = 0, send = 0, bus = 'fx' } = {}) {
  const a = bus === 'music' ? [mL, mR] : [L, R];
  const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  const s0 = Math.max(0, Math.round(t0 * SR)), n = Math.min(Math.round(len * SR), N - s0);
  for (let i = 0; i < n; i++) {
    const v = fn(i / SR, i);
    a[0][s0 + i] += v * gl; a[1][s0 + i] += v * gr;
    if (send) { vL[s0 + i] += v * gl * send; vR[s0 + i] += v * gr * send; }
  }
}
function bandpass() {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x, f, q) => {
    const w = TAU * Math.min(f, SR * .45) / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const y = (al * x - al * x2 + 2 * Math.cos(w) * y1 - (1 - al) * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; return y;
  };
}
const onepole = c => { let y = 0; return x => (y += c * (x - y)); };

/* Drums */
const kicks = [];
const kick = (t, g = 1) => { kicks.push(t); let ph = 0; voice(t, .45, s => { ph += TAU * (44 + 120 * Math.exp(-s * 26)) / SR; return Math.sin(ph) * Math.exp(-s * 8) + (s < .004 ? noise() * .35 : 0); }, { gain: g }); };
const hat = (t, g = .06, pan = .2) => { const hp = onepole(.62); voice(t, .06, s => { const n = noise(); return (n - hp(n)) * Math.exp(-s * 75); }, { gain: g, pan }); };
const clap = (t, g = .28) => { const bp = bandpass(); voice(t, .24, s => bp(noise(), 1700, .9) * (Math.exp(-s * 34) + (s > .011 ? .8 * Math.exp(-(s - .011) * 24) : 0) + (s > .022 ? .6 * Math.exp(-(s - .022) * 20) : 0)) * 2.2, { gain: g, send: .3 }); };
const snare = (t, g = .12) => { const bp = bandpass(); voice(t, .12, s => (bp(noise(), 2400, .7) * 2 + Math.sin(TAU * 190 * s) * .5) * Math.exp(-s * 30), { gain: g, send: .2 }); };

/* Tonal */
const bass = (t, m, len = .28, g = .3) => { const f = hz(m), lp = onepole(.07); voice(t, len, s => lp(Math.tanh(2.2 * Math.sin(TAU * f * s) + .5 * Math.sin(TAU * 2 * f * s))) * Math.min(1, s * 300) * Math.min(1, (len - s) * 40), { gain: g, bus: 'music' }); };
const pluck = (t, m, g = .06, pan = 0, bright = 2.2) => { const f = hz(m); voice(t, .55, s => Math.sin(TAU * f * s + bright * Math.exp(-s * 16) * Math.sin(TAU * 3.01 * f * s)) * Math.exp(-s * 7.5) * Math.min(1, s * 900), { gain: g, pan, send: .28, bus: 'music' }); };
function pad(t, len, notes, g = .05, cutoff = .045) {
  notes.forEach(m => [-.07, 0, .07].forEach((dt, k) => {
    const f = hz(m + dt), lp = onepole(cutoff), lp2 = onepole(cutoff * 1.5), pan = (k - 1) * .6;
    let ph = rnd();
    voice(t, len, s => { ph += f / SR; return lp2(lp((ph % 1) * 2 - 1)) * Math.min(1, s / .35) * Math.min(1, (len - s) / .45); }, { gain: g, pan, send: .45, bus: 'music' });
  }));
}
const stab = (t, notes, g = .1) => notes.forEach(m => { const f = hz(m), lp = onepole(.12); let ph = rnd(); voice(t, .5, s => { ph += f / SR; return lp((ph % 1) * 2 - 1) * Math.exp(-s * 6) * Math.min(1, s * 600); }, { gain: g, send: .4, bus: 'music' }); });
const bell = (t, m, g = .12, pan = 0, len = 2) => { const f = hz(m); voice(t, len, s => (Math.sin(TAU * f * s) + .45 * Math.sin(TAU * f * 2.76 * s) * Math.exp(-s * 5) + .2 * Math.sin(TAU * f * 5.4 * s) * Math.exp(-s * 9)) * Math.exp(-s * 2.8) * Math.min(1, s * 400), { gain: g, pan, send: .45 }); };

/* Effects */
const thud = (t, f = 70, g = .8) => { let ph = 0; voice(t, .4, s => { ph += TAU * f * (1 + 1.6 * Math.exp(-s * 38)) / SR; return Math.tanh(1.7 * Math.sin(ph)) * Math.exp(-s * 12); }, { gain: g, send: .15 }); };
const click = (t, g = .14, pan = 0, f = 3200) => voice(t, .03, s => (Math.sin(TAU * f * s) * .6 + noise() * .4) * Math.exp(-s * 260), { gain: g, pan, send: .08 });
const tap = (t, g = .16) => { click(t, g, -.1, 2400); thud(t, 180, g * .5); };
const pop = (t, f = 520, g = .22, pan = 0) => { let ph = 0; voice(t, .12, s => { ph += TAU * f * (1 + 1.3 * Math.min(1, s / .03)) / SR; return Math.sin(ph) * Math.exp(-s * 36); }, { gain: g, pan, send: .2 }); };
const blip = (t, m, g = .08, pan = 0) => { const f = hz(m); voice(t, .14, s => Math.sin(TAU * f * s) * Math.exp(-s * 34) * Math.min(1, s * 900), { gain: g, pan, send: .2 }); };
function whoosh(t, len, g = .3, f0 = 300, f1 = 3500, pan0 = 0, pan1 = 0) {
  const bp = bandpass(), bp2 = bandpass(), s0 = Math.round(t * SR), n = Math.round(len * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const k = i / n, f = f0 * Math.pow(f1 / f0, k), env = Math.pow(Math.sin(Math.PI * Math.pow(k, .7)), 2);
    const v = (bp(noise(), f, 1.2) + .5 * bp2(noise(), f * 1.9, 3)) * env * g;
    const pn = pan0 + (pan1 - pan0) * k, gl = Math.cos((pn + 1) * Math.PI / 4), gr = Math.sin((pn + 1) * Math.PI / 4);
    L[s0 + i] += v * gl; R[s0 + i] += v * gr; vL[s0 + i] += v * gl * .25; vR[s0 + i] += v * gr * .25;
  }
}
function riser(t1, len, g = .25, m0 = 48) {
  const bp = bandpass(); let ph = 0;
  voice(t1 - len, len, s => { const k = s / len; ph += TAU * hz(m0 + 24 * k * k) / SR; return (bp(noise(), 400 + 6000 * k * k, 1.5) * .8 + .22 * ((ph / TAU % 1) * 2 - 1)) * k * k * k; }, { gain: g, send: .3 });
}
const tick = (t, hi, g) => { const bp = bandpass(), f = hi ? 2700 : 2000; voice(t, .07, s => bp(noise(), f, 7) * Math.exp(-s * 95) * 3 + Math.sin(TAU * f * 1.5 * s) * Math.exp(-s * 140) * .25, { gain: g, pan: .2, send: .15 }); };
const clink = (t, g = .04, pan = 0) => voice(t, .6, s => [3120, 4410, 5930, 7810].reduce((a, f, i) => a + Math.sin(TAU * f * s) * Math.exp(-s * (9 + i * 6)) / (i + 1), 0) * Math.min(1, s * 3000), { gain: g, pan, send: .35 });
const whistle = (t, len, g = .05) => { let ph = 0; voice(t, len, s => { const k = s / len; ph += TAU * 1600 * Math.pow(320 / 1600, k) / SR; return Math.sin(ph) * Math.sin(Math.PI * k); }, { gain: g, send: .3 }); };
const zip = (t, len, g = .06) => { let ph = 0; voice(t, len, s => { const k = s / len; ph += TAU * (300 + 1400 * k * k) / SR; return (Math.sin(ph) * .8 + noise() * .12) * Math.sin(Math.PI * k); }, { gain: g, send: .2 }); };
const key = (t, g = .09) => { const bp = bandpass(), f = 2600 + rnd() * 1800; voice(t, .045, s => bp(noise(), f, 2) * Math.exp(-s * 150) * 3, { gain: g, pan: .25, send: .05 }); };
const count = (t0, t1, n, g = .045) => { for (let j = 0; j < n; j++) click(t0 + (t1 - t0) * Math.pow(j / n, 1.3), g, .3, 4200); };
function murmur(t0, t1, g) {
  for (let v = 0; v < 8; v++) {
    const bp = bandpass(), bp2 = bandpass(), fc = 360 + rnd() * 720, pan = rnd() * 1.4 - .7, rate = 2.6 + rnd() * 2.6, ph = rnd() * 10;
    voice(t0, t1 - t0, s => {
      const env = Math.pow(Math.max(0, .55 * Math.sin(TAU * rate * s + ph) + .45 * Math.sin(TAU * rate * .41 * s + ph * 2)), 2);
      const fade = Math.min(1, s / 1.4) * Math.min(1, (t1 - t0 - s) / .25);
      return (bp(noise(), fc * (1 + .15 * Math.sin(s * 2 + v)), 4) + .5 * bp2(noise(), fc * 2.3, 6)) * env * fade;
    }, { gain: g, pan, send: .4 });
  }
}

/* ---------- Score ---------- */
// Act 1, the wait: room tone, a low A minor bed, a clock that tightens.
murmur(0, 7.45, .22);
[.9, 1.7, 2.3, 3.4, 4.1, 5.2, 6.1, 6.8].forEach((x, i) => clink(x, .04 + (i % 3) * .015, i % 2 ? .5 : -.45));
pad(0, 7.5, [45, 52, 57, 60], .065, .03);
voice(0, 7.5, s => Math.sin(TAU * hz(33) * s) * Math.min(1, s / 2) * Math.min(1, (7.5 - s) / .2), { gain: .09, bus: 'music' });
whoosh(.4, .7, .05, 600, 2400);
whoosh(2.55, .75, .09, 260, 1500, .3, 0); thud(3.12, 140, .2);
whoosh(2.6, .6, .05, 800, 3000);
for (let x = 3.75, i = 0; x < 7.42; x += BEAT / 2, i++) tick(x, i % 2 === 0, .12 + .3 * p(x, 3.75, 7.4));
[4.3, 4.95, 5.6].forEach((x, i) => pop(x, 300 + i * 70, .28));
[0, 1, 2].forEach(i => clink(5.6 + i * .12, .06, .3));
riser(7.45, 2.2, .2);
whistle(7.45, .41, .05);
thud(7.86, 52, .95); kick(7.86, .6);

// The turn: red floods, three stabs, then the groove.
riser(8.44, .44, .18, 60);
whoosh(8.0, .45, .2, 200, 3000);
[[8.4375, [48, 52, 55, 60]], [8.75, [45, 48, 52, 57]], [9.0625, [41, 45, 48, 53]]].forEach(([x, ch], i) => { stab(x, ch, .09); kick(x, i ? .75 : 1); clap(x, .18); });
bass(8.4375, 36, .5, .34); bass(8.75, 33, .3, .3); bass(9.0625, 29, .3, .3);
[72, 76, 79, 84].forEach((m, i) => bell(9.375 + i * .08, m, .07, -.3 + i * .2, 1.6));

// Chords by bar (2.5 s): the guest act rides C F C G Am F C G C; the restaurant Am F G; the close lands on C.
const CH = { C: [48, [48, 52, 55, 60, 64]], F: [41, [41, 45, 48, 53, 57]], G: [43, [43, 47, 50, 55, 59]], Am: [45, [45, 48, 52, 57, 60]] };
const bars = { 3: 'C', 4: 'C', 5: 'F', 6: 'C', 7: 'G', 8: 'Am', 9: 'F', 10: 'C', 11: 'G', 12: 'C', 13: 'Am', 14: 'F', 15: 'G', 16: 'G' };
const chordAt = t => CH[bars[Math.floor(t / 2.5)] || 'C'];
const A0 = 9.375, A1 = U(32.25), B1 = U(39.85);          // groove A (guest), groove B (restaurant), then the close
for (let b = Math.round(A0 / BEAT); b * BEAT < B1 - .01; b++) {
  const t = b * BEAT, inA = t < A1, full = t >= U(10.625);
  if (inA || b % 2 === 0) kick(t, inA ? .85 : .7);
  if (inA && full && (b % 4 === 1 || b % 4 === 3)) clap(t, .2);
  for (let e = 0; e < 4; e++) { const x = t + e * BEAT / 4; if (inA || e % 2 === 0) hat(x, (e % 2 ? .03 : .05) * (inA ? 1 : .8), e % 2 ? .25 : -.2); }
}
for (let bar = 3; bar * 2.5 < B1; bar++) {
  const t0 = bar * 2.5, [root, tones] = chordAt(t0);
  if (t0 + 2.5 > A0) {
    const inA = t0 < A1;
    if (inA) for (let e = 0; e < 8; e++) { const x = t0 + e * BEAT / 2; if (x >= A0 && x < A1) bass(x, root - 12 + (e % 4 === 3 ? 12 : 0), .26, .28); }
    else bass(Math.max(t0, A1), root - 12, 2.45, .2);
    if (t0 >= 10) pad(t0, 2.55, tones.slice(0, 4), inA ? .026 : .024, inA ? .045 : .03);
  }
  // Plucked arpeggio: sixteenths over the guest act, eighths on the restaurant side.
  const step = t0 < A1 ? BEAT / 4 : BEAT / 2, pat = [0, 2, 4, 3, 1, 3, 2, 4];
  for (let k = 0; k * step < 2.5 - 1e-6; k++) {
    const x = t0 + k * step;
    if (x < U(10.625) || x >= B1) continue;
    pluck(x, tones[pat[k % 8]] + 12, (k % 4 === 0 ? .05 : .034) * (x < A1 ? 1 : .8), (k % 2 ? .35 : -.35), x < A1 ? 2.2 : 1.1);
  }
}
for (let x = U(38.2); x < U(39.85); x += x < U(39.2) ? BEAT / 2 : BEAT / 4) snare(x, .04 + .1 * p(x, U(38.2), U(39.85)));
riser(U(39.85), 1.7, .22);

/* ---------- Effects on the film's cues ---------- */
whoosh(U(10.25), .6, .3, 250, 5000, .6, -.8);               // the whip into cream
whoosh(U(10.7), .55, .16, 200, 1400, 0, 0);                   // phone rises
[11.4, 11.52].forEach(x => blip(U(x), 96, .05));              // camera focus
whoosh(U(11.75), .38, .08, 2000, 6500);                       // scan line
[88, 95].forEach((m, i) => bell(U(12.1) + i * .07, m, .07, .2, .8));
whoosh(U(12.5), .35, .1, 500, 3000);                          // the menu opens
for (let i = 0; i < 5; i++) click(U(12.55) + i * .07, .05, .2, 3600);
[10.625, 14.375, 18.125, 22.5, 25.625, 29.375].forEach((x, i) => { if (i) whoosh(U(x) - .05, .5, .07, 700, 2600, .4, -.2); blip(U(x) + .3, 84 + [0, 2, 4, 7, 9, 12][i], .05, .3); });
[12.35, 14.62, 14.98, 15.95, 16.12, 16.62, 17.5, 18.25, 19.05, 20.45, 20.85, 22.35, 26.75, 29.8, 31.3].forEach(x => tap(U(x)));
[14.7, 16.02].forEach(x => pop(U(x), 700, .12));
[15.02, 16.16].forEach(x => whoosh(U(x), .35, .08, 1200, 3800, -.3, .3));
count(U(16.68), U(17), 8, .04); count(U(17.55), U(17.85), 8, .035);
[18.4, 19.25, 22.55].forEach(x => whoosh(U(x), .4, .1, 400, 2600, .5, -.3));
for (let i = 0; i < 10; i++) click(U(18.5) + i * .035, .035, .2, 3800);
[19.45, 19.75, 20.05, 20.3].forEach((x, i) => blip(U(x), [79, 81, 84, 76][i], .06, .2));
[20.47, 20.87].forEach(x => count(U(x), U(x) + .24, 5, .035));
thud(U(21.2), 58, .8); clap(U(21.2), .3); kick(U(21.2), .7);
pop(U(22.95), 620, .18); count(U(22.95), U(23.5), 10, .035); bell(U(23.5), 91, .05, .3, .6);
[25.75, 26.0, 26.25].forEach((x, i) => blip(U(x), [79, 83, 86][i], .06, .2));
whoosh(U(26.88), .4, .1, 400, 2400, 0, 0);
voice(U(27.05), .33, s => Math.sin(TAU * (500 + 900 * s / .33) * s) * .5 * Math.sin(Math.PI * s / .33), { gain: .04, send: .2 });
kick(U(27.4), .8); [72, 76, 79, 84, 88].forEach((m, i) => bell(U(27.4) + i * .06, m, .09, -.4 + i * .2, 1.8));
[0, 1, 2, 3, 4].forEach(i => bell(U(29.85) + i * .05, [84, 86, 88, 91, 93][i], .06, -.5 + i * .25, 1.2));
thud(U(29.95), 60, .5); for (let i = 0; i < 40; i++) click(U(29.95) + rnd() * .7, .02 + rnd() * .03, rnd() * 1.6 - .8, 3000 + rnd() * 4000);
whoosh(U(30.3), .4, .09, 300, 2000); blip(U(31.0), 83, .05, .2); whoosh(U(31.55), .4, .07, 2000, 400);

whoosh(U(32.2), .75, .3, 180, 3200, -.5, .5);                 // into the restaurant
whoosh(U(32.7), .5, .12, 400, 2400, .6, 0);
[84, 88].forEach((m, i) => bell(U(33.4) + i * .12, m, .07, .3, 1));
count(U(33.45), U(33.95), 10, .03);
whoosh(U(34.0), .45, .07, 600, 2200);
tap(U(34.72));
[76, 79, 84, 88].forEach((m, i) => bell(U(34.9) + i * .05, m, .08, -.2 + i * .15, 1.6)); [0, 1].forEach(i => clink(U(34.92) + i * .06, .05, .2));
count(U(34.9), U(35.4), 10, .03);
whoosh(U(35.95), .45, .12, 2400, 300, 0, -.7); whoosh(U(36.2), .5, .12, 300, 2400, .7, 0);
tap(U(36.95));
[37.1, 37.16, 37.22, 37.28, 37.36, 37.44, 37.52, 37.6].forEach(x => key(U(x)));
pop(U(37.45), 560, .12); pop(U(37.72), 760, .12);
tap(U(38.08));
[79, 84, 88].forEach((m, i) => bell(U(38.2) + i * .07, m, .08, 0, 1.2));
zip(U(38.18), .32, .06); bell(U(38.5), 91, .06, .5, .8);

whoosh(U(39.85), .5, .22, 300, 4000);                         // the close
pop(U(40.3), 420, .3);
zip(U(40.52), .38, .07);
const HIT = U(40.625);
kick(HIT, 1); thud(HIT, 44, .85);
pad(HIT, 45 - HIT, [48, 55, 59, 62, 64], .05, .05);
voice(HIT, 45 - HIT, s => Math.sin(TAU * hz(36) * s) * Math.exp(-s * .6), { gain: .28, bus: 'music' });
[84, 88, 91, 95, 98].forEach((m, i) => bell(HIT + i * .07, m, .06, -.4 + i * .2, 2.4));
voice(U(40.95), .6, s => { const bp = 0; return noise() * Math.pow(s / .6, 2) * .5; }, { gain: .03, send: .6 });
[41.25, 41.4, 41.55].forEach((x, i) => blip(U(x), [88, 91, 96][i], .04, -.2 + i * .2));
pop(U(41.7), 520, .18); click(U(42.05), .05, 0, 2600);

/* ---------- Mix ---------- */
// Duck the music bus under each kick, add a short room, soft-clip, normalise, fade the tail.
for (let i = 0; i < N; i++) {
  const t = i / SR; let d = 1;
  for (let k = 0; k < kicks.length; k++) { const s = t - kicks[k]; if (s >= 0 && s < .3) d = Math.min(d, 1 - .55 * Math.exp(-s / .09)); }
  L[i] += mL[i] * d; R[i] += mR[i] * d;
}
function reverb(inp, comb, ap) {
  const out = new Float32Array(N);
  for (const n of comb) { const buf = new Float32Array(n); let j = 0, lp = 0; for (let i = 0; i < N; i++) { const y = buf[j]; lp = y * .6 + lp * .4; buf[j] = inp[i] + lp * .8; j = (j + 1) % n; out[i] += y * .22; } }
  for (const n of ap) { const buf = new Float32Array(n); let j = 0; for (let i = 0; i < N; i++) { const b = buf[j], y = -out[i] + b; buf[j] = out[i] + b * .5; j = (j + 1) % n; out[i] = y; } }
  return out;
}
const rl = reverb(vL, [1557, 1617, 1491, 1422, 1277, 1356], [556, 441]);
const rr = reverb(vR, [1580, 1640, 1514, 1445, 1300, 1379], [579, 464]);
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, (N - i) / (SR * 1.2)) * Math.min(1, i / (SR * .08));
  L[i] = Math.tanh((L[i] + rl[i] * .55) * 1.35) * fade; R[i] = Math.tanh((R[i] + rr[i] * .55) * 1.35) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const g = .85 / peak, buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * g * 32767), 46 + i * 4); }
const out = process.argv[2] || 'reel.wav';
fs.writeFileSync(out, buf);
console.log('wrote', out);
