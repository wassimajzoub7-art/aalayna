/* Aalayna logo geometry. One module grid draws both marks:
   - the Block: AALA / YNA and a red full stop, capitals built on 5 x 5 modules;
   - the Kufi: علينا in square Kufic, the Arabic script that has always been drawn on a square grid.
   One module is the stroke width. Outer corners turn on a 1.5-module radius, inner corners on 0.5
   (so every bend is one concentric stroke), stroke ends are cut square, and horizontals are drawn 8%
   thinner than verticals so they look the same weight. Red is only ever punctuation: the full stop,
   and the dots of the Arabic letters.
   Runs in the browser (window.AalaynaLogo) and in Node (require), so the SVG files, the brand page
   and the motion renders all come from this one file. */
(function (root) {
  'use strict';

  const COLORS = { ink: '#211B16', cream: '#FAF6F1', red: '#C9414B', petrol: '#173E43', peach: '#F6C39F', white: '#FFFFFF' };
  const CORNERS = { R: 1.5, r: 0.5, Rt: 0 };
  const THIN = 0.92;           // horizontal stroke weight, relative to a vertical one
  const U = 10;                // path units per module in the exported geometry

  /* ---------- Engine: grid cells -> outline -> rounded path ---------- */

  // Outline loops of the filled cells, ink on the right of travel (outer loops clockwise on screen).
  function trace(bits) {
    const H = bits.length, W = Math.max(...bits.map(r => r.length));
    const on = (x, y) => y >= 0 && y < H && x >= 0 && x < W && bits[y][x] === '#';
    const edges = new Map();
    const add = (x1, y1, x2, y2) => { const k = x1 + ',' + y1; if (!edges.has(k)) edges.set(k, []); edges.get(k).push({ x1, y1, x2, y2, used: false }); };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x, y, x + 1, y);
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!on(x - 1, y)) add(x, y + 1, x, y);
    }
    const loops = [];
    for (const list of edges.values()) for (const first of list) {
      if (first.used) continue;
      const pts = []; let e = first;
      while (!e.used) {
        e.used = true; pts.push([e.x1, e.y1]);
        const next = (edges.get(e.x2 + ',' + e.y2) || []).filter(c => !c.used);
        if (!next.length) break;
        const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
        const rank = c => { const z = dx * (c.y2 - c.y1) - dy * (c.x2 - c.x1); return z > 0 ? 0 : z === 0 ? 1 : 2; };
        next.sort((a, b) => rank(a) - rank(b)); // at a saddle, turn right: diagonal cells stay apart
        e = next[0];
      }
      const n = pts.length, keep = [];
      for (let i = 0; i < n; i++) {
        const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
        if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) keep.push(b);
      }
      loops.push(keep);
    }
    return loops;
  }

  // Cumulative position of grid line g for column widths / row heights `sizes` (uniform when absent).
  const along = sizes => g => {
    if (!sizes) return g;
    let s = 0, i = 0;
    for (; i < Math.floor(g) && i < sizes.length; i++) s += sizes[i];
    const frac = g - Math.floor(g);
    return s + (i < sizes.length ? frac * sizes[i] : (g - i));
  };
  const num = v => +v.toFixed(2);

  // opt: R (outer corners), r (inner corners), Rt (stroke ends), rowH, colW, u, ox, oy
  function outline(bits, opt) {
    const o = Object.assign({}, CORNERS, opt);
    const u = o.u ?? U, ox = o.ox || 0, oy = o.oy || 0;
    const fx = along(o.colW), fy = along(o.rowH);
    let d = '';
    for (const loop of trace(bits)) {
      const n = loop.length;
      const P = loop.map(([gx, gy]) => [ox + fx(gx) * u, oy + fy(gy) * u]);
      const turn = i => { const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n]; return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]); };
      const convex = P.map((_, i) => turn(i) > 0);
      const len = i => { const a = P[i], b = P[(i + 1) % n]; return Math.hypot(b[0] - a[0], b[1] - a[1]); };
      const isEnd = i => len(i) < 1.2 * u; // an edge no longer than one stroke is the cut end of that stroke
      const rad = P.map((_, i) => {
        if (!convex[i]) return o.r * u;
        const prev = (i - 1 + n) % n, next = (i + 1) % n;
        return ((isEnd(prev) && convex[prev]) || (isEnd(i) && convex[next]) ? o.Rt : o.R) * u;
      });
      for (let pass = 0; pass < 3; pass++) for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, l = len(i);
        if (rad[i] + rad[j] > l) { const k = l / (rad[i] + rad[j]); rad[i] *= k; rad[j] *= k; }
      }
      for (let i = 0; i < n; i++) {
        const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n], r = rad[i];
        const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
        const p1 = [b[0] - (b[0] - a[0]) / l1 * r, b[1] - (b[1] - a[1]) / l1 * r];
        const p2 = [b[0] + (c[0] - b[0]) / l2 * r, b[1] + (c[1] - b[1]) / l2 * r];
        d += (i ? 'L' : 'M') + num(p1[0]) + ' ' + num(p1[1]);
        if (r > 0.001) d += 'A' + num(r) + ' ' + num(r) + ' 0 0 ' + (convex[i] ? 1 : 0) + ' ' + num(p2[0]) + ' ' + num(p2[1]);
      }
      d += 'Z';
    }
    return d;
  }

  /* ---------- The letters ---------- */

  // Latin capitals, 5 x 5. N is two stems here plus one diagonal drawn separately (nDiagonal).
  const LATIN = {
    A: ['#####', '#...#', '#####', '#...#', '#...#'],
    L: ['#....', '#....', '#....', '#....', '#####'],
    Y: ['#...#', '#...#', '#####', '..#..', '..#..'],
    N: ['#...#', '#...#', '#...#', '#...#', '#...#'],
  };
  const TILE = ['#####', '#####', '#####', '#####', '#####'];
  const LATIN_ROWS = [THIN, (5 - 3 * THIN) / 2, THIN, (5 - 3 * THIN) / 2, THIN];
  // The diagonal is 1.25 modules across, which makes it exactly one module thick at its angle.
  const DIAG = 1.25;

  // علينا, right to left: ع (a square hook, open to the right), ل (tall), ي (tooth, two dots below),
  // ن (tooth, one dot above), ا (tall). Row 9 is the baseline. 'o' marks a dot.
  const KUFI = [
    '#.....#.....',
    '#.....#.....',
    '#.....#.....',
    '#.o...#.....',
    '#.....#.....',
    '#.#.#.#.####',
    '#.#.#.#.#...',
    '#.#.#.#.#...',
    '#.#.#.#.#...',
    '############',
    '............',
    '...o.o......',
  ];
  const KUFI_ROWS = [1, 1, 1, 1, 1, THIN, 2 - THIN, 1, 2 - THIN, THIN, 1, 1];
  // Latin capitals stand on the Kufi baseline and reach exactly the height of its teeth (rows 5 to 9).
  const KUFI_TEETH = { top: 5, bottom: 10 };

  const only = (bits, ch) => bits.map(r => [...r].map(c => (c === ch ? '#' : '.')).join(''));

  /* ---------- Builders. Every builder returns { ink, red, w, h } in path units (U per module). ---------- */

  function nDiagonal(x, y, u) {
    const h = 5 * u;
    return 'M' + num(x) + ' ' + num(y) + 'L' + num(x + DIAG * u) + ' ' + num(y) + 'L' + num(x + 5 * u) + ' ' + num(y + h) + 'L' + num(x + (5 - DIAG) * u) + ' ' + num(y + h) + 'Z';
  }
  function glyph(ch, x, y, u) {
    const d = outline(LATIN[ch], { u, ox: x, oy: y, rowH: LATIN_ROWS });
    return ch === 'N' ? d + nDiagonal(x, y, u) : d;
  }

  // AALA / YNA and the full stop filling the eighth cell. 23 x 11 modules.
  function block(u = U) {
    let ink = '';
    [...'AALAYNA'].forEach((ch, i) => { ink += glyph(ch, (i % 4) * 6 * u, Math.floor(i / 4) * 6 * u, u); });
    const red = outline(TILE, { u, ox: 18 * u, oy: 6 * u });
    return { ink, red, w: 23 * u, h: 11 * u };
  }

  // AALAYNA. on one line: the full stop is one module on the baseline. 43 x 5 modules.
  function line(u = U, ox = 0, oy = 0) {
    let ink = '';
    [...'AALAYNA'].forEach((ch, i) => { ink += glyph(ch, ox + i * 6 * u, oy, u); });
    const red = outline(['#'], { u, ox: ox + 42 * u, oy: oy + (5 - THIN) * u, rowH: [THIN], R: 0, Rt: 0 });
    return { ink, red, w: 43 * u, h: 5 * u };
  }

  // The Kufi mark: 12 x 12 modules.
  function kufi(u = U, ox = 0, oy = 0) {
    return {
      ink: outline(only(KUFI, '#'), { u, ox, oy, rowH: KUFI_ROWS }),
      red: outline(only(KUFI, 'o'), { u, ox, oy, rowH: KUFI_ROWS, R: 0, Rt: 0 }),
      w: 12 * u, h: 12 * u,
    };
  }

  // Kufi mark with the Latin name beside it, capitals standing on the Kufi baseline. 58 x 12 modules.
  function lockup(u = U) {
    const k = kufi(u), top = KUFI_ROWS.slice(0, KUFI_TEETH.top).reduce((a, b) => a + b, 0);
    const l = line(u, 15 * u, top * u);
    return { ink: k.ink + l.ink, red: k.red + l.red, w: 58 * u, h: 12 * u };
  }

  // Latin first, Arabic after: the one-line name with the Kufi mark closing it. 58 x 12 modules.
  function lockupLatin(u = U) {
    const top = KUFI_ROWS.slice(0, KUFI_TEETH.top).reduce((a, b) => a + b, 0);
    const l = line(u, 0, top * u), k = kufi(u, 46 * u, 0);
    return { ink: l.ink + k.ink, red: l.red + k.red, w: 58 * u, h: 12 * u };
  }

  // App and favicon marks on a rounded tile.
  function iconBlock(u = U) {        // the full stop as a tile, the A cut out of it: 10 x 10 modules
    return { tile: roundTile(10 * u, 2.25 * u), ink: glyph('A', 2.5 * u, 2.5 * u, u), w: 10 * u, h: 10 * u };
  }
  function iconKufi(u = U) {         // the Kufi mark centred on its own square: 16 x 16 modules
    const k = kufi(u, 2 * u, 2 * u);
    return { tile: roundTile(16 * u, 3.5 * u), ink: k.ink, red: k.red, w: 16 * u, h: 16 * u };
  }
  function roundTile(s, r) { return 'M' + r + ' 0H' + (s - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + s + ' ' + r + 'V' + (s - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (s - r) + ' ' + s + 'H' + r + 'A' + r + ' ' + r + ' 0 0 1 0 ' + (s - r) + 'V' + r + 'A' + r + ' ' + r + ' 0 0 1 ' + r + ' 0Z'; }

  /* ---------- Modules for motion: every cell of a mark as a unit square, in module coordinates ---------- */

  function cells(bits, ox, oy, kind) {
    const out = [];
    bits.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#' || c === 'o') out.push({ x: ox + x, y: oy + y, red: c === 'o' || kind === 'red' }); }));
    return out;
  }
  // The Block as modules. N's diagonal steps through the grid here and is drawn true when the modules fuse.
  function blockCells() {
    const out = [];
    const N = ['#...#', '##..#', '#.#.#', '#..##', '#...#'];
    [...'AALAYNA'].forEach((ch, i) => out.push(...cells(ch === 'N' ? N : LATIN[ch], (i % 4) * 6, Math.floor(i / 4) * 6).map(c => Object.assign(c, { letter: i }))));
    out.push(...cells(TILE, 18, 6, 'red').map(c => Object.assign(c, { letter: 7 })));
    return out;
  }

  /* ---------- SVG ---------- */

  // mark: a builder result. colors: { ink, red, tile }. pad in modules.
  function svg(mark, colors = {}, pad = 0, u = U, title = 'Aalayna') {
    const c = Object.assign({ ink: COLORS.ink, red: COLORS.red }, colors), p = pad * u;
    const w = mark.w + 2 * p, h = mark.h + 2 * p;
    let body = '';
    if (mark.tile && c.tile) body += '<path fill="' + c.tile + '" d="' + mark.tile + '"/>';
    if (c.ground) body = '<rect width="' + num(w) + '" height="' + num(h) + '" fill="' + c.ground + '"/>' + body;
    const g = (d, fill) => (d && fill ? '<path fill="' + fill + '" d="' + d + '"/>' : '');
    const inner = g(mark.ink, c.ink) + g(mark.red, c.red);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + num(w) + ' ' + num(h) + '" role="img" aria-label="' + title + '"><title>' + title + '</title>' +
      body + (p ? '<g transform="translate(' + num(p) + ' ' + num(p) + ')">' + inner + '</g>' : inner) + '</svg>';
  }

  const api = { COLORS, CORNERS, THIN, U, LATIN, KUFI, LATIN_ROWS, KUFI_ROWS, trace, outline, glyph, block, line, kufi, lockup, lockupLatin, iconBlock, iconKufi, blockCells, nDiagonal, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AalaynaLogo = api;
})(typeof self !== 'undefined' ? self : this);
