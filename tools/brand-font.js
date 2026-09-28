#!/usr/bin/env node
// Builds Aalayna Block, the site's display face, from the capitals in brand/logo.js: the logo and the
// headlines are drawn by the same code, so they cannot drift apart. Writes brand/fonts/aalayna-block.woff
// (for the site) and aalayna-block.otf (to install for layouts and mockups).
//
//   node tools/brand-font.js           needs opentype.js: npm install opentype.js (anywhere on NODE_PATH)
//
// One module is 140 units, so the capitals are 700 units tall on a 1000-unit em, the same cap height as
// IBM Plex Sans: set at one size, the two faces line up. Lowercase maps onto the capitals.
'use strict';
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

let opentype;
try { opentype = require('opentype.js'); } catch {
  console.error('tools/brand-font.js needs opentype.js: npm install opentype.js (or put it on NODE_PATH)');
  process.exit(1);
}
const Logo = require('../brand/logo.js');

const M = 140, CAP = 5 * M;                               // units per module; cap height
const out = path.join(__dirname, '..', 'brand', 'fonts');

// "M x y L x y ... Z" (y down from the cap line) -> an opentype path (y up from the baseline).
function toPath(d) {
  const p = new opentype.Path();
  for (const [, cmd, args] of d.matchAll(/([MLZ])([^MLZ]*)/g)) {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === 'Z') { p.close(); continue; }
    (cmd === 'M' ? p.moveTo : p.lineTo).call(p, n[0], CAP - n[1]);
  }
  return p;
}

const lower = { À: 'à', Â: 'â', Ä: 'ä', Ç: 'ç', É: 'é', È: 'è', Ê: 'ê', Ë: 'ë', Î: 'î', Ï: 'ï', Ô: 'ô', Ö: 'ö', Ù: 'ù', Û: 'û', Ü: 'ü' };
const glyphs = [
  new opentype.Glyph({ name: '.notdef', advanceWidth: 6 * M, path: toPath('M0 0L' + 5 * M + ' 0L' + 5 * M + ' ' + CAP + 'L0 ' + CAP + 'Z') }),
  new opentype.Glyph({ name: 'space', unicodes: [0x20, 0xA0, 0x202F], advanceWidth: Logo.SPACE * M, path: new opentype.Path() }),
];
for (const ch of Object.keys(Logo.TYPE)) {
  const d = Logo.typeGlyph(ch, 0, 0, M);
  if (/A/.test(d)) throw new Error(ch + ': curved outline; the font expects square corners');
  const codes = [ch.codePointAt(0)];
  if (/^[A-Z]$/.test(ch)) codes.push(ch.toLowerCase().codePointAt(0));
  if (lower[ch]) codes.push(lower[ch].codePointAt(0));
  const name = /^[A-Za-z0-9]$/.test(ch) ? (/\d/.test(ch) ? 'digit' + ch : ch) : 'uni' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  glyphs.push(new opentype.Glyph({ name, unicodes: codes, advanceWidth: Logo.typeWidth(ch) * M, path: toPath(d) }));
}

const font = new opentype.Font({
  familyName: 'Aalayna Block', styleName: 'Regular', unitsPerEm: 1000, ascender: 1000, descender: -250,
  designer: 'Aalayna', description: 'The Aalayna capitals on their 5 x 5 module grid', version: '1.000', glyphs,
});
font.tables.os2 = Object.assign(font.tables.os2 || {}, { sCapHeight: CAP, sxHeight: CAP, usWeightClass: 400 });
const otf = Buffer.from(font.toArrayBuffer());

// WOFF 1.0: the same sfnt tables, each deflated when that makes it smaller.
function woff(sfnt) {
  const num = sfnt.readUInt16BE(4), tables = [];
  for (let i = 0; i < num; i++) {
    const r = 12 + i * 16;
    const t = { tag: sfnt.toString('latin1', r, r + 4), sum: sfnt.readUInt32BE(r + 4), off: sfnt.readUInt32BE(r + 8), len: sfnt.readUInt32BE(r + 12) };
    t.data = sfnt.subarray(t.off, t.off + t.len);
    const z = zlib.deflateSync(t.data, { level: 9 });
    t.body = z.length < t.len ? z : t.data;
    tables.push(t);
  }
  const pad = n => (n + 3) & ~3;
  let offset = 44 + 20 * num;
  const dir = Buffer.alloc(20 * num);
  tables.forEach((t, i) => {
    t.woffOff = offset;
    dir.write(t.tag, i * 20, 'latin1'); dir.writeUInt32BE(offset, i * 20 + 4); dir.writeUInt32BE(t.body.length, i * 20 + 8);
    dir.writeUInt32BE(t.len, i * 20 + 12); dir.writeUInt32BE(t.sum, i * 20 + 16);
    offset += pad(t.body.length);
  });
  const head = Buffer.alloc(44);
  head.write('wOFF', 0, 'latin1'); head.writeUInt32BE(sfnt.readUInt32BE(0), 4); head.writeUInt32BE(offset, 8);
  head.writeUInt16BE(num, 12); head.writeUInt32BE(12 + 16 * num + tables.reduce((a, t) => a + pad(t.len), 0), 16);
  head.writeUInt16BE(1, 20);
  const body = Buffer.concat(tables.map(t => Buffer.concat([t.body, Buffer.alloc(pad(t.body.length) - t.body.length)])));
  return Buffer.concat([head, dir, body]);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'aalayna-block.otf'), otf);
fs.writeFileSync(path.join(out, 'aalayna-block.woff'), woff(otf));
console.log('wrote brand/fonts/aalayna-block.otf (' + otf.length + ' bytes) and .woff, ' + (glyphs.length - 2) + ' glyphs');
