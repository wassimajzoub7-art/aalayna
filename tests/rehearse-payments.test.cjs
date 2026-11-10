/* tools/rehearse-payments.js: the stand-in for the shared store behaves as live does where the
   guest page depends on it (2026-11-10 review):
   - POST /rest/v1/rpc/aal_now answers the server's time as a JSON string (an ISO timestamp);
   - reserve refuses an amount or a tip that is not a number (the SQL casts both ::numeric),
     so a tip of 'x' cannot slip past the balance check;
   - a fake-provider payment, reserved, handed to the real payment-start, paid on the fake
     checkout and confirmed by the real payment-webhook, reaches the guest's snapshot without
     externalRef (aal_snapshot strips it) and with demo: true (kv_rows_settle_demo). */
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const tool = require('../tools/rehearse-payments.js');
const { postgrest, KEY, RID, CHECK, SELF, db } = tool;

const guest = (op, body, token = 'g'.repeat(40)) => postgrest(SELF + '/rest/v1/rpc/aal_mutate', {
  method: 'POST', headers: { 'x-aalayna-key': KEY }, body: JSON.stringify({ p_rid: RID, p_op: op, p_body: body, p_token: token }),
});
const read = async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || 'null') });
const quiet = (() => { const orig = console.log; return async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = orig; } }; })();

test('rehearsal stand-in: aal_now answers the server time as a JSON string', async () => {
  const before = Date.now();
  const r = await read(await postgrest(SELF + '/rest/v1/rpc/aal_now', { method: 'POST', headers: {}, body: '{}' }));
  assert.equal(r.status, 200);
  assert.equal(typeof r.body, 'string');
  assert.match(r.body, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/);
  const t = Date.parse(r.body);
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000);
});

test('rehearsal stand-in: reserve requires numbers for amount and tip, as the SQL casts do', async () => {
  await quiet(async () => {
    const base = { checkId: CHECK.id, rail: 'card', items: {} };
    for (const [id, over] of [['bad-tip', { amount: 1000, tip: 'x' }], ['bad-amount', { amount: 'lots', tip: 0 }], ['obj-tip', { amount: 6, tip: {} }], ['inf', { amount: 6, tip: '1e999' }]]) {
      const r = await read(await guest('reserve', Object.assign({ id, requestId: id }, base, over)));
      assert.equal(r.status, 400, id);
      assert.equal(r.body.message, 'Invalid amount', id);
      assert.equal(db.settle.has(id), false, id);
    }
    // a number is still checked against the balance
    let r = await read(await guest('reserve', Object.assign({ id: 'too-much', requestId: 'too-much', amount: 1000, tip: 0 }, base)));
    assert.match(r.body.message, /already covers this balance/);
    // numeric strings are what ::numeric accepts
    r = await read(await guest('reserve', Object.assign({ id: 'str-ok', requestId: 'str-ok', amount: '6', tip: '1' }, base)));
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.amount, r.body.tip, r.body.status], [6, 1, 'initiated']);
    await guest('cancel', { id: 'str-ok' });
  });
});

test('rehearsal stand-in: a demo confirmation reaches the guest with demo: true and without externalRef', async () => {
  await quiet(async () => {
    const logs = [];
    const fns = await tool.functionHandlers({ log: { warn: (...a) => logs.push(a.join(' ')), info() {} } });
    const token = crypto.randomBytes(24).toString('hex');
    let r = await read(await guest('reserve', { id: 'demo-1', requestId: 'demo-1', checkId: CHECK.id, amount: 13, tip: 1, rail: 'card', items: {} }, token));
    assert.equal(r.body.status, 'initiated');
    assert.equal('demo' in r.body, false, 'no demo key before confirmation');
    const headers = { 'x-aalayna-key': KEY, 'x-aalayna-payer': token, Origin: SELF, 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' };
    r = await read(await fns['payment-start'](new Request(SELF + '/functions/v1/payment-start', { method: 'POST', headers, body: JSON.stringify({ paymentId: 'demo-1', returnUrl: SELF + '/guest.html?venue=Mayda&place=Hamra&k=' + KEY }) })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = new URL(r.body.url).searchParams.get('s');
    r = await read(await fns['payment-start'](new Request(SELF + '/functions/v1/payment-start/fake/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SELF }, body: JSON.stringify({ s, outcome: 'paid' }) })));
    assert.deepEqual([r.status, r.body.outcome, r.body.result], [200, 'paid', 'confirmed'], JSON.stringify(r.body) + logs.join('\n'));
    // the store keeps the reference; the guest sees the flag, never the reference
    assert.match(db.settle.get('demo-1').externalRef, /^fake-demo-1-/);
    const snap = await read(await postgrest(SELF + '/rest/v1/rpc/aal_snapshot', { method: 'POST', headers: { 'x-aalayna-key': KEY }, body: JSON.stringify({ p_rid: RID }) }));
    const row = snap.body.rows.find((x) => x.id === 'demo-1').body;
    assert.equal(row.status, 'confirmed');
    assert.equal(row.demo, true);
    for (const k of ['externalRef', 'deviceId', 'sessionId', 'customerId', 'identityId', 'payerRef']) assert.equal(k in row, false, k);
    // the stand-in derives it as the trigger does: no other reference is a demo
    db.settle.set('real-1', { id: 'real-1', status: 'initiated', expiresAt: new Date(Date.now() + 60000).toISOString(), amount: 1, currency: 'USD' });
    tool.mutate('confirm_digital', { id: 'real-1', externalRef: 'whish-123', amountCents: 100, currency: 'USD' }, '', true);
    assert.equal(db.settle.get('real-1').demo, false);
    db.settle.delete('real-1');
  });
});
