/* The POS bridge (T13): supabase/functions/pos-bill, supabase/functions/pos-webhook-deliver
   and supabase/integrations-2026-09-30.sql. The Edge Function handlers are plain ES
   modules; they run here under Node with a fake PostgREST (a fetch that answers
   /rest/v1/rpc/<fn>, as in tests/followups.test.cjs) and fake webhook receivers. Proves
   that:
   - pos-bill answers 401 for a malformed or unknown key (the plain key never reaches the
     database, only its sha256), 429 past 600 calls a minute with Retry-After and without
     touching the bill, 400 with field names, 413 for a large body, 503 when the database
     is down; it turns the POS body into aal_mutate's lines (cents to units, modifiers in
     the name, notes dropped, the discount spread over the lines to the cent, service as
     its own line) and passes LBP through unconverted; it maps aal_pos_bill's answers:
     opened 201, unchanged and updated 200, a bill rule 409 with the server's sentence,
     a close with a balance 409 with the outstanding cents, closed 200;
   - pos-webhook-deliver refuses a call without the cron secret, signs the exact body
     (HMAC-SHA256, hex) with the endpoint's secret, sends the event and delivery headers,
     retries after 1, 5, 30, 120, 720, 720, 720 minutes and gives up after the 8th
     failure, times out after the limit, never posts to a removed endpoint, and sends
     pings;
   - the SQL keeps its stated structure (one transaction, pinned search paths, tables
     closed to anon and authenticated, bridge functions for service_role only, aal_mutate
     untouched), and, with PGLITE_MODULE set, behaves as stated against PostgreSQL, with
     both handlers talking to it: open, idempotent resend, update, paid-line removal 409,
     close with a balance 409, close, table busy, stale and reused versions, LBP, the rate
     limit, bill.paid and bill.closed queued once each and delivered signed, ping. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const nodeCrypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const bill = load('supabase/functions/pos-bill/handler.js');
const deliver = load('supabase/functions/pos-webhook-deliver/handler.js');
const shared = load('supabase/functions/_shared/supabase.js');

const KEY = 'pos_' + 'ab'.repeat(32), OTHER_KEY = 'pos_' + 'cd'.repeat(32);
const sha = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
const hmac = (secret, body) => nodeCrypto.createHmac('sha256', secret).update(body).digest('hex');
const ENV = { SUPABASE_URL: 'https://fake-project.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-for-tests', AALAYNA_CRON_SECRET: 'fake-cron-secret-for-tests' };
const NOW = new Date('2026-09-30T12:00:20.000Z');

/* the fake PostgREST: routes[fn](args) -> [status, body] */
function fakeRest(routes) {
  const s = { calls: [], down: false };
  s.fetch = async (url, o) => {
    const u = new URL(url);
    if (s.down) throw new TypeError('fetch failed');
    assert.equal(u.origin, ENV.SUPABASE_URL);
    const fn = u.pathname.replace('/rest/v1/rpc/', ''), args = o.body ? JSON.parse(o.body) : {};
    s.calls.push({ fn, args, headers: o.headers });
    const r = routes[fn] ? routes[fn](args) : [404, { code: 'PGRST202', message: 'Could not find the function' }];
    return new Response(r[1] == null ? null : JSON.stringify(r[1]), { status: r[0], headers: { 'Content-Type': 'application/json' } });
  };
  s.of = (fn) => s.calls.filter((c) => c.fn === fn);
  return s;
}
const posRequest = (body, key = KEY, extra = {}) => new Request('https://fake-project.supabase.test/functions/v1/pos-bill', {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Aalayna-Integration-Key': key }, extra),
  body: typeof body === 'string' ? body : JSON.stringify(body) });
const cronRequest = (secret = ENV.AALAYNA_CRON_SECRET) => new Request('https://fake-project.supabase.test/functions/v1/pos-webhook-deliver', {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, secret ? { 'X-Aalayna-Cron': secret } : {}), body: '{}' });
const answer = async (res) => ({ status: res.status, headers: res.headers, body: await res.json() });

const VENUE = '["mayda","hamra"]';
function posServer(o = {}) {
  let calls = o.calls || 0;
  const s = fakeRest({
    aal_pos_resolve: (a) => a.p_key_hash === sha(KEY)
      ? [200, { restaurant_id: VENUE, key_id: 'k-1', scopes: ['bills'], calls: ++calls, limit: 600, resetAt: '2026-09-30T12:01:00+00:00' }]
      : [200, null],
    aal_pos_bill: (a) => s.bill ? s.bill(a) : [200, { checkId: 'pos_1', status: 'opened', revision: 1, balance: { totalCents: 0 } }],
  });
  return s;
}
const run = async (server, req) => (await bill).handle(req, { fetch: server.fetch, env: ENV, now: () => NOW });

const OPEN = {
  externalId: 'omega-2026-09-30-0042', table: 7, currency: 'USD', version: 1, totalCents: 2600,
  lines: [
    { externalId: 'L1', name: 'Hummus', quantity: 2, unitPriceCents: 500, note: 'guest Rana, no garlic' },
    { externalId: 'L2', name: 'Shish taouk', quantity: 1, unitPriceCents: 1200, modifiers: ['Extra garlic', { name: 'Fries' }] },
    { externalId: 'L3', name: 'Voided soda', quantity: 0, unitPriceCents: 300 },
  ],
  discountCents: 200, serviceCents: 600,
};
const balance = (t, p = 0, q = 0) => ({ totalCents: t, paidCents: p, pendingCents: q, remainingCents: t - p });

/* ---------------------------------------------------------------- pos-bill */
test('pos-bill: a malformed key is refused without a database call, an unknown one after it; the key itself never reaches the database', async () => {
  const s = posServer();
  let r = await answer(await run(s, posRequest(OPEN, 'own_' + 'ab'.repeat(18))));
  assert.equal(r.status, 401); assert.equal(r.body.error.code, 'unknown_key'); assert.equal(s.calls.length, 0);
  r = await answer(await run(s, posRequest(OPEN, '')));
  assert.equal(r.status, 401); assert.equal(s.calls.length, 0);
  r = await answer(await run(s, posRequest(OPEN, OTHER_KEY)));
  assert.equal(r.status, 401); assert.equal(r.body.error.message, 'Unknown or revoked integration key.');
  assert.deepEqual(s.of('aal_pos_resolve')[0].args, { p_key_hash: sha(OTHER_KEY) });
  assert.equal(s.of('aal_pos_bill').length, 0);
  assert.equal(JSON.stringify(s.calls).includes(OTHER_KEY), false);
  assert.equal(s.calls[0].headers.apikey, ENV.SUPABASE_SERVICE_ROLE_KEY);        // the service role, never the POS key
  r = await answer(await run(s, new Request('https://x/functions/v1/pos-bill', { method: 'GET', headers: { 'X-Aalayna-Integration-Key': KEY } })));
  assert.equal(r.status, 405);
});

test('pos-bill: opening sends aal_mutate lines (units, modifiers in the name, notes dropped, discount spread to the cent, service line) and answers 201', async () => {
  const s = posServer();
  s.bill = () => [200, { checkId: 'pos_9f', status: 'opened', system: 'pos', externalId: OPEN.externalId, version: 1, revision: 1, table: 7,
    currency: 'USD', closed: false, closedAt: null, balance: balance(2600) }];
  const logs = [];
  const res = await (await bill).handle(posRequest(OPEN), { fetch: s.fetch, env: ENV, now: () => NOW, log: { info: (l) => logs.push(l), warn() {}, error() {} } });
  const r = await answer(res);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { checkId: 'pos_9f', status: 'opened', system: 'pos', externalId: OPEN.externalId, version: 1, revision: 1, table: 7,
    currency: 'USD', closed: false, closedAt: null, balance: balance(2600) });
  assert.equal(r.headers.get('X-RateLimit-Remaining'), '599');
  const sent = s.of('aal_pos_bill')[0].args;
  assert.equal(sent.p_key_hash, sha(KEY));
  // 200 off 2200 of items: 2200*200/2200 split 1000:1200 -> 91 and 109 cents
  assert.deepEqual(sent.p_bill, { system: 'pos', externalId: OPEN.externalId, table: 7, currency: 'USD', totalCents: 2600,
    discountCents: 200, serviceCents: 600, version: 1, closed: false,
    items: [{ id: 'L1', q: 2, unitCents: 500, name: 'Hummus' }, { id: 'L2', q: 1, unitCents: 1200, name: 'Shish taouk (Extra garlic, Fries)' }],
    lines: [{ id: 'L1', q: 2, p: 9.09, name: 'Hummus' }, { id: 'L2', q: 1, p: 10.91, name: 'Shish taouk (Extra garlic, Fries)' },
      { id: 'aalayna:service', q: 1, p: 6, name: 'Service' }], tenders: [] });
  assert.equal(JSON.stringify(sent).includes('Rana'), false);                      // a note never leaves the function
  assert.equal(logs.join('\n').includes('Hummus'), false); assert.equal(logs.join('\n').includes(KEY), false);
  assert.match(logs[0], /"status":201/);
});

test('pos-bill: the discount spread is exact, never negative, largest remainder first', async () => {
  const { spreadDiscount } = await bill;
  assert.deepEqual(spreadDiscount([100, 100, 100], 100), [34, 33, 33]);
  assert.deepEqual(spreadDiscount([1, 999], 1000), [1, 999]);
  assert.deepEqual(spreadDiscount([500, 0], 7), [7, 0]);
  assert.deepEqual(spreadDiscount([3, 3], 0), [0, 0]);
  const big = spreadDiscount([9e14, 1e14, 333], 123456789);
  assert.equal(big.reduce((a, b) => a + b, 0), 123456789);
});

test('pos-bill: the same version again is 200, a higher one 200, and the answer is the database\'s', async () => {
  const s = posServer(), seen = [];
  s.bill = (a) => { seen.push(a.p_bill.version); return [200, { checkId: 'pos_9f', status: a.p_bill.version === 1 ? 'unchanged' : 'updated', version: a.p_bill.version, revision: a.p_bill.version, balance: balance(2600) }]; };
  let r = await answer(await run(s, posRequest(OPEN)));
  assert.equal(r.status, 200); assert.equal(r.body.status, 'unchanged');
  r = await answer(await run(s, posRequest(Object.assign({}, OPEN, { version: 2 }))));
  assert.equal(r.status, 200); assert.equal(r.body.status, 'updated'); assert.equal(r.body.revision, 2);
  assert.deepEqual(seen, [1, 2]);
});

test('pos-bill: a bill rule is 409 with the server\'s sentence; a close with a balance is 409 with the outstanding cents; a close is 200', async () => {
  const s = posServer();
  s.bill = () => [400, { code: 'P0001', message: 'Hummus is covered by a payment and cannot be removed.', details: '{}', hint: 'pos:409:rule' }];
  let r = await answer(await run(s, posRequest(Object.assign({}, OPEN, { version: 3 }))));
  assert.equal(r.status, 409); assert.deepEqual(r.body, { error: { code: 'rule', message: 'Hummus is covered by a payment and cannot be removed.' } });
  s.bill = () => [400, { code: 'P0001', message: 'This bill still has 1600 cents outstanding in Aalayna, so it cannot be closed.',
    details: JSON.stringify(Object.assign(balance(2600, 1000), { checkId: 'pos_9f' })), hint: 'pos:409:balance_outstanding' }];
  r = await answer(await run(s, posRequest(Object.assign({}, OPEN, { version: 3, closed: true }))));
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'balance_outstanding');
  assert.equal(r.body.error.remainingCents, 1600); assert.equal(r.body.error.paidCents, 1000); assert.equal(r.body.error.checkId, 'pos_9f');
  s.bill = (a) => [200, { checkId: 'pos_9f', status: 'closed', closed: a.p_bill.closed, closedAt: '2026-09-30T12:00:21.000Z', balance: balance(2600, 2600) }];
  r = await answer(await run(s, posRequest(Object.assign({}, OPEN, { version: 3, closed: true }))));
  assert.equal(r.status, 200); assert.equal(r.body.closed, true); assert.equal(r.body.balance.remainingCents, 0);
  // other refusals keep their status
  for (const [hint, status] of [['pos:409:table_busy', 409], ['pos:409:stale_version', 409], ['pos:401:unknown_key', 401], ['pos:400:empty_bill', 400]]) {
    s.bill = () => [400, { code: 'P0001', message: 'm', details: '{"table":7}', hint }];
    r = await answer(await run(s, posRequest(OPEN)));
    assert.equal(r.status, status, hint); assert.equal(r.body.error.code, hint.split(':')[2]);
  }
  // a database error without a bridge hint is not passed through
  s.bill = () => [400, { code: '22P02', message: 'invalid input syntax for type json', details: null, hint: null }];
  r = await answer(await run(s, posRequest(OPEN)));
  assert.equal(r.status, 500); assert.equal(r.body.error.code, 'internal'); assert.doesNotMatch(r.body.error.message, /syntax/);
});

test('pos-bill: LBP bills pass through unconverted', async () => {
  const s = posServer();
  const lbp = { externalId: 'omega-7781', table: 3, currency: 'LBP', version: 1, totalCents: 450000000,
    lines: [{ externalId: 'a', name: 'Manakish', quantity: 3, unitPriceCents: 150000000 }] };
  await run(s, posRequest(lbp));
  const sent = s.of('aal_pos_bill')[0].args.p_bill;
  assert.equal(sent.currency, 'LBP'); assert.equal(sent.totalCents, 450000000);
  assert.deepEqual(sent.lines, [{ id: 'a', q: 3, p: 4500000, name: 'Manakish' }]);
});

test('pos-bill: more than 600 calls a minute is 429 with Retry-After, and the bill is not touched', async () => {
  const s = posServer({ calls: 600 });
  const r = await answer(await run(s, posRequest(OPEN)));
  assert.equal(r.status, 429); assert.equal(r.body.error.code, 'rate_limited');
  assert.equal(r.headers.get('Retry-After'), '40');                                // 12:00:20 -> 12:01:00
  assert.equal(r.body.error.retryAfterSeconds, 40); assert.equal(r.headers.get('X-RateLimit-Remaining'), '0');
  assert.equal(s.of('aal_pos_bill').length, 0);
});

test('pos-bill: a bad body is 400 with every field named; a total that does not add up names totalCents; too large is 413; a database outage is 503', async () => {
  const s = posServer();
  let r = await answer(await run(s, posRequest({ externalId: '', table: 0, currency: 'EUR', version: 1.5, totalCents: -1, closed: 'yes',
    lines: [{ externalId: 'aalayna:x', name: '', quantity: 2.5, unitPriceCents: -3, modifiers: 'x' }, { externalId: 'd', name: 'A', quantity: 1, unitPriceCents: 1 }, { externalId: 'd', name: 'B', quantity: 1, unitPriceCents: 1 }] })));
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'bad_body');
  assert.deepEqual(r.body.error.fields.map((f) => f.field).sort(), ['closed', 'currency', 'externalId', 'lines[0].externalId', 'lines[0].modifiers',
    'lines[0].name', 'lines[0].quantity', 'lines[0].unitPriceCents', 'lines[2].externalId', 'table', 'totalCents', 'version'].sort());
  r = await answer(await run(s, posRequest(Object.assign({}, OPEN, { totalCents: 2601 }))));
  assert.equal(r.status, 400); assert.deepEqual(r.body.error.fields, [{ field: 'totalCents', message: 'must equal the lines minus discountCents plus serviceCents: 2600' }]);
  r = await answer(await run(s, posRequest('{not json')));
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'bad_json');
  r = await answer(await run(s, posRequest(JSON.stringify(Object.assign({}, OPEN, { pad: 'x'.repeat(300 * 1024) })))));
  assert.equal(r.status, 413);
  assert.equal(s.of('aal_pos_bill').length, 0);
  s.down = true;
  r = await answer(await run(s, posRequest(OPEN)));
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'unavailable');
});

test('pos-bill: tenders from the till are checked and passed on; a tender conflict is 409', async () => {
  const s = posServer();
  const withTenders = Object.assign({}, OPEN, { closed: true, tenders: [
    { externalId: 'T1', method: 'cash', amountCents: 2000, tipCents: 200, takenAt: '2026-09-30T20:15:00+03:00' },
    { externalId: 'T2', method: 'card', amountCents: 800 }] });
  s.bill = () => [200, { checkId: 'pos_9f', status: 'closed', tendersRecorded: 2, closed: true, balance: balance(2600, 2600) }];
  let r = await answer(await run(s, posRequest(withTenders)));
  assert.equal(r.status, 200); assert.equal(r.body.tendersRecorded, 2);
  assert.deepEqual(s.of('aal_pos_bill')[0].args.p_bill.tenders, [
    { externalId: 'T1', method: 'cash', amountCents: 2000, tipCents: 200, takenAt: '2026-09-30T17:15:00.000Z' },
    { externalId: 'T2', method: 'card', amountCents: 800, tipCents: 0, takenAt: null }]);
  r = await answer(await run(s, posRequest(Object.assign({}, OPEN, { tenders: [
    { externalId: 'T1', method: 'cheque', amountCents: 0 }, { externalId: 'T1', method: 'cash', amountCents: 500, tipCents: 500, takenAt: 'yesterday' }, 'x'] }))));
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.error.fields.map((f) => f.field).sort(), ['tenders[0].amountCents', 'tenders[0].method', 'tenders[1].externalId',
    'tenders[1].takenAt', 'tenders[1].tipCents', 'tenders[2]'].sort());
  r = await answer(await run(s, posRequest(Object.assign({}, OPEN, { tenders: {} }))));
  assert.equal(r.status, 400); assert.equal(r.body.error.fields[0].field, 'tenders');
  s.bill = () => [400, { code: 'P0001', message: 'Tender T3 would overpay this bill: 400 cents are left to pay in Aalayna.',
    details: JSON.stringify({ leftToPayCents: 400, tenderExternalId: 'T3', amountCents: 900, tipCents: 0 }), hint: 'pos:409:overpaid' }];
  r = await answer(await run(s, posRequest(Object.assign({}, OPEN, { tenders: [{ externalId: 'T3', method: 'cash', amountCents: 900 }] }))));
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'overpaid'); assert.equal(r.body.error.leftToPayCents, 400);
});

/* ---------------------------------------------------------------- pos-webhook-deliver */
function deliverServer(rows) {
  const results = [];
  const s = fakeRest({
    aal_pos_claim_deliveries: () => [200, rows.splice(0)],
    aal_pos_delivery_result: (a) => { results.push(a); return [204, null]; },
  });
  s.results = results;
  return s;
}
function receivers(behaviour) {
  const got = [];
  const send = async (url, init) => {
    got.push({ url, init });
    return behaviour(url, init);
  };
  return { got, send };
}
const row = (o = {}) => Object.assign({ id: 'd-1', endpointId: 'e-1', eventType: 'bill.paid', eventId: 'pos_1:bill.paid', attempts: 0,
  url: 'https://pos.example.com/aalayna', secret: 'whsec_' + '11'.repeat(32), active: true,
  payload: { event: 'bill.paid', eventId: 'pos_1:bill.paid', venue: VENUE, checkId: 'pos_1', externalId: 'omega-1', table: 7, totalCents: 2600, paidCents: 2600, currency: 'USD', payments: [] } }, o);
const runDeliver = async (server, r, extra = {}) => (await deliver).handle(r, Object.assign({ rpc: (await shared).fromEnv(ENV, server.fetch).rpc, env: ENV, now: () => NOW }, extra));

test('pos-webhook-deliver: without the cron secret nothing is claimed', async () => {
  const s = deliverServer([row()]);
  let r = await answer(await runDeliver(s, cronRequest(null)));
  assert.equal(r.status, 401);
  r = await answer(await runDeliver(s, cronRequest('wrong')));
  assert.equal(r.status, 401); assert.equal(s.calls.length, 0);
  r = await answer(await (await deliver).handle(cronRequest(), { rpc: async () => [], env: {}, now: () => NOW }));
  assert.equal(r.status, 500); assert.equal(r.body.error.code, 'not_configured');
});

test('pos-webhook-deliver: the body is signed with the endpoint secret (HMAC-SHA256 hex) and a 2xx is recorded as delivered', async () => {
  const d = row(), s = deliverServer([d]), rx = receivers(() => new Response('ok', { status: 202 }));
  const r = await answer(await runDeliver(s, cronRequest(), { send: rx.send }));
  assert.deepEqual(r.body, { claimed: 1, delivered: 1, failed: 0, gaveUp: 0, unrecorded: 0 });
  const sent = rx.got[0];
  assert.equal(sent.url, d.url); assert.equal(sent.init.method, 'POST'); assert.equal(sent.init.redirect, 'manual');
  assert.equal(sent.init.body, JSON.stringify(d.payload));
  assert.equal(sent.init.headers['X-Aalayna-Signature'], hmac(d.secret, sent.init.body));
  assert.equal(sent.init.headers['X-Aalayna-Event'], 'bill.paid'); assert.equal(sent.init.headers['X-Aalayna-Delivery'], 'd-1');
  // the receiver's three lines
  assert.ok(nodeCrypto.timingSafeEqual(Buffer.from(hmac(d.secret, sent.init.body)), Buffer.from(sent.init.headers['X-Aalayna-Signature'])));
  assert.deepEqual(s.results, [{ p_id: 'd-1', p_ok: true, p_status: 202, p_error: null, p_next_attempt_at: null }]);
});

test('pos-webhook-deliver: failures back off 1, 5, 30, 120, 720, 720, 720 minutes and the 8th gives up, keeping the error', async () => {
  const rx = receivers(() => new Response('no', { status: 500 })), next = [];
  for (let attempts = 0; attempts < 8; attempts++) {
    const s = deliverServer([row({ attempts })]);
    const r = await answer(await runDeliver(s, cronRequest(), { send: rx.send }));
    const res = s.results[0];
    assert.equal(res.p_ok, false); assert.equal(res.p_status, 500);
    next.push(res.p_next_attempt_at && (Date.parse(res.p_next_attempt_at) - NOW.getTime()) / 60000);
    assert.equal(r.body.unrecorded, 0);
    if (attempts < 7) { assert.equal(res.p_error, 'HTTP 500'); assert.equal(r.body.failed, 1); }
    else { assert.equal(res.p_error, 'gave up after 8 attempts: HTTP 500'); assert.equal(r.body.gaveUp, 1); }
  }
  assert.deepEqual(next, [1, 5, 30, 120, 720, 720, 720, null]);
  const { nextAttemptAt, MAX_ATTEMPTS } = await deliver;
  assert.equal(MAX_ATTEMPTS, 8); assert.equal(nextAttemptAt(8, NOW), null);
  // a redirect is a failure too, not followed
  const s = deliverServer([row()]);
  await runDeliver(s, cronRequest(), { send: async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }) });
  assert.equal(s.results[0].p_error, 'HTTP 302');
});

test('pos-webhook-deliver: a slow endpoint times out; a removed endpoint or a private address is never called; pings are sent', async () => {
  let s = deliverServer([row()]);
  const slow = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await runDeliver(s, cronRequest(), { send: slow, timeoutMs: 20 });
  assert.match(s.results[0].p_error, /^timed out after/); assert.ok(s.results[0].p_next_attempt_at);
  const rx = receivers(() => new Response('ok', { status: 200 }));
  s = deliverServer([row({ id: 'd-2', active: false }), row({ id: 'd-3', url: 'https://10.0.0.8/hook' }), row({ id: 'd-4', url: 'https://pos.localhost/hook' })]);
  const r = await answer(await runDeliver(s, cronRequest(), { send: rx.send }));
  assert.equal(rx.got.length, 0); assert.equal(r.body.gaveUp, 3);
  assert.deepEqual(s.results.map((x) => [x.p_id, x.p_error, x.p_next_attempt_at]).sort(),
    [['d-2', 'endpoint removed', null], ['d-3', 'address not allowed', null], ['d-4', 'address not allowed', null]]);
  const ping = row({ id: 'd-5', eventType: 'ping', eventId: 'ping:1', payload: { event: 'ping', eventId: 'ping:1', venue: VENUE, endpointId: 'e-1' } });
  s = deliverServer([ping]);
  await runDeliver(s, cronRequest(), { send: rx.send });
  assert.equal(rx.got[0].init.headers['X-Aalayna-Event'], 'ping');
  assert.equal(JSON.parse(rx.got[0].init.body).event, 'ping'); assert.equal(s.results[0].p_ok, true);
});

/* ---------------------------------------------------------------- the SQL, static */
const SQL = fs.readFileSync(path.join(root, 'supabase', 'integrations-2026-09-30.sql'), 'utf8');
test('integrations SQL: one transaction, pinned search paths, closed tables, service-role-only bridge, aal_mutate untouched, re-runnable', () => {
  const body = SQL.replace(/--[^\n]*/g, '');
  assert.match(body, /^\s*begin;/); assert.match(body, /commit;\s*$/);
  assert.equal((body.match(/\bbegin;/g) || []).length, 1); assert.equal((body.match(/\bcommit;/g) || []).length, 1);
  assert.match(SQL, /UNTESTED/); assert.match(SQL, /Run after theme-2026-09-28\.sql/);
  assert.match(body, /raise exception 'Run auth-2026-09-24\.sql before integrations-2026-09-30\.sql'/);
  const fns = [...body.matchAll(/create or replace function ([\w.]+)\(([^)]*)\)[\s\S]*?\$\$;/g)];
  assert.ok(fns.length >= 15);
  for (const f of fns) assert.match(f[0], /set search_path = public, extensions, pg_temp as \$\$/, f[1]);
  assert.equal(/create (or replace )?function public\.aal_mutate\b/.test(body), false);
  assert.equal(/\bcreate (table|index)\b(?! if not exists)/.test(body), false);
  assert.equal(/\bcreate extension\b(?! if not exists)/.test(body), false);
  assert.match(body, /drop trigger if exists kv_rows_pos_webhooks on public\.kv_rows;\s*create trigger kv_rows_pos_webhooks/);
  // every table: RLS on, nothing for anon or authenticated
  const tables = [...body.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables.sort(), ['integration_key_usage', 'integration_keys', 'integration_settings', 'webhook_deliveries', 'webhook_endpoints']);
  for (const t of tables) {
    assert.match(body, new RegExp('alter table public\\.' + t + ' enable row level security;'), t);
    assert.match(body, new RegExp('revoke all on [^;]*public\\.' + t + '[^;]* from public, anon, authenticated;'), t);
  }
  assert.equal(/create policy/.test(body), false);
  // the bridge: service_role only; the owner's two: anon and authenticated, deciding inside
  for (const f of ['aal_pos_resolve(text)', 'aal_pos_bill(text, jsonb)', 'aal_pos_claim_deliveries(int)', 'aal_pos_delivery_result(uuid, boolean, int, text, timestamptz)']) {
    const esc = f.replace(/[()]/g, '\\$&');
    assert.match(body, new RegExp('revoke all on function public\\.' + esc + ' from public, anon, authenticated;'), f);
    assert.match(body, new RegExp('grant execute on function public\\.' + esc + ' to service_role;'), f);
  }
  const grants = [...body.matchAll(/grant execute on function public\.(\w+)[^;]* to ([^;]+);/g)];
  for (const g of grants) if (/anon|authenticated/.test(g[2])) assert.ok(['aal_integration', 'aal_webhooks'].includes(g[1]), g[1]);
  for (const f of ['aal_integration', 'aal_webhooks']) {
    const src = fns.find((x) => x[1] === 'public.' + f)[0];
    assert.match(src, /if not public\.aal_pos_is_owner\(p_rid\) then raise exception/, f);
  }
  // the owner key is borrowed for the transaction only, and handed back
  const pos = fns.find((x) => x[1] === 'public.aal_pos_bill')[0];
  assert.match(pos, /set_config\('request\.headers', jsonb_build_object\('x-aalayna-key', okey\)::text, true\)/);
  assert.match(pos, /set_config\('request\.headers', coalesce\(nullif\(hdr, ''\), '\{\}'\), true\)/);
  assert.ok(pos.indexOf('pg_advisory_xact_lock(hashtextextended(rid, 0))') < pos.indexOf("set_config('request.headers'"));
  assert.deepEqual([...pos.matchAll(/aal_pos_call\(rid, '(\w+)'/g)].map((m) => m[1]).sort(), ['close_check', 'open_check', 'update_check']);
  // round 2: the order inside a request, and closedBy marked for this transaction only
  const at = (needle) => { const i = pos.indexOf(needle); assert.ok(i > 0, needle); return i; };
  assert.ok(at("perform set_config('aalayna.actor', 'pos', true)") < at("'bill_superseded'"));
  assert.ok(at("'bill_superseded'") < at("aal_pos_call(rid, 'open_check'"));
  assert.ok(at("aal_pos_call(rid, 'update_check'") < at('aal_pos_record_tenders(rid, cid'));
  assert.ok(at('aal_pos_record_tenders(rid, cid') < at("aal_pos_call(rid, 'close_check'"));
  assert.ok(at("aal_pos_call(rid, 'close_check'") < at("perform set_config('aalayna.actor', '', true)"));
  const trig = fns.find((x) => x[1] === 'public.aal_pos_webhook_trigger')[0];
  assert.match(trig, /'closedBy', case when coalesce\(current_setting\('aalayna\.actor', true\), ''\) = 'pos' then 'pos' else 'aalayna' end/);
  assert.equal((trig.match(/'origin', case when c->'posRef'->>'externalId' is not null then 'pos' else 'aalayna' end/g) || []).length, 2);
  const tenders = fns.find((x) => x[1] === 'public.aal_pos_record_tenders')[0];
  assert.match(tenders, /'rail', 'pos', 'source', 'pos'/); assert.match(tenders, /'status', 'confirmed'/);
  assert.match(tenders, /'eventType', 'payment_completed'/);
  // optional extensions never stop the migration; the schedule only when pg_cron is there
  assert.match(body, /create extension if not exists pg_net with schema extensions;\s*exception when others then raise notice/);
  assert.match(body, /create extension if not exists pg_cron;\s*exception when others then raise notice/);
  assert.match(body, /if to_regnamespace\('cron'\) is not null then\s*execute \$c\$select cron\.schedule\('aalayna-pos-webhooks', '\* \* \* \* \*'/);
  // no secret in the file
  assert.equal(/(pos|whsec|own|chk)_[0-9a-f]{16,}/.test(SQL), false);
  assert.equal(/eyJ[A-Za-z0-9_-]{10,}/.test(SQL), false);
});

test('the .gitignore allowlist ships docs/ and the functions', () => {
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const line of ['!docs/', '!docs/*', '!supabase/functions/', '!supabase/functions/*/', '!supabase/functions/*/*']) assert.ok(gi.split('\n').includes(line), line);
});

/* ---------------------------------------------------------------- the SQL, in PostgreSQL */
const modulePath = process.env.PGLITE_MODULE;
/* A fresh database with every migration applied twice over, one venue, and the handlers'
   rpc as PostgREST would run it (the service role). */
async function pgBridge() {
  const { PGlite } = require(modulePath), db = new PGlite();
  const { SupabaseError } = await shared;
  const sql = (f) => fs.readFileSync(path.join(root, 'supabase', f), 'utf8').replace('create extension if not exists pgcrypto;', '');
  await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
  await assert.rejects(db.exec(sql('integrations-2026-09-30.sql')), /Run auth-2026-09-24\.sql/);
  await db.exec('rollback');
  for (const f of ['migration.sql', 'site-events.sql', 'hardening-2026-09-15.sql', 'hardening-2026-09-24.sql', 'admin.sql', 'sessions-2026-09-24.sql',
    'auth-2026-09-24.sql', 'followups-2026-09-24.sql', 'theme-2026-09-28.sql', 'integrations-2026-09-30.sql', 'integrations-2026-09-30.sql']) await db.exec(sql(f));
  await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
  const as = async (role, headers, claims) => {
    await db.exec('reset role');
    await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)", [JSON.stringify(headers || {}), JSON.stringify(claims || { role })]);
    await db.exec('set role ' + role);
  };
  const one = async (q, args) => (await db.query(q, args)).rows[0].value;
  const su = async (q, args) => { await db.exec('reset role'); return (await db.query(q, args)).rows; };
  await as('anon', { 'x-aalayna-admin': 'adm_test' });
  const v = await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra','{}'::jsonb) as value");
  const rid = v.restaurant_id;
  const owner = () => as('anon', { 'x-aalayna-key': v.owner_key });
  const mutate = (op, body, token = '') => one('select aal_mutate($1,$2,$3::jsonb,$4) as value', [rid, op, JSON.stringify(body), token]);

  // PostgREST, as the service role: what the handlers' rpc does
  const rpc = async (fn, args) => {
    await as('service_role', {}, { role: 'service_role' });
    const names = Object.keys(args || {});
    try {
      const q = 'select public.' + fn + '(' + names.map((n, i) => n + ' => $' + (i + 1)).join(', ') + ') as value';
      return (await db.query(q, names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n])))).rows[0].value;
    } catch (e) {
      throw new SupabaseError(e.message, 400, { code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null });
    }
  };
  const posDeps = { rpc, now: () => new Date() };
  const post = async (body, key) => answer(await (await bill).handle(posRequest(body, key), posDeps));

  const issue = async () => { await owner(); return one('select aal_integration($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'issue', label: 'till' })]); };
  const endpoint = async () => { await owner(); return one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'add', url: 'https://pos.example.com/aalayna' })]); };
  const check = async (id) => (await su("select body from kv_rows where collection='aal.checks' and id=$1", [id]))[0].body;
  return { db, as, one, su, v, rid, owner, mutate, rpc, post, issue, endpoint, check };
}

test('integrations SQL in PostgreSQL: the whole bridge through both handlers', { skip: !modulePath }, async () => {
  const { db, as, one, su, v, rid, owner, mutate, rpc, post } = await pgBridge();
  try {
    // the owner's surface: keys and endpoints; guests and anon get nothing
    await as('anon', {});
    await assert.rejects(one('select aal_integration($1,$2::jsonb) as value', [rid, '{"op":"issue"}']), /Only the restaurant owner/);
    await assert.rejects(db.query('select * from integration_keys'), /permission denied/);
    await assert.rejects(one('select aal_pos_resolve($1) as value', [sha(KEY)]), /permission denied/);
    await assert.rejects(one('select aal_pos_bill($1,$2::jsonb) as value', [sha(KEY), '{}']), /permission denied/);
    await owner();
    const issued = await one('select aal_integration($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'issue', label: 'Omega till 1' })]);
    assert.match(issued.key, /^pos_[0-9a-f]{64}$/);
    assert.equal(issued.keys[0].hint, 'pos_' + issued.key.slice(4, 12) + '...'); assert.equal(JSON.stringify(issued.keys).includes(issued.key), false);
    assert.equal((await su('select key_hash from integration_keys'))[0].key_hash, sha(issued.key));   // only the hash is stored
    await owner();
    await assert.rejects(one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'add', url: 'http://pos.example.com/x' })]), /https:\/\//);
    await assert.rejects(one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'add', url: 'https://192.168.1.4/x' })]), /public host name/);
    await assert.rejects(one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'add', url: 'https://pos.example.com/x', events: ['bill.opened'] })]), /Events must be/);
    const ep = await one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'add', url: 'https://pos.example.com/aalayna' })]);
    assert.match(ep.secret, /^whsec_[0-9a-f]{64}$/); assert.deepEqual(ep.events, ['bill.paid', 'bill.closed']);
    await owner();
    assert.equal(JSON.stringify(await one('select aal_webhooks($1,$2::jsonb) as value', [rid, '{"op":"list"}'])).includes(ep.secret), false);

    const KEYV = issued.key;
    const body = { externalId: 'omega-0042', table: 7, currency: 'USD', version: 1, totalCents: 2200,
      lines: [{ externalId: 'L1', name: 'Hummus', quantity: 2, unitPriceCents: 500 }, { externalId: 'L2', name: 'Shish taouk', quantity: 1, unitPriceCents: 1200 }] };
    // unknown key
    assert.equal((await post(body, KEY)).status, 401);
    // open
    let r = await post(body, KEYV);
    assert.equal(r.status, 201); assert.equal(r.body.status, 'opened'); assert.match(r.body.checkId, /^pos_[0-9a-f]{24}$/);
    assert.deepEqual(r.body.balance, balance(2200)); assert.equal(r.body.revision, 1); assert.equal(r.body.version, 1);
    const cid = r.body.checkId;
    let c = (await su("select body from kv_rows where collection='aal.checks' and id=$1", [cid]))[0].body;
    assert.equal(c.source, 'staff'); assert.equal(c.totalCents, 2200); assert.equal(c.currency, 'USD');
    assert.deepEqual(c.lines, [{ id: 'L1', q: 2, p: 10, name: 'Hummus' }, { id: 'L2', q: 1, p: 12, name: 'Shish taouk' }]);
    assert.deepEqual({ system: c.posRef.system, externalId: c.posRef.externalId, version: c.posRef.version }, { system: 'pos', externalId: 'omega-0042', version: 1 });
    // the owner key was only borrowed
    await as('service_role', { 'x-test': '1' }, { role: 'service_role' });
    await db.exec('begin');
    await db.query('select aal_pos_bill($1,$2::jsonb)', [sha(KEYV), JSON.stringify((await bill).validateBill(body).bill)]);
    assert.equal((await db.query("select current_setting('request.headers') as h")).rows[0].h, '{"x-test":"1"}');
    await db.exec('commit');
    // the same version again: unchanged; with other contents: refused
    r = await post(body, KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'unchanged'); assert.equal(r.body.revision, 1);
    r = await post(Object.assign({}, body, { table: 8 }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'version_reused'); assert.equal(r.body.error.currentVersion, 1);
    // update: a line more, and the table moves to 9
    const v2 = Object.assign({}, body, { version: 2, table: 9, totalCents: 2600, lines: body.lines.concat([{ externalId: 'L3', name: 'Ayran', quantity: 1, unitPriceCents: 400 }]) });
    r = await post(v2, KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'updated'); assert.equal(r.body.table, 9); assert.equal(r.body.revision, 3);
    assert.equal(r.body.balance.totalCents, 2600);
    r = await post(Object.assign({}, v2, { version: 1 }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'stale_version'); assert.equal(r.body.error.currentVersion, 2);
    // a guest pays for both Hummus with cash; staff confirm it
    await owner();
    await mutate('reserve', { id: 'pay-1', checkId: cid, amount: 10, tip: 0, rail: 'cash', items: { L1: 2 } }, 't'.repeat(40));
    await owner(); await mutate('confirm_cash', { id: 'pay-1' });
    // another POS bill for that table: the open bill has a payment, so it is busy, not superseded
    r = await post(Object.assign({}, body, { externalId: 'omega-0043', table: 9 }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'table_busy'); assert.equal(r.body.error.openCheckId, cid);
    // the POS removes the paid Hummus: 409 with the server's sentence, nothing changed
    const v3 = Object.assign({}, v2, { version: 3, totalCents: 1600, lines: v2.lines.slice(1) });
    r = await post(v3, KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'rule'); assert.equal(r.body.error.message, 'Hummus is covered by a payment and cannot be removed.');
    c = (await su("select body from kv_rows where collection='aal.checks' and id=$1", [cid]))[0].body;
    assert.equal(c.posRef.version, 2); assert.equal(c.lines.length, 3);
    // closing with 1600 outstanding: 409 with the cents, still open
    r = await post(Object.assign({}, v2, { closed: true }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'balance_outstanding');
    assert.deepEqual([r.body.error.totalCents, r.body.error.paidCents, r.body.error.remainingCents, r.body.error.checkId], [2600, 1000, 1600, cid]);
    assert.equal((await su("select body->>'closedAt' as c from kv_rows where collection='aal.checks' and id=$1", [cid]))[0].c, null);
    assert.equal((await su('select count(*)::int as n from webhook_deliveries'))[0].n, 0);
    // the rest is paid: bill.paid is queued once
    await owner();
    await mutate('reserve', { id: 'pay-2', checkId: cid, amount: 17, tip: 1, rail: 'cash' }, 'u'.repeat(40));
    await owner(); await mutate('confirm_cash', { id: 'pay-2' });
    await owner(); await mutate('confirm_cash', { id: 'pay-2' });                  // an idempotent resend
    let q = await su('select event_type, event_id, payload from webhook_deliveries order by created_at');
    assert.deepEqual(q.map((x) => x.event_id), [cid + ':bill.paid']);
    const paid = q[0].payload;
    assert.deepEqual([paid.event, paid.venue, paid.checkId, paid.externalId, paid.table, paid.totalCents, paid.paidCents, paid.currency, paid.origin],
      ['bill.paid', rid, cid, 'omega-0042', 9, 2600, 2600, 'USD', 'pos']);
    assert.deepEqual(paid.payments.map((p) => [p.id, p.rail, p.amountCents, p.tipCents, !!p.confirmedAt]), [['pay-1', 'cash', 1000, 0, true], ['pay-2', 'cash', 1700, 100, true]]);
    assert.equal(JSON.stringify(paid).includes('deviceId'), false);
    // close: 200, bill.closed queued once, a resend is unchanged
    r = await post(Object.assign({}, v2, { closed: true }), KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'closed'); assert.equal(r.body.closed, true); assert.deepEqual(r.body.balance, balance(2600, 2600));
    r = await post(Object.assign({}, v2, { closed: true }), KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'unchanged');
    r = await post(Object.assign({}, v2, { version: 4, totalCents: 3000, lines: v2.lines.concat([{ externalId: 'L4', name: 'Tea', quantity: 1, unitPriceCents: 400 }]) }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'bill_closed');
    q = await su('select event_type from webhook_deliveries order by created_at');
    assert.deepEqual(q.map((x) => x.event_type), ['bill.paid', 'bill.closed']);
    // LBP: stored as sent
    r = await post({ externalId: 'omega-lbp-1', table: 3, currency: 'LBP', version: 1, totalCents: 450000000,
      lines: [{ externalId: 'a', name: 'Manakish', quantity: 3, unitPriceCents: 150000000 }] }, KEYV);
    assert.equal(r.status, 201); assert.equal(r.body.currency, 'LBP'); assert.equal(r.body.balance.totalCents, 450000000);
    r = await post({ externalId: 'omega-lbp-1', table: 3, currency: 'USD', version: 2, totalCents: 4500,
      lines: [{ externalId: 'a', name: 'Manakish', quantity: 3, unitPriceCents: 1500 }] }, KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'currency_changed');
    // a new bill with nothing on it yet is refused
    r = await post({ externalId: 'omega-empty', table: 4, currency: 'USD', version: 1, totalCents: 0, lines: [] }, KEYV);
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'empty_bill');
    // the rate limit: the 601st call this minute
    // (this minute and the next, so a minute turning over mid-test changes nothing)
    const usage = (n) => su("insert into integration_key_usage (key_id, minute, calls) select $1::uuid, m, $2 from (values (date_trunc('minute', now())), (date_trunc('minute', now()) + interval '1 minute')) t(m) on conflict (key_id, minute) do update set calls = excluded.calls", [issued.id, n]);
    await usage(599);
    assert.equal((await post(Object.assign({}, v2, { closed: true }), KEYV)).status, 200);   // the 600th
    await usage(600);
    r = await post(Object.assign({}, v2, { closed: true }), KEYV);
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('Retry-After')) >= 1);
    await su('delete from integration_key_usage');
    // a revoked key stops at once
    await owner();
    await one('select aal_integration($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'revoke', id: issued.id })]);
    assert.equal((await post(body, KEYV)).status, 401);

    // delivery: a ping is queued, then everything due is sent signed; a failing endpoint backs off
    await owner();
    await one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'test', id: ep.id })]);
    const rx = receivers(() => new Response('ok', { status: 200 }));
    let out = await answer(await (await deliver).handle(cronRequest(), { rpc, env: ENV, now: () => new Date(), send: rx.send }));
    assert.deepEqual(out.body, { claimed: 3, delivered: 3, failed: 0, gaveUp: 0, unrecorded: 0 });
    assert.deepEqual(rx.got.map((g) => g.init.headers['X-Aalayna-Event']).sort(), ['bill.closed', 'bill.paid', 'ping']);
    for (const g of rx.got) assert.equal(g.init.headers['X-Aalayna-Signature'], hmac(ep.secret, g.init.body));
    const closed = JSON.parse(rx.got.find((g) => g.init.headers['X-Aalayna-Event'] === 'bill.closed').init.body);
    assert.deepEqual([closed.event, closed.checkId, closed.externalId, closed.table, !!closed.closedAt, closed.origin, closed.closedBy, closed.supersededBy],
      ['bill.closed', cid, 'omega-0042', 9, true, 'pos', 'pos', null]);
    q = await su('select delivered_at is not null as ok, attempts, next_attempt_at from webhook_deliveries');
    assert.ok(q.every((x) => x.ok && x.attempts === 1 && x.next_attempt_at === null));
    out = await answer(await (await deliver).handle(cronRequest(), { rpc, env: ENV, now: () => new Date(), send: rx.send }));
    assert.equal(out.body.claimed, 0);                                              // nothing twice
    await owner();
    await one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'test', id: ep.id })]);
    out = await answer(await (await deliver).handle(cronRequest(), { rpc, env: ENV, now: () => new Date(), send: async () => new Response('', { status: 503 }) }));
    assert.equal(out.body.failed, 1); assert.equal(out.body.unrecorded, 0);
    q = await su("select attempts, last_status, last_error, next_attempt_at > now() + interval '50 seconds' as later from webhook_deliveries where event_type='ping' and delivered_at is null");
    assert.deepEqual(q, [{ attempts: 1, last_status: 503, last_error: 'HTTP 503', later: true }]);
    await owner();
    const log = await one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'deliveries' })]);
    assert.equal(log.deliveries.length, 4); assert.equal(log.deliveries[0].event, 'ping');
    // removing the endpoint stops its retries
    await owner();
    await one('select aal_webhooks($1,$2::jsonb) as value', [rid, JSON.stringify({ op: 'remove', id: ep.id })]);
    q = await su('select count(*)::int as n from webhook_deliveries where delivered_at is null and next_attempt_at is not null');
    assert.equal(q[0].n, 0);
    // without an endpoint, payments queue nothing and still work
    await owner();
    await mutate('open_check', { id: 'staff-1', table: 12, lines: [{ id: 'x', q: 1, p: 5, name: 'Tea' }] });
    await owner(); await mutate('reserve', { id: 'pay-3', checkId: 'staff-1', amount: 5, tip: 0, rail: 'cash' }, 'v'.repeat(40));
    await owner(); await mutate('confirm_cash', { id: 'pay-3' });
    await owner(); await mutate('close_check', { checkId: 'staff-1' });
    assert.equal((await su("select count(*)::int as n from webhook_deliveries where event_id like 'staff-1%'"))[0].n, 0);
  } finally { await db.close(); }
});

test('integrations SQL in PostgreSQL: till tenders, superseded bills, adding after a payment, origin and closedBy', { skip: !modulePath }, async () => {
  const { db, one, su, rid, owner, mutate, post, issue, endpoint, check } = await pgBridge();
  try {
    const KEYV = (await issue()).key;
    await endpoint();
    const settle = async (cid) => (await su("select body from kv_rows where collection='aal.settle' and body->>'checkId'=$1 order by body->>'confirmedAt', id", [cid])).map((x) => x.body);
    const queued = async (type, cid) => (await su('select payload from webhook_deliveries where event_type=$1 and payload->>\'checkId\'=$2', [type, cid])).map((x) => x.payload);
    const pay = async (id, cid, amount, items, confirm = true) => {
      await owner(); await mutate('reserve', Object.assign({ id, checkId: cid, amount, tip: 0, rail: 'cash' }, items ? { items } : {}), (id + 'x'.repeat(40)).slice(0, 40));
      if (confirm) { await owner(); await mutate('confirm_cash', { id }); }
    };
    const item = (externalId, quantity, unitPriceCents, name) => ({ externalId, name: name || externalId, quantity, unitPriceCents });

    // 1. The till takes all the money: tenders, then the close, in one request
    const b1 = { externalId: 'B-1', table: 6, currency: 'USD', version: 1, totalCents: 3000, closed: true,
      lines: [item('L1', 2, 1000, 'Mixed grill'), item('L2', 1, 1000, 'Tabbouleh')],
      tenders: [{ externalId: 'T1', method: 'cash', amountCents: 2000 }, { externalId: 'T2', method: 'card', amountCents: 1300, tipCents: 300, takenAt: '2020-01-01T00:00:00Z' }] };
    let r = await post(b1, KEYV);
    assert.equal(r.status, 201); assert.equal(r.body.status, 'closed'); assert.equal(r.body.tendersRecorded, 2);
    assert.equal(r.body.closed, true); assert.deepEqual(r.body.balance, balance(3000, 3000));
    const c1 = r.body.checkId, open1 = (await check(c1)).openedAt;
    const rows = await settle(c1);
    assert.equal(rows.length, 2);
    const t2 = rows.find((x) => x.posRef.externalId === 'T2');
    assert.match(t2.id, /^tnd_[0-9a-f]{24}$/);
    assert.deepEqual(Object.keys(t2).sort(), ['amount', 'amountUsd', 'checkId', 'confirmedAt', 'currency', 'fxRateUsed', 'id', 'items', 'method', 'posRef',
      'rail', 'recordedAt', 'source', 'status', 'table', 'tip', 'ts', 'venueId'].sort());
    assert.deepEqual([t2.rail, t2.source, t2.method, t2.posRef, t2.amount, t2.tip, t2.amountUsd, t2.currency, t2.status, t2.table, t2.venueId],
      ['pos', 'pos', 'card', { externalId: 'T2', method: 'card' }, 13, 3, 13, 'USD', 'confirmed', 6, rid]);
    assert.equal(t2.confirmedAt, open1);                                              // a takenAt before the opening is kept at the opening
    const events = (await su("select body from kv_rows where collection='aal.events' and body->>'eventType'='payment_completed' and body->'payload'->>'orderId'=$1", [c1])).map((x) => x.body);
    assert.deepEqual(events.map((e) => [e.payload.rail, e.payload.amount]).sort(), [['pos', 13], ['pos', 20]]);
    // the owner's snapshot counts them as payments; the guest's bill too
    await owner();
    const snap = await one('select aal_snapshot($1) as value', [rid]);
    assert.equal(snap.rows.filter((x) => x.collection === 'aal.settle' && x.body.checkId === c1 && x.body.rail === 'pos' && x.body.status === 'confirmed').length, 2);
    // webhooks: origin and closedBy, the tenders recognisable by their externalId
    const [paid1] = await queued('bill.paid', c1), [closed1] = await queued('bill.closed', c1);
    assert.equal(paid1.origin, 'pos'); assert.deepEqual(paid1.payments.map((x) => [x.rail, x.tenderExternalId, x.amountCents, x.tipCents]).sort(),
      [['pos', 'T1', 2000, 0], ['pos', 'T2', 1300, 300]]);
    assert.deepEqual([closed1.origin, closed1.closedBy], ['pos', 'pos']);
    // the same request again records nothing; a changed tender is refused; a new one overpays
    r = await post(b1, KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'unchanged'); assert.equal(r.body.tendersRecorded, 0);
    assert.equal((await settle(c1)).length, 2);
    r = await post(Object.assign({}, b1, { tenders: [{ externalId: 'T2', method: 'card', amountCents: 1400, tipCents: 300 }] }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'tender_changed');
    r = await post(Object.assign({}, b1, { tenders: [{ externalId: 'T9', method: 'cash', amountCents: 100 }] }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'overpaid'); assert.equal(r.body.error.leftToPayCents, 0);

    // 2. Tenders on an update without closing; an overpaying tender changes nothing; a guest's pending cash counts
    const b2 = { externalId: 'B-2', table: 11, currency: 'USD', version: 1, totalCents: 2000, lines: [item('L1', 2, 1000)],
      tenders: [{ externalId: 'T1', method: 'cash', amountCents: 800 }] };
    r = await post(b2, KEYV);
    assert.equal(r.status, 201); assert.equal(r.body.tendersRecorded, 1); assert.deepEqual(r.body.balance, balance(2000, 800));
    const c2 = r.body.checkId;
    await pay('g-1', c2, 5, null, false);                                             // a guest's cash request, not yet collected
    r = await post(Object.assign({}, b2, { tenders: [{ externalId: 'T1', method: 'cash', amountCents: 800 }, { externalId: 'T2', method: 'other', amountCents: 1200 }] }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'overpaid');
    assert.deepEqual([r.body.error.leftToPayCents, r.body.error.pendingCents, r.body.error.paidCents], [700, 500, 800]);
    assert.equal((await settle(c2)).filter((x) => x.rail === 'pos').length, 1);
    await owner(); await mutate('cancel', { id: 'g-1' });
    r = await post(Object.assign({}, b2, { version: 2, closed: true, tenders: [{ externalId: 'T1', method: 'cash', amountCents: 800 }, { externalId: 'T2', method: 'other', amountCents: 1200 }] }), KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'closed'); assert.equal(r.body.tendersRecorded, 1);

    // 3. A stale bill is superseded when nothing was paid or asked for on it
    await owner(); await mutate('open_check', { id: 'staff-5', table: 5, lines: [{ id: 'x', q: 1, p: 4, name: 'Tea' }] });
    r = await post({ externalId: 'A-1', table: 5, currency: 'USD', version: 1, totalCents: 900, lines: [item('L1', 1, 900)] }, KEYV);
    assert.equal(r.status, 201); const a1 = r.body.checkId;
    const staff5 = await check('staff-5');
    assert.ok(staff5.closedAt); assert.deepEqual(staff5.posRef, { superseded: 'A-1' });
    const sup = (await su("select body from kv_rows where collection='aal.events' and body->>'eventType'='bill_superseded'")).map((x) => x.body.payload);
    assert.deepEqual(sup, [{ orderId: 'staff-5', externalId: null, supersededBy: 'A-1', system: 'pos', totalCents: 400 }]);
    const [closed5] = await queued('bill.closed', 'staff-5');
    assert.deepEqual([closed5.origin, closed5.closedBy, closed5.supersededBy, closed5.externalId], ['aalayna', 'pos', 'A-1', null]);
    r = await post({ externalId: 'A-2', table: 5, currency: 'USD', version: 1, totalCents: 900, lines: [item('L1', 1, 900)] }, KEYV);
    assert.equal(r.status, 201); const a2 = r.body.checkId;
    assert.equal((await check(a1)).posRef.superseded, 'A-2'); assert.ok((await check(a1)).closedAt);
    // the superseded bill takes no more changes
    r = await post({ externalId: 'A-1', table: 5, currency: 'USD', version: 2, totalCents: 1800, lines: [item('L1', 2, 900)] }, KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'bill_closed');
    // any settlement row, even a cancelled request, keeps the bill: 409 with its id
    await pay('g-2', a2, 9, null, false); await owner(); await mutate('cancel', { id: 'g-2' });
    r = await post({ externalId: 'A-3', table: 5, currency: 'USD', version: 1, totalCents: 900, lines: [item('L1', 1, 900)] }, KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'table_busy'); assert.equal(r.body.error.openCheckId, a2);
    assert.equal((await check(a2)).closedAt, undefined);
    // a bill staff close in Aalayna: closedBy aalayna
    await owner(); await mutate('open_check', { id: 'staff-20', table: 20, lines: [{ id: 'x', q: 1, p: 4, name: 'Tea' }] });
    await pay('g-3', 'staff-20', 4); await owner(); await mutate('close_check', { checkId: 'staff-20' });
    const [closed20] = await queued('bill.closed', 'staff-20'), [paid20] = await queued('bill.paid', 'staff-20');
    assert.deepEqual([closed20.origin, closed20.closedBy, paid20.origin], ['aalayna', 'aalayna', 'aalayna']);

    // 4. After a payment the service charge only grows, by an added line
    const c = { externalId: 'C-1', table: 14, currency: 'USD', version: 1, serviceCents: 220, totalCents: 2420,
      lines: [item('L1', 2, 500, 'Hummus'), item('L2', 1, 1200, 'Shish taouk')] };
    r = await post(c, KEYV); const cc = r.body.checkId;
    await pay('g-4', cc, 5, { L1: 1 });
    r = await post(Object.assign({}, c, { version: 2, serviceCents: 280, totalCents: 3080, lines: c.lines.concat([item('L3', 1, 600, 'Knefeh')]) }), KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'updated'); assert.equal(r.body.balance.totalCents, 3080);
    assert.deepEqual((await check(cc)).lines, [{ id: 'L1', q: 2, p: 10, name: 'Hummus' }, { id: 'L2', q: 1, p: 12, name: 'Shish taouk' },
      { id: 'aalayna:service', q: 1, p: 2.2, name: 'Service' }, { id: 'L3', q: 1, p: 6, name: 'Knefeh' }, { id: 'aalayna:service:2', q: 1, p: 0.6, name: 'Service' }]);
    const c3 = Object.assign({}, c, { version: 3, serviceCents: 330, totalCents: 3630, lines: [item('L1', 3, 500, 'Hummus'), item('L2', 1, 1200, 'Shish taouk'), item('L3', 1, 600, 'Knefeh')] });
    r = await post(c3, KEYV);
    assert.equal(r.status, 200);
    const l3 = (await check(cc)).lines;
    assert.deepEqual(l3.find((x) => x.id === 'L1'), { id: 'L1', q: 3, p: 15, name: 'Hummus' });           // no discount share: grows in place
    assert.deepEqual(l3.find((x) => x.id === 'aalayna:service:3'), { id: 'aalayna:service:3', q: 1, p: 0.5, name: 'Service' });
    r = await post(Object.assign({}, c3, { version: 4, serviceCents: 300, totalCents: 3600 }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'rule');
    assert.equal(r.body.error.message, 'A payment is recorded on this bill. Items can be added, not removed or reduced.');
    r = await post(Object.assign({}, c3, { version: 4, totalCents: 2430, lines: [item('L1', 3, 500, 'Hummus'), item('L3', 1, 600, 'Knefeh')] }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.message, 'A payment is recorded on this bill. Items can be added, not removed or reduced.');
    r = await post(Object.assign({}, c3, { version: 4, totalCents: 3730, lines: [item('L1', 3, 500, 'Hummus'), item('L2', 1, 1200, 'Shish taouk'), item('L3', 1, 700, 'Knefeh')] }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.message, 'A payment is recorded on this bill. Prices of existing items cannot change.');
    r = await post(Object.assign({}, c3, { version: 4, totalCents: 2130, lines: [item('L2', 1, 1200, 'Shish taouk'), item('L3', 1, 600, 'Knefeh')] }), KEYV);
    assert.equal(r.status, 409); assert.equal(r.body.error.message, 'Hummus is covered by a payment and cannot be removed.');
    assert.equal((await check(cc)).posRef.version, 3);

    // 5. After a payment the discount cannot change; unchanged, new items come at full price and grown lines get an added line
    const d = { externalId: 'D-1', table: 15, currency: 'USD', version: 1, discountCents: 200, totalCents: 1800, lines: [item('L1', 2, 500), item('L2', 1, 1000)] };
    r = await post(d, KEYV); const dc = r.body.checkId;
    assert.deepEqual((await check(dc)).lines.map((x) => [x.id, x.q, x.p]), [['L1', 2, 9], ['L2', 1, 9]]);
    await pay('g-5', dc, 9);
    for (const discountCents of [300, 100]) {
      r = await post(Object.assign({}, d, { version: 2, discountCents, totalCents: 2000 - discountCents }), KEYV);
      assert.equal(r.status, 409); assert.equal(r.body.error.message, 'A payment is recorded on this bill. The discount cannot change.');
    }
    r = await post(Object.assign({}, d, { version: 2, totalCents: 2300, lines: d.lines.concat([item('L3', 1, 500)]) }), KEYV);
    assert.equal(r.status, 200);
    r = await post(Object.assign({}, d, { version: 3, totalCents: 2800, lines: [item('L1', 3, 500), item('L2', 1, 1000), item('L3', 1, 500)] }), KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.balance.totalCents, 2800);
    assert.deepEqual((await check(dc)).lines.map((x) => [x.id, x.q, x.p]), [['L1', 2, 9], ['L2', 1, 9], ['L3', 1, 5], ['aalayna:+3:L1', 1, 5]]);
    // and it all closes from the till
    r = await post(Object.assign({}, d, { version: 3, totalCents: 2800, lines: [item('L1', 3, 500), item('L2', 1, 1000), item('L3', 1, 500)], closed: true,
      tenders: [{ externalId: 'T1', method: 'card', amountCents: 1900 }] }), KEYV);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'closed'); assert.deepEqual(r.body.balance, balance(2800, 2800));
  } finally { await db.close(); }
});
