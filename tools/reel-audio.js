#!/usr/bin/env node
// Synthesises the reel's soundtrack: a 120 bpm bed (kick, hats, bass, pad) and sound effects on the same cue
// times as reel.html. Everything is generated here, so there is no sample or music licence to clear.
//
//   node tools/reel-audio.js [out.wav]
'use strict';
const fs = require('fs');

const SR = 48000, DUR = 15, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);   // effects, straight to master
const mL = new Float32Array(N), mR = new Float32Array(N); // music bus, ducked by the kick
const vL = new Float32Array(N), vR = new Float32Array(N); // reverb send
let seed = 5;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;

// Write a mono voice into a bus, panned, with an optional reverb send.
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
// RBJ band-pass whose centre can move per sample.
function bandpass() {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x, f, q) => {
    const w = TAU * Math.min(f, SR * .45) / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const y = (al * x - al * x2 - -2 * Math.cos(w) * y1 - (1 - al) * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; return y;
  };
}
const onepole = (c) => { let y = 0; return x => (y += c * (x - y)); };

/* Instruments */
const kick = (t, g = 1) => { let ph = 0; voice(t, .4, s => { ph += TAU * (45 + 110 * Math.exp(-s * 28)) / SR; return Math.sin(ph) * Math.exp(-s * 9) + (s < .004 ? noise() * .4 : 0); }, { gain: g }); };
const hat = (t, g = .1, pan = .2) => { const hp = onepole(.6); voice(t, .06, s => { const n = noise(); return (n - hp(n)) * Math.exp(-s * 70); }, { gain: g, pan }); };
const thud = (t, f = 70, g = .9) => { let ph = 0; voice(t, .35, s => { ph += TAU * f * (1 + 1.5 * Math.exp(-s * 40)) / SR; return Math.tanh(1.6 * Math.sin(ph)) * Math.exp(-s * 14); }, { gain: g, send: .15 }); };
const click = (t, g = .25, pan = 0, f = 3200) => voice(t, .03, s => (Math.sin(TAU * f * s) * .6 + noise() * .4) * Math.exp(-s * 260), { gain: g, pan, send: .1 });
const pop = (t, f = 500, g = .35, pan = 0) => { let ph = 0; voice(t, .12, s => { ph += TAU * f * (1 + 1.4 * Math.min(1, s / .03)) / SR; return Math.sin(ph) * Math.exp(-s * 38); }, { gain: g, pan, send: .2 }); };
function whoosh(t, len, g = .45, f0 = 300, f1 = 3500, pan0 = 0, pan1 = 0) {
  const bp = bandpass(), bp2 = bandpass();
  const s0 = Math.round(t * SR), n = Math.round(len * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const k = i / n, f = f0 * Math.pow(f1 / f0, k), env = Math.pow(Math.sin(Math.PI * Math.pow(k, .7)), 2);
    const v = (bp(noise(), f, 1.2) + .5 * bp2(noise(), f * 1.9, 3)) * env * g;
    const pn = pan0 + (pan1 - pan0) * k, gl = Math.cos((pn + 1) * Math.PI / 4), gr = Math.sin((pn + 1) * Math.PI / 4);
    L[s0 + i] += v * gl; R[s0 + i] += v * gr; vL[s0 + i] += v * gl * .25; vR[s0 + i] += v * gr * .25;
  }
}
const bell = (t, m, g = .22, pan = 0, len = 2.2) => { const f = hz(m); voice(t, len, s => (Math.sin(TAU * f * s) + .45 * Math.sin(TAU * f * 2.76 * s) * Math.exp(-s * 5) + .2 * Math.sin(TAU * f * 5.4 * s) * Math.exp(-s * 9)) * Math.exp(-s * 2.6) * Math.min(1, s * 400), { gain: g, pan, send: .45 }); };
const clap = (t, g = .35) => { const bp = bandpass(); voice(t, .22, s => bp(noise(), 1800, .9) * (Math.exp(-s * 30) + (s > .012 ? .7 * Math.exp(-(s - .012) * 22) : 0)) * 2.2, { gain: g, send: .35 }); };
function tear(t, len, g = .5) {
  const bp = bandpass();
  voice(t, len, s => { const crack = rnd() < .02 ? 3 : 1; return bp(noise(), 2400 + 1800 * Math.sin(s * 60), 1.4) * crack * Math.sin(Math.PI * s / len); }, { gain: g, send: .15 });
}
function riser(t1, len, g = .35) {
  const bp = bandpass(); let ph = 0;
  voice(t1 - len, len, s => { const k = s / len; ph += TAU * hz(48 + 24 * k * k) / SR; return (bp(noise(), 400 + 6000 * k * k, 1.5) * .8 + .25 * ((ph / TAU % 1) * 2 - 1)) * k * k * k; }, { gain: g, send: .3 });
}
function pad(t, len, notes, g = .07) {
  notes.forEach((m, j) => [-.08, 0, .08].forEach((dt, k) => {
    const f = hz(m + dt), lp = onepole(.05), pan = (k - 1) * .6;
    let ph = rnd();
    voice(t, len, s => { ph += f / SR; const saw = (ph % 1) * 2 - 1; return lp(saw) * Math.min(1, s / .25) * Math.min(1, (len - s) / .4); }, { gain: g, pan, send: .5, bus: 'music' });
  }));
}
const bass = (t, m, len = .24, g = .32) => { const f = hz(m), lp = onepole(.08); voice(t, len, s => lp(Math.tanh(2 * Math.sin(TAU * f * s) + .6 * Math.sin(TAU * f * 2 * s))) * Math.min(1, s * 300) * Math.min(1, (len - s) * 60), { gain: g, bus: 'music' }); };

/* Score: 120 bpm, bar = 2 s. Am, F, C, G, F, then G into C for the logo. */
const bars = [[2, 57, [57, 60, 64, 67]], [4, 53, [53, 57, 60, 64]], [6, 48, [52, 55, 60, 64]], [8, 55, [55, 59, 62, 67]], [10, 53, [53, 57, 60, 65]]];
const kicks = [];
for (const [t, root, chord] of bars) {
  pad(t, 2.05, chord);
  for (let b = 0; b < 4; b++) { kicks.push(t + b * .5); kick(t + b * .5, .8); }
  for (let e = 0; e < 8; e++) bass(t + e * .25, e % 4 === 3 ? root + 12 : root - 12 + 12 * (e % 2) * 0);
  for (let e = 0; e < 16; e++) hat(t + e * .125, e % 2 ? .05 : .09, e % 4 < 2 ? .25 : -.25);
}
riser(12.5, 1.3, .3);
pad(12.95, 2.05, [48, 55, 60, 62, 64, 71], .085);
bass(12.95, 36, 2, .35);

/* Effects, on reel.html's cue times */
thud(.5, 80, .8); thud(.75, 95, .45);
whoosh(.85, .5, .18, 800, 5000);
for (let i = 0; i < 26; i++) click(1.0 + rnd() * .5, .05 + rnd() * .06, rnd() * 1.2 - .6, 2500 + rnd() * 3000);
pop(1.1, 700, .2); click(1.5, .12, 0, 1760);
whoosh(1.5, .4, .15, 2000, 6000);
riser(2.0, .5, .25);
kick(2.0, 1); clap(2.0, .4); thud(2.0, 55, .7);
clap(2.25, .25); clap(2.5, .3);
whoosh(3.15, .6, .55, 250, 5000, .6, -.8);
whoosh(3.6, .5, .3, 200, 1500);
for (let j = 0; j < 7; j++) click(3.9 + j * .1, .09, .15, 2200);
for (let j = 0; j < 22; j++) click(4.6 + .4 * Math.pow(j / 22, 1.6), .06, .1, 4200);
thud(5.0, 60, .9); clap(5.0, .35);
tear(5.45, .5, .4);
for (let j = 0; j < 4; j++) whoosh(5.95 + j * .125, .3, .12, 900, 3500, -.6 + j * .4, -.6 + j * .4);
whoosh(6.7, .55, .4, 300, 3000, .5, -.2);
thud(7.2, 75, .5);
for (let j = 0; j < 12; j++) click(7.25 + .55 * Math.pow(j / 12, 1.4), .05, .4, 4200);
[0, 1, 2].forEach(i => pop(7.75 + i * .125, 520 + i * 110, .3, .3 + i * .15));
click(8.25, .3, -.3, 2600); bell(8.78, 84, .12, .3, 1.2);
for (let j = 0; j < 10; j++) click(8.3 + .45 * Math.pow(j / 10, 1.4), .05, .4, 4200);
[0, 1, 2].forEach(i => whoosh(8.85 + i * .125, .25, .1, 1200, 4000, .8, .3));
click(9.25, .3, -.3, 2600);
for (let j = 0; j < 9; j++) click(9.5 + j * .035, .08, .3, 1600 + j * 120);
click(10.0, .35, -.3, 2600);
whoosh(9.95, .6, .5, 150, 4000, -.3, 0);
whoosh(10.35, .45, .12, 1500, 4000);
kick(11.0, 1); thud(11.0, 50, .8);
[77, 81, 84, 89].forEach((m, i) => bell(11.0 + i * .06, m, .16, -.3 + i * .2));
for (let j = 0; j < 40; j++) click(11.0 + rnd() * .7, .03 + rnd() * .04, rnd() * 1.6 - .8, 3000 + rnd() * 4000);
[0, 1, 2].forEach(i => clap(11.15 + i * .16, .22 + i * .04));
[84, 86, 88, 91, 93].forEach((m, i) => bell(11.6 + i * .07, m, .09, -.5 + i * .25, 1.4));
whoosh(12.2, .5, .3, 3000, 400);
pop(12.55, 420, .45);
whoosh(12.8, .45, .2, 500, 2500);
kick(12.95, .9); thud(12.95, 45, .8);
[72, 76, 79, 83, 86].forEach((m, i) => bell(12.95 + i * .05, m, .1, -.4 + i * .2, 2));
[0, 1, 2].forEach(i => click(13.75 + i * .15, .08, -.2 + i * .2, 2000));

/* Mix: duck the music on each kick, reverb the send, soft-clip, normalise, fade the tail. */
for (let i = 0; i < N; i++) {
  const t = i / SR; let d = 1;
  for (const k of kicks) if (t >= k && t < k + .3) d = Math.min(d, 1 - .6 * Math.exp(-(t - k) / .09));
  L[i] += mL[i] * d; R[i] += mR[i] * d;
}
function reverb(inp, sizes) {
  const out = new Float32Array(N);
  for (const n of sizes.comb) { const buf = new Float32Array(n); let j = 0, lp = 0; for (let i = 0; i < N; i++) { const y = buf[j]; lp = y * .6 + lp * .4; buf[j] = inp[i] + lp * .8; j = (j + 1) % n; out[i] += y * .25; } }
  for (const n of sizes.ap) { const buf = new Float32Array(n); let j = 0; for (let i = 0; i < N; i++) { const b = buf[j], y = -out[i] + b; buf[j] = out[i] + b * .5; j = (j + 1) % n; out[i] = y; } }
  return out;
}
const rl = reverb(vL, { comb: [1557, 1617, 1491, 1422, 1277, 1356], ap: [556, 441] });
const rr = reverb(vR, { comb: [1580, 1640, 1514, 1445, 1300, 1379], ap: [579, 464] });
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, (N - i) / (SR * .6));
  L[i] = Math.tanh((L[i] + rl[i] * .6) * 1.1) * fade; R[i] = Math.tanh((R[i] + rr[i] * .6) * 1.1) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const g = .89 / peak, buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * g * 32767), 46 + i * 4); }
const out = process.argv[2] || 'reel.wav';
fs.writeFileSync(out, buf);
console.log('wrote', out);
