/* Aalayna logo geometry. One module grid draws both marks:
   - the Block: the Latin name in square capitals on 5 x 5 modules, stacked in two rows. 3LAYNA fills
     two rows of three (3LA / YNA); a seven-letter spelling (AALA / YNA) gets a red full stop in the spare cell;
   - the Kufi: علينا in square Kufic, the Arabic script that has always been drawn on a square grid.
   One module is the stroke width and every corner is square: the letters are whole modules, the same
   squares the table QR is made of. Horizontals are drawn 8% thinner than verticals so they look the
   same weight. Red marks what is Arabic: the 3, which is how
   Lebanon types ع in Latin letters, and the dots of the Arabic letters. A spelling without a 3 ends on
   a red full stop instead.
   Runs in the browser (window.AalaynaLogo) and in Node (require), so the SVG files, the brand page
   and the motion renders all come from this one file. */
(function (root) {
  'use strict';

  const COLORS = { ink: '#211B16', cream: '#FAF6F1', red: '#C9414B', petrol: '#173E43', peach: '#F6C39F', white: '#FFFFFF' };
  // Corner radii in modules: outer (R), inner (r), stroke ends (Rt). All square; the engine can round them.
  const CORNERS = { R: 0, r: 0, Rt: 0 };
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

  const LATIN_ROWS = [THIN, (5 - 3 * THIN) / 2, THIN, (5 - 3 * THIN) / 2, THIN];
  const RB = LATIN_ROWS.reduce((a, h) => a.concat(a[a.length - 1] + h), [0]);   // row boundaries: 0 ... 5
  // A diagonal is 1.25 modules across, which makes the N's exactly one module thick at its angle.
  const DIAG = 1.25;

  /* ---------- The typeface: the logo's capitals, extended to a full alphabet ---------- */
  // Each glyph is rows of 5 x 5 modules ('#' is ink; a glyph can be narrower) standing on the baseline (y = 5),
  // plus optional extra shapes in module coordinates for the few strokes that leave the grid: diagonals,
  // accents above the capitals and tails below the baseline. Horizontals sit on rows 0, 2 and 4, so the 8%
  // optical thinning reaches every one of them. Lowercase maps onto the same capitals.
  // A parallelogram with horizontal ends: top edge [xt, xt + w] at yt, bottom edge [xb, xb + w] at yb.
  const slant = (xt, yt, xb, yb, w = DIAG) => [[xt, yt], [xt + w, yt], [xb + w, yb], [xb, yb]];
  const box = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  const ACCENT = {                               // centred on c, the glyph's middle
    acute: c => [slant(c + 0.1, -1.7, c - 0.6, -0.8, 1.2)],
    grave: c => [slant(c - 1.3, -1.7, c - 0.6, -0.8, 1.2)],
    circ: c => [box(c - 1.5, -1.25, c - 0.5, -0.8), box(c - 0.5, -1.7, c + 0.5, -1.25), box(c + 0.5, -1.25, c + 1.5, -0.8)],
    uml: c => [box(c - 1.5, -1.7, c - 0.5, -0.8), box(c + 0.5, -1.7, c + 1.5, -0.8)],
  };
  const O5 = ['#####', '#...#', '#...#', '#...#', '#####'];
  const TYPE = {
    A: { bits: ['#####', '#...#', '#####', '#...#', '#...#'] },
    B: { bits: ['####.', '#...#', '#####', '#...#', '####.'] },
    C: { bits: ['#####', '#....', '#....', '#....', '#####'] },
    D: { bits: ['####.', '#...#', '#...#', '#...#', '####.'] },
    E: { bits: ['#####', '#....', '####.', '#....', '#####'] },
    F: { bits: ['#####', '#....', '####.', '#....', '#....'] },
    G: { bits: ['#####', '#....', '#.###', '#...#', '#####'] },
    H: { bits: ['#...#', '#...#', '#####', '#...#', '#...#'] },
    I: { bits: ['#', '#', '#', '#', '#'] },
    J: { bits: ['....#', '....#', '....#', '#...#', '#####'] },
    K: { bits: ['#....', '#....', '#....', '#....', '#....'], extra: [slant(3.75, 0, 1, 2.6), slant(1.9, 2.1, 3.75, 5)] },
    L: { bits: ['#....', '#....', '#....', '#....', '#####'] },
    M: { bits: ['#...#', '#...#', '#...#', '#...#', '#...#'], extra: [slant(0.4, 0, 1.875, 3.4), slant(3.35, 0, 1.875, 3.4)] },
    N: { bits: ['#...#', '#...#', '#...#', '#...#', '#...#'], extra: [slant(0, 0, 5 - DIAG, 5)] },
    O: { bits: O5 },
    P: { bits: ['#####', '#...#', '#####', '#....', '#....'] },
    Q: { bits: ['#####', '#...#', '#...#', '#..##', '#####'], extra: [box(4, 5, 5, 5.9)] },
    R: { bits: ['#####', '#...#', '#####', '#....', '#....'], extra: [slant(2.2, RB[3] - 0.3, 3.75, 5)] },
    S: { bits: ['#####', '#....', '#####', '....#', '#####'] },
    T: { bits: ['#####', '..#..', '..#..', '..#..', '..#..'] },
    U: { bits: ['#...#', '#...#', '#...#', '#...#', '#####'] },
    V: { bits: ['.....', '.....', '.....', '.....', '.....'], extra: [slant(0, 0, 1.875, 5, 1.2), slant(3.8, 0, 1.925, 5, 1.2)] },
    W: { bits: ['#...#', '#...#', '#...#', '#...#', '#...#'], extra: [slant(1.875, 1.6, 0.4, 5), slant(1.875, 1.6, 3.35, 5)] },
    X: { bits: ['.....', '.....', '.....', '.....', '.....'], extra: [slant(0, 0, 5 - DIAG, 5), slant(5 - DIAG, 0, 0, 5)] },
    Y: { bits: ['#...#', '#...#', '#####', '..#..', '..#..'] },
    Z: { bits: ['#####', '.....', '.....', '.....', '#####'], extra: [slant(5 - DIAG, 0, 0, 5)] },
    0: { bits: O5 },
    1: { bits: ['##.', '.#.', '.#.', '.#.', '###'] },
    2: { bits: ['#####', '....#', '#####', '#....', '#####'] },
    3: { bits: ['#####', '....#', '..###', '....#', '#####'] },
    4: { bits: ['#...#', '#...#', '#####', '....#', '....#'] },
    5: { bits: ['#####', '#....', '####.', '....#', '####.'] },
    6: { bits: ['#####', '#....', '#####', '#...#', '#####'] },
    7: { bits: ['#####', '....#', '....#', '....#', '....#'] },
    8: { bits: ['#####', '#...#', '#####', '#...#', '#####'] },
    9: { bits: ['#####', '#...#', '#####', '....#', '#####'] },
    '.': { bits: ['.', '.', '.', '.', '#'] },
    ',': { bits: ['.', '.', '.', '.', '#'], extra: [box(0, 5, 1, 5.9)] },
    ':': { bits: ['.', '#', '.', '.', '#'] },
    ';': { bits: ['.', '#', '.', '.', '#'], extra: [box(0, 5, 1, 5.9)] },
    '!': { bits: ['#', '#', '#', '.', '#'] },
    '?': { bits: ['#####', '....#', '..###', '.....', '..#..'] },
    "'": { bits: ['#', '#', '.', '.', '.'] },
    '"': { bits: ['#.#', '#.#', '...', '...', '...'] },
    '-': { bits: ['...', '...', '###', '...', '...'] },
    '–': { bits: ['.....', '.....', '#####', '.....', '.....'] },
    '·': { bits: ['.', '.', '#', '.', '.'] },
    '*': { bits: ['#.#.#', '.###.', '#.#.#', '.....', '.....'] },
    '+': { bits: ['...', '.#.', '###', '.#.', '...'] },
    '×': { bits: ['...', '#.#', '.#.', '#.#', '...'] },
    '÷': { bits: ['.#.', '...', '###', '...', '.#.'] },
    '(': { bits: ['##', '#.', '#.', '#.', '##'] },
    ')': { bits: ['##', '.#', '.#', '.#', '##'] },
    '/': { bits: ['....', '....', '....', '....', '....'], extra: [slant(4 - DIAG, 0, 0, 5)] },
    '%': { bits: ['##...', '##...', '.....', '...##', '...##'], extra: [slant(5 - DIAG, 0, 0, 5)] },   // 2 x 2 dots: one-module dots vanish at small sizes
    '$': { bits: ['#####', '#....', '#####', '....#', '#####'], extra: [box(2, -0.9, 3, 0), box(2, 5, 3, 5.9)] },
    '&': { bits: ['###..', '#.#..', '###..', '#....', '####.'], extra: [slant(1.5, RB[2], 3.75, 5), box(3.2, RB[2], 5, RB[3])] },
  };
  // Typographic twins and French capitals. Î and Ï stand the I in a three-module cell so the accent stays over its own letter.
  const I3 = { bits: ['.#.', '.#.', '.#.', '.#.', '.#.'] };
  Object.assign(TYPE, { '’': TYPE["'"], '‘': TYPE["'"], '“': TYPE['"'], '”': TYPE['"'], '—': TYPE['–'], '−': TYPE['-'] });
  [['À', 'A', 'grave'], ['Â', 'A', 'circ'], ['Ä', 'A', 'uml'], ['É', 'E', 'acute'], ['È', 'E', 'grave'], ['Ê', 'E', 'circ'], ['Ë', 'E', 'uml'],
    ['Î', 'I', 'circ'], ['Ï', 'I', 'uml'], ['Ô', 'O', 'circ'], ['Ö', 'O', 'uml'], ['Ù', 'U', 'grave'], ['Û', 'U', 'circ'], ['Ü', 'U', 'uml']]
    .forEach(([ch, base, acc]) => { const g = base === 'I' ? I3 : TYPE[base], c = g.bits[0].length / 2; TYPE[ch] = { bits: g.bits, extra: (g.extra || []).concat(ACCENT[acc](c)) }; });
  TYPE['Ç'] = { bits: TYPE.C.bits, extra: [box(2, 5, 3, 5.9)] };
  const SPACE = 2;                               // word space in modules; every glyph also carries a one-module gap

  // One glyph as path data, top-left of its cap height at (x, y). Extra shapes are wound like the outlines.
  function typeGlyph(ch, x = 0, y = 0, u = U) {
    const g = TYPE[ch];
    if (!g) return '';
    let d = outline(g.bits, { u, ox: x, oy: y, rowH: LATIN_ROWS });
    for (const poly of g.extra || []) {
      const area = poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
      const pts = area < 0 ? poly.slice().reverse() : poly;
      d += pts.map((p, i) => (i ? 'L' : 'M') + num(x + p[0] * u) + ' ' + num(y + p[1] * u)).join('') + 'Z';
    }
    return d;
  }
  const typeWidth = ch => (ch === ' ' ? SPACE : TYPE[ch] ? TYPE[ch].bits[0].length + 1 : 0);   // advance, in modules

  // The logo's own capitals are the typeface's: the Block and the font can never drift apart.
  const LATIN = { '3': TYPE[3].bits, A: TYPE.A.bits, L: TYPE.L.bits, Y: TYPE.Y.bits, N: TYPE.N.bits };
  const RED = '3';                           // letters drawn in red
  const SPELLINGS = ['3LAYNA', 'AALAYNA'];
  const NAME = SPELLINGS[0];                 // the spelling every builder draws unless told otherwise
  const TILE = ['#####', '#####', '#####', '#####', '#####'];

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
  const TOOTH = KUFI_ROWS.slice(0, 5).reduce((a, b) => a + b, 0);

  const only = (bits, ch) => bits.map(r => [...r].map(c => (c === ch ? '#' : '.')).join(''));
  const isRed = ch => RED.includes(ch);

  /* ---------- Builders. Every builder returns { ink, red, w, h } in path units (U per module). ---------- */

  function nDiagonal(x, y, u) {
    const h = 5 * u;
    return 'M' + num(x) + ' ' + num(y) + 'L' + num(x + DIAG * u) + ' ' + num(y) + 'L' + num(x + 5 * u) + ' ' + num(y + h) + 'L' + num(x + (5 - DIAG) * u) + ' ' + num(y + h) + 'Z';
  }
  function glyph(ch, x, y, u) {
    const d = outline(LATIN[ch], { u, ox: x, oy: y, rowH: LATIN_ROWS });
    return ch === 'N' ? d + nDiagonal(x, y, u) : d;
  }

  // The Block's grid: two rows; a name with an odd number of letters gets the full stop in the spare cell.
  function grid(word = NAME) { const n = word.length + (word.length % 2); return { cols: n / 2, stop: word.length % 2 === 1 }; }

  // 3LA / YNA (17 x 11 modules), or AALA / YNA with the full stop filling the eighth cell (23 x 11).
  function block(word = NAME, u = U) {
    const { cols, stop } = grid(word);
    let ink = '', red = '';
    [...word].forEach((ch, i) => { const d = glyph(ch, (i % cols) * 6 * u, Math.floor(i / cols) * 6 * u, u); if (isRed(ch)) red += d; else ink += d; });
    if (stop) red += outline(TILE, { u, ox: (cols - 1) * 6 * u, oy: 6 * u });
    return { ink, red, w: (cols * 6 - 1) * u, h: 11 * u };
  }

  // One line: 3LAYNA (35 x 5 modules), or AALAYNA. with its full stop one module on the baseline (43 x 5).
  function line(word = NAME, u = U, ox = 0, oy = 0) {
    let ink = '', red = '';
    [...word].forEach((ch, i) => { const d = glyph(ch, ox + i * 6 * u, oy, u); if (isRed(ch)) red += d; else ink += d; });
    const stop = ![...word].some(isRed);
    if (stop) red += outline(['#'], { u, ox: ox + word.length * 6 * u, oy: oy + (5 - THIN) * u, rowH: [THIN], R: 0, Rt: 0 });
    return { ink, red, w: (word.length * 6 - 1 + (stop ? 2 : 0)) * u, h: 5 * u };
  }

  // The Kufi mark: 12 x 12 modules.
  function kufi(u = U, ox = 0, oy = 0) {
    return {
      ink: outline(only(KUFI, '#'), { u, ox, oy, rowH: KUFI_ROWS }),
      red: outline(only(KUFI, 'o'), { u, ox, oy, rowH: KUFI_ROWS, R: 0, Rt: 0 }),
      w: 12 * u, h: 12 * u,
    };
  }

  // Kufi mark with the Latin name beside it, capitals standing on the Kufi baseline, three modules apart.
  function lockup(word = NAME, u = U) {
    const k = kufi(u), l = line(word, u, 15 * u, TOOTH * u);
    return { ink: k.ink + l.ink, red: k.red + l.red, w: 15 * u + l.w, h: 12 * u };
  }

  // Latin first, Arabic after: the one-line name with the Kufi mark closing it.
  function lockupLatin(word = NAME, u = U) {
    const l = line(word, u, 0, TOOTH * u), k = kufi(u, l.w + 3 * u, 0);
    return { ink: l.ink + k.ink, red: l.red + k.red, w: l.w + 15 * u, h: 12 * u };
  }

  // App and favicon marks on a square tile (phones round it themselves). The Block's is 10 x 10 modules
  // around the first letter: a red 3 on ink, or the initial A cut out of the red full stop.
  function iconBlock(word = NAME, u = U) {
    const ch = word[0], d = glyph(ch, 2.5 * u, 2.5 * u, u);
    return { tile: roundTile(10 * u, 0), ink: isRed(ch) ? '' : d, red: isRed(ch) ? d : '', w: 10 * u, h: 10 * u };
  }
  const iconBlockColors = (word = NAME) => (isRed(word[0]) ? { tile: COLORS.ink, red: COLORS.red } : { tile: COLORS.red, ink: COLORS.cream });
  function iconKufi(u = U) {         // the Kufi mark centred on its own square: 16 x 16 modules
    const k = kufi(u, 2 * u, 2 * u);
    return { tile: roundTile(16 * u, 0), ink: k.ink, red: k.red, w: 16 * u, h: 16 * u };
  }
  function roundTile(s, r) {
    if (!r) return 'M0 0H' + s + 'V' + s + 'H0Z';
    return 'M' + r + ' 0H' + (s - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + s + ' ' + r + 'V' + (s - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (s - r) + ' ' + s + 'H' + r + 'A' + r + ' ' + r + ' 0 0 1 0 ' + (s - r) + 'V' + r + 'A' + r + ' ' + r + ' 0 0 1 ' + r + ' 0Z';
  }

  /* ---------- Modules for motion: every cell of a mark as a unit square, in module coordinates ---------- */

  function cells(bits, ox, oy, red) {
    const out = [];
    bits.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') out.push({ x: ox + x, y: oy + y, red }); }));
    return out;
  }
  // The Block as modules; letter i is the i-th letter, the full stop is letter word.length.
  // N's diagonal steps through the grid here and is drawn true when the modules fuse.
  function blockCells(word = NAME) {
    const { cols, stop } = grid(word), out = [];
    const N = ['#...#', '##..#', '#.#.#', '#..##', '#...#'];
    [...word].forEach((ch, i) => out.push(...cells(ch === 'N' ? N : LATIN[ch], (i % cols) * 6, Math.floor(i / cols) * 6, isRed(ch)).map(c => Object.assign(c, { letter: i }))));
    if (stop) out.push(...cells(TILE, (cols - 1) * 6, 6, true).map(c => Object.assign(c, { letter: word.length })));
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

  const api = { COLORS, CORNERS, THIN, U, LATIN, RED, SPELLINGS, NAME, KUFI, LATIN_ROWS, KUFI_ROWS, TOOTH, TYPE, SPACE, trace, outline, glyph, typeGlyph, typeWidth, grid, block, line, kufi, lockup, lockupLatin, iconBlock, iconBlockColors, iconKufi, blockCells, nDiagonal, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AalaynaLogo = api;
})(typeof self !== 'undefined' ? self : this);
