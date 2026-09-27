#!/usr/bin/env node
// Synthesises the sound for the two logo reveals, on the cue times brand/motion.js reports, so picture and
// sound never drift apart. Everything is generated here: no samples, nothing to license.
//
//   node tools/brand-audio.js block out.wav [SPELLING]
//   node tools/brand-audio.js kufi out.wav [SPELLING]      (3LAYNA unless given, e.g. AALAYNA)
//
// Both end on the same three-note bell, the sound of the logo. The Kufi letters rise on a Hijaz scale
// (D, E flat, F sharp, G, A) played on a plucked string, the way an oud would.
'use strict';
const fs = require('fs');
const path = require('path');

global.self = global;
global.AalaynaLogo = require('../brand/logo.js');
global.Path2D = class {};
require('../brand/motion.js');

const which = process.argv[2] === 'kufi' ? 'kufi' : 'block';
const piece = global.AalaynaMotion[which]({ word: process.argv[4] });
const cue = piece.cues;
const SR = 48000, DUR = piece.duration + 0.6, N = Math.round(SR * DUR);
const L = new Float32Array(N), R = new Float32Array(N), vL = new Float32Array(N), vR = new Float32Array(N);
let seed = which === 'kufi' ? 11 : 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;

function voice(t0, len, fn, { gain = 1, pan = 0, send = 0 } = {}) {
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4), gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  const s0 = Math.max(0, Math.round(t0 * SR)), n = Math.min(Math.round(len * SR), N - s0);
  for (let i = 0; i < n; i++) {
    const v = fn(i / SR, i);
    L[s0 + i] += v * gl; R[s0 + i] += v * gr;
    if (send) { vL[s0 + i] += v * gl * send; vR[s0 + i] += v * gr * send; }
  }
}
function bandpass() {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x, f, q) => {
    const w = (TAU * Math.min(f, SR * 0.45)) / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const y = (al * x - al * x2 + 2 * Math.cos(w) * y1 - (1 - al) * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; return y;
  };
}

/* Instruments */
const click = (t, g = 0.2, pan = 0, f = 3200) => voice(t, 0.03, s => (Math.sin(TAU * f * s) * 0.6 + noise() * 0.4) * Math.exp(-s * 260), { gain: g, pan, send: 0.1 });
const pop = (t, f = 500, g = 0.3, pan = 0) => { let ph = 0; voice(t, 0.12, s => { ph += (TAU * f * (1 + 1.4 * Math.min(1, s / 0.03))) / SR; return Math.sin(ph) * Math.exp(-s * 38); }, { gain: g, pan, send: 0.2 }); };
const tok = (t, f = 900, g = 0.3, pan = 0) => voice(t, 0.09, s => (Math.sin(TAU * f * s) + 0.5 * Math.sin(TAU * f * 2.3 * s)) * Math.exp(-s * 55) * Math.min(1, s * 2000), { gain: g, pan, send: 0.18 });
const thud = (t, f = 70, g = 0.8) => { let ph = 0; voice(t, 0.4, s => { ph += (TAU * f * (1 + 1.5 * Math.exp(-s * 40))) / SR; return Math.tanh(1.6 * Math.sin(ph)) * Math.exp(-s * 12); }, { gain: g, send: 0.15 }); };
const stamp = (t, g = 0.35) => { const bp = bandpass(); voice(t, 0.2, s => bp(noise(), 1500, 0.8) * Math.exp(-s * 34) * 2.4, { gain: g, send: 0.3 }); };
const beep = (t, f = 1760, len = 0.09, g = 0.12) => voice(t, len, s => Math.sin(TAU * f * s) * Math.min(1, s * 600, (len - s) * 600), { gain: g, send: 0.2 });
const bell = (t, m, g = 0.2, pan = 0, len = 2.2) => { const f = hz(m); voice(t, len, s => (Math.sin(TAU * f * s) + 0.45 * Math.sin(TAU * f * 2.76 * s) * Math.exp(-s * 5) + 0.2 * Math.sin(TAU * f * 5.4 * s) * Math.exp(-s * 9)) * Math.exp(-s * 2.6) * Math.min(1, s * 400), { gain: g, pan, send: 0.45 }); };
function whoosh(t, len, g = 0.4, f0 = 300, f1 = 3500, pan0 = 0, pan1 = 0) {
  const bp = bandpass(), bp2 = bandpass(), s0 = Math.round(t * SR), n = Math.round(len * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const k = i / n, f = f0 * Math.pow(f1 / f0, k), env = Math.pow(Math.sin(Math.PI * Math.pow(k, 0.7)), 2);
    const v = (bp(noise(), f, 1.2) + 0.5 * bp2(noise(), f * 1.9, 3)) * env * g;
    const pn = pan0 + (pan1 - pan0) * k, gl = Math.cos(((pn + 1) * Math.PI) / 4), gr = Math.sin(((pn + 1) * Math.PI) / 4);
    L[s0 + i] += v * gl; R[s0 + i] += v * gr; vL[s0 + i] += v * gl * 0.25; vR[s0 + i] += v * gr * 0.25;
  }
}
// Plucked string (Karplus-Strong) with a little body: close enough to an oud for four notes.
function pluck(t, m, g = 0.35, pan = 0, len = 1.6) {
  const f = hz(m), n = Math.round(SR / f), buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = noise() * (i < n / 2 ? 1 : 0.6);
  let j = 0, prev = 0, dcx = 0, dcy = 0; const body = bandpass();
  voice(t, len, s => {
    const y = buf[j], nx = 0.5 * (y + buf[(j + 1) % n]) * 0.994;
    buf[j] = nx; j = (j + 1) % n;
    const raw = y * 0.8 + body(y, 300, 1.4) * 0.45 + (y - prev) * 0.2; prev = y;
    dcy = raw - dcx + 0.995 * dcy; dcx = raw;            // DC blocker: the noise burst is not zero-mean
    return dcy * Math.min(1, s * 900);
  }, { gain: g, pan, send: 0.3 });
}
// The sound of the logo: three bells, one per word of "scan, split, settle".
const signature = (t, g = 1) => [79, 84, 88].forEach((m, i) => bell(t + i * 0.07, m, 0.15 * g, -0.35 + i * 0.35, 2.4));

if (which === 'block') {
  cue.bloom.forEach(b => { if (rnd() < 0.2) click(b + 0.03, 0.03 + rnd() * 0.04, rnd() * 1.4 - 0.7, 2600 + rnd() * 3200); });
  cue.finders.forEach((t, i) => pop(t + 0.02, 520 + i * 110, 0.3, [-0.5, 0.5, -0.2][i]));
  whoosh(cue.scan[0] - 0.05, cue.scan[1] - cue.scan[0] + 0.1, 0.16, 900, 5200);
  beep(cue.scan[1] - 0.02, 1760, 0.08, 0.1); beep(cue.scan[1] + 0.09, 2349, 0.1, 0.09);
  whoosh(cue.fly, 1.1, 0.42, 250, 3000, 0.6, -0.4);
  cue.lands.forEach(t => click(t, 0.035 + rnd() * 0.03, rnd() * 0.8 - 0.4, 1600 + rnd() * 1800));
  click(cue.snap, 0.3, 0, 2400); tok(cue.snap, 1300, 0.18);
  whoosh(cue.snap, 0.14, 0.12, 3000, 7000, -0.3, 0.3);
  whoosh(cue.lift, cue.hit - cue.lift, 0.12, 400, 1600);
  thud(cue.hit, 58, 0.85); stamp(cue.hit, 0.4); pop(cue.hit, 180, 0.35);
  signature(cue.hit + 0.02);
  [0, 1, 2].forEach(i => click(cue.tag + i * 0.1, 0.07, -0.2 + i * 0.2, 2000));
} else {
  whoosh(cue.drop, cue.land - cue.drop, 0.08, 3000, 700, 0.5, 0.5);
  tok(cue.land, 520, 0.4, 0.5); thud(cue.land, 90, 0.3);
  tok(cue.bounce, 600, 0.22, 0.5);
  // The pen writing: a dry scratch that travels right to left with it.
  const bp = bandpass(), s0 = Math.round(cue.run * SR), n = Math.round((cue.climb - cue.run + 0.3) * SR);
  for (let i = 0; i < n; i++) {
    const k = i / n, v = bp(noise(), 3800 + 1400 * Math.sin(i / 90), 2.2) * Math.sin(Math.PI * k) * 0.22, pn = 0.6 - 1.2 * Math.min(1, k * 1.3);
    L[s0 + i] += v * Math.cos(((pn + 1) * Math.PI) / 4); R[s0 + i] += v * Math.sin(((pn + 1) * Math.PI) / 4);
  }
  [62, 63, 66, 67].forEach((m, i) => pluck(cue.rises[i] + 0.02, m, 0.34, 0.5 - i * 0.25));
  [69, 74].forEach((m, i) => pluck(cue.climb + 0.05 + i * 0.09, m, 0.3 - i * 0.06, -0.6));
  cue.hops.forEach(([a, b], i) => { whoosh(a, b - a, 0.07, 800, 2400, -0.3 + i * 0.3, -0.1 + i * 0.3); tok(b, [760, 900, 1180][i], 0.34, [0.1, -0.1, -0.3][i]); });
  signature(cue.hops[2][1] + 0.02);
  for (let i = 0; i < 7; i++) click(cue.latin + i * 0.06 + 0.05, 0.06, -0.4 + i * 0.13, 2200 + i * 90);
  tok(cue.red, 1400, 0.22, 0.6);
  [0, 1, 2].forEach(i => click(cue.tag + i * 0.1, 0.06, -0.2 + i * 0.2, 2000));
}

/* Mix: reverb the send, soft-clip, normalise, fade the tail. */
function reverb(inp, sizes) {
  const out = new Float32Array(N);
  for (const n of sizes.comb) { const buf = new Float32Array(n); let j = 0, lp = 0; for (let i = 0; i < N; i++) { const y = buf[j]; lp = y * 0.6 + lp * 0.4; buf[j] = inp[i] + lp * 0.78; j = (j + 1) % n; out[i] += y * 0.25; } }
  for (const n of sizes.ap) { const buf = new Float32Array(n); let j = 0; for (let i = 0; i < N; i++) { const b = buf[j], y = -out[i] + b; buf[j] = out[i] + b * 0.5; j = (j + 1) % n; out[i] = y; } }
  return out;
}
const rl = reverb(vL, { comb: [1557, 1617, 1491, 1422, 1277, 1356], ap: [556, 441] });
const rr = reverb(vR, { comb: [1580, 1640, 1514, 1445, 1300, 1379], ap: [579, 464] });
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, (N - i) / (SR * 0.5));
  L[i] = Math.tanh((L[i] + rl[i] * 0.55) * 1.1) * fade; R[i] = Math.tanh((R[i] + rr[i] * 0.55) * 1.1) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const g = 0.89 / peak, buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * g * 32767), 46 + i * 4); }
const out = process.argv[3] || which + '.wav';
fs.writeFileSync(out, buf);
console.log('wrote', path.relative(process.cwd(), out));
