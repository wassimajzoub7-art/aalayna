/* Aalayna logo motion. Two reveals, each a pure function of time drawn on a 2D canvas, so they play
   live on the brand page and render frame-exact to video through tools/brand.js.

   Block (5.2 s): the table QR (a real one, it opens aalayna.com) blooms, is scanned, and its modules
   fly into the capitals; the red finder eyes become the full stop, which lands last like a stamp.
   Kufi (5.6 s): a red module is the pen. It writes علينا right to left along the baseline, each letter
   rising as it passes, climbs the alif, then hops three times to set the dots. The Latin name follows.

   Every piece: { duration, cues, render(g, t, W, H) }, g already scaled to W x H logical pixels. */
(function (root) {
  'use strict';
  const Logo = root.AalaynaLogo;
  const C = Logo.COLORS, U = Logo.U;

  /* ---------- Math ---------- */
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const lerp = (a, b, k) => a + (b - a) * k;
  const E = {
    outCubic: k => 1 - Math.pow(1 - k, 3),
    inOutCubic: k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    inOutSine: k => -(Math.cos(Math.PI * k) - 1) / 2,
    outExpo: k => (k === 1 ? 1 : 1 - Math.pow(2, -10 * k)),
    inExpo: k => (k === 0 ? 0 : Math.pow(2, 10 * k - 10)),
    inOutQuart: k => (k < 0.5 ? 8 * k * k * k * k : 1 - Math.pow(-2 * k + 2, 4) / 2),
    outBack: (k, s = 1.7) => 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2),
  };
  // Damped spring from 0 to 1, s seconds after release; a decaying wobble around 0.
  const spring = (s, f = 2.2, d = 7) => (s <= 0 ? 0 : 1 - Math.exp(-d * s) * Math.cos(2 * Math.PI * f * s));
  const wobble = (s, f = 3, d = 7) => (s <= 0 ? 0 : Math.exp(-d * s) * Math.cos(2 * Math.PI * f * s));
  const rng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };

  // https://aalayna.com as a version 2-M QR code, from qr-lib.js. It scans.
  const QR = ['#######.#.###.#...#######', '#.....#.##.##...#.#.....#', '#.###.#.#...###.#.#.###.#', '#.###.#..#####..#.#.###.#', '#.###.#.#.#####.#.#.###.#', '#.....#....#..#.#.#.....#', '#######.#.#.#.#.#.#######', '.............#.##........', '#..######...##..##..#.###', '.#.#.#.#..#######..#####.', '..##..##...#.#.#######..#', '##.#...##.##.#..#.#..####', '..###.##...###.##.##....#', '#.#.##...##..####...#..#.', '##...##.######.###..#####', '#.##.#.##.##...#..##.##.#', '#.....#...#...#.#####.##.', '........#.#####.#...#.##.', '#######.##.#....#.#.#...#', '#.....#.#...#.###...#..#.', '#.###.#.##..#########...#', '#.###.#.#.....#####....##', '#.###.#...#.#.####..#####', '#.....#...#...##.####.###', '#######.##...##.#.#..#..#'];
  const QN = QR.length;
  const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= QN - 7) || (r >= QN - 7 && c < 7);

  const colorsOf = o => Object.assign({ bg: C.cream, ink: C.ink, red: C.red, sub: '#6E635B' }, o && o.colors);
  const rrect = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); g.fill(); };
  const FONT = "'IBM Plex Sans', system-ui, sans-serif";

  function tagline(g, t, t0, x, y, size, col, words = ['scan,', 'split,', 'settle.']) {
    g.save();
    g.font = '500 ' + size + 'px ' + FONT;
    g.textBaseline = 'alphabetic';
    const gap = size * 0.32, ws = words.map(w => g.measureText(w).width);
    let cx = x - (ws.reduce((a, b) => a + b, 0) + gap * (words.length - 1)) / 2;
    words.forEach((w, i) => {
      const k = E.outExpo(seg(t, t0 + i * 0.1, t0 + i * 0.1 + 0.55));
      g.globalAlpha = k;
      const yy = y + (1 - k) * size * 0.6, stop = w.endsWith('.'), body = stop ? w.slice(0, -1) : w;
      g.fillStyle = col.sub; g.fillText(body, cx, yy);
      if (stop) { g.fillStyle = col.red; g.fillText('.', cx + g.measureText(body).width, yy); } // red is punctuation
      cx += ws[i] + gap;
    });
    g.restore();
  }

  /* ================= Block ================= */
  function block(opt) {
    const col = colorsOf(opt);
    const withTag = !(opt && opt.tagline === false);
    const DUR = 5.2;
    // The ink without N's diagonal, which slices in on its own when the modules snap to the letterforms.
    const P = {
      ink: new Path2D([...'AALAYNA'].map((ch, i) => { const x = (i % 4) * 6 * U, y = Math.floor(i / 4) * 6 * U; return ch === 'N' ? Logo.outline(Logo.LATIN.N, { u: U, ox: x, oy: y, rowH: Logo.LATIN_ROWS }) : Logo.glyph(ch, x, y, U); }).join('')),
      diag: new Path2D(Logo.nDiagonal(6 * U, 6 * U, U)),
    };
    const rand = rng(21);

    // Sources: every dark QR module. Targets: every module of the Block.
    const src = [];
    QR.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === '#') src.push({ c, r, red: finder(r, c), used: false }); }));
    const cx = src.reduce((a, s) => a + s.c, 0) / src.length, cy = src.reduce((a, s) => a + s.r, 0) / src.length;
    const eyeOf = s => [s.r < 7 ? 3 : QN - 4, s.c < 7 ? 3 : QN - 4];
    src.forEach(s => {
      if (s.red) { const [er, ec] = eyeOf(s); s.bloom = 0.42 + (s.r < 7 && s.c >= QN - 7 ? 0.06 : s.r >= QN - 7 ? 0.12 : 0) + Math.hypot(s.r - er, s.c - ec) * 0.022; }
      else s.bloom = 0.12 + Math.hypot(s.c - cx, s.r - cy) / 17 * 0.42 + rand() * 0.05;
      s.fade = 1.3 + rand() * 0.42;
      s.spin = (rand() - 0.5) * 120;
    });
    const tgt = Logo.blockCells();
    // Match each target to the nearest free source of its colour, in normalised space, in a seeded shuffle
    // (Fisher-Yates, so every browser and the renderer build the same flight plan).
    const order = tgt.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const i of order) {
      const T = tgt[i], tx = (T.x + 0.5) / 23, ty = (T.y + 0.5) / 11;
      let best = null, bd = 1e9;
      for (const s of src) {
        if (s.used || s.red !== T.red) continue;
        const d = Math.hypot((s.c + 0.5) / QN - tx, (s.r + 0.5) / QN - ty);
        if (d < bd) { bd = d; best = s; }
      }
      best.used = true; T.src = best;
      T.start = 1.32 + T.letter * 0.075 + rand() * 0.07;
      T.bend = (rand() - 0.5) * 0.36;
      T.turn = rand() < 0.5 ? 90 : -90;
    }
    const FUSE = [2.42, 2.58], SNAP = 2.6, SLASH = [2.6, 2.72], LIFT = [2.74, 2.88], HIT = 2.88;

    function layout(W, H) {
      const m = Math.min((W * (W / H < 1.2 ? 0.8 : 0.62)) / 23, (H * (withTag ? 0.44 : 0.52)) / 11);
      const qm = (Math.min(W, H) * 0.58) / QN;
      const bx = W / 2 - 11.5 * m, by = H / 2 - 5.5 * m - (withTag ? m * 0.95 : 0);
      return { m, qm, bx, by, qx: W / 2 - (QN / 2) * qm, qy: H / 2 - (QN / 2) * qm };
    }

    function render(g, t, W, H) {
      const { m, qm, bx, by, qx, qy } = layout(W, H);
      g.save();
      g.fillStyle = col.bg; g.fillRect(0, 0, W, H);

      // Camera: a slow push, and a shake when the stamp lands.
      const push = lerp(1, 1.035, E.outCubic(seg(t, 0, DUR)));
      const sh = m * 0.16 * wobble(t - HIT, 11, 9), sv = m * 0.12 * wobble(t - HIT - 0.02, 14, 9);
      g.translate(W / 2 + sh, H / 2 + sv); g.scale(push, push); g.translate(-W / 2, -H / 2);

      // QR modules that are not needed evaporate outwards.
      for (const s of src) {
        if (s.used) continue;
        const b = clamp(spring(t - s.bloom, 2.4, 8), 0, 1.22), out = E.inExpo(seg(t, s.fade, s.fade + 0.34));
        const sz = qm * 0.86 * b * (1 - out);
        if (sz <= 0.2) continue;
        const x = qx + (s.c + 0.5) * qm, y = qy + (s.r + 0.5) * qm;
        const dx = x - W / 2, dy = y - H / 2, dl = Math.hypot(dx, dy) || 1;
        g.save();
        g.translate(x + (dx / dl) * qm * 1.6 * out, y + (dy / dl) * qm * 1.6 * out);
        g.rotate((s.spin * out * Math.PI) / 180);
        g.fillStyle = s.red ? col.red : col.ink;
        rrect(g, -sz / 2, -sz / 2, sz, sz, sz * 0.2);
        g.restore();
      }

      // The scan line.
      const sk = seg(t, 0.92, 1.3);
      if (sk > 0 && sk < 1) {
        const y = lerp(qy - qm, qy + (QN + 1) * qm, E.inOutCubic(sk)), a = Math.sin(Math.PI * sk);
        const w = (QN + 3) * qm, x0 = W / 2 - w / 2;
        const grd = g.createLinearGradient(0, y - qm * 5, 0, y);
        grd.addColorStop(0, 'rgba(201,65,75,0)'); grd.addColorStop(1, 'rgba(201,65,75,' + (0.2 * a).toFixed(3) + ')');
        g.fillStyle = grd; g.fillRect(x0, y - qm * 5, w, qm * 5);
        g.globalAlpha = a; g.fillStyle = col.red; rrect(g, x0, y - qm * 0.18, w, qm * 0.36, qm * 0.18); g.globalAlpha = 1;
      }

      const fuse = E.inOutCubic(seg(t, FUSE[0], FUSE[1]));
      if (t < SNAP) {
        // Modules that make the Block: bloom in the QR, fly home, close their gaps.
        for (const T of tgt) {
          const s = T.src, b = clamp(spring(t - s.bloom, 2.4, 8), 0, 1.22);
          const k = E.inOutCubic(seg(t, T.start, T.start + 0.62));
          const x0 = qx + (s.c + 0.5) * qm, y0 = qy + (s.r + 0.5) * qm;
          const x1 = bx + (T.x + 0.5) * m, y1 = by + (T.y + 0.5) * m;
          const dx = x1 - x0, dy = y1 - y0, arc = Math.sin(Math.PI * k) * T.bend;
          const x = lerp(x0, x1, k) - dy * arc, y = lerp(y0, y1, k) + dx * arc;
          const sz = lerp(qm * 0.86 * b, lerp(m * 0.86, m * 1.02, fuse), k);
          if (sz <= 0.2) continue;
          g.save();
          g.translate(x, y); g.rotate((T.turn * k * Math.PI) / 180);
          g.fillStyle = T.red ? col.red : col.ink;
          rrect(g, -sz / 2, -sz / 2, sz, sz, sz * lerp(0.2, 0.04, fuse));
          g.restore();
        }
      } else {
        // Snap: the modules become the letterforms in one frame, N's diagonal slices through,
        // the full stop rounds its corners, lifts, and lands like a stamp.
        g.save();
        g.translate(bx, by); g.scale(m / U, m / U);
        g.fillStyle = col.ink; g.fill(P.ink);
        const sl = E.outCubic(seg(t, SLASH[0], SLASH[1]));
        if (sl > 0) { g.save(); g.beginPath(); g.rect(6 * U - 1, 6 * U - 1, 5 * U + 2, 5 * U * sl + 1); g.clip(); g.fill(P.diag); g.restore(); }
        const lift = E.outCubic(seg(t, LIFT[0], LIFT[1])), land = t >= HIT;
        let s = lerp(1, 1.14, lift), sx = 1, sy = 1;
        if (land) { s = lerp(1.14, 1, E.outExpo(seg(t, HIT, HIT + 0.08))); const w = wobble(t - HIT, 3.2, 8); sx = 1 + 0.07 * w; sy = 1 - 0.07 * w; }
        const tc = [20.5 * U, 8.5 * U];
        g.translate(tc[0], tc[1]); g.scale(s * sx, s * sy); g.translate(-tc[0], -tc[1]);
        if (lift > 0 && !land) { g.shadowColor = 'rgba(33,27,22,' + (0.28 * lift).toFixed(3) + ')'; g.shadowBlur = m * 0.9 * lift; g.shadowOffsetY = m * 0.35 * lift; }
        g.fillStyle = col.red;
        g.beginPath(); g.roundRect(18 * U, 6 * U, 5 * U, 5 * U, lerp(0.08, 1.5, E.outCubic(seg(t, SNAP, LIFT[1]))) * U); g.fill();
        g.restore();
        // Shockwave from the stamp.
        const rk = seg(t, HIT, HIT + 0.5);
        if (rk > 0 && rk < 1) {
          const cxr = bx + 20.5 * m, cyr = by + 8.5 * m, half = lerp(2.5, 5.2, E.outCubic(rk)) * m;
          g.save(); g.globalAlpha = 1 - rk; g.strokeStyle = col.red; g.lineWidth = m * 0.22 * (1 - rk * 0.6);
          g.beginPath(); g.roundRect(cxr - half, cyr - half, half * 2, half * 2, m * 1.5); g.stroke(); g.restore();
        }
      }

      g.restore();
      if (withTag) tagline(g, t, 3.0, W / 2, by + 11 * m + 2.5 * m, Math.round(Math.max(m * 0.78, Math.min(W, H) * 0.04)), col);
    }
    // Cue times for the soundtrack (tools/brand-audio.js).
    const eye = (top, right) => Math.min(...src.filter(x => x.red && (x.r >= 7) === top && (x.c >= 7) === right).map(x => x.bloom));
    const cues = {
      bloom: src.filter(x => !x.red).map(x => x.bloom), finders: [eye(false, false), eye(false, true), eye(true, false)],
      scan: [0.92, 1.3], fly: 1.32, lands: tgt.map(T => T.start + 0.62), snap: SNAP, lift: LIFT[0], hit: HIT, tag: 3.0,
    };
    return { duration: DUR, render, cues };
  }

  /* ================= Kufi ================= */
  function kufi(opt) {
    const col = colorsOf(opt);
    const withTag = !(opt && opt.tagline === false);
    const DUR = 5.6;
    const RY = [0]; Logo.KUFI_ROWS.forEach(h => RY.push(RY[RY.length - 1] + h));
    const P = new Path2D(Logo.kufi().ink), stop = new Path2D(Logo.line().red);
    const letters = [0, 1, 2, 3, 4, 5, 6].map(i => new Path2D(Logo.glyph('AALAYNA'[i], i * 6 * U, 0, U)));
    const BASE = [RY[9], RY[10]];              // the baseline band, in modules
    const DROP = [0.08, 0.4], BOUNCE = 0.56;   // the pen falls onto the end of the baseline and bounces once
    const RUN = [0.62, 1.45];                  // then runs the baseline, right to left
    const penX = t => lerp(11, 0, E.inOutCubic(seg(t, RUN[0], RUN[1])));
    const passes = c => { for (let t = RUN[0]; t <= RUN[1]; t += 0.002) if (penX(t) <= c + 0.35) return t; return RUN[1]; };
    const rises = [                             // each letter stands up as the pen passes it
      { c: 8, top: RY[5], at: passes(8), plain: true },   // ع, then its arm reaches right
      { c: 6, top: 0, at: passes(6) },                     // ل
      { c: 4, top: RY[5], at: passes(4) },                 // ي
      { c: 2, top: RY[5], at: passes(2) },                 // ن
    ];
    const CLIMB = [RUN[1] + 0.02, RUN[1] + 0.34];         // the pen climbs the alif
    const HOPS = [                                         // and sets the dots, right to left
      { from: [0, 0], to: [5, RY[11]], t: [1.9, 2.24], h: 4 },
      { from: [5, RY[11]], to: [3, RY[11]], t: [2.32, 2.54], h: 1.3 },
      { from: [3, RY[11]], to: [2, RY[3]], t: [2.62, 3.0], h: 4 },
    ];
    const INKED = 2.45, CAM = [3.1, 4.05], LAT = 3.35, TAG = 4.1;
    const squash = (s, amp) => amp * wobble(s, 3.4, 9);

    // Where the pen is: top-left corner and height in modules, turn, and squash (anchored at its base).
    function pen(t) {
      if (t < DROP[0]) return null;
      const s = { x: 11, y: BASE[0], h: BASE[1] - BASE[0], rot: 0, sx: 1, sy: 1 };
      if (t < DROP[1]) { s.y = lerp(BASE[0] - 14, BASE[0], E.inOutCubic(seg(t, DROP[0], DROP[1])) * 0.25 + 0.75 * Math.pow(seg(t, DROP[0], DROP[1]), 2)); s.sx = 0.82; s.sy = 1.3; return s; }
      if (t < BOUNCE) { const u = seg(t, DROP[1], BOUNCE); s.y = BASE[0] - 1.1 * 4 * u * (1 - u); }
      const w = squash(t - DROP[1], 0.34) * (t < BOUNCE ? 1 : 0) + squash(t - BOUNCE, 0.2) * (t >= BOUNCE ? 1 : 0);
      if (t < RUN[0]) { s.sx = 1 + w; s.sy = 1 - w; return s; }
      if (t < RUN[1]) { s.x = penX(t); return s; }
      s.x = 0; s.h = 1;
      if (t < HOPS[0].t[0]) { s.y = lerp(BASE[0], 0, E.outCubic(seg(t, CLIMB[0], CLIMB[1]))); return s; }
      let landed = null;
      for (const hp of HOPS) {
        if (t < hp.t[0]) { s.x = hp.from[0]; s.y = hp.from[1]; const q = squash(t - landed, 0.3); s.sx = 1 + q; s.sy = 1 - q; return s; }
        if (t < hp.t[1]) {
          const k = seg(t, hp.t[0], hp.t[1]), e = E.inOutSine(k);
          s.x = lerp(hp.from[0], hp.to[0], e); s.y = lerp(hp.from[1], hp.to[1], e) - hp.h * 4 * e * (1 - e);
          s.rot = (E.inOutCubic(k) * Math.PI) / 2;
          return s;
        }
        landed = hp.t[1];
      }
      const last = HOPS[HOPS.length - 1], q = squash(t - last.t[1], 0.3);
      Object.assign(s, { x: last.to[0], y: last.to[1], sx: 1 + q, sy: 1 - q });
      return s;
    }
    function drawSquare(g, m, x, y, h, rot, sx, sy) {
      g.save();
      g.translate((x + 0.5) * m, (y + h) * m); g.scale(sx, sy); g.translate(0, -h * m / 2); g.rotate(rot);
      g.fillRect(-m / 2, (-h * m) / 2, m, h * m);
      g.restore();
    }

    function frame(W, H) {       // where the camera starts (on the Kufi) and ends (on the lockup)
      const wide = W / H > 1.3;
      const end = wide ? { cx: 29, cy: 6 + (withTag ? 1.4 : 0), m: Math.min((W * 0.8) / 58, (H * 0.5) / 12) }
        : { cx: 6, cy: 8.4 + (withTag ? 1.2 : 0), m: Math.min((W * 0.62) / 12, (H * 0.56) / 17) };
      return { wide, start: { cx: 6, cy: 6, m: (Math.min(W, H) * 0.6) / 12 }, end };
    }

    function render(g, t, W, H) {
      const F = frame(W, H), ck = E.inOutCubic(seg(t, CAM[0], CAM[1]));
      const m = lerp(F.start.m, F.end.m, ck), cxm = lerp(F.start.cx, F.end.cx, ck), cym = lerp(F.start.cy, F.end.cy, ck);
      const Z = m / U; // path units to pixels
      g.save();
      g.fillStyle = col.bg; g.fillRect(0, 0, W, H);
      g.translate(W / 2 - cxm * m, H / 2 - cym * m);

      // The ink so far: the finished letterforms, clipped to the strokes the pen has made.
      g.save();
      g.scale(Z, Z);
      if (t < INKED) {
        g.beginPath();
        if (t >= RUN[0]) { const px = penX(t); g.rect((px + 0.5) * U, (BASE[0] - 0.55) * U, (12 - px - 0.5) * U + 1, (BASE[1] - BASE[0] + 0.56) * U); }
        for (const R of rises) {
          if (t < R.at) continue;
          const k = R.plain ? E.outCubic(seg(t, R.at, R.at + 0.24)) : clamp(spring(t - R.at, 1.7, 6.2), 0, 2);
          const top = Math.max(lerp(BASE[0], R.top, k), R.top);
          g.rect(R.c * U, top * U, U, (BASE[1] - top) * U);
          if (R.plain) { const a = E.outCubic(seg(t, R.at + 0.14, R.at + 0.4)); if (a > 0) g.rect((R.c + 1) * U, R.top * U, 3 * a * U + 1, 1.6 * U); }
        }
        if (t >= CLIMB[0]) { const top = lerp(BASE[0], 0, E.outCubic(seg(t, CLIMB[0], CLIMB[1]))); g.rect(0, top * U, U, (BASE[1] - top) * U); }
        g.clip();
      }
      g.fillStyle = col.ink; g.fill(P);
      g.restore();
      // A spring overshoots: the stroke runs past its end for a moment, then settles back.
      if (t < INKED) for (const R of rises) {
        if (R.plain || t < R.at) continue;
        const top = lerp(BASE[0], R.top, spring(t - R.at, 1.7, 6.2));
        if (top < R.top) { g.fillStyle = col.ink; g.fillRect(R.c * m, top * m, m, (R.top - top) * m + 0.5); }
      }

      // The dots already set, then the pen.
      g.fillStyle = col.red;
      HOPS.slice(0, -1).forEach(hp => { if (t >= hp.t[1]) { const q = squash(t - hp.t[1], 0.3); drawSquare(g, m, hp.to[0], hp.to[1], 1, 0, 1 + q, 1 - q); } });
      const s = pen(t);
      if (s) drawSquare(g, m, s.x, s.y, s.h, s.rot, s.sx, s.sy);

      // The Latin name, letter by letter; its full stop drops in last.
      const ls = F.wide ? 1 : 12 / 43, lx = F.wide ? 15 : 6 - 21.5 * ls, ly = F.wide ? RY[5] : 14.2;
      letters.forEach((p, i) => {
        const k = seg(t, LAT + i * 0.06, LAT + i * 0.06 + 0.42);
        if (k <= 0) return;
        const sc = lerp(0.55, 1, E.outBack(k, 1.6)) * ls * Z;
        g.save(); g.globalAlpha = clamp(k * 3);
        g.translate((lx + (i * 6 + 2.5) * ls) * m, (ly + 5 * ls) * m); g.scale(sc, sc); g.translate(-(i * 6 + 2.5) * U, -5 * U);
        g.fillStyle = col.ink; g.fill(p); g.restore();
      });
      const d0 = LAT + 0.54, dk = seg(t, d0, d0 + 0.24);
      if (dk > 0) {
        const q = squash(t - d0 - 0.24, 0.3);
        g.save(); g.translate(lx * m, (ly - 3 * ls * (1 - E.outCubic(dk)) * (1 - E.outCubic(dk))) * m); g.scale(ls * Z, ls * Z);
        g.translate(42.5 * U, 5 * U); g.scale(1 + q, 1 - q); g.translate(-42.5 * U, -5 * U);
        g.fillStyle = col.red; g.fill(stop); g.restore();
      }
      g.restore();

      if (withTag) {
        const bottom = H / 2 + ((F.wide ? 12 : 15.6) - F.end.cy) * F.end.m;
        tagline(g, t, TAG, W / 2, bottom + F.end.m * (F.wide ? 3.3 : 2.8), Math.round(Math.min(W, H) * 0.045), col);
      }
    }
    return { duration: DUR, render, cues: { drop: DROP[0], land: DROP[1], bounce: BOUNCE, run: RUN[0], rises: rises.map(r => r.at), climb: CLIMB[0], hops: HOPS.map(h => h.t), latin: LAT, stop: LAT + 0.78, tag: TAG } };
  }

  /* ---------- Player: plays a piece on a canvas, sized to its box, at the device's pixel ratio ---------- */
  function player(canvas, piece, { autoplay = true, onEnd } = {}) {
    const g = canvas.getContext('2d');
    let W = 0, H = 0, t0 = null, raf = 0, t = autoplay ? 0 : piece.duration;
    const reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function size() {
      const r = canvas.getBoundingClientRect(), d = Math.min(3, root.devicePixelRatio || 1);
      W = r.width; H = r.height;
      canvas.width = Math.round(W * d); canvas.height = Math.round(H * d);
      g.setTransform(d, 0, 0, d, 0, 0);
      piece.render(g, t, W, H);
    }
    function tick(now) {
      if (t0 === null) t0 = now;
      t = Math.min(piece.duration, (now - t0) / 1000);
      piece.render(g, t, W, H);
      if (t < piece.duration) raf = requestAnimationFrame(tick); else if (onEnd) onEnd();
    }
    function play() { cancelAnimationFrame(raf); t0 = null; t = 0; if (reduce) { t = piece.duration; piece.render(g, t, W, H); if (onEnd) onEnd(); return; } raf = requestAnimationFrame(tick); }
    if (root.ResizeObserver) new ResizeObserver(size).observe(canvas); else root.addEventListener('resize', size);
    size();
    if (autoplay) play();
    return { play, redraw() { piece.render(g, t, W, H); }, seek(s) { cancelAnimationFrame(raf); t = s; piece.render(g, t, W, H); } };
  }

  root.AalaynaMotion = { block, kufi, player, QR };
})(typeof self !== 'undefined' ? self : this);
