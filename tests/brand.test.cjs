// The logo (brand/): the SVG files are what brand/logo.js draws today, the QR in the motion is the one
// qr-lib.js makes for https://aalayna.com, the Kufi mark still spells علينا with its three dots, and every
// local file the brand pages load exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Logo = require('../brand/logo.js');
const { svgContents } = require('../tools/brand.js');

test('brand/svg is what brand/logo.js draws (run node tools/brand.js svg after changing the logo)', () => {
  const want = svgContents();
  const have = fs.readdirSync(path.join(ROOT, 'brand/svg')).filter(f => f.endsWith('.svg')).sort();
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

test('the Block: seven letters in a 2 x 4 grid and the full stop in the eighth cell, the only red', () => {
  const cells = Logo.blockCells();
  assert.equal(new Set(cells.map(c => c.letter)).size, 8);
  assert.ok(cells.filter(c => c.red).every(c => c.letter === 7 && c.x >= 18 && c.y >= 6), 'red only in the last cell');
  assert.equal(cells.filter(c => c.red).length, 25, 'the full stop fills its 5 x 5 cell');
  const b = Logo.block();
  assert.equal(b.w / Logo.U, 23); assert.equal(b.h / Logo.U, 11);
});

test('brand pages: every local src and href resolves to a file', () => {
  for (const f of ['brand/index.html', 'brand/motion.html']) {
    const refs = [...read(f).matchAll(/\b(?:href|src|data-sound)="([^"]*)"/g)].map(m => m[1]).filter(u => !/^(?:[a-z]+:|#|\/\/)/i.test(u));
    assert.ok(refs.length, f + ' loads local files');
    for (const u of refs) assert.ok(fs.existsSync(path.join(ROOT, path.dirname(f), u.split(/[?#]/)[0])), f + ': ' + u);
  }
});
