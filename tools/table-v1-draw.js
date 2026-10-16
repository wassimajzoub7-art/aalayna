#!/usr/bin/env node
// Writes table-v1.html and ar/table-v1.html: prototype V1 of the homepage in style B, soft paper cut-out.
//
//   node tools/table-v1-draw.js
//
// One template, two languages. Every object on the table is drawn here as inline SVG, so it stays editable: two to
// four stacked flat layers of cut paper, each with a soft offset shadow under it (the same shape in ink at low
// opacity, a few units lower: never a filter, never a box-shadow). Food, bread, herbs and napkins have gently
// irregular edges (smooth closed curves through jittered points, seeded so the drawing is the same on every run);
// plates, glasses and cups are circles. Colours are classes, so the palette lives in table-v1.css.
//
// Units. A board (one stretch of the table) is 400 units wide: the chairs 0 to 44 and 356 to 400, the cloth 44 to
// 356, the runner down the middle 130 to 270. An object's own drawing is in the same units (an object of width w
// takes w / 4 percent of its board), so the lettering inside the drawings, which is real SVG text in Instrument Sans
// (IBM Plex Sans Arabic on the Arabic page), is set at the page's size tokens in table units (classes z-s, z-b, z-l,
// z-h in the stylesheet). The Block appears only as the name on the QR card, traced from brand/logo.js.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const Logo = require(path.join(ROOT, 'brand/logo.js'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- Geometry ---------------- */
const f = v => +(+v).toFixed(2);
const pct = v => +(+v).toFixed(3);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// A closed smooth curve through points (Catmull-Rom as cubic Beziers).
function smooth(pts) {
  const n = pts.length; let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}
// A soft, slightly irregular round shape: food, bread, leaves of lettuce.
function blob(cx, cy, rx, ry, seed, j = .1, n = 9, rot = 0) {
  const r = rng(seed), pts = [];
  for (let i = 0; i < n; i++) { const a = rot + i / n * 2 * Math.PI, k = 1 + (r() * 2 - 1) * j; pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]); }
  return smooth(pts);
}
const circle = (cx, cy, r) => `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
const ellipse = (cx, cy, rx, ry) => `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`;
function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}v${f(h - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}h${f(-(w - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}v${f(-(h - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}Z`;
}
// A rectangle cut by hand: each side bows a little, the corners softly rounded. Napkins, cards, paper.
function cut(x, y, w, h, seed, j = 1.2) {
  const r = rng(seed), q = () => (r() * 2 - 1) * j, c = Math.min(w, h) * .12, pts = [];
  pts.push([x + c, y + q()], [x + w / 2, y + q()], [x + w - c, y + q()], [x + w + q() * .4, y + c * .4], [x + w + q(), y + h / 2], [x + w + q() * .4, y + h - c * .4],
    [x + w - c, y + h + q()], [x + w / 2, y + h + q()], [x + c, y + h + q()], [x + q() * .4, y + h - c * .4], [x + q(), y + h / 2], [x + q() * .4, y + c * .4]);
  return smooth(pts);
}
// A leaf: two curves from base to tip.
function leaf(x, y, len, wid, a) {
  const c = Math.cos(a), s = Math.sin(a), tx = x + c * len, ty = y + s * len, mx = x + c * len * .5, my = y + s * len * .5, px = -s * wid, py = c * wid;
  return `M${f(x)} ${f(y)}Q${f(mx + px)} ${f(my + py)} ${f(tx)} ${f(ty)}Q${f(mx - px)} ${f(my - py)} ${f(x)} ${f(y)}Z`;
}
// A rounded bar from (x1, y1) to (x2, y2): a skewer, a stem, a handle.
function bar(x1, y1, x2, y2, t) {
  const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy), nx = -dy / l * t / 2, ny = dx / l * t / 2, h = t / 2;
  return `M${f(x1 + nx)} ${f(y1 + ny)}L${f(x2 + nx)} ${f(y2 + ny)}A${f(h)} ${f(h)} 0 0 0 ${f(x2 - nx)} ${f(y2 - ny)}L${f(x1 - nx)} ${f(y1 - ny)}A${f(h)} ${f(h)} 0 0 0 ${f(x1 + nx)} ${f(y1 + ny)}Z`;
}
function star(cx, cy, ro, ri = ro * .48) {
  const pts = [];
  for (let i = 0; i < 10; i++) { const r = i % 2 ? ri : ro, a = -Math.PI / 2 + i * Math.PI / 5; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return 'M' + pts.map(p => f(p[0]) + ' ' + f(p[1])).join('L') + 'Z';
}
const check = (x, y, s, t) => bar(x, y + s * .55, x + s * .36, y + s * .9, t) + bar(x + s * .36, y + s * .9, x + s, y + s * .12, t);
// The foot of a receipt torn softly: a scalloped edge from (x, y) to (x + w, y).
function receiptShape(x, y, w, h, teeth = 9) {
  let d = `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}`;
  const s = w / teeth;
  for (let i = 0; i < teeth; i++) d += `Q${f(x + w - (i + .5) * s)} ${f(y + h + s * .55)} ${f(x + w - (i + 1) * s)} ${f(y + h)}`;
  return d + 'Z';
}

/* ---------------- A picture: layers of paper, each with its shadow ---------------- */
// add(cls, d, o): the shape in its colour, its shadow first (o units lower). text(): lettering in the drawing.
class Pic {
  constructor() { this.s = ''; }
  add(cls, d, o = 0) { o = Math.min(2, +(o * .66).toFixed(2)); if (o) this.s += `<path class="sh" transform="translate(0 ${o})" d="${d}"/>`; this.s += `<path class="${cls}" d="${d}"/>`; return this; }
  raw(s) { this.s += s; return this; }
  toString() { return this.s; }
}
// Lettering. a: where x is, in drawn space ('l', 'm', 'r'); rtl strings carry their direction so Arabic and figures
// read correctly whatever the page's direction.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function tx(x, y, s, z = 's', o = {}) {
  const rtl = o.rtl || false, a = o.a || 'l';
  const anchor = a === 'm' ? 'middle' : (a === 'l') !== rtl ? 'start' : 'end';
  return `<text class="z-${z} w${o.w || 5} ${o.c || 'k'}" x="${f(x)}" y="${f(y)}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}${rtl ? ' direction="rtl"' : ''}>${esc(s)}</text>`;
}

const QR = JSON.parse(read('brand/motion.js').match(/const QR = (\[[^\]]+\]);/)[1].replace(/'/g, '"'));
// The name in the Block, traced as the logo is: 3LAYNA, the 3 in red.
function blockName(p, x, y, u) {
  let cx = x;
  for (const ch of '3LAYNA') { p.add(ch === '3' ? 'r' : 'k', Logo.typeGlyph(ch, cx, y, u)); cx += Logo.typeWidth(ch) * u; }
  return cx - x - u;
}

/* ---------------- Furniture and tableware (the boards' base layers) ---------------- */
// A chair seen from above, tucked under the cloth: backrest, seat, cushion, each a paper layer.
function chair(p, side, c, H) {
  if (side === 'l') { p.add('o', rr(6, c - 26, 8, 52, 3), 1.5); p.add('kf', rr(13, c - 22, 35, 44, 6), 1.5); p.add('sd', rr(19, c - 16, 22, 32, 5), 1); }
  if (side === 'r') { p.add('o', rr(386, c - 26, 8, 52, 3), 1.5); p.add('kf', rr(352, c - 22, 35, 44, 6), 1.5); p.add('sd', rr(359, c - 16, 22, 32, 5), 1); }
  if (side === 't') { p.add('o', rr(c - 26, 6, 52, 8, 3), 1.5); p.add('kf', rr(c - 22, 13, 44, 35, 6), 1.5); p.add('sd', rr(c - 16, 19, 32, 22, 5), 1); }
  if (side === 'b') { const y = H - 48; p.add('kf', rr(c - 22, y, 44, 35, 6), 1.5); p.add('sd', rr(c - 16, y + 7, 32, 22, 5), 1); p.add('o', rr(c - 26, y + 34, 52, 8, 3), 1.5); }
}
// A round plate: the rim and its well, two paper circles.
function plate(p, cx, cy, r = 32) { p.add('p', circle(cx, cy, r), 3); p.add('p2', circle(cx, cy, r * .7)); p.add('p', circle(cx, cy, r * .62), .8); }
function bowl(p, cx, cy, r = 22) { p.add('p', circle(cx, cy, r), 2.5); p.add('p2', circle(cx, cy, r * .78)); }
// Cutlery, lying along a plate: a fork (tines on its head) and a knife, as rounded paper strips. a: angle.
function fork(p, x, y, l, a = 0) {
  const c = Math.cos(a), s = Math.sin(a), at = (u, v) => [x + c * u - s * v, y + s * u + c * v];
  const [h0x, h0y] = at(0, 0), [h1x, h1y] = at(l * .62, 0);
  let d = bar(h0x, h0y, h1x, h1y, 4.5);
  [-3.4, 0, 3.4].forEach(v => { const [a0x, a0y] = at(l * .6, v), [a1x, a1y] = at(l, v); d += bar(a0x, a0y, a1x, a1y, 2.2); });
  const [bx, by] = at(l * .62, 0); d += ellipse(bx, by, 4.6, 4.6);
  p.add('od', d, 1.6);
}
function knife(p, x, y, l, a = 0) {
  const c = Math.cos(a), s = Math.sin(a), at = (u, v) => [x + c * u - s * v, y + s * u + c * v];
  const [h0x, h0y] = at(0, 0), [h1x, h1y] = at(l * .5, 0), [b1x, b1y] = at(l, -1);
  p.add('od', bar(h0x, h0y, h1x, h1y, 5) + bar(h1x, h1y, b1x, b1y, 6.5), 1.6);
}
// A glass from above: its rim and the water, and a fleck of light.
function glass(p, cx, cy, r = 11) { p.add('op', circle(cx, cy, r), 2.2); p.add('p', circle(cx, cy, r * .74)); p.add('op', circle(cx + r * .28, cy - r * .28, r * .18)); }
// A napkin folded in a triangle over a square, its edges cut by hand.
function napkin(p, x, y, s, a, b, seed) {
  p.add(a, cut(x, y, s, s, seed, 1), 2);
  p.add(b, smooth([[x + 1.5, y + 2], [x + s * .5, y + 1], [x + s - 2, y + 1.5], [x + s * .55, y + s * .5], [x + 1.5, y + s - 2.5], [x + 1, y + s * .5]]), 1.2);
}
function coffee(p, cx, cy) { p.add('p', circle(cx, cy, 17), 2.5); p.add('cp', rr(cx + 9, cy - 3.5, 13, 7, 3.5), 1.2); p.add('cp', circle(cx, cy, 11.5), 1.5); p.add('k', circle(cx, cy, 8)); p.add('cl', circle(cx - 2.5, cy - 2.5, 2.2)); }
function crumbs(p, cx, cy, seed, cls = 'hm') {
  const r = rng(seed); let d = '';
  for (let i = 0; i < 6; i++) { const a = r() * 6.28, q = 6 + r() * 14; d += blob(cx + Math.cos(a) * q, cy + Math.sin(a) * q, 1.6 + r() * 1.6, 1.4 + r() * 1.4, seed + i, .2, 6); }
  p.add(cls, d);
}
// A used place: the plate, the crumbs, the knife and fork laid together across it.
function usedPlate(p, cx, cy, seed, a) { plate(p, cx, cy, 32); crumbs(p, cx, cy, seed, seed % 2 ? 'hm' : 'cp'); fork(p, cx - 18 * Math.cos(a), cy - 18 * Math.sin(a), 40, a); knife(p, cx - 16 * Math.cos(a) + 5 * Math.sin(a), cy - 16 * Math.sin(a) - 5 * Math.cos(a) + 9, 40, a); }
// A place setting at the cloth's left or right edge: the plate, the fork above, the knife below, the glass in front.
function setting(p, side, cy, seed) {
  const L = side === 'l', cx = L ? 92 : 308;
  plate(p, cx, cy, 30);
  if (L) { fork(p, 66, cy - 42, 52, 0); knife(p, 66, cy + 42, 52, 0); glass(p, 136, cy + 40, 11); }
  else { fork(p, 334, cy + 42, 52, Math.PI); knife(p, 334, cy - 42, 52, Math.PI); glass(p, 264, cy - 40, 11); }
}

/* ---------------- Food, cut from paper (drawn on a plate or in a bowl centred at cx, cy) ---------------- */
const FOOD = {
  hummus: (p, cx, cy, r, s) => { p.add('hm', blob(cx, cy, r * .74, r * .7, s, .08), 1.2); p.add('wl', blob(cx, cy, r * .42, r * .38, s + 1, .1), 1); p.add('ol', blob(cx + r * .05, cy, r * .2, r * .16, s + 2, .2, 7)); p.add('c', circle(cx - r * .42, cy - r * .2, 1.6) + circle(cx + r * .38, cy + r * .28, 1.6) + circle(cx - r * .12, cy + r * .46, 1.4)); },
  tabbouleh: (p, cx, cy, r, s) => {
    p.add('ol', blob(cx, cy, r * .72, r * .7, s, .12, 10), 1.2);
    const q = rng(s); let d = '', t = '';
    for (let i = 0; i < 7; i++) { const a = q() * 6.28, d0 = q() * r * .5; d += leaf(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, r * .3, r * .1, q() * 6.28); }
    for (let i = 0; i < 4; i++) { const a = q() * 6.28, d0 = q() * r * .45; t += circle(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, r * .09); }
    p.add('o', d, .8); p.add('cl', t);
  },
  fattoush: (p, cx, cy, r, s) => {
    p.add('op', blob(cx, cy, r * .74, r * .72, s, .12, 10), 1.2);
    const q = rng(s + 3); let g = '', c = '', t = '';
    for (let i = 0; i < 5; i++) { const a = i * 1.26 + q(), d0 = r * .38; g += blob(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, r * .22, r * .16, s + i, .2, 7, a); }
    for (let i = 0; i < 4; i++) { const a = i * 1.57 + .6, d0 = r * .24; c += blob(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, r * .13, r * .11, s + 9 + i, .25, 5, a); }
    t += circle(cx + r * .1, cy - r * .1, r * .1) + circle(cx - r * .3, cy + r * .2, r * .09);
    p.add('ol', g, .8); p.add('hm', c, .8); p.add('cl', t);
  },
  labneh: (p, cx, cy, r, s) => { p.add('p', blob(cx, cy, r * .72, r * .68, s, .08), 1.2); p.add('ol', blob(cx, cy, r * .3, r * .22, s + 1, .2, 7)); p.add('od', circle(cx - r * .38, cy - r * .3, 2) + circle(cx + r * .4, cy + r * .32, 2) + circle(cx + r * .36, cy - r * .36, 2)); p.add('o', leaf(cx - r * .1, cy + r * .44, r * .3, r * .1, -.4)); },
  olives: (p, cx, cy, r, s) => { const q = rng(s); let d = '', h = ''; for (let i = 0; i < 7; i++) { const a = i * .9 + q() * .4, d0 = i ? r * .36 : 0, x = cx + Math.cos(a) * d0, y = cy + Math.sin(a) * d0; d += blob(x, y, r * .2, r * .15, s + i, .05, 8, a); h += circle(x - r * .06, y - r * .05, r * .04); } p.add('od', d, 1); p.add('op', h); },
  grill: (p, cx, cy, r, s) => {
    [-.26, .22].forEach((o, k) => {
      const y = cy + o * r * 1.3; p.add('k', bar(cx - r * .78, y, cx + r * .78, y, 1.6));
      let d = ''; for (let i = 0; i < 4; i++) d += blob(cx - r * .45 + i * r * .3, y, r * .14, r * .13, s + i + k * 4, .15, 7);
      p.add(k ? 'cl' : 'c', d, 1);
    });
    p.add('o', leaf(cx + r * .3, cy + r * .58, r * .26, r * .08, -.3) + leaf(cx + r * .2, cy + r * .6, r * .24, r * .08, 2.6));
  },
  kibbeh: (p, cx, cy, r, s) => { let d = ''; [[-.28, -.18, .5], [.26, -.12, -.4], [0, .3, .1]].forEach(([u, v, a], i) => { d += blob(cx + u * r, cy + v * r, r * .26, r * .15, s + i, .05, 8, a); }); p.add('c', d, 1.2); p.add('cl', [[-.28, -.18], [.26, -.12], [0, .3]].map(([u, v]) => ellipse(cx + u * r - 1, cy + v * r - 1, r * .1, r * .05)).join('')); p.add('p', blob(cx + r * .42, cy + r * .4, r * .14, r * .12, s + 7, .2, 7), .8); p.add('o', leaf(cx - r * .48, cy + r * .36, r * .24, r * .08, -.8)); },
  taouk: (p, cx, cy, r, s) => { p.add('k', bar(cx - r * .8, cy - r * .18, cx + r * .8, cy - r * .18, 1.6)); let d = ''; for (let i = 0; i < 4; i++) d += blob(cx - r * .48 + i * r * .32, cy - r * .18, r * .15, r * .14, s + i, .15, 7); p.add('cl', d, 1); p.add('p', blob(cx - r * .2, cy + r * .36, r * .22, r * .16, s + 6, .15, 8), 1); p.add('hm', blob(cx + r * .32, cy + r * .36, r * .2, r * .13, s + 7, .15, 7), .8); },
  fish: (p, cx, cy, r, s) => {
    p.add('cl', smooth([[cx - r * .62, cy], [cx - r * .2, cy - r * .3], [cx + r * .3, cy - r * .26], [cx + r * .55, cy - r * .06], [cx + r * .55, cy + r * .08], [cx + r * .3, cy + r * .28], [cx - r * .2, cy + r * .3]])
      + smooth([[cx - r * .55, cy], [cx - r * .82, cy - r * .26], [cx - r * .76, cy], [cx - r * .82, cy + r * .26]]), 1.2);
    p.add('c', bar(cx - r * .1, cy - r * .16, cx - r * .1, cy + r * .16, 1.4) + bar(cx + r * .08, cy - r * .18, cx + r * .08, cy + r * .18, 1.4) + bar(cx + r * .26, cy - r * .14, cx + r * .26, cy + r * .14, 1.4));
    p.add('k', circle(cx + r * .4, cy - r * .04, 1.4));
    p.add('hm', `M${f(cx + r * .2)} ${f(cy + r * .46)}a${f(r * .2)} ${f(r * .2)} 0 0 1 ${f(r * .4)} 0Z`, .8);
  },
};
function bread(p, cx, cy) {
  p.add('kf', blob(cx, cy, 34, 26, 41, .06, 10), 2.5);
  p.add('cp', blob(cx, cy, 29, 21, 42, .05, 10));
  p.add('hm', blob(cx - 7, cy - 3, 17, 15, 43, .1), 1.4);
  p.add('hm', blob(cx + 8, cy + 3, 17, 15, 44, .1), 1.4);
  p.add('wl', circle(cx + 4, cy - 1, 1.5) + circle(cx + 12, cy + 6, 1.5) + circle(cx + 9, cy - 4, 1.2) + circle(cx - 11, cy - 6, 1.3));
}

/* ---------------- The objects that carry the story ---------------- */
// Each returns { w, h, svg, ground }: its drawing, and the outline of its lowest layer (the shadow it casts on the
// cloth is drawn apart, so it can arrive a beat after the paper is set down).

// The QR card: the brand's own QR (https://aalayna.com), its finders in red, the name in the Block, the table number.
function qrCard() {
  const p = new Pic(), w = 104, h = 164, g = cut(0, 0, w, h, 7, .6), u = 84 / 25;
  p.add('p', g);
  p.add('tn', cut(6, 6, w - 12, 92, 8, .4), 1);
  const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c > 17) || (r > 17 && c < 7);
  const only = keep => QR.map((row, r) => [...row].map((ch, c) => (ch === '#' && keep(r, c) ? '#' : '.')).join(''));
  p.add('k', Logo.outline(only((r, c) => !finder(r, c)), { u, ox: 10, oy: 10 }));
  p.add('r', Logo.outline(only(finder), { u, ox: 10, oy: 10 }));
  blockName(p, 12, 112, 1.8);
  p.add('k', rr(66, 134, 28, 20, 2), 1);
  p.raw(tx(80, 149, '12', 's', { a: 'm', w: 6, c: 'p' }));
  p.add('sd', rr(12, 141, 44, 3, 1.5) + rr(12, 148, 30, 3, 1.5));
  return { w, h, svg: p.toString(), ground: g };
}

// The guest's phone: body and screen; the screen's content is laid in layers over it (see the screens below).
// The screen's content runs from x 20 to 136 (L to R).
const PW = 156, PH = 304, L = 20, R = 136;
function phone() {
  const p = new Pic(), g = rr(0, 0, PW, PH, 22);
  p.add('k', g); p.add('ks', rr(3, 3, PW - 6, PH - 6, 19)); p.add('p', rr(8, 8, PW - 16, PH - 16, 15));
  p.add('k', rr(60, 14, 36, 9, 4.5)); p.add('sd', rr(58, 288, 40, 4, 2));
  return { w: PW, h: PH, svg: p.toString(), ground: g };
}
// Screens are drawn in the phone's units; X mirrors them for the Arabic page (the phone's UI reads right to left).
const SC = rtl => ({ X: x => rtl ? PW - x : x, a: a => rtl ? ({ l: 'r', r: 'l', m: 'm' })[a] : a, rtl, bx: (x, w) => rtl ? PW - x - w : x });
const DISHES = { en: [['Hummus', '$9', 'hm'], ['Fattoush', '$10', 'ol'], ['Kibbeh', '$14', 'c'], ['Grill', '$28', 'cl'], ['Fish', '$38', 'op']],
  ar: [['حمص', '$9', 'hm'], ['فتوش', '$10', 'ol'], ['كبة', '$14', 'c'], ['مشاوي', '$28', 'cl'], ['سمك', '$38', 'op']] };
function screenMenuHead(lang) {
  const s = SC(lang === 'ar'), X = s.X, p = new Pic();
  p.raw(tx(X(L), 54, lang === 'ar' ? 'القائمة' : 'Menu', 'l', { w: 6, a: s.a('l'), rtl: s.rtl }));
  p.add('k', rr(s.bx(R - 22, 22), 38, 22, 22, 3)); p.raw(tx(X(R - 11), 54, '$', 's', { a: 'm', w: 6, c: 'p' }));
  p.raw(tx(X(R - 28), 54, 'LL', 's', { a: s.a('r'), w: 5, c: 'su' }));
  [['EN', L], ['FR', L + 38], ['AR', L + 76]].forEach(([t, x]) => { const on = t === lang.toUpperCase(), xx = s.bx(x, 36); p.add(on ? 'k' : 'p2', rr(xx, 66, 36, 22, 3)); p.raw(tx(xx + 18, 82, t, 's', { a: 'm', w: 6, c: on ? 'p' : 'k' })); });
  return p.toString();
}
const DISH_Y = k => 102 + k * 36;
function dishRow(lang, k) {
  const s = SC(lang === 'ar'), X = s.X, p = new Pic(), [name, price, c] = DISHES[lang][k], y = DISH_Y(k);
  p.add('p2', blob(X(L + 12), y + 13, 12, 11.5, 60 + k, .06, 8)); p.add(c, blob(X(L + 12), y + 13, 8.5, 8, 70 + k, .14, 8), .8);
  p.raw(tx(X(L + 32), y + 18, name, 's', { w: 5, a: s.a('l'), rtl: s.rtl }));
  p.raw(tx(X(R), y + 18, price, 's', { w: 6, a: s.a('r') }));
  if (k < 4) p.add('p2', rr(L, y + 31, R - L, 1.5, .75));
  return p.toString();
}
// The receipt, Table 12: six lines and the total, its foot torn softly.
const BILL = { en: [['Hummus', '$9'], ['Fattoush', '$10'], ['Kibbeh', '$14'], ['Grill', '$56'], ['Fish', '$38'], ['Arak', '$25.50']],
  ar: [['حمص', '$9'], ['فتوش', '$10'], ['كبة', '$14'], ['مشاوي', '$56'], ['سمك', '$38'], ['عرق', '$25.50']] };
const RW = 128, RH = 212;
function receipt(lang) {
  const rtl = lang === 'ar', X = x => rtl ? RW - x : x, A = a => rtl ? ({ l: 'r', r: 'l' })[a] : a, p = new Pic(), g = receiptShape(0, 0, RW, RH - 8, 11);
  p.add('p', g);
  p.raw(tx(X(14), 26, rtl ? 'طاولة 12' : 'Table 12', 's', { w: 6, a: A('l'), rtl }));
  p.raw(tx(X(RW - 14), 26, '21:40', 's', { w: 5, a: A('r'), c: 'su' }));
  p.add('sd', rr(14, 36, RW - 28, 1.5, .75));
  BILL[lang].forEach(([n, v], i) => { const y = 58 + i * 21; p.raw(tx(X(14), y, n, 's', { a: A('l'), rtl })); p.raw(tx(X(RW - 14), y, v, 's', { a: A('r') })); });
  p.add('k', rr(14, 178, RW - 28, 1.5, .75));
  p.raw(tx(X(RW - 14), 199, '$152.50', 'b', { w: 6, a: A('r') }));
  return { w: RW, h: RH, svg: p.toString(), ground: g };
}
// The folder the bill comes in: a clay frame, a cream liner.
function tray() {
  const p = new Pic(), w = 156, h = 244, g = cut(0, 0, w, h, 21, .8);
  p.add('c', g); p.add('p2', cut(6, 6, w - 12, h - 12, 22, .5));
  return { w, h, svg: p.toString(), ground: g };
}
// The split, on the phone: the bill's head (where the receipt lands), the ÷4, four shares.
const INITIALS = { en: ['R', 'M', 'K', 'Y'], ar: ['ر', 'م', 'ك', 'أ'] };
function splitHead(lang) {
  const s = SC(lang === 'ar'), X = s.X, p = new Pic();
  p.raw(tx(X(L), 48, lang === 'ar' ? 'طاولة 12' : 'Table 12', 's', { w: 5, a: s.a('l'), rtl: s.rtl, c: 'su' }));
  p.raw(tx(X(L), 74, '$152.50', 'l', { w: 6, a: s.a('l') }));
  return p.toString();
}
function splitDiv(lang) { const s = SC(lang === 'ar'); return tx(s.X(R), 75, '÷4', 'h', { w: 6, a: s.a('r'), c: 'rt' }); }
const SHARE_Y = k => 92 + k * 44;
function shareRow(lang, k) {
  const s = SC(lang === 'ar'), X = s.X, p = new Pic(), y = SHARE_Y(k), mine = k === 3;
  p.add(mine ? 'wl' : 'p2', rr(18, y, 120, 36, 4), mine ? 1.5 : 0);
  p.add(['c', 'o', 'cl', 'k'][k], circle(X(L + 16), y + 18, 10));
  p.raw(tx(X(L + 16), y + 23, INITIALS[lang][k], 's', { a: 'm', w: 6, c: 'p' }));
  if (mine) p.raw(tx(X(L + 34), y + 23, lang === 'ar' ? 'أنت' : 'You', 's', { w: 6, a: s.a('l'), rtl: s.rtl }));
  p.raw(tx(X(R - 6), y + 24, '$38.13', 'b', { w: 6, a: s.a('r') }));
  return p.toString();
}
// The payment, on the phone: your share (where the fourth share lands), the tip suggested, three ways to pay, pay.
function payAmt(lang) {
  const s = SC(lang === 'ar'), X = s.X, p = new Pic();
  p.add('wl', rr(18, 30, 120, 58, 4), 1.5);
  p.raw(tx(X(L + 10), 53, lang === 'ar' ? 'حصتك' : 'Your share', 's', { w: 5, a: s.a('l'), rtl: s.rtl, c: 'su' }));
  p.raw(tx(X(L + 10), 78, '$38.13', 'l', { w: 6, a: s.a('l') }));
  return p.toString();
}
function payTip(lang) {
  const s = SC(lang === 'ar'), X = s.X, p = new Pic();
  p.raw(tx(X(L), 114, lang === 'ar' ? 'إكرامية' : 'Tip', 's', { w: 6, a: s.a('l'), rtl: s.rtl }));
  p.raw(tx(X(R), 114, '+$3.81', 's', { w: 5, a: s.a('r'), c: 'su' }));
  [['5%', 18], ['10%', 58], ['15%', 98]].forEach(([t, x], i) => { const xx = s.bx(x, 40); p.add(i === 1 ? 'k' : 'p2', rr(xx, 122, 40, 24, 3)); p.raw(tx(xx + 20, 139, t, 's', { a: 'm', w: 6, c: i === 1 ? 'p' : 'k' })); });
  return p.toString();
}
const WAYS = { en: ['Whish', 'Card', 'Cash'], ar: ['Whish', 'بطاقة', 'نقداً'] };
const WAY_Y = k => 158 + k * 30;
function payWay(lang, k) {
  const s = SC(lang === 'ar'), X = s.X, p = new Pic(), y = WAY_Y(k), on = k === 0;
  p.add(on ? 'tn' : 'p2', rr(18, y, 120, 26, 3), on ? 1.2 : 0);
  p.add(['c', 'o', 'ol'][k], rr(s.bx(28, 16), y + 7, 16, 12, 2));
  p.raw(tx(X(52), y + 18, WAYS[lang][k], 's', { w: on ? 6 : 5, a: s.a('l'), rtl: s.rtl && k > 0 }));
  p.add('k', circle(X(126), y + 13, 6)); p.add(on ? 'k' : 'p', circle(X(126), y + 13, on ? 3.4 : 4.4));
  if (on) p.add('p', circle(X(126), y + 13, 1.3));
  return p.toString();
}
function payBtn(lang) {
  const p = new Pic();
  p.add('r', rr(18, 252, 120, 30, 4), 1.5);
  p.raw(tx(78, 272, lang === 'ar' ? 'ادفع \u2066$41.94\u2069' : 'Pay $41.94', 's', { a: 'm', w: 6, c: 'p', rtl: lang === 'ar' }));
  return p.toString();
}
// A bank card, olive, lengthwise; a cash note beside it.
function bankCard() {
  const p = new Pic(), w = 58, h = 92, g = rr(0, 0, w, h, 5);
  p.add('o', g); p.add('od', rr(12, 0, 4, h, 0)); p.add('hm', rr(30, 12, 14, 18, 3), 1); p.add('ol', rr(33, 15, 8, 12, 1.5));
  p.add('op', rr(44, 50, 4, 30, 2) + rr(37, 62, 4, 18, 2));
  return { w, h, svg: p.toString(), ground: g };
}
function cashNote() {
  const p = new Pic(), w = 64, h = 126, g = cut(0, 0, w, h, 31, .6);
  p.add('op', g); p.add('ol', cut(6, 6, w - 12, h - 12, 32, .4)); p.add('op', cut(7.5, 7.5, w - 15, h - 15, 33, .4));
  p.add('ol', circle(32, 63, 15), 1); p.add('op', circle(32, 63, 9)); p.add('o', leaf(32, 70, 13, 4, -1.57));
  p.raw(tx(16, 28, '50', 's', { w: 6, c: 'od' }) + tx(48, 110, '50', 's', { w: 6, c: 'od', a: 'r' }));
  return { w, h, svg: p.toString(), ground: g };
}
// The review card: a question, five stars (the red ones are their own layers), the button to Google.
const CW = 160, CH = 196;
function reviewCard(lang) {
  const rtl = lang === 'ar', X = x => rtl ? CW - x : x, A = a => rtl ? ({ l: 'r', r: 'l', m: 'm' })[a] : a, p = new Pic(), g = cut(0, 0, CW, CH, 51, .6);
  p.add('p', g);
  p.raw(tx(X(16), 30, rtl ? 'طاولة 12' : 'Table 12', 's', { w: 5, a: A('l'), rtl, c: 'su' }));
  p.raw(tx(X(16), 54, rtl ? 'كيف كان العشاء؟' : 'How was dinner?', 'b', { w: 6, a: A('l'), rtl }));
  for (let i = 0; i < 5; i++) p.add('p2', star(STAR_X(i), 92, 12));
  p.add('sd', rr(16, 120, 128, 3, 1.5) + rr(16, 129, 92, 3, 1.5));
  p.add('k', rr(16, 148, 128, 32, 3), 1.5);
  p.raw(tx(80, 169, rtl ? 'قيّمنا على Google' : 'Review on Google', 's', { a: 'm', w: 6, c: 'p', rtl }));
  return { w: CW, h: CH, svg: p.toString(), ground: g };
}
const STAR_X = i => 28 + i * 26;
// Set again for next time: a clean plate, a napkin folded on it, the fork and knife, the glass.
function freshSetting(side, nap, seed) {
  const p = new Pic(), L = side === 'l', w = 100, h = 120, cx = L ? 38 : 62, g = circle(cx, 60, 33);
  p.add('p', g); p.add('p2', circle(cx, 60, 23)); p.add('p', circle(cx, 60, 20.5), .8);
  napkin(p, cx - 15, 45, 30, nap[0], nap[1], seed);
  if (L) { fork(p, 10, 12, 54, 0); knife(p, 10, 108, 54, 0); glass(p, 86, 104, 11); }
  else { fork(p, 90, 108, 54, Math.PI); knife(p, 90, 12, 54, Math.PI); glass(p, 14, 16, 11); }
  return { w, h, svg: p.toString(), ground: g };
}
// A low clay vase with an olive branch, the middle of the table set again.
function oliveBranch() {
  const p = new Pic(), g = circle(50, 56, 21);
  p.add('c', g); p.add('cl', circle(50, 56, 15)); p.add('c', circle(50, 56, 7));
  p.add('od', bar(50, 56, 50, 6, 2.4) + bar(50, 40, 24, 22, 2) + bar(50, 30, 78, 14, 2) + bar(50, 70, 80, 88, 2), 1);
  const L = [[50, 8, -1.9], [50, 10, -1.2], [44, 30, -2.6], [32, 26, -2.0], [26, 22, -2.8], [58, 26, -.6], [68, 20, -1.2], [74, 15, -.3], [62, 74, .4], [72, 82, 1.2], [78, 87, .2], [50, 20, -2.4], [50, 18, -.7]];
  p.add('o', L.filter((_, i) => i % 2 === 0).map(([x, y, a]) => leaf(x, y, 15, 4, a)).join(''), 1);
  p.add('ol', L.filter((_, i) => i % 2 === 1).map(([x, y, a]) => leaf(x, y, 14, 3.8, a)).join(''), 1);
  p.add('od', ellipse(30, 20, 3.4, 2.6) + ellipse(70, 12, 3.4, 2.6) + ellipse(76, 84, 3.4, 2.6));
  return { w: 100, h: 100, svg: p.toString(), ground: g };
}
// The restaurant's own bill: two months at $0, then $150 a month.
const PRW = 156, PRH = 230;
function priceReceipt(lang) {
  const rtl = lang === 'ar', X = x => rtl ? PRW - x : x, A = a => rtl ? ({ l: 'r', r: 'l' })[a] : a, p = new Pic(), g = receiptShape(0, 0, PRW, PRH - 10, 12);
  p.add('p', g);
  p.add('c', rr(rtl ? PRW - 16 - 12 : 16, 18, 12, 12, 1));
  p.raw(tx(X(36), 29, rtl ? 'مطعمك، فرع واحد' : 'Your restaurant', 's', { w: 6, a: A('l'), rtl }));
  p.add('sd', rr(16, 42, PRW - 32, 1.5, .75));
  const rows = rtl ? [['الشهر 1', '$0', 'ot'], ['الشهر 2', '$0', 'ot'], ['الشهر 3', '$150', 'k']] : [['Month 1', '$0', 'ot'], ['Month 2', '$0', 'ot'], ['Month 3', '$150', 'k']];
  rows.forEach(([m, v, c], i) => { const y = 82 + i * 38; p.raw(tx(X(16), y, m, 'b', { w: 5, a: A('l'), rtl })); p.raw(tx(X(PRW - 16), y + 2, v, 'l', { w: 6, a: A('r'), c })); });
  p.add('k', rr(16, 174, PRW - 32, 1.5, .75));
  p.raw(tx(X(16), 198, rtl ? 'ثم كل شهر' : 'then every month', 's', { w: 5, a: A('l'), rtl, c: 'su' }));
  return { w: PRW, h: PRH, svg: p.toString(), ground: g };
}

/* ---------------- Placing things on a board ---------------- */
// An object: the shadow it casts on the cloth (its own layer), then the piece and whatever is laid on it (.pc).
// x, y in table units; i orders the arrivals; inner: layers inside the piece, in the piece's own units.
function obj(cls, d, x, y, H, a = {}, inner = '') {
  const st = `--x:${pct(x / 4)};--y:${pct(y / H * 100)};--w:${pct(d.w / 4)}` + (a.i ? `;--i:${a.i}` : '');
  const vb = `0 0 ${d.w} ${d.h}`;
  return `<div class="ob ${cls}" style="${st}"><svg class="osh" viewBox="${vb}" focusable="false"><path class="cast" transform="translate(0 ${a.sh || 3})" d="${d.ground}"/></svg>`
    + `<div class="pc"><svg class="pz" viewBox="${vb}" focusable="false">${d.svg}</svg>${inner}</div></div>`;
}
// A layer inside a piece, cropped to its box (x, y, w, h in the piece's units) so it can move on its own.
function lay(cls, W, H, x, y, w, h, svg, style = '') {
  return `<svg class="ly ${cls}" viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" style="left:${pct(x / W * 100)}%;top:${pct(y / H * 100)}%;width:${pct(w / W * 100)}%${style}" focusable="false">${svg}</svg>`;
}
// A box inside a piece with no drawing: where a travelling layer lands.
const spot = (id, W, H, x, y, w, h) => `<span class="spot" id="${id}" style="left:${pct(x / W * 100)}%;top:${pct(y / H * 100)}%;width:${pct(w / W * 100)}%;height:${pct(h / H * 100)}%"></span>`;

const BOARDS = {
  // The head of the table: the head chair and the cloth's first edge (it peeks in under the poster).
  head: () => { const H = 72, b = new Pic(); chair(b, 't', 200, H); return { H, base: b, objs: [] }; },
  // The first place: a setting, the olives, and the QR card on the runner. A red line passes down its code.
  qr: () => {
    const H = 330, b = new Pic();
    chair(b, 'l', 150, H); chair(b, 'r', 190, H);
    setting(b, 'l', 150, 1);
    bowl(b, 306, 96, 22); FOOD.olives(b, 306, 96, 17, 5);
    const card = qrCard();
    const scan = `<span class="scan" style="left:${pct(10 / card.w * 100)}%;top:${pct(10 / card.h * 100)}%;width:${pct(84 / card.w * 100)}%;height:${pct(84 / card.h * 100)}%"><i></i></span>`;
    return { H, base: b, objs: [obj('ob-qr', card, 148, 76, H, {}, scan)] };
  },
  // The menu on the guest's phone; the bread, a setting.
  menu: lang => {
    const H = 360, b = new Pic();
    chair(b, 'l', 250, H); chair(b, 'r', 150, H);
    setting(b, 'l', 250, 2);
    glass(b, 316, 96, 11);
    const ph = phone();
    const head = lay('scr-head', PW, PH, 12, 32, 132, 60, screenMenuHead(lang));
    const rows = [0, 1, 2, 3, 4].map(k => lay('dish', PW, PH, 12, DISH_Y(k) - 2, 132, 36, dishRow(lang, k), `;--k:${k}`)).join('');
    return { H, base: b, objs: [
      obj('ob-bread', (() => { const p = new Pic(); bread(p, 40, 32); return { w: 80, h: 64, svg: p.toString(), ground: blob(40, 32, 34, 26, 41, .06, 10) }; })(), 50, 60, H, { i: 1 }),
      obj('ob-phone ob-menu', ph, 122, 30, H, { sh: 4 }, head + rows),
    ] };
  },
  // Dinner: four full plates along the sides, the mezze down the runner.
  mezze: () => {
    const H = 400, b = new Pic();
    [92, 308].forEach(c => { chair(b, 'l', c, H); chair(b, 'r', c, H); });
    const plateOf = (name, seed) => { const p = new Pic(); plate(p, 34, 34, 32); FOOD[name](p, 34, 34, 22, seed); return { w: 68, h: 72, svg: p.toString(), ground: circle(34, 34, 32) }; };
    const bowlOf = (name, seed, r = 24) => { const p = new Pic(); bowl(p, r, r, r); FOOD[name](p, r, r, r * .8, seed); return { w: r * 2, h: r * 2 + 3, svg: p.toString(), ground: circle(r, r, r) }; };
    const pita = (() => { const p = new Pic(); bread(p, 40, 32); return { w: 80, h: 64, svg: p.toString(), ground: blob(40, 32, 34, 26, 41, .06, 10) }; })();
    [[68, 128, 1], [68, 288, 2], [332, 128, 3], [332, 288, 4]].forEach(([x, y]) => { /* cutlery beside each plate */
      if (x < 200) { fork(b, x - 20, y - 46, 46, 0); knife(b, x - 20, y + 46, 46, 0); } else { fork(b, x + 20, y + 46, 46, Math.PI); knife(b, x + 20, y - 46, 46, Math.PI); }
    });
    return { H, base: b, objs: [
      obj('ob-plate', plateOf('grill', 11), 58, 58, H, { i: 0 }), obj('ob-plate', plateOf('kibbeh', 12), 274, 58, H, { i: 1 }),
      obj('ob-bowl', bowlOf('hummus', 13), 146, 60, H, { i: 2 }), obj('ob-bowl', bowlOf('tabbouleh', 14), 206, 60, H, { i: 3 }),
      obj('ob-bread', pita, 160, 166, H, { i: 4 }),
      obj('ob-bowl', bowlOf('labneh', 16), 176, 268, H, { i: 5 }),
      obj('ob-plate', plateOf('taouk', 18), 58, 254, H, { i: 7 }), obj('ob-plate', plateOf('fish', 19), 274, 254, H, { i: 8 }),
    ] };
  },
  // The plates are empty; the bill comes on its tray. The receipt is its own layer: it lifts, travels down the table
  // and lands in the split phone (#land-bill).
  bill: lang => {
    const H = 380, b = new Pic();
    [80, 300].forEach(c => { chair(b, 'l', c, H); chair(b, 'r', c, H); });
    usedPlate(b, 90, 80, 1, .6); usedPlate(b, 310, 80, 2, 2.4); usedPlate(b, 90, 300, 3, -.5); usedPlate(b, 310, 300, 4, 3.6);
    const t = tray(), r = receipt(lang), rx = 14, ry = 16;
    const rc = `<span class="rc" style="left:${pct(rx / t.w * 100)}%;top:${pct(ry / t.h * 100)}%;width:${pct(r.w / t.w * 100)}%"><span class="rc-go" data-go="land-bill" data-from=".42" data-to=".5" data-min=".55">`
      + `<svg class="rc-sh" viewBox="0 0 ${r.w} ${r.h}" focusable="false"><path class="cast" transform="translate(0 3)" d="${r.ground}"/></svg><svg class="rc-pz" viewBox="0 0 ${r.w} ${r.h}" focusable="false">${r.svg}</svg></span></span>`;
    return { H, base: b, objs: [obj('ob-tray', t, 122, 64, H, {}, rc)] };
  },
  // The split: the bill lands in the phone, ÷4, then the four shares one after another.
  split: lang => {
    const H = 380, b = new Pic();
    chair(b, 'l', 190, H); chair(b, 'r', 190, H);
    coffee(b, 84, 120); glass(b, 320, 270, 11);
    const ph = phone();
    const head = lay('scr-head', PW, PH, 14, 30, 96, 52, splitHead(lang));
    const div = lay('div4', PW, PH, lang === 'ar' ? 14 : 92, 44, 50, 38, splitDiv(lang));
    const shares = [0, 1, 2, 3].map(k => {
      const y = SHARE_Y(k), go = k === 3 ? ' data-go="land-share" data-from=".38" data-to=".5" data-min=".4"' : '';
      return `<span class="share share-${k}" style="--k:${k};left:${pct(16 / PW * 100)}%;top:${pct((y - 2) / PH * 100)}%;width:${pct(124 / PW * 100)}%"${go}>${`<svg viewBox="16 ${y - 2} 124 42" focusable="false">${shareRow(lang, k)}</svg>`}</span>`;
    }).join('');
    return { H, base: b, objs: [obj('ob-phone ob-split', ph, 122, 38, H, { sh: 4 }, spot('land-bill', PW, PH, 16, 28, 124, 120) + head + div + shares)] };
  },
  // Settling: yours becomes the payment (#land-share); the tip, the ways to pay, then pay. A card and a note beside.
  pay: lang => {
    const H = 380, b = new Pic();
    chair(b, 'l', 120, H); chair(b, 'r', 260, H);
    const ph = phone();
    const layers = spot('land-share', PW, PH, 16, 28, 124, 62) + lay('pay-amt', PW, PH, 16, 28, 124, 64, payAmt(lang))
      + lay('pay-row', PW, PH, 14, 96, 128, 54, payTip(lang), ';--k:0')
      + [0, 1, 2].map(k => lay('pay-row', PW, PH, 16, WAY_Y(k) - 2, 124, 30, payWay(lang, k), `;--k:${k + 1}`)).join('')
      + lay('pay-row', PW, PH, 16, 250, 124, 36, payBtn(lang), ';--k:4');
    return { H, base: b, objs: [
      obj('ob-phone ob-pay', ph, 122, 38, H, { sh: 4 }, layers),
      obj('ob-card', bankCard(), 56, 70, H, { i: 1, sh: 4 }),
      obj('ob-cash', cashNote(), 282, 176, H, { i: 2, sh: 4 }),
    ] };
  },
  // The review card on the runner; five stars arrive one by one.
  review: lang => {
    const H = 320, b = new Pic();
    chair(b, 'l', 160, H); chair(b, 'r', 160, H);
    coffee(b, 316, 220);
    const card = reviewCard(lang);
    const stars = [0, 1, 2, 3, 4].map(i => lay('star', CW, CH, STAR_X(i) - 14, 76, 28, 30, new Pic().add('r', star(STAR_X(i), 92, 12), 1.4).toString(), `;--k:${i}`)).join('');
    return { H, base: b, objs: [obj('ob-review', card, 120, 58, H, {}, stars)] };
  },
  // Next time: the table set again, an olive branch in the middle.
  again: () => {
    const H = 340, b = new Pic();
    chair(b, 'l', 170, H); chair(b, 'r', 170, H);
    return { H, base: b, objs: [
      obj('ob-set', freshSetting('l', ['ol', 'o'], 61), 52, 110, H, { i: 0, sh: 3 }),
      obj('ob-set', freshSetting('r', ['cl', 'c'], 62), 248, 110, H, { i: 1, sh: 3 }),
      obj('ob-branch', oliveBranch(), 150, 120, H, { i: 2 }),
    ] };
  },
  // At the foot of the table, the restaurant's own bill.
  price: lang => {
    const H = 300, b = new Pic();
    chair(b, 'l', 150, H); chair(b, 'r', 150, H);
    glass(b, 318, 230, 11);
    return { H, base: b, objs: [obj('ob-price', priceReceipt(lang), 122, 34, H, {})] };
  },
  // The foot of the table: the cloth's last edge and the chair at the end.
  foot: () => { const H = 72, b = new Pic(); chair(b, 'b', 200, H); return { H, base: b, objs: [] }; },
};

function board(key, label, lang, cls = '') {
  const { H, base, objs } = BOARDS[key](lang);
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<div class="board${cls}" style="--h:${H}" ${a11y}><svg class="base" viewBox="0 0 400 ${H}" focusable="false">${base}</svg>${objs.join('')}</div>`;
}

/* ---------------- Copy ---------------- */
const enHome = read('index.html'), arHome = read('ar/index.html');
const logo = (s, where) => s.match(where === 'header' ? /<header[\s\S]*?(<a class="logo"[^>]*>[\s\S]*?<\/a>)/ : /<footer[^>]*>\s*(<a class="logo"[^>]*>[\s\S]*?<\/a>)/)[1];
const LOGOS = { en: { head: logo(enHome, 'header'), foot: logo(enHome, 'footer') }, ar: { head: logo(arHome, 'header'), foot: logo(arHome, 'footer') } };

const EN = {
  lang: 'en', dir: '', pre: '',
  title: 'Aalayna: nobody waits for the bill · the table, V1',
  desc: 'Prototype V1 of the Aalayna homepage. Nobody waits for the bill: tables turn faster, tips go up, reviews come in. QR menus, bill splitting and payment for restaurants in Lebanon.',
  ogTitle: 'Aalayna: nobody waits for the bill.',
  ogDesc: 'Tables turn faster. Tips go up. Reviews come in. QR menus, bill splitting and payment for restaurants in Lebanon: $150 / month / location, the first two months free.',
  ogUrl: 'https://aalayna.com/table-v1.html', locale: 'en_GB', localeAlt: 'ar_LB',
  ogAlt: 'The Aalayna payment screen on a phone: the guest\'s share, a tip, and Whish Money, card or cash.',
  fonts: 'family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Arabic:wght@400;600&display=swap',
  skip: 'Skip to content', nav: 'Main navigation',
  links: [['#table', 'The table'], ['#price', 'Price']],
  lang2: '<a class="lang" href="ar/table-v1.html" hreflang="ar" lang="ar" aria-label="العربية">عربي</a>',
  book: 'Book a demo', bookHref: 'book.html',
  wa: 'WhatsApp us', waHref: 'https://wa.me/33665745963?text=Hi%2C%20I%27d%20like%20to%20discuss%20Aalayna%20for%20my%20restaurant',
  waFoot: 'https://wa.me/33665745963?text=Hi%2C%20I%27d%20like%20to%20learn%20more%20about%20Aalayna',
  eyebrow: 'For restaurants in Lebanon',
  name: '<span class="sr-only">Aalayna.</span><span class="name" aria-hidden="true"><em>3</em>layna.</span>',
  tag: 'Nobody waits for the bill.',
  sub: 'Tables turn faster. Tips go up. Reviews come in.',
  does: 'Scan. Split. Settle.',
  price: '<span class="amt">$150</span> <span class="unit">/ month / location</span>',
  free: 'The first two months are free.',
  tableTitle: 'One table, one evening',
  tableAlt: 'Seen from above, one long table through one evening: the QR card at the first place, the menu on a phone, mezze, then empty plates and the bill on its tray, a phone splitting $152.50 four ways at $38.13 each, payment by Whish with a card and a cash note beside it, the review card, and the table set again at the far end.',
  s: {
    qr: { step: '01 · The QR card', head: 'Scan.', say: 'One QR code per table. Guests read the menu, split the bill and pay on their phone. No app to download.' },
    menu: { step: '02 · The menu', head: 'Browse.', say: 'In their language. In dollars or lira.' },
    mezze: { step: 'Dinner', head: 'Sahtein.', say: 'Dinner, as usual.' },
    bill: { step: '03 · The bill', head: 'The bill.', say: 'On their phone the moment they ask for it.', fig: ['10 min', 'Saved per table: nobody waits for the bill.'] },
    split: { step: '04 · The split', head: 'Split.', say: 'Evenly, by dish or by amount. Four friends, $38.13 each.', cta: 'table' },
    pay: { step: '05 · The payment', head: 'Settle.', say: 'Whish, card or cash. Staff confirm the cash when they collect it.', fig: ['22%', 'Average tip per table once it is suggested at payment, up from 10%.'] },
    review: { step: '06 · The review', head: 'Rate.', say: 'One tap after paying, then a review on Google.', fig: ['83%', 'Of customers asked for a review leave one. Aalayna asks every table.'] },
    again: { step: '07 · Next time', head: 'Again.', say: 'Guests can leave a number and opt in to your offers. See who comes back, and who stopped.', fig: ['50%', 'Of orders can come from the few guests who return. Aalayna tells you who they are.'], cta: 'outcomes' },
    price: { step: 'For your restaurant', head: '<span class="amt">$150</span> <span class="unit">/ month / location</span>', say: 'First 10 founding restaurants lock in <strong>$100/month per location.</strong>', pill: 'Free two-month pilot', pilot: 'Two months free from go-live. Continue only if it works for your restaurant.', cta: 'pricing', more: 'How the pilot runs, and the questions owners ask' },
  },
  askEyebrow: 'Ahla w sahla', askHead: 'Your table is ready.', askSay: 'Tell us about your restaurant. The rest is on us.',
  film: 'Or watch the 96-second film',
  foot: '© 2026 Aalayna · For restaurants in Lebanon', footLang: '',
};
const AR = {
  lang: 'ar', dir: ' dir="rtl"', pre: '../',
  title: 'علينا: لا أحد ينتظر الفاتورة · الطاولة، النسخة 1',
  desc: 'النسخة التجريبية الأولى من الصفحة الرئيسية لعلينا. لا أحد ينتظر الفاتورة: الطاولات تدور أسرع، والإكرامية تكبر، والمراجعات تتوالى. قوائم QR وتقسيم الفاتورة والدفع للمطاعم في لبنان.',
  ogTitle: 'علينا: لا أحد ينتظر الفاتورة.',
  ogDesc: 'الطاولات تدور أسرع. الإكرامية تكبر. والمراجعات تتوالى. قوائم QR وتقسيم الفاتورة والدفع للمطاعم في لبنان: $150 / شهرياً / للفرع، والشهران الأولان مجاناً.',
  ogUrl: 'https://aalayna.com/ar/table-v1.html', locale: 'ar_LB', localeAlt: 'en_GB',
  ogAlt: 'شاشة الدفع في Aalayna على الهاتف: حصة الضيف، وإكرامية، وWhish Money أو البطاقة أو النقد.',
  fonts: 'family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Noto+Kufi+Arabic:wght@700&display=swap',
  skip: 'انتقل إلى المحتوى', nav: 'التنقل الرئيسي',
  links: [['#table', 'الطاولة'], ['#price', 'السعر']],
  lang2: '<a class="lang" href="../table-v1.html" hreflang="en" lang="en" aria-label="English">EN</a>',
  book: 'احجز عرضاً توضيحياً', bookHref: '../book.html',
  wa: 'راسلنا على واتساب', waHref: 'https://wa.me/33665745963?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7%D9%8B%D8%8C%20%D8%A3%D9%88%D8%AF%D9%91%20%D8%A7%D9%84%D8%AA%D8%AD%D8%AF%D8%AB%20%D8%B9%D9%86%20Aalayna%20%D9%84%D9%85%D8%B7%D8%B9%D9%85%D9%8A',
  waFoot: 'https://wa.me/33665745963?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7%D9%8B%D8%8C%20%D8%A3%D9%88%D8%AF%D9%91%20%D9%85%D8%B9%D8%B1%D9%81%D8%A9%20%D8%A7%D9%84%D9%85%D8%B2%D9%8A%D8%AF%20%D8%B9%D9%86%20Aalayna',
  eyebrow: 'للمطاعم في لبنان',
  name: '<span class="sr-only">علينا.</span><span class="name" aria-hidden="true"><em>علينا.</em></span>',
  tag: 'لا أحد ينتظر الفاتورة.',
  sub: 'الطاولات تدور أسرع. الإكرامية تكبر. والمراجعات تتوالى.',
  does: 'امسح. قسّم. ادفع.',
  price: '<span class="amt">$150</span> <span class="unit">/ شهرياً / للفرع</span>',
  free: 'والشهران الأولان مجاناً.',
  tableTitle: 'طاولة واحدة، سهرة واحدة',
  tableAlt: 'طاولة طويلة نراها من فوق على امتداد سهرة واحدة: بطاقة QR عند أول مكان، والقائمة على الهاتف، والمازة، ثم الصحون الفارغة والفاتورة على صينيتها، وهاتف يقسم $152.50 على أربعة، $38.13 لكل واحد، والدفع عبر Whish وبجانبه بطاقة وورقة نقدية، وبطاقة التقييم، والطاولة مجهّزة من جديد في آخرها.',
  s: {
    qr: { step: '01 · بطاقة QR', head: 'امسح.', say: 'رمز QR واحد لكل طاولة: يقرأ ضيوفك القائمة ويقسّمون الفاتورة ويدفعون من هواتفهم. لا تطبيق ولا تنزيل.' },
    menu: { step: '02 · القائمة', head: 'تصفّح.', say: 'بلغة الضيف، بالدولار أو بالليرة.' },
    mezze: { step: 'العشاء', head: 'صحتين.', say: 'سهرة كالعادة.' },
    bill: { step: '03 · الفاتورة', head: 'الفاتورة.', say: 'على هاتف الضيف لحظة يطلبها.', fig: ['10 دقائق', 'توفَّر لكل طاولة: لا أحد ينتظر الفاتورة.'] },
    split: { step: '04 · التقسيم', head: 'قسّم.', say: 'بالتساوي، أو بحسب الأطباق، أو بأي مبلغ. أربعة أصدقاء: $38.13 لكلّ واحد.', cta: 'table' },
    pay: { step: '05 · الدفع', head: 'ادفع.', say: 'Whish أو البطاقة أو النقد، ويؤكّد فريقك النقد عند استلامه.', fig: ['22%', 'متوسط الإكرامية لكل طاولة حين تُقترح لحظة الدفع، مقابل 10% من دون اقتراح.'] },
    review: { step: '06 · التقييم', head: 'قيّم.', say: 'نقرة واحدة بعد الدفع، ثم مراجعة على Google.', fig: ['83%', 'ممن يُطلب منهم ترك مراجعة يكتبونها. ويطلبها Aalayna من كل طاولة.'] },
    again: { step: '07 · المرّة القادمة', head: 'يعودون.', say: 'يترك الضيف رقمه إن شاء ويوافق على عروضك، فتعرف من يعود ومن انقطع.', fig: ['50%', 'من الطلبات قد تأتي من القلّة الذين يعودون. ويخبرك Aalayna من هم.'], cta: 'outcomes' },
    price: { step: 'لمطعمك', head: '<span class="amt">$150</span> <span class="unit">/ شهرياً / للفرع</span>', say: 'أول 10 مطاعم مؤسِّسة تثبّت سعر <strong>$100 شهرياً للفرع.</strong>', pill: 'تجربة مجانية لمدة شهرين', pilot: 'شهران مجاناً من يوم التشغيل، ولا تكمل إلا إذا نفع مطعمك.', cta: 'pricing', more: 'كيف تسير التجربة، وأجوبة أسئلة أصحاب المطاعم' },
  },
  askEyebrow: 'أهلاً وسهلاً', askHead: 'طاولتك جاهزة.', askSay: 'أخبرنا عن مطعمك، والباقي علينا.',
  film: 'أو شاهد الفيلم في 96 ثانية',
  foot: '© 2026 Aalayna · للمطاعم في لبنان',
  footLang: '<a class="foot-lang" href="../table-v1.html" hreflang="en" lang="en" aria-label="EN, English version">EN</a>',
};

const ORDER = ['qr', 'menu', 'mezze', 'bill', 'split', 'pay', 'review', 'again', 'price'];
const HEAD_IDS = { qr: 's-scan', menu: 's-menu', mezze: 's-dinner', bill: 's-bill', split: 's-split', pay: 's-pay', review: 's-review', again: 's-again', price: 'price-title' };

function page(L) {
  const p = L.pre, lg = L.lang === 'ar' ? LOGOS.ar : LOGOS.en;
  const btn = (place, cls = 'btn') => `<a class="${cls}" data-track="booking_click" data-placement="${place}" href="${L.bookHref}">${L.book}</a>`;
  const wa = (place, href = L.waHref, cls = 'btn outline') => `<a class="${cls}" data-track="whatsapp_click" data-placement="${place}" href="${href}">${L.wa}</a>`;
  const stretch = (key, i) => {
    const s = L.s[key], id = HEAD_IDS[key];
    const fig = s.fig ? `<div class="fig"><p class="num">${s.fig[0]}</p><p class="src">${s.fig[1]}</p></div>` : '';
    const cta = s.cta ? `<p class="cta">${btn(s.cta)}</p>` : '';
    const extra = key === 'price'
      ? `<p class="pilot"><span class="pill">${s.pill}</span> ${s.pilot}</p>${cta}<p class="more"><a href="${p}book.html">${s.more}</a></p>`
      : fig + cta;
    const cls = (key === 'mezze' ? ' s-quiet' : '') + (i % 2 ? ' side-b' : '');
    const sid = key === 'price' ? ' id="price"' : '';
    return `    <article class="stretch s-${key}${cls}"${sid} aria-labelledby="${id}">
      ${board(key, i === 0 ? L.tableAlt : '', L.lang)}
      <div class="note"><p class="step">${s.step}</p><h3 class="head" id="${id}">${s.head}</h3><p class="say">${s.say}</p>${extra}</div>
    </article>`;
  };
  return `<!DOCTYPE html>
<html lang="${L.lang}"${L.dir}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${L.title}</title>
<meta name="description" content="${L.desc}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Aalayna">
<meta property="og:title" content="${L.ogTitle}">
<meta property="og:description" content="${L.ogDesc}">
<meta property="og:url" content="${L.ogUrl}">
<meta property="og:locale" content="${L.locale}">
<meta property="og:locale:alternate" content="${L.localeAlt}">
<meta property="og:image" content="https://aalayna.com/images/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${L.ogAlt}">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" hreflang="en" href="https://aalayna.com/table-v1.html">
<link rel="alternate" hreflang="ar" href="https://aalayna.com/ar/table-v1.html">
<link rel="alternate" hreflang="x-default" href="https://aalayna.com/table-v1.html">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${L.fonts}" rel="stylesheet">
<link rel="preload" href="${p}brand/fonts/aalayna-block.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="${p}table-v1.css?v=2">
<link rel="icon" href="${p}brand/icons/icon-32.png" sizes="32x32">
<link rel="icon" href="${p}brand/svg/3layna/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${p}brand/icons/icon-180.png">
<script src="${p}aalayna-config.js"></script>
<script src="${p}table-v1.js?v=2" defer></script>
</head>
<body>
<a class="skip" href="#main">${L.skip}</a>
<header class="top">
  <nav class="wrap top-in" aria-label="${L.nav}">
    ${lg.head}
    <div class="top-links">${L.links.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</div>
    ${L.lang2}
    ${btn('navigation', 'btn compact')}
  </nav>
</header>
<main id="main">
  <section class="poster" aria-labelledby="poster-title">
    <div class="wrap poster-in">
      <p class="eyebrow">${L.eyebrow}</p>
      <h1 class="poster-title" id="poster-title">${L.name}<span class="tag">${L.tag}</span></h1>
      <p class="poster-sub">${L.sub}</p>
      <div class="poster-offer"><p class="poster-price">${L.price}</p><p class="poster-free">${L.free}</p></div>
      <div class="actions">${btn('hero')}${wa('hero')}</div>
      <p class="poster-does">${L.does}</p>
    </div>
  </section>

  <section class="table" id="table" aria-labelledby="table-title">
    <h2 class="sr-only" id="table-title">${L.tableTitle}</h2>
    <!-- Where the figures come from (for meetings; not shown): 10 min, the average wait just to be handed the bill, Barclaycard survey of 2,000 diners, 2018. 22%, the average tip in New York taxis once the screen suggested one, up from 10%, reported by The New York Times. 83%, of people asked for a review who wrote one, BrightLocal Local Consumer Review Survey 2026. 50%, the share of orders that can come from the 7% of guests who return, Toast Regulars Report 2026. -->
    <div class="cloth" aria-hidden="true"><i class="c-sh"></i><i class="c-hem"></i><i class="c-band"></i><i class="c-sand"></i></div>
    <div class="runner" aria-hidden="true"><i><b></b></i></div>
    ${board('head', '', L.lang, ' board-end')}
${ORDER.map(stretch).join('\n')}
    ${board('foot', '', L.lang, ' board-end')}
  </section>

  <section class="ask" id="ask" aria-labelledby="ask-title">
    <div class="wrap ask-in">
      <p class="eyebrow">${L.askEyebrow}</p>
      <h2 class="ask-title" id="ask-title">${L.askHead}</h2>
      <p class="say">${L.askSay}</p>
      <div class="actions">${btn('footer')}${wa('footer')}</div>
      <p class="film"><a href="${p}reel.html">${L.film}</a></p>
    </div>
  </section>
</main>
<footer class="wrap foot">${lg.foot}<p>${L.foot}</p>${L.footLang}<a class="foot-wa" data-track="whatsapp_click" data-placement="footer_contact" href="${L.waFoot}">${L.wa}</a></footer>
</body>
</html>
`;
}

const en = page(EN), ar = page(AR);
[en, ar].forEach((s, k) => { if (/—|&mdash;/.test(s)) throw new Error((k ? 'ar' : 'en') + ': em dash'); });
fs.writeFileSync(path.join(ROOT, 'table-v1.html'), en);
fs.writeFileSync(path.join(ROOT, 'ar/table-v1.html'), ar);
console.log('wrote table-v1.html', en.length, 'bytes; ar/table-v1.html', ar.length, 'bytes');
