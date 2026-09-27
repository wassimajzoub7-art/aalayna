#!/usr/bin/env node
// Synthesises the film's soundtrack: a warm 96 bpm score (FM electric piano, additive pads, plucked strings, sub bass,
// soft drums) and a small set of interface sounds tuned to the chords, all on reel.html's cue times. The mix has
// per-bus EQ, a kick sidechain, a convolution reverb, a glue compressor and a limiter, and is normalised to -14 LUFS.
// Nothing is sampled, so there is no licence to clear.
//
//   node tools/reel-audio.js [out.wav]
'use strict';
const fs = require('fs');

const SR = 48000, DUR = 75, N = SR * DUR;
const BEAT = .75, S16 = BEAT / 4, BAR = BEAT * 4, O16 = .15625; // 80 bpm; bar 24 (72 s) is the logo. O16: a sixteenth on the material's clock
const TAU = Math.PI * 2;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const p = (t, a, b) => clamp((t - a) / (b - a));
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const db = x => Math.pow(10, x / 20);

/* ---------- Buses and voices ---------- */
const BUSES = ['kick', 'drums', 'bass', 'keys', 'pad', 'pluck', 'bell', 'fx', 'amb', 'rev', 'dly'];
const bus = {};
for (const b of BUSES) bus[b] = [new Float32Array(N), new Float32Array(N)];
const kicks = [];
// The film plays its material in story order (reel.html's SEG): film time T0-T1 shows material time a-b.
const SEG = [[0, 6, 11.96, 11.96], [6, 18, 11.96, 19.2], [18, 24, 19.2, 19.2], [24, 37.32, 0, 11.1], [37.32, 40.137, 11.1, 13.75],
  [40.137, 62.5, 19.2, 34.375], [62.5, 70.5, 34.375, 41.25], [70.5, 75, 41.25, 45]];
const M = t => SEG.filter(([, , a, b]) => b > a && t >= a - 1e-9 && t < b + (b === 45 ? 1 : 0)).map(([T0, T1, a, b]) => T0 + (t - a) * (T1 - T0) / (b - a));
let MAP = false;                                              // while true, times given to voices are material times
const mapped = (t0, go) => { MAP = false; M(t0).forEach(go); MAP = true; };
// Adds fn(s) for len seconds from t0 to a bus, panned, with reverb and delay sends. trem: stereo tremolo depth.
function voice(t0, len, fn, o = {}) {
  if (MAP) return mapped(t0, x => voice(x, len, fn, o));
  const { gain = 1, pan = 0, to = 'fx', rev = 0, dly = 0, trem = 0 } = o;
  const [bl, br] = bus[to], [rl, rr] = bus.rev, [dl, dr] = bus.dly;
  const s0 = Math.round(t0 * SR), n = Math.round(len * SR);
  let gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
  const fo = Math.round(.005 * SR);
  for (let i = 0; i < n; i++) {
    const j = s0 + i;
    if (j >= N) break;
    const v = fn(i / SR, i) * gain * (n - i < fo ? (n - i) / fo : 1);
    if (j < 0) continue;
    if (trem) { const pn = clamp(pan + trem * Math.sin(TAU * 4.4 * (j / SR)), -1, 1); gl = Math.cos((pn + 1) * Math.PI / 4); gr = Math.sin((pn + 1) * Math.PI / 4); }
    bl[j] += v * gl; br[j] += v * gr;
    if (rev) { rl[j] += v * gl * rev; rr[j] += v * gr * rev; }
    if (dly) { dl[j] += v * gl * dly; dr[j] += v * gr * dly; }
  }
}

/* ---------- Filters ---------- */
// RBJ biquads: lp, hp, bp (0 dB peak), peak, ls, hs.
function biquad(type, f, q = .707, gainDb = 0) {
  const w = TAU * Math.min(f, SR * .45) / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  else if (type === 'ls') {
    const sq = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) - (A - 1) * cw + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sq);
    a0 = (A + 1) + (A - 1) * cw + sq; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sq;
  } else {
    const sq = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq);
    a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return x => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
function eq(name, ...specs) {                                  // run a chain of biquads over both channels of a bus
  for (const ch of bus[name]) { const fs = specs.map(s => biquad(...s)); for (let i = 0; i < N; i++) { let v = ch[i]; for (const f of fs) v = f(v); ch[i] = v; } }
}
// Topology-preserving state-variable filter, for sweeps.
function svf() {
  let ic1 = 0, ic2 = 0;
  return (x, f, q = .707) => {
    const g = Math.tan(Math.PI * Math.min(f, SR * .45) / SR), k = 1 / q, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    svf.bp = v1; return v2;
  };
}
// Pink-ish noise (Paul Kellet's economy filter).
function pink() { let b0 = 0, b1 = 0, b2 = 0; return () => { const w = noise(); b0 = .99765 * b0 + w * .099046; b1 = .963 * b1 + w * .2965164; b2 = .57 * b2 + w * 1.0526913; return (b0 + b1 + b2 + w * .1848) * .25; }; }

/* ---------- Instruments ---------- */
// Electric piano: two FM pairs, a warm 1:1 body with a falling index and a short 14:1 tine, stereo tremolo.
function ep(t0, m, len, vel = .7, o = {}) {
  const f = hz(m), dk = .75 + Math.max(0, m - 48) * .035, rel = o.rel || .22;
  voice(t0, len + rel * 3, s => {
    const a = Math.min(1, s / .0025), d = Math.exp(-s * dk), r = s < len ? 1 : Math.exp(-(s - len) * 3 / rel);
    const I = (.35 + 1.5 * vel) * Math.exp(-s * 2.6) + .18;
    const body = Math.sin(TAU * f * s + I * Math.sin(TAU * f * s));
    const tine = Math.sin(TAU * f * s + (1 + 2.4 * vel) * Math.exp(-s * 38) * Math.sin(TAU * 14 * f * s)) * .16 * Math.exp(-s * 11);
    return (body + tine) * a * d * r * (.3 + .7 * vel);
  }, { gain: o.gain ?? .1, pan: o.pan ?? 0, to: 'keys', rev: o.rev ?? .16, trem: o.trem ?? .28 });
}
const chordEP = (t0, notes, len, vel, o = {}) => notes.forEach((m, i) => ep(t0 + i * (o.roll || 0), m, len, vel * (i === notes.length - 1 ? 1 : .88), { ...o, pan: (i / (notes.length - 1) - .5) * .5 }));
// Pads: additive wavetables (soft partials), three detuned voices per note, slow attack.
const TBL = 4096;
function table(amp) { const t = new Float32Array(TBL + 1); for (let n = 1; n <= 24; n++) { const a = amp(n); if (!a) continue; const ph = rnd() * TAU; for (let i = 0; i <= TBL; i++) t[i] += a * Math.sin(TAU * n * i / TBL + ph); } let mx = 0; for (const v of t) mx = Math.max(mx, Math.abs(v)); for (let i = 0; i <= TBL; i++) t[i] /= mx; return t; }
const PAD = table(n => Math.exp(-(n - 1) / 2.6) / n), WARM = table(n => (n <= 6 ? 1 / (n * n) : 0));
function pad(t0, notes, len, g = .03, o = {}) {
  const atk = o.atk ?? .7, rel = o.rel ?? 1.1, tb = o.table || PAD;
  for (const m of notes) for (const [c, pn] of [[-6, -.7], [0, 0], [6, .7]]) {
    const inc = hz(m) * Math.pow(2, c / 1200) / SR * TBL; let ph = rnd() * TBL;
    voice(t0, len + rel, s => {
      ph += inc; if (ph >= TBL) ph -= TBL;
      const i = ph | 0, fr = ph - i, v = tb[i] + (tb[i + 1] - tb[i]) * fr;
      const e = (s < atk ? Math.sin(Math.PI / 2 * s / atk) : 1) * (s > len ? Math.max(0, 1 - (s - len) / rel) : 1);
      return v * e * e;
    }, { gain: g / Math.sqrt(notes.length), pan: pn, to: o.to || 'pad', rev: o.rev ?? .3 });
  }
}
// Plucked string (Karplus-Strong with an allpass for exact tuning and a pick-position comb).
function pluck(t0, m, g = .1, o = {}) {
  const f = hz(m), P = SR / f, L = Math.floor(P - .6), d = P - L - .5, C = (1 - d) / (1 + d);
  const buf = new Float32Array(L), br = o.bright ?? .45, t60 = o.t60 ?? 1.4, loss = Math.pow(10, -3 / (t60 * f));
  let lp = 0; const ex = new Float32Array(L);
  for (let i = 0; i < L; i++) { lp += br * (noise() - lp); ex[i] = lp; }
  const pk = Math.max(1, Math.round(L * .14)); let mean = 0;
  for (let i = 0; i < L; i++) { buf[i] = ex[i] - (i >= pk ? ex[i - pk] : 0); mean += buf[i] / L; }
  for (let i = 0; i < L; i++) buf[i] -= mean;
  let idx = 0, prev = 0, ax = 0, ay = 0;
  voice(t0, o.len ?? Math.min(3, t60 * 1.2), s => {
    const y = buf[idx], avg = .5 * (y + prev); prev = y;
    const ap = C * avg + ax - C * ay; ax = avg; ay = ap;
    buf[idx] = ap * loss; idx = idx + 1 === L ? 0 : idx + 1;
    return y * Math.min(1, s / .001);
  }, { gain: g, pan: o.pan ?? 0, to: o.to || 'pluck', rev: o.rev ?? .22, dly: o.dly ?? .18 });
}
// Soft glockenspiel.
function bell(t0, m, g = .05, o = {}) {
  const f = hz(m), P = [[1, 1, 1.9], [2.76, .2, 4], [5.4, .07, 7], [8.93, .025, 11]];
  voice(t0, o.len ?? 2.4, s => P.reduce((a, [r, amp, dk]) => a + amp * Math.sin(TAU * f * r * s) * Math.exp(-s * dk), 0) * Math.min(1, s / .0015), { gain: g, pan: o.pan ?? 0, to: 'bell', rev: o.rev ?? .35, dly: o.dly ?? .1 });
}
// Sub bass: sine with a little 2nd and 3rd harmonic so small speakers can hear it.
function bass(t0, m, len, g = .22) {
  const f = hz(m); let ph = 0;
  voice(t0, len + .08, s => {
    ph += f / SR;
    const e = Math.min(1, s / .006) * (s > len ? Math.max(0, 1 - (s - len) / .08) : 1) * (.8 + .2 * Math.exp(-s * 6));
    return Math.tanh(1.4 * (.85 * Math.sin(TAU * ph) + .45 * Math.sin(2 * TAU * ph) + .14 * Math.sin(3 * TAU * ph))) * e;
  }, { gain: g, to: 'bass' });
}

/* ---------- Drums ---------- */
function kick(t0, g = 1) {
  if (MAP) return mapped(t0, x => kick(x, g));
  kicks.push(t0);
  let ph = 0; const lp = biquad('lp', 3500);
  voice(t0, .55, s => {
    ph += TAU * (50 + 70 * Math.exp(-s * 22) + 30 * Math.exp(-s * 180)) / SR;
    const body = Math.sin(ph) * Math.exp(-s * 6.2) * Math.min(1, s / .0012);
    const click = s < .005 ? noise() * .1 * (1 - s / .005) : 0;
    return Math.tanh(1.25 * lp(body + click));
  }, { gain: g * .55, to: 'kick' });
}
function clap(t0, g = .1, pan = .08) {
  const bp = biquad('bp', 1350, .9), bp2 = biquad('bp', 2600, 1.4);
  voice(t0, .4, s => {
    const e = [0, .008, .017].reduce((a, dd, k) => a + (s >= dd ? Math.exp(-(s - dd) * (k < 2 ? 160 : 26)) : 0), 0);
    const n = noise(); return (bp(n) * 2.2 + bp2(n) * .9) * e;
  }, { gain: g, pan, to: 'drums', rev: .22 });
}
function snap(t0, g = .07, pan = -.15) {
  const bp = biquad('bp', 2300, 1.2);
  voice(t0, .15, s => bp(noise()) * 3 * (Math.exp(-s * 70) + .2 * Math.exp(-s * 20)) + Math.sin(TAU * 1180 * s) * .12 * Math.exp(-s * 80), { gain: g, pan, to: 'drums', rev: .25 });
}
function hat(t0, g = .03, open = false, pan = .22) {
  const hp = biquad('hp', 7200, .8), bp = biquad('bp', 10500, 1.2);
  voice(t0, open ? .35 : .09, s => { const n = noise(); return (hp(n) * .7 + bp(n) * .8) * Math.exp(-s * (open ? 11 : 60)) * Math.min(1, s / .0008); }, { gain: g, pan, to: 'drums', rev: .05 });
}
function shaker(t0, g = .012, pan = -.3) {
  const bp = biquad('bp', 6200, .9);
  voice(t0, .1, s => bp(noise()) * (s < .012 ? s / .012 : Math.exp(-(s - .012) * 45)), { gain: g, pan, to: 'drums' });
}
function crash(t0, g = .04, len = 2.2) {
  const hp = biquad('hp', 4200, .7), lp = biquad('lp', 12000, .7), hp2 = biquad('hp', 4200, .7), lp2 = biquad('lp', 12000, .7);
  voice(t0, len, s => lp(hp(noise())) * Math.exp(-s * 2.2) * Math.min(1, s / .002), { gain: g, pan: -.35, to: 'drums', rev: .3 });
  voice(t0, len, s => lp2(hp2(noise())) * Math.exp(-s * 2.4) * Math.min(1, s / .003), { gain: g, pan: .35, to: 'drums', rev: .3 });
}
// Reverse cymbal into t1: noise swelling to a hard stop.
function swell(t1, len, g = .05, f0 = 1800) {
  const hp = biquad('hp', f0, .7), sv = svf();
  voice(t1 - len, len, s => { const k = s / len; return sv(hp(noise()), 2000 + 9000 * k * k, .8) * Math.pow(k, 2.6) * Math.min(1, (len - s) / .006); }, { gain: g, to: 'fx', rev: .2 });
}

/* ---------- Sound design ---------- */
// Soft mallet tap, tuned: the phone's taps and small UI moments.
function tock(t0, m, g = .05, pan = .1) { const f = hz(m); voice(t0, .3, s => Math.sin(TAU * f * s + 1.1 * Math.exp(-s * 55) * Math.sin(TAU * 4 * f * s)) * Math.exp(-s * 18) * Math.min(1, s / .0012), { gain: g, pan, to: 'fx', rev: .12 }); }
function pop(t0, m, g = .05, pan = 0) { const f = hz(m); let ph = 0; voice(t0, .16, s => { ph += TAU * f * (1 + .5 * Math.min(1, s / .035)) / SR; return Math.sin(ph) * Math.exp(-s * 30) * Math.min(1, s / .002); }, { gain: g, pan, to: 'fx', rev: .15 }); }
// Air: filtered noise whose cutoff rises (in) or falls (out), for camera moves. Kept low.
function air(t0, len, g = .03, f0 = 300, f1 = 2400, pan0 = 0, pan1 = 0) {
  if (MAP) return mapped(t0, x => air(x, len, g, f0, f1, pan0, pan1));
  const nz = pink(), sv = svf(), s0 = Math.round(t0 * SR), n = Math.round(len * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const k = i / n, f = f0 * Math.pow(f1 / f0, k), e = Math.pow(Math.sin(Math.PI * k), 1.6) * g;
    const v = sv(nz() * 3, f, 1.1) * e, pn = pan0 + (pan1 - pan0) * k, gl = Math.cos((pn + 1) * Math.PI / 4), gr = Math.sin((pn + 1) * Math.PI / 4);
    bus.fx[0][s0 + i] += v * gl; bus.fx[1][s0 + i] += v * gr; bus.rev[0][s0 + i] += v * gl * .2; bus.rev[1][s0 + i] += v * gr * .2;
  }
}
function boom(t0, g = .35, f0 = 58) { let ph = 0; voice(t0, 1.1, s => { ph += TAU * (f0 - 20 * (1 - Math.exp(-s * 5))) / SR; return Math.sin(ph) * Math.exp(-s * 3.2) * Math.min(1, s / .003); }, { gain: g, to: 'kick' }); }
function thock(t0, g = .2) { const bp = biquad('bp', 900, 1.1); let ph = 0; voice(t0, .25, s => { ph += TAU * (160 * (1 + Math.exp(-s * 40))) / SR; return Math.sin(ph) * Math.exp(-s * 22) + bp(noise()) * 1.5 * Math.exp(-s * 45); }, { gain: g, to: 'fx', rev: .15 }); }
function woodblock(t0, f, g = .04, pan = .45) { const bp = biquad('bp', f, 14), bp2 = biquad('bp', f * 1.51, 10); voice(t0, .12, (s, i) => { const x = i < 30 ? noise() * (1 - i / 30) : 0; return (bp(x) + .5 * bp2(x)) * 9; }, { gain: g, pan, to: 'fx', rev: .12 }); }
function clink(t0, g = .02, pan = 0, base = 2600) { voice(t0, .7, s => [[1, 1, 7], [1.51, .5, 10], [2.72, .3, 14], [3.8, .12, 20]].reduce((a, [r, amp, dk]) => a + amp * Math.sin(TAU * base * r * s) * Math.exp(-s * dk), 0) * Math.min(1, s / .0008), { gain: g, pan, to: 'amb', rev: .4 }); }
function coin(t0, g = .025, pan = .2) { voice(t0, .35, s => [[1, 1, 18], [2.41, .6, 26], [4.13, .35, 34], [5.62, .2, 40]].reduce((a, [r, amp, dk]) => a + amp * Math.sin(TAU * 3100 * r * s) * Math.exp(-s * dk), 0) * Math.min(1, s / .0006), { gain: g, pan, to: 'fx', rev: .25 }); }
function key(t0, g = .018) { const bp = biquad('bp', 2800 + rnd() * 900, 1.4); voice(t0, .05, s => bp(noise()) * 3 * Math.exp(-s * 140) + Math.sin(TAU * 210 * s) * .3 * Math.exp(-s * 120), { gain: g, pan: -.2, to: 'fx', rev: .05 }); }
function tear(t0, len = .2, g = .03) { const bp = biquad('bp', 2600, .8); let e = 0; voice(t0, len, s => { if (rnd() < .06) e = .4 + rnd() * .6; e *= .93; return bp(noise()) * e * 3 * Math.sin(Math.PI * s / len); }, { gain: g, to: 'fx', rev: .1 }); }
function glide(t0, len, m0, m1, g = .02, pan = 0) { let ph = 0; voice(t0, len, s => { const k = s / len; ph += TAU * hz(m0 + (m1 - m0) * k) / SR; return Math.sin(ph) * Math.sin(Math.PI * k); }, { gain: g, pan, to: 'fx', rev: .3 }); }
function sparkle(t0, len, n, g = .02, notes = [84, 86, 88, 91, 93, 96, 98, 100]) { for (let k = 0; k < n; k++) bell(t0 + len * Math.pow(k / n, 1.2), notes[Math.floor(rnd() * notes.length)], g * (1 - .5 * k / n), { pan: rnd() * 1.6 - .8, len: 1, rev: .45 }); }

/* ---------- Harmony ---------- */
// Rootless keyboard voicings; bass roots; pads double the root an octave up.
const CH = {
  Cmaj9: [36, [59, 62, 64, 67]], Am9: [45, [60, 64, 67, 71]], Fmaj9: [41, [60, 64, 67, 69]], Em7: [40, [59, 62, 64, 67]],
  Dm9: [38, [60, 64, 65, 69]], G13s: [43, [60, 64, 65, 69]], G13: [43, [59, 64, 65, 69]],
  Abmaj7: [32, [60, 63, 67, 68]], Fm6: [29, [60, 62, 65, 68]], G7b9: [31, [59, 62, 65, 68]],
};
// Chords on the film's clock: the table (0-24), the wait (24-35, darker), the guest's payment and the room.
const PROG = [[0, 'Cmaj9'], [3, 'Am9'], [6, 'Fmaj9'], [9, 'Em7'], [12, 'Dm9'], [15, 'G13s'], [16.5, 'G13'], [18, 'Cmaj9'], [21, 'Am9'],
  [24, 'Cmaj9'], [27.18, 'Abmaj7'], [30, 'Fm6'], [31.5, 'G7b9'], [33.75, 'Fmaj9'], [34.125, 'G13'], [34.5, 'Cmaj9'],
  [36, 'Am9'], [39, 'Fmaj9'], [42, 'Dm9'], [43.5, 'G13'], [45, 'Cmaj9'], [48, 'Am9'], [51, 'Fmaj9'], [54, 'G13s'], [55.5, 'G13'], [57, 'Cmaj9'],
  [60, 'Am9'], [61.5, 'G13'], [63, 'Fmaj9'], [66, 'Em7'], [67.5, 'Am9'], [69, 'Dm9'], [70.5, 'G13'], [72, 'Cmaj9']];
const chordAt = t => { let c = PROG[0][1]; for (const [a, n] of PROG) if (t + 1e-6 >= a) c = n; return CH[c]; };
const toneAt = (t, k, oct = 1) => { const v = chordAt(t)[1]; return v[((k % v.length) + v.length) % v.length] + 12 * (oct + Math.floor(k / v.length)); };
const toneAtO = (t, k, oct) => toneAt(M(t)[0] ?? t, k, oct);

/* ---------- The table: they sit down, read the menu, order, eat (0-24) ---------- */
{
  const nz = pink(), lp = biquad('lp', 900), lp2 = biquad('lp', 900);
  voice(0, 24.2, s => lp(nz()) * (.6 + .4 * Math.sin(s * 1.3) * Math.sin(s * .7 + 1)) * Math.min(1, s / 1.2) * Math.min(1, (24.2 - s) / .6), { gain: .07, pan: -.3, to: 'amb' });
  voice(0, 24.2, s => lp2(nz()) * (.6 + .4 * Math.sin(s * 1.1 + 2)) * Math.min(1, s / 1.2) * Math.min(1, (24.2 - s) / .6), { gain: .07, pan: .3, to: 'amb' });
  [[1.2, -.5], [3.4, .4], [5.1, -.2], [19.9, .3], [20.15, -.4], [20.4, .5], [21.3, -.3], [22.2, .2]].forEach(([x, pn], i) => clink(x, .012 + .004 * (i % 2), pn, 2400 + i * 150));
}
chordEP(.4, CH.Cmaj9[1], 2.5, .5, { roll: .03 }); pad(.2, CH.Cmaj9[1].map(m => m + 12), 2.9, .016, { atk: 1.2 }); bass(.4, 36, 2.5, .1);
chordEP(3, CH.Am9[1], 2.8, .5, { roll: .03 }); pad(3, CH.Am9[1].slice(0, 3).map(m => m + 12), 3, .016, { atk: .8 }); bass(3, 45, 2.8, .1);

/* ---------- The wait, on the material's cues stretched to 80 bpm (24-35) ---------- */
pad(24.12, [59, 64, 67, 71], 3, .018, { atk: 1 });
chordEP(24.36, CH.Cmaj9[1], 2.64, .55, { roll: .03 }); bass(24.36, 36, 2.64, .12);
pad(27.12, [56, 63, 67, 72], 2.88, .02); chordEP(27.18, CH.Abmaj7[1], 2.64, .5, { roll: .025 }); bass(27.18, 32, 2.7, .14);
chordEP(30, CH.Fm6[1], 1.38, .52); bass(30, 29, 1.38, .15); pad(30, [56, 60, 65, 68], 1.44, .022, { atk: .3, rel: .3 });
chordEP(31.5, CH.G7b9[1], 1.32, .58); bass(31.5, 31, 1.44, .17); pad(31.5, [55, 59, 62, 65], 1.5, .024, { atk: .2, rel: .2 });
[[33.75, 'Fmaj9'], [34.125, 'G13'], [34.5, 'Cmaj9']].forEach(([x, c], i) => {
  chordEP(x, CH[c][1], i === 2 ? 1.1 : .31, .9, { gain: .12 }); pad(x, CH[c][1].map(m => m + 12), i === 2 ? 1.1 : .34, .016, { atk: .02, rel: .3 });
  bass(x, CH[c][0], i === 2 ? .72 : .31, .22); kick(x, i === 2 ? 1 : .8); clap(x, .11);
});

/* ---------- The groove ---------- */
// L: light (reading the menu, dinner). in: intro. A: the guest pays. thin: pull-outs. build: the rise. B: the room.
const SECT = [[6, 'L'], [22.5, 'none'], [35.25, 'in'], [36, 'A'], [37.32, 'gap'], [38.25, 'A'], [43.4, 'thin'], [45, 'A'], [57.5, 'thin'], [59.25, 'A2'], [61, 'build'], [63, 'B'], [70.5, 'end']];
const sectAt = t => { let s = 'none'; for (const [a, n] of SECT) if (t + 1e-6 >= a) s = n; return s; };
for (let i = Math.round(6 / S16); i * S16 < 70.5 - 1e-6; i++) {
  const t = i * S16, sx = sectAt(t), pos = i % 16, sw = pos % 2 ? S16 * .12 : 0, full = sx === 'A' || sx === 'B' || sx === 'A2', lite = sx === 'L';
  if (sx === 'gap' || sx === 'none' || sx === 'end') continue;
  if (lite) {
    if (pos === 0 || pos === 8) kick(t, .6);
    if (pos === 4 || pos === 12) snap(t, .04);
    if (pos % 4 === 2) hat(t, .018, false, .2);
    shaker(t + sw, .008);
    continue;
  }
  if (pos % 4 === 0 && (full || sx === 'in' || (sx === 'thin' && pos % 8 === 0))) kick(t, sx === 'B' ? .95 : .85);
  if (pos === 14 && full && Math.floor(i / 16) % 2) kick(t, .35);
  if ((pos === 4 || pos === 12) && (full || sx === 'thin')) { clap(t, sx === 'thin' ? .06 : .085); snap(t + .012, .05); }
  if (pos % 4 === 2 && sx !== 'build') hat(t, full ? .034 : .022, sx === 'B' && pos % 8 === 6, .2);
  if (pos % 2 === 1 && full) hat(t + sw, .012 + (pos % 4 === 3 ? .004 : 0), false, .3);
  if (full || sx === 'thin') shaker(t + sw, sx === 'B' ? .014 : .01);
  if (sx === 'build') { const k = p(t, 61, 63); if (pos % 2 === 0 || t > 62.2) snap(t, .025 + .06 * k * k, (pos % 4) / 4 - .4); }
}
[6, 45, 63].forEach(x => crash(x, x === 6 ? .015 : .03));
const BL = [[0, 5, 0, .95], [6, 2, 0, .7], [8, 3, 7, .8], [11, 2, 0, .65], [14, 2, 12, .7]];
const KP = [[0, 5, .72], [6, 3, .52], [10, 5, .6]];
for (let bar = 2; bar < 24; bar++) {
  const t0 = bar * BAR;
  for (const [pos, len, iv, v] of BL) {
    const t = t0 + pos * S16, sx = sectAt(t);
    if (sx === 'none' || sx === 'gap' || sx === 'end' || (sx === 'build' && t > 62.2) || (t >= 22.5 && t < 35.25)) continue;
    if ((sx === 'thin' || sx === 'L') && pos > 8) continue;
    bass(t, chordAt(t)[0] + iv, len * S16 * .92 * (sx === 'thin' ? 3 : 1), .2 * v * (sx === 'L' ? .8 : 1));
  }
  for (const [pos, len, v] of KP) {
    const t = t0 + pos * S16, sx = sectAt(t);
    if (sx === 'none' || sx === 'gap' || sx === 'end' || sx === 'build' || (t >= 22.5 && t < 35.25)) continue;
    if (sx === 'thin' && pos > 0) continue;
    chordEP(t, chordAt(t)[1], len * S16 * (sx === 'thin' ? 4 : 1), v * (sx === 'B' ? 1.05 : sx === 'L' ? .85 : 1), { roll: .008 });
  }
}
bass(35.25, 36, .6, .18); chordEP(35.25, CH.Cmaj9[1], .6, .6);
for (let k = 0; k < PROG.length - 1; k++) {
  const [a, c] = PROG[k], b = PROG[k + 1][0];
  if (a < 6 || (a >= 22.5 && a < 35.25) || a >= 70.5) continue;
  const [, v] = CH[c]; pad(a, v.slice(0, 3).map(m => m + 12), b - a, sectAt(a) === 'B' ? .024 : .017, { atk: .35, rel: .6 });
}
for (let i = Math.round(9 / S16); i * S16 < 70.5 - 1e-6; i++) {
  const t = i * S16, sx = sectAt(t), pos = i % 16;
  if (!(sx === 'A' || sx === 'B' || sx === 'A2' || sx === 'L')) continue;
  if (sx === 'L' && pos % 8 !== 2) continue;
  if ((sx === 'A' || sx === 'A2') && pos % 4 !== 2) continue;
  if (sx === 'B' && pos % 2 !== 0) continue;
  const k = sx === 'B' ? [0, 2, 1, 3, 2, 4, 3, 1][(pos / 2) % 8] : [0, 2, 1, 3][Math.floor(pos / 4) % 4];
  pluck(t, toneAt(t, k, 1), sx === 'B' ? .05 : .04, { pan: pos % 8 < 4 ? -.4 : .4, bright: sx === 'B' ? .55 : .42, t60: 1.1 });
}
// The close: the logo lands on bar 24 and rings out.
kick(72, .9); crash(72, .03, 3);
chordEP(72, CH.Cmaj9[1], 2.8, .8, { roll: .02, gain: .11 }); ep(72, 64, 2.8, .6, { gain: .08 });
bass(72, 36, 2.9, .2); pad(72, [60, 67, 71, 74, 76, 83], 2.9, .026, { atk: .05, rel: .3 });

/* ---------- Sound effects, on the material's cues ---------- */
MAP = true;
/* ---------- Act 1: the wait (0-7.5) ---------- */
{
  const nz = pink(), lp = biquad('lp', 900), lp2 = biquad('lp', 900);
  voice(0, 7.7, s => lp(nz()) * (.6 + .4 * Math.sin(s * 1.3) * Math.sin(s * .7 + 1)) * Math.min(1, s / .8) * Math.min(1, (7.7 - s) / .3), { gain: .09, pan: -.3, to: 'amb' });
  voice(0, 7.7, s => lp2(nz()) * (.6 + .4 * Math.sin(s * 1.1 + 2)) * Math.min(1, s / .8) * Math.min(1, (7.7 - s) / .3), { gain: .09, pan: .3, to: 'amb' });
  [[.9, -.5], [2.1, .4], [3.4, -.2], [5.2, .5], [6.5, -.4]].forEach(([x, pn], i) => clink(x, .012 + .004 * (i % 2), pn, 2400 + i * 180));
}
air(2.5, .75, .018, 900, 300);                               // the bill slides in
thock(3.15, .09);
// The clock tightens: quarters, eighths, then sixteenths.
{
  const ticks = [4.375, 5, 5.3125, 5.625, 5.9375]; for (let x = 6.25; x < 7.45; x += O16) ticks.push(x);
  ticks.forEach((x, i) => woodblock(x, i % 2 ? 1500 : 1900, .03 + .05 * p(x, 4.3, 7.4)));
}
[[4.3, 63], [4.95, 60], [5.6, 62]].forEach(([x, m]) => tock(x, m, .07, -.35));   // the three problems
[0, 1, 2].forEach(i => coin(5.6 + i * .12, .018));
clink(5.75, .02, .55, 3100);                                  // the waiter's tray goes by
// A short Hijaz run on G as the dot falls; the dot lands on the bill.
[67, 68, 71, 72, 74].forEach((m, i) => pluck(6.25 + i * O16 * 2, m, .045, { pan: .2, t60: 1, bright: .5 }));
glide(7.1, .4, 91, 72, .018);
swell(7.5, 1.1, .03);

boom(7.5, .4); kick(7.5, .9); crash(7.5, .035);
air(7.55, .55, .035, 200, 2600);                              // red floods the frame
[76, 79, 84].forEach((m, i) => bell(8.75 + i * .12, m, .04, { pan: -.3 + i * .3 }));     // the Aalayna motif
/* ---------- The guest's journey: tuned interface sounds ---------- */
air(11.1, .5, .03, 3000, 700, .6, -.7);                       // the words whip off
swell(11.875, .6, .02, 3000);
bell(11.875, 96, .04); bell(11.875, 84, .03);                // the red becomes the QR dot
air(12.05, .8, .014, 250, 900);                               // the phone lifts
air(12.95, .8, .022, 300, 2000);                              // into the phone
[[13.8, 88], [13.86, 91]].forEach(([x, m]) => tock(x, m, .025, .2));
glide(13.95, .3, 84, 96, .01, .2);                            // the scan line
pop(14.2, 79, .05);                                           // scanned
const TAPS = [14.45, 15.35, 15.95, 16.45, 17.35, 17.65, 18.6, 18.85, 19.45, 20.2, 20.65, 21.0, 27.85, 29.75, 31.05];
TAPS.forEach((x, i) => tock(x, toneAtO(x, i % 4, 2), .045));
air(15.45, .4, .01, 700, 2200);                               // the filter sheet rises
pop(15.97, 84, .035);                                         // Vegetarian on
air(16.5, .3, .008, 2200, 700);                               // Done: the sheet drops
[[16.6, 79], [16.7, 76]].forEach(([x, m]) => pluck(x, m, .022, { pan: -.25, t60: .8, dly: .1 }));   // two dishes fade
pop(16.62, 88, .018);                                         // the badge
[0, 1, 2].forEach(i => pluck(17.69 + i * .06, toneAtO(17.69, 2 - i, 2), .03, { pan: .3, t60: .7, dly: .1 }));     // العربية
[0, 1, 2].forEach(i => pluck(18.89 + i * .06, toneAtO(18.89, i, 2), .03, { pan: .3, t60: .7, dly: .1 }));         // English
[19.65, 20.4].forEach(x => air(x, .35, .01, 1200, 3200, .4, -.2));
[[20.67, 88], [21.02, 91]].forEach(([x, m]) => pop(x + .02, m, .03, .2));
air(21.3, .9, .024, 2200, 300);                               // back out to the table
[60, 64, 67, 71, 74, 76].forEach((m, i) => pluck(21.75 + i * .09, m + 12, .035, { pan: -.2 + i * .08, t60: .8 }));   // the receipt prints
thock(22.5, .16); boom(22.5, .22, 70); bell(22.5, 84, .03);  // ÷ 4, on the downbeat
tear(22.65, .2, .035);
air(22.8, .6, .012, 800, 2600);
[0, 1, 2, 3].forEach(i => pluck(23.6 + i * .06, [72, 76, 79, 84][i], .04, { pan: -.45 + i * .3, t60: 1 }));   // four shares land
air(24.3, .75, .022, 300, 2000);                              // back into the phone
pop(25.0, 79, .045); bell(25.02, 88, .025);                   // 10% for the waiter
[[26.95, 84], [27.2, 86], [27.45, 88]].forEach(([x, m]) => tock(x, m, .022, .25));
air(27.95, .3, .01, 900, 3000);
[72, 76, 79, 84].forEach((m, i) => bell(28.45 + i * .07, m + 12, .035, { pan: -.3 + i * .2 }));                 // paid
[84, 86, 88, 91, 93].forEach((m, i) => pluck(29.8 + i * .05, m, .03, { pan: -.4 + i * .2, t60: .8, dly: .15 })); // five stars
sparkle(29.9, .7, 14, .018); crash(29.95, .02);
air(30.2, .35, .01, 900, 2600); tock(30.75, 86, .02); air(31.2, .3, .008, 2600, 900);
air(31.45, .85, .024, 2200, 300);                             // back to the table
// Everyone pays: three chimes, one amber "pending", resolved when the cash is confirmed.
[[32.35, 79], [32.7, 83], [33.1, 86]].forEach(([x, m], i) => { bell(x, m, .04, { pan: [0, -.4, .4][i] }); pluck(x, m - 12, .02, { t60: .8 }); });
tock(33.5, 69, .05, -.4); tock(33.68, 67, .04, -.4);
glide(33.5, .45, 79, 91, .008);

/* ---------- The room ---------- */
{
  const hp = biquad('hp', 400), sv = svf();                     // the rise: a long airy lift into the downbeat
  voice(33.9, 1.1, s => { const k = s / 1.1; return sv(hp(noise()), 500 + 6000 * k * k, .9) * Math.pow(k, 2) * Math.min(1, (1.1 - s) / .02); }, { gain: .03, to: 'fx', rev: .25 });
}
air(34.375, 1.2, .02, 400, 1800);
pop(35.05, 81, .035);                                         // "cash pending" tag
air(35.55, .35, .01, 800, 2400, -.5, 0);
tock(36.45, 84, .04);
[79, 84].forEach((m, i) => bell(36.6 + i * .1, m, .045)); boom(36.6, .16, 64); pluck(36.6, 72, .03);     // cash confirmed
pop(36.78, 84, .03);
air(37.8, .35, .008, 2400, 800); air(38.1, .35, .01, 800, 2400, -.5, 0);
tock(38.68, 86, .035);
[38.85, 38.91, 38.97, 39.03, 39.1, 39.17, 39.24, 39.31].forEach(x => key(x));
pop(39.2, 91, .015);
tock(39.68, 84, .045);
[88, 91].forEach((m, i) => bell(39.8 + i * .08, m, .03));    // published
// The price reaches every table: a rising pentatonic cascade.
[72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96].forEach((m, i) => pluck(40.0 + i * .085, m, .024, { pan: -.6 + i * .12, t60: .9, dly: .12 }));
air(39.95, 1.0, .012, 400, 1400);
air(41.0, .3, .008, 2400, 900);

/* ---------- The close ---------- */
swell(41.875, .62, .04, 1200);                                // the room folds into the dot
glide(41.35, .52, 67, 55, .01);
boom(41.875, .3, 55); bell(41.875, 96, .03); pop(41.875, 84, .03);
air(41.92, .45, .016, 400, 2200);
glide(42.3, .35, 72, 84, .006);
[76, 79, 84].forEach((m, i) => bell(42.5 + i * .12, m, .045, { pan: -.3 + i * .3, len: 2.4 }));
bell(42.78, 91, .02, { pan: .4 });
[[43.0, 79], [43.13, 81], [43.26, 84]].forEach(([x, m], i) => pluck(x, m, .03, { pan: -.3 + i * .3, t60: 1.2 }));
pop(43.42, 76, .03);

MAP = false;

/* ---------- Mix ---------- */
// Sidechain: the music breathes with the kick.
{
  const env = new Float32Array(N);
  for (const k of kicks) { const s0 = Math.round(k * SR); for (let i = 0; i < SR * .4 && s0 + i < N; i++) { const s = i / SR, v = Math.min(1, s / .004) * Math.exp(-s / .11); if (v > env[s0 + i]) env[s0 + i] = v; } }
  const duck = { bass: .5, keys: .18, pad: .35, pluck: .2 };
  for (const [b, d] of Object.entries(duck)) for (const ch of bus[b]) for (let i = 0; i < N; i++) ch[i] *= 1 - d * env[i];
}
eq('kick', ['hp', 30, .7], ['ls', 55, .7, -2.5], ['peak', 115, 1.2, 2.5], ['peak', 320, 1, -3]);
eq('bass', ['hp', 34, .7], ['lp', 1600, .7], ['peak', 240, 1, -2]);
eq('drums', ['hp', 160, .7], ['hs', 8500, .7, -4.5]);
eq('keys', ['hp', 120, .7], ['peak', 260, .9, -3], ['peak', 2400, .8, 1.5], ['hs', 7000, .7, -2]);
eq('pad', ['hp', 250, .7], ['lp', 6000, .7], ['peak', 400, 1, -2]);
eq('pluck', ['hp', 240, .7], ['hs', 8000, .7, -3]);
eq('bell', ['hp', 400, .7], ['hs', 9000, .7, -3]);
eq('fx', ['hp', 120, .7], ['lp', 8500, .7]);
eq('amb', ['hp', 100, .7], ['lp', 3000, .7]);
// A ping-pong delay (dotted eighth) for the plucks and bells.
{
  const [dl, dr] = bus.dly, T = Math.round(BEAT * .75 * SR), fbL = biquad('lp', 3200), fbR = biquad('lp', 3200);
  const oL = new Float32Array(N), oR = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = i >= T ? oR[i - T] : 0, b = i >= T ? oL[i - T] : 0;
    oL[i] = dl[i] + fbL(a) * .38; oR[i] = dr[i] * .3 + fbR(b) * .38;
  }
  for (let i = 0; i < N; i++) { const l = i >= T ? oL[i - T] : 0, r = i >= T ? oR[i - T] : 0; bus.fx[0][i] += l * .5; bus.fx[1][i] += r * .5; bus.rev[0][i] += l * .15; bus.rev[1][i] += r * .15; }
}
// Convolution reverb: a generated stereo hall tail (1.9 s), darker as it decays, with early reflections.
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function impulse(seedOff) {
  const len = Math.round(2.4 * SR), ir = new Float64Array(len), pre = Math.round(.016 * SR); let lp = 0;
  seed = 1000 + seedOff;
  for (let i = pre; i < len; i++) { const s = (i - pre) / SR, c = .5 * Math.exp(-s * 2.2) + .04; lp += c * (noise() - lp); ir[i] = lp * Math.exp(-s * 3.6) * Math.min(1, s / .01); }
  [[.007, .5], [.013, -.35], [.021, .3], [.029, -.22], [.041, .16]].forEach(([d, a]) => { ir[Math.round((d + seedOff * .0013) * SR)] += a * .6; });
  let e = 0; for (const v of ir) e += v * v; const g = 1 / Math.sqrt(e); for (let i = 0; i < len; i++) ir[i] *= g;
  return ir;
}
function convolve(x, ir) {
  let n = 1; while (n < x.length + ir.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x); br.set(ir); fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i], im = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  return ar.subarray(0, x.length);
}
eq('rev', ['hp', 280, .7], ['lp', 6500, .7]);
const revL = convolve(bus.rev[0], impulse(1)), revR = convolve(bus.rev[1], impulse(2));

// Sum the buses at their levels, glue-compress, limit to -2.5 dBFS (headroom for AAC), normalise to -14 LUFS.
const LEVEL = { kick: -2.5, drums: 7, bass: -1, keys: 3, pad: 4, pluck: 9, bell: 0, fx: 3, amb: -1 };
if (process.env.STEMS) for (const b of Object.keys(LEVEL)) { const [l, r] = bus[b], k = db(LEVEL[b]), a = l.map(v => v * k), c = r.map(v => v * k); console.log(b.padEnd(6), lufs(a, c).toFixed(1), 'LUFS, loudest 400 ms', momentaryMax(a, c).toFixed(1)); }
const L = new Float64Array(N), R = new Float64Array(N);
for (const [b, g] of Object.entries(LEVEL)) { const k = db(g), [bl, br] = bus[b]; for (let i = 0; i < N; i++) { L[i] += bl[i] * k; R[i] += br[i] * k; } }
for (let i = 0; i < N; i++) { L[i] += revL[i] * .75; R[i] += revR[i] * .75; }
{ const a = biquad('peak', 320, .7, -2), b = biquad('peak', 320, .7, -2); for (let i = 0; i < N; i++) { L[i] = a(L[i]); R[i] = b(R[i]); } }
if (process.env.STEMS) console.log('reverb', lufs(revL.map(v => v * .75), revR.map(v => v * .75)).toFixed(1), 'LUFS; dry+wet', lufs(L, R).toFixed(1), 'LUFS');
function lufs(a, b) {
  const kw = () => { const f1 = (() => { const B = [1.53512485958697, -2.69169618940638, 1.19839281085285], A = [-1.69065929318241, .73248077421585]; let x1 = 0, x2 = 0, y1 = 0, y2 = 0; return x => { const y = B[0] * x + B[1] * x1 + B[2] * x2 - A[0] * y1 - A[1] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; }; })();
    const f2 = (() => { const A = [-1.99004745483398, .99007225036621]; let x1 = 0, x2 = 0, y1 = 0, y2 = 0; return x => { const y = x - 2 * x1 + x2 - A[0] * y1 - A[1] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; }; })();
    return x => f2(f1(x)); };
  const ka = kw(), kb = kw(), sq = new Float64Array(N);
  for (let i = 0; i < N; i++) { const x = ka(a[i]), y = kb(b[i]); sq[i] = x * x + y * y; }
  const blk = Math.round(.4 * SR), hop = Math.round(.1 * SR), z = [];
  const cum = new Float64Array(N + 1); for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + sq[i];
  for (let s = 0; s + blk <= N; s += hop) z.push((cum[s + blk] - cum[s]) / blk);
  const Lk = v => -.691 + 10 * Math.log10(v + 1e-12);
  const abs = z.filter(v => Lk(v) > -70), rel = Lk(abs.reduce((m, v) => m + v, 0) / abs.length) - 10;
  const g = abs.filter(v => Lk(v) > rel);
  return Lk(g.reduce((m, v) => m + v, 0) / g.length);
}
function momentaryMax(a, b) {
  const blk = Math.round(.4 * SR), hop = Math.round(.1 * SR); let mx = -99;
  const f1 = biquad('hs', 1681, .707, 4), f2 = biquad('hp', 38, .5), g1 = biquad('hs', 1681, .707, 4), g2 = biquad('hp', 38, .5), cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { const x = f2(f1(a[i])), y = g2(g1(b[i])); cum[i + 1] = cum[i] + x * x + y * y; }
  for (let s = 0; s + blk <= N; s += hop) mx = Math.max(mx, -.691 + 10 * Math.log10((cum[s + blk] - cum[s]) / blk + 1e-12));
  return mx;
}
function glue(thr = -16, ratio = 2, att = .02, rel = .25) {
  const aA = Math.exp(-1 / (att * SR)), aR = Math.exp(-1 / (rel * SR)); let env = 0;
  for (let i = 0; i < N; i++) {
    const lvl = 20 * Math.log10(Math.max(Math.abs(L[i]), Math.abs(R[i])) + 1e-9), over = lvl - thr, knee = 6;
    const gr = 2 * over < -knee ? 0 : 2 * Math.abs(over) <= knee ? (1 / ratio - 1) * Math.pow(over + knee / 2, 2) / (2 * knee) : (1 / ratio - 1) * over;
    env = gr < env ? aA * env + (1 - aA) * gr : aR * env + (1 - aR) * gr;
    const g = db(env); L[i] *= g; R[i] *= g;
  }
}
// Look-ahead limiter: the gain needed over the next 2 ms, box-smoothed into a ramp, released over 80 ms.
function limit(ceil) {
  const la = Math.round(.002 * SR), need = new Float64Array(N), rel = Math.exp(-1 / (.08 * SR));
  for (let i = 0; i < N; i++) need[i] = Math.min(1, ceil / Math.max(1e-9, Math.abs(L[i]), Math.abs(R[i])));
  const mn = new Float64Array(N), dq = new Int32Array(N); let h = 0, tl = 0;
  for (let i = N - 1; i >= 0; i--) {                           // mn[i] = min(need[i .. i + la])
    while (tl > h && need[dq[tl - 1]] >= need[i]) tl--;
    dq[tl++] = i;
    while (dq[h] > i + la) h++;
    mn[i] = need[dq[h]];
  }
  let acc = la, g = 1;
  for (let i = 0; i < N; i++) {
    acc += mn[i] - (i >= la ? mn[i - la] : 1);
    const target = acc / la;
    g = target < g ? target : target - (target - g) * rel;
    L[i] *= g; R[i] *= g;
  }
}
glue();
let gain = db(-14 - lufs(L, R));
for (let i = 0; i < N; i++) { L[i] *= gain; R[i] *= gain; }
limit(db(-2.5));
gain = db(-14 - lufs(L, R));
for (let i = 0; i < N; i++) { L[i] *= gain; R[i] *= gain; }
limit(db(-2.5));
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, (N - i) / (SR * .9)) * Math.min(1, i / (SR * .02));
  L[i] *= fade; R[i] *= fade; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
if (!(peak > 0 && peak < 1)) throw new Error('bad peak ' + peak);

const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const d = (rnd() - rnd()) / 32768;                           // TPDF dither to 16 bit
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((L[i] + d) * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((R[i] + d) * 32767))), 46 + i * 4);
}
const out = process.argv[2] || 'reel.wav';
fs.writeFileSync(out, buf);
console.log(`wrote ${out}: ${lufs(L, R).toFixed(1)} LUFS, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
