/* dashboard.html marks a payment the fake provider confirmed: the server sets demo on the row
   (supabase/review-fixes-2026-11-10.sql), the payment list tags it "Demo" and the statement
   export says so in its last column. paintRows and exportCSV run here against stubs. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
const slice = (from, to) => { const i = html.indexOf(from); assert.ok(i >= 0, from); return html.slice(i, html.indexOf(to, i)); };

function page(rows) {
  const els = new Map();
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.innerHTML = ''; this.textContent = ''; this.style = {}; this.attrs = {}; }
    appendChild(c) { this.children.push(c); return c; } replaceChildren() { this.children = []; }
    setAttribute(k, v) { this.attrs[k] = v; } get classList() { return { contains: () => false, add() {}, remove() {} }; }
  }
  const $ = (id) => { if (!els.has(id)) els.set(id, new El('div')); return els.get(id); };
  const out = { csv: null };
  const ctx = {
    $, document: { createElement: (t) => (t === 'a' ? Object.assign(new El('a'), { click() {} }) : new El(t)) },
    opsEl: (t, text) => Object.assign(new El(t), { textContent: text }), opsRailLabel: (x) => x.rail, money: (n) => '$' + Number(n).toFixed(2),
    toast() {}, URL: { createObjectURL: () => 'blob:x' }, Blob: class { constructor(parts) { out.csv = parts.join(''); } },
    Aalayna: {
      pendingCash: () => [], ownerPaymentHistory: () => rows, isConfirmed: (x) => x.status === 'confirmed',
      settlementStatus: (x) => x.status, sync: null,
    },
  };
  $('report-period').value = 'today';
  vm.runInNewContext(slice('function paintRows(){', '\nasync function confirmCashReceived') + '\n' + slice('function exportCSV(){', '\n/* ') + '\nthis.paintRows=paintRows;this.exportCSV=exportCSV;', ctx);
  return { ctx, $, out };
}

test('dashboard: the payment list tags demo confirmations, and only those; the export marks them', () => {
  const at = '2026-11-10T10:00:00.000Z';
  const rows = [
    { id: 'p-demo', table: 4, rail: 'card', amount: 12, tip: 1, status: 'confirmed', confirmedAt: at, ts: at, demo: true, server: 'Rana' },
    { id: 'p-real', table: 5, rail: 'whish', amount: 20, tip: 0, status: 'confirmed', confirmedAt: at, ts: at, demo: false, server: 'Rana' },
    { id: 'p-cash', table: 6, rail: 'cash', amount: 8, tip: 0, status: 'confirmed', confirmedAt: at, ts: at, server: 'Rana' },
    { id: 'p-claim', table: 7, rail: 'card', amount: 3, tip: 0, status: 'confirmed', confirmedAt: at, ts: at, demo: 'true', externalRef: 'fake-x', server: 'Rana' },
  ];
  const { ctx, $, out } = page(rows);
  ctx.paintRows();
  const painted = $('setrows').children.filter((c) => c.className && c.className.startsWith('setr'));
  assert.equal(painted.length, 4);
  const tagged = painted.map((d) => /<span class="rftag"[^>]*>Demo<\/span>/.test(d.innerHTML));
  // newest first (reversed); only the row whose server-set flag is true
  assert.deepEqual(tagged, [false, false, false, true]);
  ctx.exportCSV();
  const lines = out.csv.split('\n');
  assert.match(lines[0], /,"demo"$/);
  assert.deepEqual(lines.slice(1).map((l) => l.endsWith(',"yes"')), [true, false, false, false]);
});
