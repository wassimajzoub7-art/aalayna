/* The printer-stream bridge (T3): tools/pos-printer/escpos.js, ticket.js, listen.js and the
   SYNTHETIC captures in tests/fixtures/pos-printer. Proves that:
   - the committed captures are what make-fixtures.cjs writes, and every one parses, stream
     to bill, to its hand-written expected.json, and every bill passes pos-bill's own
     validateBill (supabase/functions/pos-bill/handler.js);
   - the parser gives the same documents however the stream is split into reads, survives
     random garbage, implausible lengths and truncated commands without throwing and still
     reads the text after them, and decodes CP437, CP850, CP858, CP1252, CP864 and CP1256,
     with ESC t switching mid-line, per-printer code page numbering and forced UTF-8;
   - a ticket that does not balance, has no table, an unmapped table, or is an image is
     held for review and never sent; a kitchen ticket is ignored;
   - the check ledger takes an unchanged reprint as a duplicate and a changed print as an
     update of the same externalId with a higher version, across a restart and past
     midnight, and notes a new check on a table that had another open;
   - the listener in dry run writes valid bodies and sends nothing, takes the stream over
     TCP (forwarding to the printer, closing the POS when the printer is down), from a
     watched folder (once per content) and as a --replay; it pushes with the integration
     key, retries the same body after 5xx, network errors and 429, drops stale versions,
     moves past a reused version, sends other refusals to review, and keeps unsent bills
     in the outbox. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const escpos = require('../tools/pos-printer/escpos.js');
const ticket = require('../tools/pos-printer/ticket.js');
const listen = require('../tools/pos-printer/listen.js');
const make = require('./fixtures/pos-printer/make-fixtures.cjs');
const FIX = path.join(__dirname, 'fixtures', 'pos-printer');
const posBill = import(pathToFileURL(path.join(root, 'supabase/functions/pos-bill/handler.js')).href);

const NOW = new Date('2026-10-27T22:30:00Z');
const KEY = 'pos_' + 'ab'.repeat(32);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aalayna-pos-printer-'));
const expectations = fs.readdirSync(FIX).filter((f) => f.endsWith('.expected.json')).sort()
  .map((f) => Object.assign({ file: f }, JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'))));
const bytesOf = (name) => fs.readFileSync(path.join(FIX, name));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(10); }
  throw new Error('timed out');
}
/* what a document is compared on: the keys the expectation names */
function view(result, exp, ledger, venue) {
  const got = { kind: result.kind, needsReview: result.needsReview };
  for (const key of Object.keys(exp)) {
    if (key === 'check') got.check = Object.fromEntries(Object.keys(exp.check).map((k) => [k, result.check[k]]));
    else if (key === 'bill') {
      if (result.kind !== 'bill') { got.bill = null; continue; }
      const body = ticket.toPosBill(result, venue, ledger.accept(result, venue.id, venue));
      delete body.version;
      got.bill = body;
    } else if (!(key in got)) got[key] = result[key];
  }
  return got;
}

test('fixtures: the committed captures are what make-fixtures.cjs writes, and all are marked synthetic', () => {
  const built = make.build();
  const bins = fs.readdirSync(FIX).filter((f) => f.endsWith('.bin')).sort();
  assert.deepEqual(bins, Object.keys(built).sort());
  for (const [name, bytes] of Object.entries(built)) assert.ok(bytesOf(name).equals(bytes), name + ' differs from its generator');
  assert.ok(expectations.length >= 6);
  for (const e of expectations) { assert.equal(e.synthetic, true, e.file); assert.ok(bins.includes(e.fixture), e.file); }
  assert.match(fs.readFileSync(path.join(FIX, 'README.md'), 'utf8'), /\*\*Every capture in this folder is synthetic\.\*\*/);
});

for (const exp of expectations) {
  test('stream to bill: ' + exp.fixture + ' (' + exp.profile + ')', async () => {
    const { validateBill } = await posBill;
    const ledger = new ticket.CheckLedger({ now: () => NOW });
    const results = ticket.readStream(bytesOf(exp.fixture), { profile: exp.profile, venue: exp.venue });
    assert.equal(results.length, exp.documents.length, 'documents in the stream');
    results.forEach((r, i) => {
      const want = exp.documents[i];
      assert.deepEqual(view(r, want, ledger, exp.venue), want, 'document ' + i + ': ' + JSON.stringify(r.issues));
      if (r.kind === 'bill') {
        assert.equal(r.confidence, 1);
        const step = { externalId: want.bill.externalId, version: 1 };
        const checked = validateBill(ticket.toPosBill(r, exp.venue, step));
        assert.equal(checked.errors, undefined, JSON.stringify(checked.errors));
        assert.equal(checked.bill.totalCents, want.bill.totalCents);
      }
    });
  });
}

test('partial reads: every capture gives the same documents however it is split', () => {
  const strip = (docs) => JSON.stringify(docs);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const name of Object.keys(make.build())) {
    const bytes = bytesOf(name);
    const whole = strip(escpos.parse(bytes).documents);
    const splits = [1, 2, 3, 5, 7, 64, 'random', 'random'];
    for (const size of splits) {
      const p = new escpos.StreamParser();
      let docs = [];
      for (let i = 0; i < bytes.length;) {
        const n = size === 'random' ? 1 + Math.floor(rnd() * 40) : size;
        docs = docs.concat(p.push(bytes.subarray(i, i + n)));
        i += n;
      }
      docs = docs.concat(p.end());
      assert.equal(strip(docs), whole, name + ' split by ' + size);
    }
  }
});

test('partial reads: a cut ends a ticket as soon as it arrives, before the connection closes', () => {
  const p = new escpos.StreamParser();
  const bytes = bytesOf('reprint.bin');
  const firstCut = bytes.indexOf(Buffer.from([0x1D, 0x56, 65, 3]));
  assert.deepEqual(p.push(bytes.subarray(0, firstCut + 2)), []);          // GS V without its arguments yet
  const done = p.push(bytes.subarray(firstCut + 2, firstCut + 4));
  assert.equal(done.length, 1);
  assert.ok(done[0].cut && done[0].lines.some((l) => l.text.includes('REPRINT')));
  const rest = p.push(bytes.subarray(firstCut + 4)).concat(p.end());
  assert.equal(rest.length, 1);
  assert.ok(rest[0].lines.some((l) => l.text.includes('Knefeh')));
});

test('garbage: random bytes never throw; a bogus length or a truncated command costs only itself', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 200; k++) {
    const junk = Buffer.from(Array.from({ length: 1 + Math.floor(rnd() * 600) }, () => Math.floor(rnd() * 256)));
    const { documents } = escpos.parse(junk);
    assert.ok(Array.isArray(documents));
    for (const d of documents) ticket.interpret(d, { profile: 'generic' });
  }
  const venue = { id: 'beit', system: 'micros', currency: 'USD' };
  const good = bytesOf('discount-service.bin');
  const read = (bytes) => ticket.readStream(bytes, { profile: 'generic', venue }).filter((r) => r.kind === 'bill');
  // a raster header whose size is implausible (65025 x 65025 bytes)
  const bogus = Buffer.concat([Buffer.from([0x1D, 0x76, 0x30, 0, 255, 255, 255, 255]), good]);
  assert.equal(read(bogus)[0].totalCents, 8266);
  // a 2D-code header that is not one (no symbol or function byte) claims 600 bytes: not trusted
  const fake = Buffer.concat([Buffer.from([0x1D, 0x28, 0x6B, 0x58, 0x02]), good]);
  assert.ok(escpos.parse(fake).warnings.some((w) => w.code === 'bad_command'));
  assert.equal(read(fake)[0].totalCents, 8266);
  // a well-formed QR store that claims 4 KB nobody sends: resynced at the end of the stream
  const short = Buffer.concat([Buffer.from([0x1D, 0x28, 0x6B, 0xFF, 0x0F, 49, 80, 48]), good]);
  assert.ok(escpos.parse(short).warnings.some((w) => w.code === 'truncated_command'));
  assert.equal(read(short)[0].totalCents, 8266);
  // stray NUL, DEL, DLE and unknown ESC/GS commands between the lines
  const noisy = Buffer.from(Array.from(good).flatMap((b) => (b === 0x0A ? [0x00, 0x7F, 0x10, 0x0A] : [b])));
  const noisy2 = Buffer.concat([Buffer.from([0x1B, 0x8F, 0x1D, 0x99, 0x1C, 0x7E]), noisy]);
  const r = read(noisy2)[0];
  assert.equal(r.totalCents, 8266);
  assert.equal(r.needsReview, false);
});

test('code pages: CP437, CP850 and CP858, CP1252, CP1256 (against the platform), CP864', () => {
  const d = (bytes, cp) => escpos.decode(bytes, cp).text;
  assert.equal(d([0x82, 0x9C, 0xC4, 0xE1, 0xF8], 'cp437'), 'é£─ß°');
  assert.equal(d([0xD5], 'cp850'), 'ı');
  assert.equal(d([0xD5, 0x82], 'cp858'), '€é');
  assert.equal(d([0x80, 0x8C, 0x9F, 0xE9, 0xB0, 0xFC], 'cp1252'), '€ŒŸé°ü');
  let td = null;
  try { td = new TextDecoder('windows-1256'); } catch (e) { td = null; }
  if (td) {
    const all = Uint8Array.from({ length: 128 }, (_, i) => 128 + i);
    assert.equal(d(all, 'cp1256'), td.decode(all));
  }
  assert.equal(d([0xC7, 0xE1, 0xE3, 0xCC, 0xE3, 0xE6, 0xDA], 'cp1256'), 'المجموع');
  // CP864: presentation forms, Arabic-Indic digits and its own percent sign
  const s = escpos.normalizeText(d([0xC7, 0xE4, 0xE5, 0xCC, 0xE5, 0xE8, 0xD9, 0x20, 0xB1, 0xB0, 0x25], 'cp864'));
  assert.equal(s, 'المجموع 10%');
  const arabic = 'شيش طاووق 24.00';
  assert.equal(escpos.normalizeText(d(escpos.encode(arabic, 'cp864'), 'cp864')), arabic);
  assert.equal(escpos.normalizeText(d([0xF9], 'cp864')), 'لآ');
});

test('code pages: ESC t switches mid-line, a printer\'s own numbering, an unknown page, forced UTF-8', () => {
  const ESC = 0x1B;
  const line = Buffer.concat([Buffer.from([ESC, 0x74, 16]), Buffer.from('Caf'), Buffer.from([0xE9, 0x20, ESC, 0x74, 50, 0xC7, 0xE1, 0x0A])]);
  const l = escpos.parse(line).documents[0].lines[0];
  assert.equal(l.text, 'Café ال');
  assert.deepEqual(l.segments.map((g) => g.codePage), ['cp1252', 'cp1256']);
  // a clone printer that numbers PC864 as 22
  const clone = Buffer.from([ESC, 0x74, 22, 0xC7, 0xE4, 0x0A]);
  assert.equal(escpos.normalizeText(escpos.parse(clone, { codePages: { 22: 'cp864' } }).documents[0].lines[0].text), 'ال');
  const unknown = escpos.parse(Buffer.from([ESC, 0x74, 99, 0x41, 0x82, 0x0A]));
  assert.ok(unknown.warnings.some((w) => w.code === 'unknown_code_page'));
  assert.equal(unknown.documents[0].lines[0].text, 'Aé');
  const utf8 = escpos.parse(Buffer.concat([Buffer.from([ESC, 0x74, 16]), Buffer.from('Crème brûlée حمص\n', 'utf8')]), { encoding: 'utf8' });
  assert.equal(utf8.documents[0].lines[0].text, 'Crème brûlée حمص');
});

test('attributes: alignment, bold, double width and height, invert, underline, tabs, absolute position', () => {
  const ESC = 0x1B, GS = 0x1D;
  const b = Buffer.concat([
    Buffer.from([ESC, 0x61, 1, ESC, 0x21, 0x38]), Buffer.from('TOTAL\n'),
    Buffer.from([ESC, 0x21, 0, ESC, 0x61, 0, GS, 0x21, 0x11, GS, 0x42, 1, ESC, 0x2D, 1]), Buffer.from('BIG\n'),
    Buffer.from([GS, 0x21, 0, GS, 0x42, 0, ESC, 0x2D, 0, ESC, 0x44, 4, 10, 0]), Buffer.from('1\tTea\t2.00\n'),
    Buffer.from('Tax'), Buffer.from([ESC, 0x24, 240, 0]), Buffer.from('0.30\n'),
  ]);
  const [a, big, tab, pos] = escpos.parse(b).documents[0].lines;
  assert.deepEqual([a.align, a.bold, a.width, a.height], ['center', true, 2, 2]);
  assert.deepEqual([big.align, big.width, big.height, big.invert, big.underline], ['left', 2, 2, true, true]);
  assert.equal(tab.text, '1   Tea   2.00');
  assert.equal(pos.text, 'Tax' + ' '.repeat(17) + '0.30');   // 240 dots at 12 dots a column
});

test('review: a ticket that does not balance, has no table, an unmapped table, or is an image is held', () => {
  const venue = { id: 'beit', system: 'micros', currency: 'USD' };
  const doc = (rows, table) => {
    const w = make.writer('cp437').init().line('CHK 77').line(table === undefined ? 'TBL 3' : table).line('27/10/2026 20:00');
    for (const r of rows) w.line(r);
    return w.cut().bytes();
  };
  const items = [make.row('1 Hummus', '5.00'), make.row('2 Pepsi', '4.00')];
  const ok = ticket.readStream(doc(items.concat([make.row('Total', '9.00')])), { profile: 'generic', venue })[0];
  assert.equal(ok.needsReview, false);
  assert.equal(ok.totalCents, 900);
  const off = ticket.readStream(doc(items.concat([make.row('Total', '9.50')])), { profile: 'generic', venue })[0];
  assert.equal(off.needsReview, true);
  assert.ok(off.issues.some((i) => i.blocking && /total says 950/.test(i.reason)));
  assert.ok(off.confidence <= 0.3);
  const noTable = ticket.readStream(doc(items.concat([make.row('Total', '9.00')]), ''), { profile: 'generic', venue })[0];
  assert.equal(noTable.needsReview, true);
  assert.ok(noTable.issues.some((i) => /no table/.test(i.reason)));
  const lettered = doc(items.concat([make.row('Total', '9.00')]), 'Table: B7');
  assert.equal(ticket.readStream(lettered, { profile: 'generic', venue })[0].needsReview, true);
  const mapped = ticket.readStream(lettered, { profile: 'generic', venue: Object.assign({ tables: { b7: 107 } }, venue) })[0];
  assert.equal(mapped.needsReview, false);
  assert.equal(mapped.check.tableNumber, 107);
  const img = Buffer.concat([Buffer.from([0x1B, 0x40, 0x1D, 0x76, 0x30, 0, 2, 0, 3, 0]), Buffer.alloc(6, 0xFF), Buffer.from([0x1D, 0x56, 0])]);
  const image = ticket.readStream(img, { profile: 'generic', venue })[0];
  assert.deepEqual([image.kind, image.needsReview], ['image', true]);
  const unparsed = ticket.readStream(doc([make.row('1 Hummus', '5.00'), 'Hummus extra?', make.row('Total', '5.00')]), { profile: 'generic', venue })[0];
  assert.equal(unparsed.needsReview, false);
  assert.equal(unparsed.confidence, 0.9);
  const strict = ticket.readStream(doc([make.row('1 Hummus', '5.00'), 'Hummus extra?', make.row('Total', '5.00')]), { profile: 'generic', venue: Object.assign({ minConfidence: 0.95 }, venue) })[0];
  assert.equal(strict.needsReview, true);
});

test('superseded: an unchanged reprint is a duplicate, a changed print an update of the same externalId', () => {
  const dir = tmp(), file = path.join(dir, 'ledger.json');
  const venue = { id: 'beit', system: 'micros', currency: 'USD' };
  let clock = NOW.getTime();
  const now = () => new Date(clock);
  const ledger = new ticket.CheckLedger({ file, now });
  const [first] = ticket.readStream(bytesOf('discount-service.bin'), { profile: 'generic', venue });
  const [again, changed] = ticket.readStream(bytesOf('reprint.bin'), { profile: 'generic', venue });
  const open = ledger.accept(first, 'beit', venue);
  assert.equal(open.action, 'open');
  assert.equal(open.version, clock);
  clock += 60000;
  const dup = ledger.accept(again, 'beit', venue);
  assert.deepEqual([dup.action, dup.externalId, dup.version], ['duplicate', open.externalId, open.version]);
  // a restart in between: the ledger is on disk
  const reborn = new ticket.CheckLedger({ file, now });
  const up = reborn.accept(changed, 'beit', venue);
  assert.deepEqual([up.action, up.externalId, up.previousVersion], ['update', open.externalId, open.version]);
  assert.ok(up.version > open.version);
  // the clock went backwards: versions still grow
  clock -= 3600000;
  const more = Object.assign({}, changed, { hash: 'changed-again' });
  assert.equal(reborn.accept(more, 'beit', venue).version, up.version + 1);
  // the same check printed again after midnight keeps the externalId it was opened with
  clock = new Date('2026-10-28T00:40:00Z').getTime();
  const late = Object.assign({}, changed, { hash: 'after-midnight', check: Object.assign({}, changed.check, { date: '2026-10-28' }) });
  assert.equal(reborn.accept(late, 'beit', venue).externalId, '2026-10-27/2291');
  // a new check on the same table notes the one it supersedes
  const next = Object.assign({}, changed, { hash: 'new-check', check: Object.assign({}, changed.check, { number: '2300' }) });
  const opened = reborn.accept(next, 'beit', venue);
  assert.deepEqual([opened.action, opened.supersedesCheck], ['open', '2026-10-27/2291']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tenders: a paid receipt can close the bill at the till, change taken off the cash', async () => {
  const { validateBill } = await posBill;
  const venue = { id: 'younes', system: 'loyverse', currency: 'USD', sendTenders: true };
  const [r] = ticket.readStream(bytesOf('loyverse-paid.bin'), { profile: 'loyverse', venue });
  const body = ticket.toPosBill(r, venue, { externalId: '2026-10-27/2-1015', version: 5 });
  assert.deepEqual(body.tenders, [{ externalId: '2026-10-27/2-1015:t1', method: 'cash', amountCents: 1400 }]);
  assert.equal(body.closed, true);
  assert.equal(validateBill(body).errors, undefined);
  const plain = ticket.toPosBill(r, { system: 'loyverse' }, { externalId: 'x', version: 1 });
  assert.equal(plain.tenders, undefined);
  assert.equal(plain.closed, undefined);
});

test('amounts: separators, currencies, negatives', () => {
  const p = ticket.loadProfile('generic');
  const c = (s) => ticket.parseAmount(s, p);
  assert.equal(c('12.50').cents, 1250);
  assert.equal(c('1,500,000').cents, 150000000);
  assert.equal(c('1.234,50').cents, 123450);
  assert.equal(c('12.5').cents, 1250);
  assert.deepEqual([c('-8.20').cents, c('-8.20').negative, c('(3.00)').negative, c('4.00-').negative, c('4.00').negative], [820, true, true, true, false]);
  assert.equal(c('USD 38.30').currency, 'USD');
  assert.equal(c('3,427,850 L.L.').currency, 'LBP');
  assert.equal(c('BILL 5').currency, null);
});

/* ---------- the listener ---------- */

function config(dir, extra) {
  return Object.assign({
    endpoint: 'https://fake-project.supabase.test/functions/v1/pos-bill', dryRun: true,
    stateDir: path.join(dir, 'state'), outDir: path.join(dir, 'out'), reviewDir: path.join(dir, 'review'),
    venues: { 'beit': { integrationKeyEnv: 'TEST_POS_KEY', system: 'micros', currency: 'USD' }, 'mayda': { integrationKeyEnv: 'TEST_POS_KEY', system: 'foodics', currency: 'USD' } },
    printers: [{ name: 'till', venue: 'beit', profile: 'generic', source: { tcp: { host: '127.0.0.1', port: 0 } } },
      { name: 'kitchen', venue: 'mayda', profile: 'foodics', source: { tcp: { host: '127.0.0.1', port: 0 } } }],
  }, extra || {});
}
function fakePos(answers) {
  const calls = [];
  const fetch = async (url, o) => {
    calls.push({ url, headers: o.headers, body: JSON.parse(o.body) });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a[1]), { status: a[0], headers: Object.assign({ 'Content-Type': 'application/json' }, a[2] || {}) });
  };
  return { calls, fetch };
}

test('listener dry run: writes valid bodies, sends nothing, ignores the kitchen ticket', async () => {
  const { validateBill } = await posBill;
  const dir = tmp();
  const sent = [];
  const bridge = new listen.Bridge(config(dir), { fetch: async () => { sent.push(1); throw new Error('no network in dry run'); }, now: () => NOW, env: {} });
  assert.deepEqual(bridge.check(), []);   // no key needed in dry run
  const out = await bridge.handleBytes(bridge.printer('till'), Buffer.concat([bytesOf('discount-service.bin'), bytesOf('reprint.bin')]));
  assert.deepEqual(out.map((o) => o.action), ['open', 'duplicate', 'update']);
  const kitchen = await bridge.handleBytes(bridge.printer('kitchen'), bytesOf('kitchen.bin'));
  assert.deepEqual(kitchen.map((o) => [o.kind, o.action]), [['kitchen', 'ignored']]);
  assert.equal(sent.length, 0);
  const files = fs.readdirSync(path.join(dir, 'out')).sort();
  assert.equal(files.length, 2);
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'out', f), 'utf8'));
    assert.equal(j.dryRun, true);
    assert.equal(validateBill(j.body).errors, undefined);
  }
  assert.ok(fs.existsSync(path.join(dir, 'state', 'ledger-dry-run.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'ledger.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener: a bill that needs review is written to review and never sent', async () => {
  const dir = tmp();
  const pos = fakePos([[201, { status: 'opened' }]]);
  const bridge = new listen.Bridge(config(dir, { dryRun: false }), { fetch: pos.fetch, now: () => NOW, env: { TEST_POS_KEY: KEY }, sleep: async () => {} });
  const bad = make.writer('cp437').init().line('CHK 9').line('TBL 3').line(make.row('1 Hummus', '5.00')).line(make.row('Total', '7.00')).cut().bytes();
  const [o] = await bridge.handleBytes(bridge.printer('till'), bad);
  assert.equal(o.action, 'review');
  assert.equal(pos.calls.length, 0);
  const j = JSON.parse(fs.readFileSync(o.file, 'utf8'));
  assert.equal(j.reason, 'needs_review');
  assert.ok(j.text.some((t) => t.includes('Hummus')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener push: the key, the same body on every retry, 429 waits Retry-After', async () => {
  const dir = tmp();
  const waits = [];
  const pos = fakePos([[503, { error: { code: 'unavailable' } }], 'network', [429, { error: { code: 'rate_limited' } }, { 'Retry-After': '2' }], [201, { status: 'opened', checkId: 'pos_1' }]]);
  const bridge = new listen.Bridge(config(dir, { dryRun: false }), { fetch: pos.fetch, now: () => NOW, env: { TEST_POS_KEY: KEY }, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(bridge.check(), []);
  const [o] = await bridge.handleBytes(bridge.printer('till'), bytesOf('discount-service.bin'));
  assert.deepEqual([o.action, o.status, o.pushed, o.checkId], ['open', 201, true, 'pos_1']);
  assert.equal(pos.calls.length, 4);
  for (const c of pos.calls) {
    assert.equal(c.url, 'https://fake-project.supabase.test/functions/v1/pos-bill');
    assert.equal(c.headers['X-Aalayna-Integration-Key'], KEY);
    assert.deepEqual(c.body, pos.calls[0].body);
  }
  assert.equal(pos.calls[0].body.version, NOW.getTime());
  assert.deepEqual(waits, [1000, 2000, 2000]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'outbox.json'), 'utf8')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener push: stale_version dropped, version_reused moves up once, a refusal goes to review', async () => {
  const dir = tmp();
  const env = { TEST_POS_KEY: KEY };
  let pos = fakePos([[409, { error: { code: 'stale_version', currentVersion: 9e12 } }]]);
  let bridge = new listen.Bridge(config(dir, { dryRun: false }), { fetch: pos.fetch, now: () => NOW, env, sleep: async () => {} });
  let [o] = await bridge.handleBytes(bridge.printer('till'), bytesOf('discount-service.bin'));
  assert.deepEqual([o.code, o.pushed, pos.calls.length], ['stale_version', false, 1]);

  pos = fakePos([[409, { error: { code: 'version_reused' } }], [200, { status: 'updated' }]]);
  bridge = new listen.Bridge(config(path.join(dir, 'b'), { dryRun: false }), { fetch: pos.fetch, now: () => NOW, env, sleep: async () => {} });
  [o] = await bridge.handleBytes(bridge.printer('till'), bytesOf('discount-service.bin'));
  assert.deepEqual([o.status, o.pushed], [200, true]);
  assert.ok(pos.calls[1].body.version > pos.calls[0].body.version);

  pos = fakePos([[409, { error: { code: 'table_busy', message: 'Table 14 has an open bill with a payment.', openCheckId: 'pos_9' } }]]);
  bridge = new listen.Bridge(config(path.join(dir, 'c'), { dryRun: false }), { fetch: pos.fetch, now: () => NOW, env, sleep: async () => {} });
  [o] = await bridge.handleBytes(bridge.printer('till'), bytesOf('discount-service.bin'));
  assert.deepEqual([o.status, o.code, o.pushed], [409, 'table_busy', false]);
  const j = JSON.parse(fs.readFileSync(o.file, 'utf8'));
  assert.equal(j.message, 'Table 14 has an open bill with a payment.');
  assert.equal(j.body.externalId, '2026-10-27/2291');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener push: an unsent bill waits in the outbox and goes out on the next retry', async () => {
  const dir = tmp();
  const pos = fakePos([[503, { error: { code: 'unavailable' } }]]);
  const cfg = config(dir, { dryRun: false, maxAttempts: 2 });
  const bridge = new listen.Bridge(cfg, { fetch: pos.fetch, now: () => NOW, env: { TEST_POS_KEY: KEY }, sleep: async () => {} });
  const [o] = await bridge.handleBytes(bridge.printer('till'), bytesOf('discount-service.bin'));
  assert.deepEqual([o.code, o.pushed], ['retry_later', false]);
  const box = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'outbox.json'), 'utf8'));
  assert.equal(box.length, 1);
  // a restart: the outbox is read back and the same body goes out
  const ok = fakePos([[200, { status: 'unchanged' }]]);
  const again = new listen.Bridge(cfg, { fetch: ok.fetch, now: () => NOW, env: { TEST_POS_KEY: KEY }, sleep: async () => {} });
  await again.retryOutbox();
  assert.deepEqual(ok.calls[0].body, box[0].body);
  assert.deepEqual(again.outbox, []);
  // without a key, a live start refuses
  const nokey = new listen.Bridge(cfg, { env: {} });
  assert.match(nokey.check().join('\n'), /set TEST_POS_KEY/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener tcp: reads a job split over many writes, forwards it to the printer, captures it', async () => {
  const dir = tmp();
  const printed = [];
  const printer = net.createServer((s) => { const parts = []; s.on('data', (d) => parts.push(d)); s.on('end', () => { printed.push(Buffer.concat(parts)); s.end(); }); });
  await new Promise((r) => printer.listen(0, '127.0.0.1', r));
  const cfg = config(dir, { captureDir: path.join(dir, 'captures') });
  cfg.printers = [{ name: 'till', venue: 'beit', profile: 'generic', source: { tcp: { host: '127.0.0.1', port: 0 } }, forward: { host: '127.0.0.1', port: printer.address().port } }];
  const running = await listen.start(cfg, { now: () => NOW, env: {} });
  const port = running.handles[0].address().port;
  const bytes = bytesOf('discount-service.bin');
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  for (let i = 0; i < bytes.length; i += 50) { sock.write(bytes.subarray(i, i + 50)); await wait(1); }
  sock.end();
  const files = await until(() => { const d = path.join(dir, 'out'); return fs.existsSync(d) && fs.readdirSync(d).length ? fs.readdirSync(d) : null; });
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'out', files[0]), 'utf8'));
  assert.equal(j.body.totalCents, 8266);
  await until(() => printed.length);
  assert.ok(printed[0].equals(bytes), 'the printer got every byte');
  const caps = await until(() => fs.existsSync(path.join(dir, 'captures')) && fs.readdirSync(path.join(dir, 'captures')).length && fs.readdirSync(path.join(dir, 'captures')));
  assert.ok(fs.readFileSync(path.join(dir, 'captures', caps[0])).equals(bytes));
  await running.close();
  await new Promise((r) => printer.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener tcp: when the printer cannot be reached, the POS connection is closed', async () => {
  const dir = tmp();
  const dead = net.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const cfg = config(dir);
  cfg.printers = [{ name: 'till', venue: 'beit', profile: 'generic', source: { tcp: { host: '127.0.0.1', port: 0 } }, forward: { host: '127.0.0.1', port: deadPort } }];
  const running = await listen.start(cfg, { now: () => NOW, env: {} });
  const sock = net.connect(running.handles[0].address().port, '127.0.0.1');
  sock.on('error', () => {});
  const closed = await new Promise((r) => { sock.on('close', () => r(true)); setTimeout(() => r(false), 3000); });
  assert.equal(closed, true);
  await running.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener folder: a print-to-file capture is read once it stops growing, once per content', async () => {
  const dir = tmp(), inbox = path.join(dir, 'in');
  fs.mkdirSync(inbox);
  const cfg = config(dir);
  cfg.printers = [{ name: 'office', venue: 'beit', profile: 'generic', source: { folder: { path: inbox, pollMs: 60000, moveProcessed: true } } }];
  const bridge = new listen.Bridge(cfg, { now: () => NOW, env: {} });
  const watcher = bridge.watchFolder(cfg.printers[0]);
  fs.writeFileSync(path.join(inbox, 'ticket.prn'), bytesOf('discount-service.bin'));
  await watcher.scan();
  assert.ok(!fs.existsSync(path.join(dir, 'out')), 'not read on the first pass: it may still be growing');
  await watcher.scan();
  assert.equal(fs.readdirSync(path.join(dir, 'out')).length, 1);
  assert.equal(fs.readdirSync(path.join(inbox, 'processed')).length, 1);
  fs.writeFileSync(path.join(inbox, 'ticket-copy.prn'), bytesOf('discount-service.bin'));
  await watcher.scan(); await watcher.scan();
  assert.equal(fs.readdirSync(path.join(dir, 'out')).length, 1, 'the same content is not read twice');
  watcher.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener --replay: prints the outcome, writes the dry-run body, keeps the ledger untouched', () => {
  const dir = tmp();
  const cfg = config(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(Object.assign(cfg, { stateDir: 'state', outDir: 'out', reviewDir: 'review' })));
  const out = execFileSync(process.execPath, [path.join(root, 'tools/pos-printer/listen.js'), '--config', path.join(dir, 'config.json'),
    '--replay', path.join(FIX, 'reprint.bin'), '--printer', 'till'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  const outcomes = JSON.parse(out.slice(out.indexOf('[')));
  assert.deepEqual(outcomes.map((o) => o.action), ['open', 'update']);
  assert.equal(fs.readdirSync(path.join(dir, 'out')).length, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'state')));
  const example = listen.loadConfig(path.join(root, 'tools/pos-printer/config.example.json'));
  assert.equal(example.dryRun, true);
  assert.deepEqual(new listen.Bridge(example, { env: {} }).check(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
