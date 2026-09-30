/* Payment provider callbacks (T14): supabase/functions/payment-webhook/handler.js and the
   shared helpers it uses (_shared/verify.js, _shared/supabase.js), run in Node against a
   fake PostgREST that applies confirm_digital's rules from supabase/auth-2026-09-24.sql.
   Proves that:
   - the fake adapter accepts only an HMAC-SHA256 of the exact body with FAKE_WEBHOOK_SECRET,
     compared in constant time; a bad or missing signature is 401 and touches nothing; with
     the secret unset the route does not exist;
   - a good 'paid' callback finds the payment (and its venue) with the service role and
     calls aal_mutate confirm_digital with {id, externalRef, amountCents, currency} and the
     service role as Bearer; the same callback again is still 200;
   - the server's 'Duplicate provider reference' is 200 (idempotent, provider stops);
     'Reservation expired or changed' and an amount mismatch are 409 with the server's
     sentence; every verified call writes one payment_callbacks row, whatever the outcome;
   - 'failed' releases an initiated payment (aal_payment_failed), is a no-op for one already
     released and 409 for a confirmed one; 'refunded' is recorded only (202);
   - the fake provider never confirms at a venue with demo payments off (403);
   - whish answers 501 naming what is unknown; bodies over 64 kB are 413; callers are rate
     limited; a callbacks row that cannot be written turns the answer into 500; no body is
     ever logged. */
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const load = (rel) => import(path.join(root, 'supabase', 'functions', rel));

const RID = JSON.stringify(['kababji', 'hamra']), OTHER = JSON.stringify(['mayda', 'hamra']);
const SECRET = 'test-fake-secret-' + 'x'.repeat(16);
const SERVICE = 'test-service-role';
const URL_BASE = 'https://proj.supabase.co';
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const future = () => new Date(Date.now() + 5 * 60000).toISOString();

/* A fake PostgREST: kv_rows (aal.settle), venue_profiles, payment_callbacks, and the two
   RPCs, with confirm_digital's checks in the SQL's order. */
function fakeDb(o = {}) {
  const s = {
    calls: [], callbacks: [], failCallbacks: false,
    settle: new Map(), profiles: new Map([[RID, { demo_payments: true }], [OTHER, { demo_payments: false }]]),
  };
  const put = (rid, body) => s.settle.set(rid + '|' + body.id, { restaurant_id: rid, body });
  s.put = put;
  s.row = (rid, id) => (s.settle.get(rid + '|' + id) || {}).body;
  const res = (status, obj) => new Response(obj == null ? '' : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const refuse = (message) => res(400, { code: 'P0001', message, details: null, hint: null });
  s.fetch = async (url, init = {}) => {
    const u = new URL(url), q = u.searchParams, h = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : null;
    s.calls.push({ path: u.pathname, search: u.search, method: init.method, headers: h, body });
    if (h.Authorization !== 'Bearer ' + SERVICE || h.apikey !== SERVICE) return res(401, { message: 'bad key' });
    const val = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/rest/v1/kv_rows' && init.method === 'GET') {
      if (o.dbDown) return res(503, { message: 'down' });
      return res(200, [...s.settle.values()].filter((r) => val('collection') === 'aal.settle' && r.body.id === val('id') && (!q.get('restaurant_id') || r.restaurant_id === val('restaurant_id'))));
    }
    if (u.pathname === '/rest/v1/venue_profiles') { const p = s.profiles.get(val('restaurant_id')); return res(200, p ? [p] : []); }
    if (u.pathname === '/rest/v1/payment_callbacks') {
      if (s.failCallbacks) return res(500, { message: 'insert failed' });
      s.callbacks.push(body); return res(201, null);
    }
    if (u.pathname === '/rest/v1/rpc/aal_mutate') {
      const { p_rid, p_op, p_body } = body;
      if (p_op !== 'confirm_digital') return refuse('Unknown operation');
      const p = s.row(p_rid, p_body.id);
      if (!p) return refuse('Payment unavailable');
      if (p.externalRef === p_body.externalRef && p.status === 'confirmed') return res(200, p);
      if (p.status !== 'initiated' || Date.parse(p.expiresAt) <= Date.now()) return refuse('Reservation expired or changed; reconcile received funds');
      if (!p_body.externalRef || p_body.currency !== p.currency || p_body.amountCents !== Math.round(p.amount * 100)) return refuse('Callback amount, currency or reference mismatch');
      if ([...s.settle.values()].some((r) => r.restaurant_id === p_rid && r.body.externalRef === p_body.externalRef)) return refuse('Duplicate provider reference');
      Object.assign(p, { status: 'confirmed', confirmedAt: new Date().toISOString(), externalRef: p_body.externalRef });
      return res(200, p);
    }
    if (u.pathname === '/rest/v1/rpc/aal_payment_failed') {
      const p = s.row(body.p_rid, body.p_id);
      if (!p) return refuse('Payment unavailable');
      if (['failed', 'cancelled', 'expired'].includes(p.status)) return res(200, p);
      if (p.status !== 'initiated') return refuse('Payment already completed');
      Object.assign(p, { status: 'failed' }); return res(200, p);
    }
    return res(404, { message: 'no route ' + u.pathname });
  };
  s.rpcs = (name) => s.calls.filter((c) => c.path === '/rest/v1/rpc/' + name);
  return s;
}

const settleRow = (over = {}) => Object.assign({ id: 'pay-1', checkId: 'bill-7', table: 7, rail: 'whish', amount: 22, tip: 2, currency: 'USD', amountUsd: 22, status: 'initiated', expiresAt: future() }, over);
const event = (over = {}) => Object.assign({ externalRef: 'fake-ref-1', paymentId: 'pay-1', amountCents: 2200, currency: 'USD', status: 'paid', occurredAt: '2026-09-30T18:00:00.000Z' }, over);

async function setup(o = {}) {
  const mod = await load('payment-webhook/handler.js');
  const db = fakeDb(o);
  db.put(RID, settleRow());
  const logs = [];
  const log = { warn: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')) };
  const env = Object.assign({ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: SERVICE, FAKE_WEBHOOK_SECRET: SECRET }, o.env || {});
  const handle = mod.createHandler({ fetch: db.fetch, env, log, limiter: o.limiter });
  const call = (body, { provider = 'fake', signature, headers = {}, method = 'POST' } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const h = Object.assign({ 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, headers);
    if (signature !== null) h['X-Signature'] = signature === undefined ? sign(raw) : signature;
    return handle(new Request(URL_BASE + '/functions/v1/payment-webhook/' + provider, { method, headers: h, body: method === 'GET' ? undefined : raw }));
  };
  return { mod, db, logs, call, handle };
}
const read = async (r) => ({ status: r.status, body: await r.json() });

test('shared verify: hmacHex matches Node, timingSafeEqual compares whole strings', async () => {
  const v = await load('_shared/verify.js');
  assert.equal(await v.hmacHex('k', 'hello'), crypto.createHmac('sha256', 'k').update('hello').digest('hex'));
  assert.equal(await v.sha256Hex('a@b.co'), crypto.createHash('sha256').update('a@b.co').digest('hex'));
  assert.equal(v.timingSafeEqual('abc', 'abc'), true);
  assert.equal(v.timingSafeEqual('abc', 'abd'), false);
  assert.equal(v.timingSafeEqual('abc', 'abcd'), false);
  assert.equal(v.timingSafeEqual('', 'a'), false);
  assert.equal(v.timingSafeEqual(null, ''), true);
});

test('shared supabase: service key in apikey and Bearer, PostgREST message kept, network failure is status 0', async () => {
  const { createClient, SupabaseError, eq } = await load('_shared/supabase.js');
  const seen = [];
  const c = createClient({ url: URL_BASE + '/', serviceKey: SERVICE, fetch: async (u, i) => { seen.push({ u, i }); return new Response(JSON.stringify({ code: 'P0001', message: 'Duplicate provider reference' }), { status: 400 }); } });
  await assert.rejects(c.rpc('aal_mutate', { a: 1 }), (e) => e instanceof SupabaseError && e.status === 400 && e.message === 'Duplicate provider reference' && e.code === 'P0001');
  assert.equal(seen[0].u, URL_BASE + '/rest/v1/rpc/aal_mutate');
  assert.equal(seen[0].i.method, 'POST');
  assert.equal(seen[0].i.headers.apikey, SERVICE);
  assert.equal(seen[0].i.headers.Authorization, 'Bearer ' + SERVICE);
  assert.deepEqual(JSON.parse(seen[0].i.body), { a: 1 });
  const ok = createClient({ url: URL_BASE, serviceKey: SERVICE, fetch: async () => new Response(null, { status: 204 }) });
  assert.equal(await ok.rest('x', { method: 'PATCH', body: { a: 1 } }), null);
  const down = createClient({ url: URL_BASE, serviceKey: SERVICE, fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.rest('kv_rows'), (e) => e.status === 0);
  await assert.rejects(createClient({}).rest('kv_rows'), /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(eq('["kababji","hamra"]'), 'eq.' + encodeURIComponent('["kababji","hamra"]'));
});

test('a correctly signed paid callback confirms through confirm_digital with the service role, and is recorded', async () => {
  const t = await setup();
  const r = await read(await t.call(event()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'confirmed', paymentId: 'pay-1' });
  const m = t.db.rpcs('aal_mutate');
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].body, { p_rid: RID, p_op: 'confirm_digital', p_token: '', p_body: { id: 'pay-1', externalRef: 'fake-ref-1', amountCents: 2200, currency: 'USD' } });
  assert.equal(m[0].headers.Authorization, 'Bearer ' + SERVICE);
  assert.equal(t.db.row(RID, 'pay-1').status, 'confirmed');
  // the venue came from the payment lookup, by id alone
  const look = t.db.calls.find((c) => c.path === '/rest/v1/kv_rows');
  assert.match(look.search, /collection=eq\.aal\.settle/);
  assert.equal(new URLSearchParams(look.search).get('restaurant_id'), null);
  assert.equal(t.db.callbacks.length, 1);
  assert.deepEqual(t.db.callbacks[0], {
    provider: 'fake', external_ref: 'fake-ref-1', payment_id: 'pay-1', restaurant_id: RID, amount_cents: 2200, currency: 'USD',
    status: 'paid', occurred_at: '2026-09-30T18:00:00.000Z', outcome: 'confirmed', http_status: 200, server_reply: 'Confirmed',
  });
  // the provider sends it again: still 200 confirmed, a second row
  const again = await read(await t.call(event()));
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'confirmed');
  assert.equal(t.db.callbacks.length, 2);
});

test('a callback naming its restaurant is looked up at that venue only; a sha256= prefix is accepted', async () => {
  const t = await setup();
  const body = JSON.stringify(event({ restaurantId: RID }));
  const r = await t.call(body, { signature: 'sha256=' + sign(body) });
  assert.equal(r.status, 200);
  const look = t.db.calls.find((c) => c.path === '/rest/v1/kv_rows');
  assert.equal(new URLSearchParams(look.search).get('restaurant_id'), 'eq.' + RID);
});

test('a bad, missing or other-secret signature is 401 and reaches nothing', async () => {
  const t = await setup();
  const body = JSON.stringify(event());
  for (const signature of ['0'.repeat(64), null, sign(body, 'another-secret'), 'not hex', sign(body + ' ')]) {
    const r = await read(await t.call(body, { signature }));
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'Invalid signature' });
  }
  assert.equal(t.db.calls.length, 0);
  assert.equal(t.db.row(RID, 'pay-1').status, 'initiated');
  // a signature over different bytes of the "same" JSON is refused: the raw body is what is signed
  const spaced = JSON.stringify(event(), null, 2);
  assert.equal((await t.call(spaced, { signature: sign(body) })).status, 401);
});

test('with FAKE_WEBHOOK_SECRET unset the fake provider does not exist; unknown providers are 404; GET is 405', async () => {
  const t = await setup({ env: { FAKE_WEBHOOK_SECRET: '' } });
  assert.equal((await t.call(event())).status, 404);
  assert.equal((await t.call(event(), { provider: 'stripe' })).status, 404);
  assert.equal((await t.call(event(), { provider: '__proto__' })).status, 404);
  assert.equal((await t.call(event(), { provider: '' })).status, 404);
  const t2 = await setup();
  assert.equal((await t2.call(null, { method: 'GET' })).status, 405);
  assert.equal(t.db.calls.length + t2.db.calls.length, 0);
});

test('Duplicate provider reference is 200 idempotent and recorded', async () => {
  const t = await setup();
  t.db.put(RID, settleRow({ id: 'pay-0', status: 'confirmed', externalRef: 'fake-ref-1' }));
  const r = await read(await t.call(event()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'duplicate', idempotent: true, paymentId: 'pay-1' });
  assert.equal(t.db.row(RID, 'pay-1').status, 'initiated');
  assert.equal(t.db.callbacks.at(-1).outcome, 'duplicate');
  assert.equal(t.db.callbacks.at(-1).server_reply, 'Duplicate provider reference');
});

test('an expired reservation is 409 with the server sentence, and a callbacks row keeps it', async () => {
  const t = await setup();
  t.db.put(RID, settleRow({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const r = await read(await t.call(event()));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Reservation expired or changed; reconcile received funds');
  assert.equal(t.db.callbacks.length, 1);
  assert.deepEqual([t.db.callbacks[0].outcome, t.db.callbacks[0].http_status, t.db.callbacks[0].server_reply, t.db.callbacks[0].amount_cents, t.db.callbacks[0].external_ref],
    ['refused', 409, 'Reservation expired or changed; reconcile received funds', 2200, 'fake-ref-1']);
});

test('an amount or currency mismatch is 409 with the server sentence', async () => {
  const t = await setup();
  for (const over of [{ amountCents: 2000 }, { currency: 'LBP' }]) {
    const r = await read(await t.call(event(over)));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'Callback amount, currency or reference mismatch');
  }
  assert.equal(t.db.row(RID, 'pay-1').status, 'initiated');
  assert.equal(t.db.callbacks.length, 2);
});

test('failed releases an initiated payment, is a no-op once released, and is 409 for a confirmed one', async () => {
  const t = await setup();
  let r = await read(await t.call(event({ status: 'failed' })));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'failed', paymentId: 'pay-1' });
  const f = t.db.rpcs('aal_payment_failed');
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].body, { p_rid: RID, p_id: 'pay-1', p_external_ref: 'fake-ref-1' });
  assert.equal(t.db.row(RID, 'pay-1').status, 'failed');
  assert.equal(t.db.rpcs('aal_mutate').length, 0);
  r = await read(await t.call(event({ status: 'failed' })));
  assert.equal(r.status, 200);
  assert.equal(t.db.rpcs('aal_payment_failed').length, 1);     // not called again
  t.db.put(RID, settleRow({ id: 'pay-2', status: 'confirmed', externalRef: 'x' }));
  r = await read(await t.call(event({ status: 'failed', paymentId: 'pay-2' })));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /confirmed; reconcile/);
  assert.deepEqual(t.db.callbacks.map((c) => c.outcome), ['failed_released', 'failed_already', 'failed_conflict']);
});

test('refunded is recorded only, 202, and changes nothing', async () => {
  const t = await setup();
  t.db.put(RID, settleRow({ status: 'confirmed', externalRef: 'fake-ref-1' }));
  const r = await read(await t.call(event({ status: 'refunded' })));
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { status: 'recorded', paymentId: 'pay-1' });
  assert.equal(t.db.rpcs('aal_mutate').length + t.db.rpcs('aal_payment_failed').length, 0);
  assert.equal(t.db.row(RID, 'pay-1').status, 'confirmed');
  assert.equal(t.db.callbacks[0].outcome, 'refund_recorded');
  assert.equal(t.db.callbacks[0].status, 'refunded');
});

test('the fake provider never confirms at a venue with demo payments off', async () => {
  const t = await setup();
  t.db.put(OTHER, settleRow({ id: 'pay-live' }));
  const r = await read(await t.call(event({ paymentId: 'pay-live' })));
  assert.equal(r.status, 403);
  assert.match(r.body.error, /only confirms payments at venues with demo payments on/);
  assert.equal(t.db.rpcs('aal_mutate').length, 0);
  assert.equal(t.db.row(OTHER, 'pay-live').status, 'initiated');
  assert.equal(t.db.callbacks[0].outcome, 'refused_live_venue');
});

test('an unknown payment is 404, one id at two venues is 409, and both are recorded', async () => {
  const t = await setup();
  assert.equal((await t.call(event({ paymentId: 'nope' }))).status, 404);
  t.db.put(OTHER, settleRow());
  assert.equal((await t.call(event())).status, 409);
  assert.deepEqual(t.db.callbacks.map((c) => c.outcome), ['unknown_payment', 'ambiguous']);
});

test('a verified but unusable callback is 400 and recorded with the reason', async () => {
  const t = await setup();
  let r = await read(await t.call(event({ amountCents: '2200' })));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'amountCents must be a positive integer');
  r = await read(await t.call(event({ status: 'pending' })));
  assert.equal(r.status, 400);
  r = await read(await t.call('not json'));
  assert.equal(r.status, 400);
  assert.deepEqual(t.db.callbacks.map((c) => c.outcome), ['invalid', 'invalid', 'invalid']);
  assert.equal(t.db.rpcs('aal_mutate').length, 0);
});

test('whish answers 501 naming what is unknown and reads nothing', async () => {
  const t = await setup();
  const r = await read(await t.call(event(), { provider: 'whish', signature: 'anything' }));
  assert.equal(r.status, 501);
  assert.match(r.body.error, /^Whish callbacks are not connected yet/);
  assert.match(r.body.error, /signed/);
  assert.match(r.body.error, /body format/);
  assert.match(r.body.error, /status values/);
  assert.equal(t.db.calls.length, 0);
  const { whishAdapter } = t.mod;
  assert.equal(typeof whishAdapter.verify, 'function');
  assert.equal(typeof whishAdapter.parse, 'function');
});

test('a body over 64 kB is 413, by Content-Length or by counting, before any signature check', async () => {
  const t = await setup();
  const big = JSON.stringify(Object.assign(event(), { pad: 'x'.repeat(65 * 1024) }));
  assert.equal((await t.call(big)).status, 413);
  // a streamed body without Content-Length is counted
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 70; i++) c.enqueue(new Uint8Array(1024)); c.close(); } });
  const r = await t.handle(new Request(URL_BASE + '/functions/v1/payment-webhook/fake', { method: 'POST', body: stream, duplex: 'half', headers: { 'X-Signature': '0'.repeat(64) } }));
  assert.equal(r.status, 413);
  // exactly at the cap is read
  const { readCapped, MAX_BODY } = t.mod;
  const ok = await readCapped(new Request(URL_BASE, { method: 'POST', body: 'a'.repeat(MAX_BODY) }), MAX_BODY);
  assert.equal(ok.text.length, MAX_BODY);
  assert.equal(t.db.calls.length, 0);
});

test('callers are rate limited per address', async () => {
  const mod = await load('payment-webhook/handler.js');
  const t = await setup({ limiter: mod.createLimiter({ max: 2, windowMs: 60000 }) });
  assert.equal((await t.call(event())).status, 200);
  assert.equal((await t.call(event())).status, 200);
  const r = await t.call(event());
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  assert.equal((await t.call(event(), { headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 200);
});

test('if the callbacks row cannot be written the answer is 500, so the provider sends it again', async () => {
  const t = await setup();
  t.db.failCallbacks = true;
  assert.equal((await t.call(event())).status, 500);
  t.db.failCallbacks = false;
  const r = await read(await t.call(event()));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'confirmed');
  assert.equal(t.db.callbacks.length, 1);
});

test('a database outage is 500 and recorded when possible; logs never carry the body', async () => {
  const t = await setup({ dbDown: true });
  const body = JSON.stringify(event({ externalRef: 'body-marker-ref' }));
  assert.equal((await t.call(body)).status, 500);
  assert.equal(t.db.callbacks[0].outcome, 'error');
  await t.call(body, { signature: '0'.repeat(64) });
  assert.ok(t.logs.length >= 2);
  for (const line of t.logs) {
    assert.doesNotMatch(line, /body-marker-ref/);
    assert.doesNotMatch(line, /amountCents/);
  }
});

test('the Deno wrapper only wires the handler', () => {
  const src = require('node:fs').readFileSync(path.join(root, 'supabase', 'functions', 'payment-webhook', 'index.ts'), 'utf8');
  assert.match(src, /import \{ createHandler \} from '\.\/handler\.js'/);
  assert.match(src, /Deno\.serve\(createHandler\(/);
  assert.match(src, /verify_jwt false/);
});
