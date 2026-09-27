// The logo (brand/): the SVG files are what brand/logo.js draws today, the QR in the motion is the one
// qr-lib.js makes for https://aalayna.com, the Kufi mark still spells علينا with its three dots, both
// spellings of the Block keep their grids, and every local file the brand pages load exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const zlib = require('node:zlib');
const Logo = require('../brand/logo.js');
const { svgContents, sitePages, SITE_PAGES } = require('../tools/brand.js');

test('brand/svg is what brand/logo.js draws (run node tools/brand.js svg after changing the logo)', () => {
  const want = svgContents();
  const walk = d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]));
  const have = walk('brand/svg').map(f => f.slice('brand/svg/'.length)).sort();
  assert.deepEqual(have, Object.keys(want).sort());
  for (const [name, text] of Object.entries(want)) {
    assert.equal(read('brand/svg/' + name), text, name);
    assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. ]+" role="img" aria-label="[^"]+"><title>/, name);
  }
});

test('the QR code in the motion is qr-lib.js encoding https://aalayna.com (version 2, level M)', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(read('qr-lib.js') + ';this.qrcode = qrcode;', ctx);
  const q = ctx.qrcode(2, 'M');
  q.addData('https://aalayna.com');
  q.make();
  const want = [];
  for (let r = 0; r < q.getModuleCount(); r++) { let row = ''; for (let c = 0; c < q.getModuleCount(); c++) row += q.isDark(r, c) ? '#' : '.'; want.push(row); }
  const literal = read('brand/motion.js').match(/const QR = (\[[^\]]+\]);/);
  assert.ok(literal, 'motion.js holds the QR as a literal');
  assert.deepEqual([...vm.runInNewContext(literal[1])], want);
});

test('the Kufi mark spells علينا: ع hook, tall ل, ي tooth with two dots below, ن tooth with one above, tall ا', () => {
  const K = Logo.KUFI, base = 9;
  const col = c => K.map(r => r[c]).join('');
  assert.equal(K[base], '############', 'one baseline under the whole word');
  assert.equal(col(0).slice(0, base + 1), '#'.repeat(base + 1), 'ا runs the full height, far left');
  assert.equal(col(6).slice(0, base + 1), '#'.repeat(base + 1), 'ل runs the full height');
  for (const c of [2, 4]) assert.equal(col(c).slice(5, base + 1), '#####', 'teeth rise five modules, column ' + c);
  assert.equal(K[5].slice(8), '####', 'ع: the arm reaches right');
  assert.ok([6, 7, 8].every(r => K[r].slice(8) === '#...'), 'ع: open to the right');
  const dots = [];
  K.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === 'o') dots.push([x, y]); }));
  assert.deepEqual(dots, [[2, 3], [3, 11], [5, 11]], 'ن dot above its tooth, ي dots either side of its tooth, below the line');
});

test('the Block: 3LAYNA fills 2 x 3 with the 3 in red; AALAYNA takes 2 x 4 with a red full stop', () => {
  assert.equal(Logo.NAME, '3LAYNA');
  const three = Logo.blockCells('3LAYNA');
  assert.deepEqual(Logo.grid('3LAYNA'), { cols: 3, stop: false });
  assert.equal(new Set(three.map(c => c.letter)).size, 6);
  assert.ok(three.filter(c => c.red).every(c => c.letter === 0 && c.x < 5 && c.y < 5), 'red only in the 3, top left');
  let b = Logo.block('3LAYNA');
  assert.equal(b.w / Logo.U, 17); assert.equal(b.h / Logo.U, 11);
  assert.equal(Logo.line('3LAYNA').w / Logo.U, 35, 'no full stop after a red 3');

  const aa = Logo.blockCells('AALAYNA');
  assert.equal(new Set(aa.map(c => c.letter)).size, 8);
  assert.ok(aa.filter(c => c.red).every(c => c.letter === 7 && c.x >= 18 && c.y >= 6), 'red only in the last cell');
  assert.equal(aa.filter(c => c.red).length, 25, 'the full stop fills its 5 x 5 cell');
  b = Logo.block('AALAYNA');
  assert.equal(b.w / Logo.U, 23); assert.equal(b.h / Logo.U, 11);
  assert.equal(Logo.line('AALAYNA').w / Logo.U, 43, 'a one-module full stop after the name');
});

test('the site carries the logo brand/logo.js draws: the Block in every header, the Kufi lockup in every footer (node tools/brand.js site)', () => {
  const want = sitePages();
  const header = '<svg viewBox="0 0 ' + Logo.block().w + ' ' + Logo.block().h + '" aria-hidden="true" focusable="false"><path class="logo-ink" d="';
  const footer = '<svg viewBox="0 0 ' + Logo.lockup().w + ' ' + Logo.lockup().h + '" aria-hidden="true" focusable="false"><path class="logo-ink" d="';
  for (const f of SITE_PAGES) {
    const s = read(f);
    assert.equal(s, want[f], f + ' holds the logo as brand/logo.js draws it today');
    assert.ok(!/aalay<b>na<\/b>|Amiri/.test(s), f + ': the old wordmark is gone');
    const links = [...s.matchAll(/<a class="logo" href="index\.html" aria-label="[^"]+">(<svg [^>]*>)/g)].map(m => m[1]);
    assert.equal(links.length, f === 'book.html' ? 1 : 2, f + ': every logo is a named link around an inline SVG');
    assert.ok(s.match(/<header[\s\S]*?<\/header>/)[0].includes(header), f + ': the Block in the header');
    if (links.length > 1) assert.ok(s.match(/<footer[\s\S]*?<\/footer>/)[0].includes(footer), f + ': the lockup in the footer');
  }
});

// The characters a WOFF 1.0 font maps, read from its cmap (format 4) table.
function woffChars(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'wOFF');
  const n = buf.readUInt16BE(12);
  let cmap;
  for (let i = 0; i < n; i++) {
    const e = 44 + i * 20, off = buf.readUInt32BE(e + 4), comp = buf.readUInt32BE(e + 8), orig = buf.readUInt32BE(e + 12);
    if (buf.toString('latin1', e, e + 4) === 'cmap') cmap = comp < orig ? zlib.inflateSync(buf.subarray(off, off + comp)) : buf.subarray(off, off + orig);
  }
  const chars = new Set();
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const t = cmap.readUInt32BE(4 + i * 8 + 4);
    if (cmap.readUInt16BE(t) !== 4) continue;
    const seg = cmap.readUInt16BE(t + 6) / 2, ends = t + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
    for (let s = 0; s < seg; s++) {
      const end = cmap.readUInt16BE(ends + s * 2), start = cmap.readUInt16BE(starts + s * 2), delta = cmap.readInt16BE(deltas + s * 2), ro = cmap.readUInt16BE(ranges + s * 2);
      for (let c = start; c <= end && c !== 0xFFFF; c++) {
        const gid = ro ? cmap.readUInt16BE(ranges + s * 2 + ro + (c - start) * 2) : (c + delta) & 0xFFFF;
        if (gid) chars.add(String.fromCodePoint(c));
      }
    }
  }
  return chars;
}

test('Aalayna Block, the site font, is built from the typeface in brand/logo.js (node tools/brand-font.js)', () => {
  const chars = woffChars(fs.readFileSync(path.join(ROOT, 'brand/fonts/aalayna-block.woff')));
  for (const ch of Object.keys(Logo.TYPE)) {
    assert.ok(chars.has(ch), JSON.stringify(ch) + ' is in the font');
    if (ch.toLowerCase() !== ch) assert.ok(chars.has(ch.toLowerCase()), JSON.stringify(ch.toLowerCase()) + ' maps onto its capital');
  }
  assert.ok(chars.has(' ') && chars.has(' '), 'spaces');
  assert.equal(chars.size, 2 * Object.keys(Logo.TYPE).filter(ch => ch.toLowerCase() !== ch).length + Object.keys(Logo.TYPE).filter(ch => ch.toLowerCase() === ch).length + 3, 'nothing else');
  // The logo is the font: its letters are the typeface's own glyphs.
  for (const ch of new Set(Logo.NAME)) assert.equal(Logo.glyph(ch, 0, 0, Logo.U), Logo.typeGlyph(ch, 0, 0, Logo.U), ch);
});

test('the site sets its headlines and big figures in Aalayna Block, and every character they use is in it', () => {
  const css = read('website.css');
  assert.match(css, /@font-face\{font-family:'Aalayna Block';src:url\(brand\/fonts\/aalayna-block\.woff\) format\('woff'\)/);
  assert.match(css, /--font-display:'Aalayna Block',/);
  assert.match(css, /\nh1,h2\{font-family:var\(--font-display\);font-weight:400;font-synthesis:none;text-transform:uppercase;letter-spacing:0/);
  ['.benefits-band .outcome-figure', '.price'].forEach(sel => assert.match(css, new RegExp(sel.replace(/\./g, '\\.') + '\\{[^}]*font-family:var\\(--font-display\\)'), sel));
  const covered = t => [...t.toUpperCase()].filter(ch => !/\s/.test(ch) && !Logo.TYPE[ch]);
  for (const f of SITE_PAGES) {
    const s = read(f), p = f.startsWith('fr/') ? '../' : '';
    assert.ok(s.includes('<link rel="preload" href="' + p + 'brand/fonts/aalayna-block.woff" as="font" type="font/woff" crossorigin>'), f + ' preloads the font');
    for (const m of s.matchAll(/<(h1|h2)\b[^>]*>([\s\S]*?)<\/\1>|<p class="(?:outcome-figure|price)">([^<]*)/g)) {
      const text = (m[2] || m[3]).replace(/<span class="sr-only">[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;|&#8239;/g, ' ');
      assert.deepEqual(covered(text), [], f + ': "' + text.trim() + '"');
    }
  }
  // numbers.html builds its figures and titles from digits, $ , . + − and % (and a * after the figure).
  assert.deepEqual(covered('0123456789$,.+−%*'), []);
  for (const m of read('numbers.html').matchAll(/el\('h[12]', '[^']*', '([^']*)'\)|title: '([^']*)'/g)) assert.deepEqual(covered(m[1] || m[2]), [], m[0]);
});

test('the reel closes on the logo: reel.html plays the Block reveal, and its soundtrack reads the same join', () => {
  const s = read('reel.html');
  assert.ok(s.includes('<script src="brand/logo.js"></script>\n<script src="brand/motion.js"></script>'), 'reel.html loads the logo and its motion');
  const join = s.match(/const LOGO_AT = ([\d.]+), logo = AalaynaMotion\.block\(\{ tagAt: ([\d.]+)/);
  assert.ok(join, 'the reveal is joined at LOGO_AT, in the form tools/reel-audio.js reads');
  // The tagline has settled and the modules have snapped before the last frame.
  const cues = (() => { global.self = global; global.AalaynaLogo = Logo; global.Path2D = global.Path2D || class {}; require('../brand/motion.js'); return global.AalaynaMotion.block({ tagAt: Number(join[2]) }).cues; })();
  const DUR = Number(s.match(/const DUR = ([\d.]+)/)[1]);
  assert.ok(Number(join[1]) + cues.snap < DUR - 0.8, 'the logo holds for the last 0.8 s at least');
  assert.ok(Number(join[1]) + cues.tag + 0.2 + 0.55 <= DUR, 'the third word of the tagline has settled by the last frame');
  assert.ok(!/Amiri|aalay<b>na/.test(s), 'the old wordmark is gone');
  assert.match(read('tools/reel-audio.js'), /const LOGO_AT = Number\(join\[1\]\), cue = global\.AalaynaMotion\.block/);
});

test('brand pages: every local src and href resolves to a file', () => {
  for (const f of ['brand/index.html', 'brand/motion.html', 'reel.html']) {
    const refs = [...read(f).matchAll(/\b(?:href|src|data-sound)="([^"]*)"/g)].map(m => m[1]).filter(u => !/^(?:[a-z]+:|#|\/\/)/i.test(u));
    assert.ok(refs.length, f + ' loads local files');
    for (const u of refs) assert.ok(fs.existsSync(path.join(ROOT, path.dirname(f), u.split(/[?#]/)[0])), f + ': ' + u);
  }
});
