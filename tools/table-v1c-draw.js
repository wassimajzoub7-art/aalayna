#!/usr/bin/env node
// Writes table-v1.html and ar/table-v1.html: prototype V1 of the homepage in style C, the all-out paper cut-out.
//
//   node tools/table-v1-draw.js
//
// Style C follows docs/table-v1c-storyboard.md: one point per stretch, one hero object on the runner, centred on its
// stretch, at full strength; everything else on the board lies in its base layer, which the stylesheet draws at
// reduced strength so it recedes. Light comes from the top left: every paper layer casts its shadow down and to the
// right by the same depth. The dinner stretch of style B is cut (it had no point of its own).
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
  // One light, from the top left: the shadow falls down and to the right, never deeper than 2 units.
  add(cls, d, o = 0) { o = Math.min(2, +(o * .66).toFixed(2)); if (o) this.s += `<path class="sh" transform="translate(${f(o * .6)} ${o})" d="${d}"/>`; this.s += `<path class="${cls}" d="${d}"/>`; return this; }
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
  p.add('p2', blob(X(L + 10), y + 13, 10.5, 10, 60 + k, .06, 8)); p.add(c, blob(X(L + 10), y + 13, 7.4, 7, 70 + k, .14, 8), .8);
  p.raw(tx(X(L + 27), y + 18, name, 's', { w: 5, a: s.a('l'), rtl: s.rtl }));
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
// The bill comes on a brass tray: a beaten rim, an engraved line inside it, the light catching its top left edge.
function tray() {
  const p = new Pic(), w = 156, h = 244, g = rr(0, 0, w, h, 12);
  p.add('brd', g); p.add('br', rr(2, 2, w - 4, h - 4, 10.5));
  p.add('brd', rr(9, 9, w - 18, h - 18, 7)); p.add('br', rr(10.4, 10.4, w - 20.8, h - 20.8, 6));
  p.add('brl', rr(14, 4.2, 70, 2.2, 1.1) + rr(4.2, 14, 2.2, 60, 1.1));
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
// Paid: the pay button once it is pressed, an olive chip with a tick. It lifts off the phone and becomes the head of
// the review card (drawn at x, y in whichever piece it lies on).
function paidChip(p, x, y, lang) {
  const ar = lang === 'ar';
  p.add('o', rr(x, y, 120, 30, 4), 1.5);
  p.add('p', check(ar ? x + 12 : x + 96, y + 8, 13, 2.6));
  p.raw(tx(ar ? x + 106 : x + 14, y + 20, ar ? 'دُفع ⁦$41.94⁩' : 'Paid $41.94', 's', { w: 6, c: 'p', a: ar ? 'r' : 'l', rtl: ar }));
  return p;
}
function payThanks(lang) {
  return tx(78, 272, lang === 'ar' ? 'شكراً، أتمنّى لكم سهرة سعيدة' : 'Thank you. Good night.', 's', { a: 'm', w: 5, c: 'su', rtl: lang === 'ar' });
}
// The review card: where the paid chip lands, the question, five stars (the red ones are their own layers), Google.
const CW = 160, CH = 198, STAR_Y = 106;
const STAR_X = i => 28 + i * 26;
function reviewCard(lang) {
  const rtl = lang === 'ar', X = x => rtl ? CW - x : x, A = a => rtl ? ({ l: 'r', r: 'l', m: 'm' })[a] : a, p = new Pic(), g = cut(0, 0, CW, CH, 51, .6);
  p.add('p', g);
  p.add('p2', rr(20, 14, 120, 30, 4));
  p.raw(tx(X(16), 72, rtl ? 'كيف كان العشاء؟' : 'How was dinner?', 'b', { w: 6, a: A('l'), rtl }));
  for (let i = 0; i < 5; i++) p.add('p2', star(STAR_X(i), STAR_Y, 12));
  p.add('k', rr(16, 150, 128, 32, 3), 1.5);
  p.raw(tx(80, 171, rtl ? 'قيّمنا على Google' : 'Review on Google', 's', { a: 'm', w: 6, c: 'p', rtl }));
  return { w: CW, h: CH, svg: p.toString(), ground: g };
}
// The regulars: who came back this month, newest first, with their visits.
const GW = 160, GH = 194, REG_Y = k => 70 + k * 38;
const REGULARS = { en: [['R', 'Rania', '6 visits'], ['K', 'Karim', '4 visits'], ['M', 'Maya', '3 visits']],
  ar: [['ر', 'رانيا', '6 زيارات'], ['ك', 'كريم', '4 زيارات'], ['م', 'مايا', '3 زيارات']] };
function regularsCard(lang) {
  const rtl = lang === 'ar', X = x => rtl ? GW - x : x, A = a => rtl ? ({ l: 'r', r: 'l', m: 'm' })[a] : a, p = new Pic(), g = cut(0, 0, GW, GH, 57, .6);
  p.add('p', g);
  p.raw(tx(X(16), 30, rtl ? 'هذا الشهر' : 'This month', 's', { w: 5, a: A('l'), rtl, c: 'su' }));
  p.raw(tx(X(16), 54, rtl ? 'من عاد إليك' : 'Who came back', 'b', { w: 6, a: A('l'), rtl }));
  return { w: GW, h: GH, svg: p.toString(), ground: g };
}
function regularRow(lang, k) {
  const rtl = lang === 'ar', X = x => rtl ? GW - x : x, A = a => rtl ? ({ l: 'r', r: 'l', m: 'm' })[a] : a, p = new Pic(), y = REG_Y(k), [ini, name, n] = REGULARS[lang][k];
  p.add(['c', 'o', 'cl'][k], circle(X(30), y + 16, 11));
  p.raw(tx(X(30), y + 21, ini, 's', { a: 'm', w: 6, c: 'p' }));
  p.raw(tx(X(50), y + 21, name, 's', { w: 6, a: A('l'), rtl }));
  p.raw(tx(X(GW - 16), y + 21, n, 's', { w: 6, a: A('r'), rtl, c: 'c' }));
  if (k < 2) p.add('p2', rr(16, y + 35, GW - 32, 1.5, .75));
  return p.toString();
}
// The close: a folded card that says the table is reserved, its far face in shade.
const RVW = 128, RVH = 80;
function reservedCard(lang) {
  const p = new Pic(), g = rr(0, 0, RVW, RVH, 2);
  p.add('p2', rr(0, 0, RVW, 30, 2)); p.add('sd', rr(0, 29, RVW, 1.6, .8)); p.add('p', rr(0, 30.6, RVW, RVH - 30.6, 2));
  p.raw(tx(64, 60, lang === 'ar' ? 'محجوز' : 'Reserved', 'b', { a: 'm', w: 6, rtl: lang === 'ar' }));
  p.add('c', rr(54, 68, 20, 2, 1));
  return { w: RVW, h: RVH, svg: p.toString(), ground: g };
}
// The restaurant's own bill: two months at $0, then $150 a month. Its rows are layers, so they come up in turn.
const PRW = 156, PRH = 230, PR_Y = i => 82 + i * 38;
function priceReceipt(lang) {
  const rtl = lang === 'ar', X = x => rtl ? PRW - x : x, A = a => rtl ? ({ l: 'r', r: 'l' })[a] : a, p = new Pic(), g = receiptShape(0, 0, PRW, PRH - 10, 12);
  p.add('p', g);
  p.add('c', rr(rtl ? PRW - 16 - 12 : 16, 18, 12, 12, 1));
  p.raw(tx(X(36), 29, rtl ? 'مطعمك، فرع واحد' : 'Your restaurant', 's', { w: 6, a: A('l'), rtl }));
  p.add('sd', rr(16, 42, PRW - 32, 1.5, .75));
  p.add('k', rr(16, 174, PRW - 32, 1.5, .75));
  p.raw(tx(X(16), 198, rtl ? 'ثم كل شهر' : 'then every month', 's', { w: 5, a: A('l'), rtl, c: 'su' }));
  return { w: PRW, h: PRH, svg: p.toString(), ground: g };
}
function priceRow(lang, i) {
  const rtl = lang === 'ar', X = x => rtl ? PRW - x : x, A = a => rtl ? ({ l: 'r', r: 'l' })[a] : a, y = PR_Y(i);
  const [m, v, c] = (rtl ? [['الشهر 1', '$0', 'ot'], ['الشهر 2', '$0', 'ot'], ['الشهر 3', '$150', 'k']] : [['Month 1', '$0', 'ot'], ['Month 2', '$0', 'ot'], ['Month 3', '$150', 'k']])[i];
  return tx(X(16), y, m, 'b', { w: 5, a: A('l'), rtl }) + tx(X(PRW - 16), y + 2, v, 'l', { w: 6, a: A('r'), c });
}

/* ---------------- The quiet things: drawn in table units, each its own layer ---------------- */
// A place: the plate, the fork above it and the knife below, at the cloth's left or right edge (no glass: it would
// reach the runner, where the hero lies). nap: a napkin folded on the plate, for the table set again.
function place(p, side, cy, nap) {
  const L = side === 'l', cx = L ? 88 : 312;
  plate(p, cx, cy, 27);
  if (nap) napkin(p, cx - 13, cy - 13, 26, nap[0], nap[1], cy);
  if (L) { fork(p, 62, cy - 39, 50, 0); knife(p, 62, cy + 39, 50, 0); } else { fork(p, 338, cy + 39, 50, Math.PI); knife(p, 338, cy - 39, 50, Math.PI); }
}
// Arak, from above: the carafe (its body, the milky arak, the neck) and a glass with one cube of ice.
function carafe(p, cx, cy) {
  p.add('gl', circle(cx, cy, 19), 2.4); p.add('ak', circle(cx, cy, 15.5));
  p.add('gl', circle(cx, cy, 7.5), 1.2); p.add('p', circle(cx, cy, 5));
  p.add('p', ellipse(cx - 9, cy - 9, 3.2, 1.7));
}
function arakGlass(p, cx, cy) {
  p.add('gl', circle(cx, cy, 10.5), 1.8); p.add('ak', circle(cx, cy, 8.2));
  p.add('p', rr(cx - 2.5, cy - 3.5, 7, 7, 1.8), .6); p.add('p', ellipse(cx - 5, cy - 5, 2, 1.1));
}
// A quiet thing as its own layer: drawn straight in table units (x, y, w, h: its box), set down from (fx, fy), in
// steps of 2.5rem: from the side of the chair it belongs to.
function sup(x, y, w, h, H, draw, a = {}) {
  const p = new Pic(); draw(p);
  const st = `--x:${pct(x / 4)};--y:${pct(y / H * 100)};--w:${pct(w / 4)}`;
  return `<div class="ob sup${a.cls ? ' ' + a.cls : ''}" style="${st}" data-fx="${a.fx || 0}" data-fy="${a.fy || 0}" data-i="${a.i || 0}"><div class="pc"><svg class="pz" viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" focusable="false">${p}</svg></div></div>`;
}

/* ---------------- Placing things on a board ---------------- */
// A hero: the shadow it casts on the cloth (its own layer), then the piece and whatever is laid on it (.pc).
// x, y in table units; inner: layers inside the piece, in the piece's own units; fx, fy: where it is set down from.
function obj(cls, d, x, y, H, a = {}, inner = '') {
  const st = `--x:${pct(x / 4)};--y:${pct(y / H * 100)};--w:${pct(d.w / 4)}`;
  const vb = `0 0 ${d.w} ${d.h}`, sh = a.sh || 3;
  return `<div class="ob hero ${cls}" style="${st}" data-fx="${a.fx || 0}" data-fy="${a.fy || 0}"><svg class="osh" viewBox="${vb}" focusable="false"><path class="cast" transform="translate(${f(sh * .6)} ${sh})" d="${d.ground}"/></svg>`
    + `<div class="pc"><svg class="pz" viewBox="${vb}" focusable="false">${d.svg}</svg>${inner}</div></div>`;
}
// A layer inside a piece, cropped to its box (x, y, w, h in the piece's units) so it can move on its own.
function lay(cls, W, H, x, y, w, h, svg, style = '', attr = '') {
  return `<svg class="ly ${cls}" viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" style="left:${pct(x / W * 100)}%;top:${pct(y / H * 100)}%;width:${pct(w / W * 100)}%${style}"${attr} focusable="false">${svg}</svg>`;
}
// A box inside a piece with no drawing: where a travelling layer lands.
const spot = (id, W, H, x, y, w, h) => `<span class="spot" id="${id}" style="left:${pct(x / W * 100)}%;top:${pct(y / H * 100)}%;width:${pct(w / W * 100)}%;height:${pct(h / H * 100)}%"></span>`;

// Every board: chairs in its base layer, the hero centred on the runner (its middle at the middle of the board, so
// the note beside it shares its line), the quiet things in their own layers.
const BOARDS = {
  head: () => { const H = 72, b = new Pic(); chair(b, 't', 200, H); return { H, base: b, objs: [] }; },
  // 01 Scan. The QR card; one place, quiet, across the table (and only on a wide screen).
  qr: () => {
    const H = 360, b = new Pic(), card = qrCard();
    chair(b, 'l', 180, H); chair(b, 'r', 180, H);
    const scan = `<span class="scan" style="left:${pct(10 / card.w * 100)}%;top:${pct(10 / card.h * 100)}%;width:${pct(84 / card.w * 100)}%;height:${pct(84 / card.h * 100)}%"><i></i></span>`;
    return { H, base: b, objs: [
      sup(270, 130, 76, 100, H, p => place(p, 'r', 180), { fx: 1, cls: 'xw' }),
      obj('ob-qr', card, 148, (H - card.h) / 2, H, { fy: 1 }, scan)] };
  },
  // 02 Browse. The menu on the guest's phone; the guest's place beside it.
  menu: lang => {
    const H = 380, b = new Pic(), ph = phone();
    chair(b, 'l', 190, H); chair(b, 'r', 190, H);
    const head = lay('scr-head', PW, PH, 12, 32, 132, 60, screenMenuHead(lang));
    const rows = [0, 1, 2, 3, 4].map(k => lay('dish', PW, PH, 12, DISH_Y(k) - 2, 132, 36, dishRow(lang, k), `;--k:${k}`, ` data-k="${k}"`)).join('');
    return { H, base: b, objs: [
      sup(270, 140, 76, 100, H, p => place(p, 'r', 190), { fx: 1 }),
      obj('ob-phone ob-menu', ph, 122, (H - PH) / 2, H, { sh: 4, fy: 1 }, head + rows),
    ] };
  },
  // 03 The bill. The brass tray comes in from the table's edge; the receipt is its own layer: it lifts, travels down
  // the table and lands in the split phone (#land-bill). Dinner is over: a used plate pushed aside, the arak.
  bill: lang => {
    const H = 380, b = new Pic(), t = tray(), r = receipt(lang), rx = 14, ry = 16;
    chair(b, 'l', 190, H); chair(b, 'r', 190, H);
    const rc = `<span class="rc" style="left:${pct(rx / t.w * 100)}%;top:${pct(ry / t.h * 100)}%;width:${pct(r.w / t.w * 100)}%"><span class="rc-go go" data-go="land-bill">`
      + `<svg class="rc-sh" viewBox="0 0 ${r.w} ${r.h}" focusable="false"><path class="cast" transform="translate(1.8 3)" d="${r.ground}"/></svg><svg class="rc-pz" viewBox="0 0 ${r.w} ${r.h}" focusable="false">${r.svg}</svg></span></span>`;
    return { H, base: b, objs: [
      sup(50, 72, 80, 80, H, p => usedPlate(p, 88, 110, 3, .7), { fx: -1, i: 1 }),
      sup(290, 210, 52, 100, H, p => { carafe(p, 316, 236); arakGlass(p, 312, 284); }, { fx: 1, i: 2 }),
      obj('ob-tray', t, 122, (H - t.h) / 2, H, { fx: 2.4 }, rc)] };
  },
  // 04 Split. The bill lands at the top of the screen, ÷4, then the four shares one after another.
  split: lang => {
    const H = 380, b = new Pic(), ph = phone();
    chair(b, 'l', 190, H); chair(b, 'r', 190, H);
    const head = lay('scr-head', PW, PH, 14, 30, 96, 52, splitHead(lang));
    const div = lay('div4', PW, PH, lang === 'ar' ? 14 : 92, 44, 50, 38, splitDiv(lang));
    const shares = [0, 1, 2, 3].map(k => {
      const y = SHARE_Y(k), go = k === 3 ? ' data-go="land-share"' : '';
      return `<span class="share share-${k}${k === 3 ? ' go' : ''}" data-k="${k}" style="left:${pct(16 / PW * 100)}%;top:${pct((y - 2) / PH * 100)}%;width:${pct(124 / PW * 100)}%"${go}><svg viewBox="16 ${y - 2} 124 42" focusable="false">${shareRow(lang, k)}</svg></span>`;
    }).join('');
    return { H, base: b, objs: [
      sup(64, 246, 46, 40, H, p => coffee(p, 84, 266), { fx: -1 }),
      obj('ob-phone ob-split', ph, 122, (H - PH) / 2, H, { sh: 4, fy: 1 }, spot('land-bill', PW, PH, 16, 28, 124, 120) + head + div + shares)] };
  },
  // 05 Settle. Yours becomes the payment (#land-share); the tip, the ways to pay, then pay; pay becomes paid, and the
  // paid chip lifts off for the review card (#land-paid).
  pay: lang => {
    const H = 380, b = new Pic(), ph = phone();
    chair(b, 'l', 190, H); chair(b, 'r', 190, H);
    const paid = `<span class="paid-go go" data-go="land-paid" style="left:${pct(16 / PW * 100)}%;top:${pct(250 / PH * 100)}%;width:${pct(124 / PW * 100)}%"><svg viewBox="16 250 124 34" focusable="false">${paidChip(new Pic(), 18, 252, lang)}</svg></span>`;
    const layers = spot('land-share', PW, PH, 16, 28, 124, 62) + lay('pay-amt', PW, PH, 16, 28, 124, 64, payAmt(lang))
      + lay('pay-row', PW, PH, 14, 96, 128, 54, payTip(lang), '', ' data-k="0"')
      + [0, 1, 2].map(k => lay('pay-row', PW, PH, 16, WAY_Y(k) - 2, 124, 30, payWay(lang, k), '', ` data-k="${k + 1}"`)).join('')
      + lay('pay-thanks', PW, PH, 16, 250, 124, 34, payThanks(lang))
      + lay('pay-row pay-btn', PW, PH, 16, 250, 124, 36, payBtn(lang), '', ' data-k="4"') + paid;
    return { H, base: b, objs: [obj('ob-phone ob-pay', ph, 122, (H - PH) / 2, H, { sh: 4, fy: 1 }, layers)] };
  },
  // 06 Rate. The paid chip lands at the head of the card; the five stars arrive one by one.
  review: lang => {
    const H = 340, b = new Pic(), card = reviewCard(lang);
    chair(b, 'l', 170, H); chair(b, 'r', 170, H);
    const stars = [0, 1, 2, 3, 4].map(i => lay('star', CW, CH, STAR_X(i) - 14, STAR_Y - 16, 28, 30, new Pic().add('r', star(STAR_X(i), STAR_Y, 12), 1.4).toString(), '', ` data-k="${i}"`)).join('');
    const landed = lay('rv-paid', CW, CH, 18, 12, 124, 34, paidChip(new Pic(), 20, 14, lang).toString());
    return { H, base: b, objs: [obj('ob-review', card, 120, (H - CH) / 2, H, { fy: 1 }, spot('land-paid', CW, CH, 18, 12, 124, 34) + landed + stars)] };
  },
  // 07 Again. Who came back; the table set again on either side, quiet.
  again: lang => {
    const H = 340, b = new Pic(), card = regularsCard(lang);
    chair(b, 'l', 170, H); chair(b, 'r', 170, H);
    const rows = [0, 1, 2].map(k => lay('reg-row', GW, GH, 10, REG_Y(k), GW - 20, 38, regularRow(lang, k), '', ` data-k="${k}"`)).join('');
    return { H, base: b, objs: [
      sup(54, 120, 76, 100, H, p => place(p, 'l', 170, ['ol', 'o']), { fx: -1, i: 1 }),
      sup(270, 120, 76, 100, H, p => place(p, 'r', 170, ['cl', 'c']), { fx: 1, i: 2 }),
      obj('ob-again', card, 120, (H - GH) / 2, H, { fy: 1 }, rows)] };
  },
  // For your restaurant: its own bill, the rows one after another.
  price: lang => {
    const H = 320, b = new Pic(), pr = priceReceipt(lang);
    chair(b, 'l', 160, H); chair(b, 'r', 160, H);
    const rows = [0, 1, 2].map(i => lay('pr-row', PRW, PRH, 10, PR_Y(i) - 26, PRW - 20, 36, priceRow(lang, i), '', ` data-k="${i}"`)).join('');
    return { H, base: b, objs: [obj('ob-price', pr, 122, (H - PRH) / 2, H, { fy: 1 }, rows)] };
  },
  // The foot of the table: the card that says it is reserved, and the chair at the end.
  foot: lang => { const H = 200, b = new Pic(), r = reservedCard(lang); chair(b, 'b', 200, H); return { H, base: b, objs: [obj('ob-reserved', r, 136, 44, H, { fy: 1, sh: 2.5 })] }; },
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
  tableAlt: 'Seen from above, one long table through one evening: the QR card, the menu on a phone, the bill on a brass tray beside the arak, the bill on a phone split four ways at $38.13 each, the payment by Whish with the tip suggested, then paid, the review card with five stars, the guests who came back, the restaurant\'s own bill, and a card at the far end that says Reserved.',
  s: {
    qr: { step: '01 · The QR card', head: 'Scan.', say: 'One code per table. Guests read, split and pay on their phone. No app to download.' },
    menu: { step: '02 · The menu', head: 'Browse.', say: 'In their language. In dollars or lira.' },
    bill: { step: '03 · The bill', head: 'The bill.', say: 'On their phone the moment they ask.', fig: ['10 min', 'Saved per table: nobody waits for the bill.'] },
    split: { step: '04 · The split', head: 'Split.', say: 'Evenly, by dish or by amount.', cta: 'table' },
    pay: { step: '05 · The payment', head: 'Settle.', say: 'Whish, card or cash, with the tip suggested.', fig: ['22%', 'Average tip per table once it is suggested at payment, up from 10%.'] },
    review: { step: '06 · The review', head: 'Rate.', say: 'Asked the moment they have paid, then sent to Google.', fig: ['83%', 'Of customers asked for a review leave one. Aalayna asks every table.'] },
    again: { step: '07 · Next time', head: 'Again.', say: 'Guests opt in to your offers. You see who comes back, and who stopped.', fig: ['50%', 'Of orders can come from the few guests who return. Aalayna tells you who they are.'], cta: 'outcomes' },
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
  tableAlt: 'طاولة طويلة نراها من فوق على امتداد سهرة واحدة: بطاقة QR، والقائمة على الهاتف، والفاتورة على صينية نحاس بجانب العرق، ثم الفاتورة على الهاتف مقسومة على أربعة، $38.13 لكل واحد، والدفع عبر Whish مع إكرامية مقترحة، ثم تمّ الدفع، وبطاقة التقييم بخمس نجوم، والضيوف الذين عادوا، وفاتورة المطعم نفسه، وفي آخر الطاولة بطاقة كُتب عليها محجوز.',
  s: {
    qr: { step: '01 · بطاقة QR', head: 'امسح.', say: 'رمز واحد لكل طاولة. يقرأ الضيف ويقسّم ويدفع من هاتفه، بلا تطبيق.' },
    menu: { step: '02 · القائمة', head: 'تصفّح.', say: 'بلغة الضيف، بالدولار أو بالليرة.' },
    bill: { step: '03 · الفاتورة', head: 'الفاتورة.', say: 'على هاتف الضيف لحظة يطلبها.', fig: ['10 دقائق', 'توفَّر لكل طاولة: لا أحد ينتظر الفاتورة.'] },
    split: { step: '04 · التقسيم', head: 'قسّم.', say: 'بالتساوي، أو بحسب الأطباق، أو بأي مبلغ.', cta: 'table' },
    pay: { step: '05 · الدفع', head: 'ادفع.', say: 'Whish أو البطاقة أو النقد، والإكرامية مقترحة.', fig: ['22%', 'متوسط الإكرامية لكل طاولة حين تُقترح لحظة الدفع، مقابل 10% من دون اقتراح.'] },
    review: { step: '06 · التقييم', head: 'قيّم.', say: 'يُسأل الضيف لحظة يدفع، ثم يُرسَل إلى Google.', fig: ['83%', 'ممن يُطلب منهم ترك مراجعة يكتبونها. ويطلبها Aalayna من كل طاولة.'] },
    again: { step: '07 · المرّة القادمة', head: 'يعودون.', say: 'يوافق الضيف على عروضك إن شاء، فترى من يعود ومن انقطع.', fig: ['50%', 'من الطلبات قد تأتي من القلّة الذين يعودون. ويخبرك Aalayna من هم.'], cta: 'outcomes' },
    price: { step: 'لمطعمك', head: '<span class="amt">$150</span> <span class="unit">/ شهرياً / للفرع</span>', say: 'أول 10 مطاعم مؤسِّسة تثبّت سعر <strong>$100 شهرياً للفرع.</strong>', pill: 'تجربة مجانية لمدة شهرين', pilot: 'شهران مجاناً من يوم التشغيل، ولا تكمل إلا إذا نفع مطعمك.', cta: 'pricing', more: 'كيف تسير التجربة، وأجوبة أسئلة أصحاب المطاعم' },
  },
  askEyebrow: 'أهلاً وسهلاً', askHead: 'طاولتك جاهزة.', askSay: 'أخبرنا عن مطعمك، والباقي علينا.',
  film: 'أو شاهد الفيلم في 96 ثانية',
  foot: '© 2026 Aalayna · للمطاعم في لبنان',
  footLang: '<a class="foot-lang" href="../table-v1.html" hreflang="en" lang="en" aria-label="EN, English version">EN</a>',
};

const ORDER = ['qr', 'menu', 'bill', 'split', 'pay', 'review', 'again', 'price'];
const HEAD_IDS = { qr: 's-scan', menu: 's-menu', bill: 's-bill', split: 's-split', pay: 's-pay', review: 's-review', again: 's-again', price: 'price-title' };

function page(L) {
  const p = L.pre, lg = L.lang === 'ar' ? LOGOS.ar : LOGOS.en;
  const btn = (place, cls = 'btn') => `<a class="${cls}" data-track="booking_click" data-placement="${place}" href="${L.bookHref}">${L.book}</a>`;
  const wa = (place, href = L.waHref, cls = 'btn outline') => `<a class="${cls}" data-track="whatsapp_click" data-placement="${place}" href="${href}">${L.wa}</a>`;
  const stretch = (key, i) => {
    const s = L.s[key], id = HEAD_IDS[key];
    const fig = s.fig ? `<div class="fig"><p class="num" data-count>${s.fig[0]}</p><p class="src">${s.fig[1]}</p></div>` : '';
    const cta = s.cta ? `<p class="cta">${btn(s.cta)}</p>` : '';
    const extra = key === 'price'
      ? `<p class="pilot"><span class="pill">${s.pill}</span> ${s.pilot}</p>${cta}<p class="more"><a href="${p}book.html">${s.more}</a></p>`
      : fig + cta;
    const cls = i % 2 ? ' side-b' : '';
    const sid = key === 'price' ? ' id="price"' : '';
    return `    <article class="stretch s-${key}${cls}"${sid} style="--h:${BOARDS[key](L.lang).H}" aria-labelledby="${id}">
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
<link rel="stylesheet" href="${p}table-v1.css?v=3">
<link rel="icon" href="${p}brand/icons/icon-32.png" sizes="32x32">
<link rel="icon" href="${p}brand/svg/3layna/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${p}brand/icons/icon-180.png">
<script src="${p}aalayna-config.js"></script>
<script src="${p}table-v1.js?v=3" defer></script>
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
    <div class="runner" aria-hidden="true"><i></i></div>
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
