/* Hosted payment pages (T15): supabase/functions/payment-start/handler.js, run in Node against
   a fake PostgREST holding check_keys, payment_secrets, kv_rows (aal.settle), venue_profiles,
   payment_providers (through aal_payment_provider) and payment_sessions, with the real
   payment-webhook handler wired behind /functions/v1/payment-webhook/fake so the fake
   provider's Pay button confirms through confirm_digital's rules. Proves that:
   - GET lists the rails a bill may pay: the fake provider for every rail at a venue with demo
     payments on, a configured provider row first, nothing at a live venue without rows, and
     nothing without FAKE_WEBHOOK_SECRET; the bill key is the only credential;
   - POST checks the bill key, the payer token (SHA-256 against payment_secrets, 401), that the
     payment is this bill's (404), a digital rail (400), 'initiated' (409 with the status) and
     not expired (409), and that returnUrl is on an allowed origin (400); it strips k, s, reset
     and pay from returnUrl and adds pay=<id>; every handoff is a payment_sessions row;
   - the fake checkout page shows the amount and the venue, refuses a tampered or expired token,
     and on Pay posts a correctly signed callback to payment-webhook/fake (the payment becomes
     confirmed), then sends the browser back (303) to returnUrl; Decline releases the payment;
     a webhook that cannot be reached shows the guest a way back and confirms nothing;
   - whish answers 501 naming what is unknown; a row naming an adapter this server lacks is 409;
   - CORS: an allowed origin gets the headers and the preflight; another origin gets none;
   - bodies over 8 kB are 413; callers are rate limited; no payer token or secret is logged. */
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const load = (rel) => import(path.join(root, 'supabase', 'functions', rel));

const RID = JSON.stringify(['mayda', 'hamra']), LIVE = JSON.stringify(['kababji', 'hamra']);
const SECRET = 'test-fake-secret-' + 'x'.repeat(16);
const SERVICE = 'test-service-role';
const URL_BASE = 'https://proj.supabase.co';
const FN = URL_BASE + '/functions/v1/payment-start';
const KEY = 'chk_' + 'ab'.repeat(24), KEY_LIVE = 'chk_' + 'cd'.repeat(24);
const TOKEN = 'payer-token-' + 'p'.repeat(40);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const future = (min = 5) => new Date(Date.now() + min * 60000).toISOString();
const RETURN = 'https://aalayna.com/guest.html?venue=Mayda&place=Hamra&live=1&k=chk_secret&s=tbl_1';

/* the fake PostgREST, with confirm_digital's and aal_payment_failed's rules */
function fakeDb(o = {}) {
  const s = {
    calls: [], sessions: [], callbacks: [], failSessions: false,
    keys: new Map([[KEY, { restaurant_id: RID, check_id: 'bill-7' }], [KEY_LIVE, { restaurant_id: LIVE, check_id: 'bill-9' }]]),
    secrets: new Map(), settle: new Map(), providers: new Map(),
    profiles: new Map([[RID, { demo_payments: true }], [LIVE, { demo_payments: false }]]),
  };
  s.put = (rid, body, token = TOKEN) => { s.settle.set(rid + '|' + body.id, { restaurant_id: rid, body }); s.secrets.set(rid + '|' + body.id, sha(token)); };
  s.row = (rid, id) => (s.settle.get(rid + '|' + id) || {}).body;
  const res = (status, obj) => new Response(obj == null ? '' : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const refuse = (message) => res(400, { code: 'P0001', message, details: null, hint: null });
  s.fetch = async (url, init = {}) => {
    const u = new URL(url), q = u.searchParams, h = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : null;
    s.calls.push({ path: u.pathname, search: u.search, method: init.method || 'GET', headers: h, body });
    if (h.Authorization !== 'Bearer ' + SERVICE || h.apikey !== SERVICE) return res(401, { message: 'bad key' });
    const val = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/rest/v1/check_keys') { const k = s.keys.get(val('key')); return res(200, k ? [k] : []); }
    if (u.pathname === '/rest/v1/kv_rows' && init.method === 'GET') {
      if (o.dbDown) return res(503, { message: 'down' });
      return res(200, [...s.settle.values()].filter((r) => val('collection') === 'aal.settle' && r.body.id === val('id') && (!q.get('restaurant_id') || r.restaurant_id === val('restaurant_id'))).map((r) => ({ restaurant_id: r.restaurant_id, body: r.body })));
    }
    if (u.pathname === '/rest/v1/payment_secrets') { const t = s.secrets.get(val('restaurant_id') + '|' + val('payment_id')); return res(200, t ? [{ token_hash: t }] : []); }
    if (u.pathname === '/rest/v1/venue_profiles') { const p = s.profiles.get(val('restaurant_id')); return res(200, p ? [p] : []); }
    if (u.pathname === '/rest/v1/payment_sessions') { if (s.failSessions) return res(500, { message: 'insert failed' }); s.sessions.push(body); return res(201, null); }
    if (u.pathname === '/rest/v1/payment_callbacks') { s.callbacks.push(body); return res(201, null); }
    if (u.pathname === '/rest/v1/rpc/aal_payment_provider') { const p = s.providers.get(body.p_rid + '|' + body.p_rail); return res(200, p ? Object.assign({ rail: body.p_rail, config: {}, secret: null }, p) : null); }
    if (u.pathname === '/rest/v1/rpc/aal_mutate') {
      const { p_rid, p_op, p_body } = body;
      if (p_op !== 'confirm_digital') return refuse('Unknown operation');
      const p = s.row(p_rid, p_body.id);
      if (!p) return refuse('Payment unavailable');
      if (p.externalRef === p_body.externalRef && p.status === 'confirmed') return res(200, p);
      if (p.status !== 'initiated' || Date.parse(p.expiresAt) <= Date.now()) return refuse('Reservation expired or changed; reconcile received funds');
      if (!p_body.externalRef || p_body.currency !== p.currency || p_body.amountCents !== Math.round(p.amount * 100)) return refuse('Callback amount, currency or reference mismatch');
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
  return s;
}

const settleRow = (over = {}) => Object.assign({ id: 'pay-1', requestId: 'pay-1', checkId: 'bill-7', table: 7, rail: 'card', amount: 22, tip: 2, currency: 'USD', amountUsd: 22, status: 'initiated', expiresAt: future() }, over);

async function setup(o = {}) {
  const mod = await load('payment-start/handler.js');
  const hook = await load('payment-webhook/handler.js');
  const db = fakeDb(o);
  db.put(RID, settleRow());
  const logs = [];
  const log = { warn: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')) };
  const env = Object.assign({ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: SERVICE, FAKE_WEBHOOK_SECRET: SECRET }, o.env || {});
  const webhook = hook.createHandler({ fetch: db.fetch, env, log });
  const state = { webhookDown: false, webhookCalls: [] };
  // the fake provider's Pay posts to the sibling function over HTTP: here, the real handler
  const fetch = async (url, init) => {
    if (String(url).startsWith(URL_BASE + '/functions/v1/payment-webhook/')) {
      state.webhookCalls.push({ url: String(url), init });
      if (state.webhookDown) throw new TypeError('fetch failed');
      return webhook(new Request(url, init));
    }
    return db.fetch(url, init);
  };
  const handle = mod.createHandler({ fetch, env, log, limiter: o.limiter });
  const req = (method, { path = '', key = KEY, token = TOKEN, body, headers = {}, origin = 'https://aalayna.com' } = {}) => {
    const h = Object.assign({ 'x-forwarded-for': '203.0.113.9' }, headers);
    if (key !== null) h['x-aalayna-key'] = key;
    if (token !== null && method === 'POST' && !path) h['x-aalayna-payer'] = token;
    if (origin) h.Origin = origin;
    let raw;
    if (body !== undefined) { raw = typeof body === 'string' ? body : JSON.stringify(body); if (!h['Content-Type']) h['Content-Type'] = 'application/json'; }
    return handle(new Request(FN + path, { method, headers: h, body: raw }));
  };
  const start = (over = {}) => req('POST', Object.assign({ body: { paymentId: 'pay-1', returnUrl: RETURN } }, over));
  return { mod, db, logs, env, handle, req, start, state };
}
const read = async (r) => ({ status: r.status, body: await r.json(), headers: r.headers });

test('GET: the fake provider takes every rail at a demo venue; a live venue without rows offers nothing; the key is the credential', async () => {
  const t = await setup();
  let r = await read(await t.req('GET'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { rails: { card: 'fake', whish: 'fake' } });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://aalayna.com');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  r = await read(await t.req('GET', { key: KEY_LIVE }));
  assert.deepEqual(r.body, { rails: {} });
  r = await read(await t.req('GET', { key: null }));
  assert.equal(r.status, 400);
  r = await read(await t.req('GET', { key: 'own_' + 'ab'.repeat(12) }));
  assert.equal(r.status, 400);
  r = await read(await t.req('GET', { key: 'chk_' + 'ef'.repeat(24) }));
  assert.equal(r.status, 404);
  // the bill key goes to check_keys; the service role is the database credential
  const look = t.db.calls.find((c) => c.path === '/rest/v1/check_keys');
  assert.equal(new URLSearchParams(look.search).get('key'), 'eq.' + KEY);
  assert.equal(look.headers.Authorization, 'Bearer ' + SERVICE);
});

test('GET: a provider row wins over the fake; without FAKE_WEBHOOK_SECRET the fake does not exist; an unknown adapter is left out', async () => {
  const t = await setup();
  t.db.providers.set(RID + '|whish', { provider: 'whish' });
  let r = await read(await t.req('GET'));
  assert.deepEqual(r.body, { rails: { card: 'fake', whish: 'whish' } });
  t.db.providers.set(RID + '|card', { provider: 'mpgs' });
  r = await read(await t.req('GET'));
  assert.deepEqual(r.body, { rails: { whish: 'whish' } });
  const u = await setup({ env: { FAKE_WEBHOOK_SECRET: '' } });
  r = await read(await u.req('GET'));
  assert.deepEqual(r.body, { rails: {} });
  u.db.providers.set(RID + '|card', { provider: 'whish' });   // Whish Collect may take cards too
  r = await read(await u.req('GET'));
  assert.deepEqual(r.body, { rails: { card: 'whish' } });
});

test('POST: a reserved card payment gets the fake checkout page; returnUrl is cleaned and pay= added; the handoff is a payment_sessions row', async () => {
  const t = await setup();
  const r = await read(await t.start());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.provider, 'fake');
  assert.match(r.body.url, new RegExp('^' + FN.replace(/[.]/g, '\\.') + '/fake/checkout\\?s=[A-Za-z0-9_%.-]+$'));
  assert.equal(r.body.expiresAt, new Date(t.db.row(RID, 'pay-1').expiresAt).toISOString());
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://aalayna.com');
  assert.equal(t.db.sessions.length, 1);
  const s = t.db.sessions[0];
  assert.deepEqual([s.restaurant_id, s.payment_id, s.provider, s.rail, s.amount_cents, s.currency], [RID, 'pay-1', 'fake', 'card', 2200, 'USD']);
  assert.match(s.provider_ref, /^fake-session-[0-9a-f]{16}$/);
  assert.equal(s.return_url, 'https://aalayna.com/guest.html?venue=Mayda&place=Hamra&live=1&pay=pay-1');
  // the token carries the cleaned return URL and the reservation's expiry, signed with the secret
  const token = decodeURIComponent(new URL(r.body.url).searchParams.get('s'));
  const p = await t.mod.readCheckoutToken(token, SECRET, crypto.webcrypto, Date.now());
  assert.deepEqual([p.rid, p.pid, p.c, p.cur, p.rail, p.ret], [RID, 'pay-1', 2200, 'USD', 'card', s.return_url]);
  assert.equal(p.exp, Date.parse(t.db.row(RID, 'pay-1').expiresAt));
  assert.equal(await t.mod.readCheckoutToken(token, 'another-secret', crypto.webcrypto, Date.now()), null);
  assert.equal(await t.mod.readCheckoutToken(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), SECRET, crypto.webcrypto, Date.now()), null);
  // the payer token travelled as a header and was hashed, never logged
  const sec = t.db.calls.find((c) => c.path === '/rest/v1/payment_secrets');
  assert.equal(new URLSearchParams(sec.search).get('payment_id'), 'eq.pay-1');
  assert.ok(!t.logs.join('\n').includes(TOKEN) && !t.logs.join('\n').includes(SECRET));
});

test('POST: wrong payer token 401, another bill\'s payment 404, cash 400, confirmed or cancelled 409 with the status, expired 409, bad return URL 400', async () => {
  const t = await setup();
  let r = await read(await t.start({ token: 'not-the-token-' + 'n'.repeat(30) }));
  assert.equal(r.status, 401);
  assert.equal(t.db.sessions.length, 0);
  r = await read(await t.start({ token: 'short' }));
  assert.equal(r.status, 400);
  r = await read(await t.start({ key: KEY_LIVE }));   // a real key, but pay-1 is bill-7's
  assert.equal(r.status, 404);
  r = await read(await t.start({ body: { paymentId: 'pay-x', returnUrl: RETURN } }));
  assert.equal(r.status, 404);
  t.db.put(RID, settleRow({ id: 'cash-1', rail: 'cash', status: 'pending', expiresAt: null }));
  r = await read(await t.start({ body: { paymentId: 'cash-1', returnUrl: RETURN } }));
  assert.equal(r.status, 400);
  t.db.put(RID, settleRow({ id: 'done-1', status: 'confirmed' }));
  r = await read(await t.start({ body: { paymentId: 'done-1', returnUrl: RETURN } }));
  assert.equal(r.status, 409);
  assert.equal(r.body.status, 'confirmed');
  t.db.put(RID, settleRow({ id: 'gone-1', status: 'cancelled' }));
  r = await read(await t.start({ body: { paymentId: 'gone-1', returnUrl: RETURN } }));
  assert.deepEqual([r.status, r.body.status], [409, 'cancelled']);
  t.db.put(RID, settleRow({ id: 'old-1', expiresAt: new Date(Date.now() - 1000).toISOString() }));
  r = await read(await t.start({ body: { paymentId: 'old-1', returnUrl: RETURN } }));
  assert.deepEqual([r.status, r.body.status], [409, 'expired']);
  for (const bad of ['https://evil.example/guest.html', 'guest.html?venue=Mayda', 'javascript:alert(1)', '', 42]) {
    r = await read(await t.start({ body: { paymentId: 'pay-1', returnUrl: bad } }));
    assert.equal(r.status, 400, String(bad));
  }
  r = await read(await t.start({ body: 'not json' }));
  assert.equal(r.status, 400);
  r = await read(await t.start({ body: { returnUrl: RETURN } }));
  assert.equal(r.status, 400);
  assert.equal(t.db.sessions.length, 0);
  // PAYMENT_RETURN_ORIGINS replaces the default list
  const u = await setup({ env: { PAYMENT_RETURN_ORIGINS: 'https://staging.example' } });
  r = await read(await u.start());
  assert.equal(r.status, 400);
  r = await read(await u.start({ body: { paymentId: 'pay-1', returnUrl: 'https://staging.example/guest.html?live=1' }, origin: 'https://staging.example' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://staging.example');
});

test('POST: no provider at a live venue is 409; whish is 501 naming what is unknown; a row naming a missing adapter is 409; a session row that cannot be written is 500', async () => {
  const t = await setup();
  t.db.put(LIVE, settleRow({ id: 'pay-9', checkId: 'bill-9' }));
  let r = await read(await t.start({ key: KEY_LIVE, body: { paymentId: 'pay-9', returnUrl: RETURN } }));
  assert.deepEqual([r.status, r.body.status], [409, 'no_provider']);
  t.db.providers.set(LIVE + '|card', { provider: 'whish', config: { merchant: 'kababji' }, secret: 'whish-secret' });
  r = await read(await t.start({ key: KEY_LIVE, body: { paymentId: 'pay-9', returnUrl: RETURN } }));
  assert.equal(r.status, 501);
  assert.match(r.body.error, /^Whish checkout is not connected yet/);
  assert.ok(!t.logs.join('\n').includes('whish-secret'));
  t.db.providers.set(LIVE + '|card', { provider: 'mpgs' });
  r = await read(await t.start({ key: KEY_LIVE, body: { paymentId: 'pay-9', returnUrl: RETURN } }));
  assert.deepEqual([r.status, r.body.status], [409, 'no_provider']);
  assert.equal(t.db.sessions.length, 0);
  t.db.failSessions = true;
  r = await read(await t.start());
  assert.equal(r.status, 500);
});

test('the fake checkout page: shows the amount and the venue; Pay signs a callback to payment-webhook/fake, the payment is confirmed, and the browser goes back with pay=', async () => {
  const t = await setup();
  const { body: started } = await read(await t.start());
  const u = new URL(started.url), token = decodeURIComponent(u.searchParams.get('s'));
  let page = await t.handle(new Request(started.url, { method: 'GET' }));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type'), /^text\/html/);
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  const html = await page.text();
  assert.match(html, /Pay <b>\$22\.00<\/b> to Mayda/);
  assert.match(html, /Reference pay-1/);
  assert.match(html, /name="outcome" value="paid"/);
  assert.match(html, /name="outcome" value="failed"/);
  assert.match(html, /No money moves/);
  assert.ok(html.includes('value="' + token.replace(/&/g, '&amp;') + '"'));
  // a tampered or foreign token has no page
  page = await t.handle(new Request(FN + '/fake/checkout?s=' + encodeURIComponent(token.slice(0, -2) + 'zz'), { method: 'GET' }));
  assert.equal(page.status, 404);
  page = await t.handle(new Request(FN + '/fake/checkout', { method: 'GET' }));
  assert.equal(page.status, 404);
  // Pay
  const form = new URLSearchParams({ s: token, outcome: 'paid' }).toString();
  const back = await t.handle(new Request(FN + '/fake/checkout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }));
  assert.equal(back.status, 303);
  assert.equal(back.headers.get('Location'), 'https://aalayna.com/guest.html?venue=Mayda&place=Hamra&live=1&pay=pay-1');
  assert.equal(t.state.webhookCalls.length, 1);
  const call = t.state.webhookCalls[0];
  assert.equal(call.url, URL_BASE + '/functions/v1/payment-webhook/fake');
  const event = JSON.parse(call.init.body);
  assert.deepEqual([event.paymentId, event.restaurantId, event.amountCents, event.currency, event.status], ['pay-1', RID, 2200, 'USD', 'paid']);
  assert.match(event.externalRef, /^fake-pay-1-[0-9a-f]{16}$/);
  assert.equal(call.init.headers['X-Signature'], crypto.createHmac('sha256', SECRET).update(call.init.body).digest('hex'));
  assert.equal(t.db.row(RID, 'pay-1').status, 'confirmed');
  assert.equal(t.db.row(RID, 'pay-1').externalRef, event.externalRef);
  assert.equal(t.db.callbacks.length, 1);
  assert.equal(t.db.callbacks[0].outcome, 'confirmed');
  // Pay again on the same page: the same reference, still 200 at the webhook, still sent back
  const again = await t.handle(new Request(FN + '/fake/checkout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }));
  assert.equal(again.status, 303);
  assert.equal(t.db.callbacks[1].outcome, 'confirmed');
});

test('the fake checkout page: Decline releases the payment; an unreachable webhook confirms nothing and offers the way back; an expired token has no page', async () => {
  const t = await setup();
  const { body: started } = await read(await t.start());
  const token = decodeURIComponent(new URL(started.url).searchParams.get('s'));
  const post = (outcome) => t.handle(new Request(FN + '/fake/checkout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ s: token, outcome }).toString() }));
  t.state.webhookDown = true;
  let r = await post('paid');
  assert.equal(r.status, 502);
  const html = await r.text();
  assert.match(html, /could not be reported to Aalayna/);
  assert.match(html, /href="https:\/\/aalayna\.com\/guest\.html\?venue=Mayda&amp;place=Hamra&amp;live=1&amp;pay=pay-1"/);
  assert.equal(t.db.row(RID, 'pay-1').status, 'initiated');
  t.state.webhookDown = false;
  r = await post('failed');
  assert.equal(r.status, 303);
  assert.equal(t.db.row(RID, 'pay-1').status, 'failed');
  assert.equal(t.db.callbacks[0].outcome, 'failed_released');
  // an expired reservation: the token expires with it
  t.db.put(RID, settleRow({ id: 'pay-2', expiresAt: new Date(Date.now() + 1000).toISOString() }));
  const { body: s2 } = await read(await t.start({ body: { paymentId: 'pay-2', returnUrl: RETURN } }));
  const t2 = decodeURIComponent(new URL(s2.url).searchParams.get('s'));
  const later = t.mod.createHandler({ fetch: t.db.fetch, env: t.env, now: () => new Date(Date.now() + 5000), log: { warn() {}, info() {} } });
  r = await later(new Request(s2.url, { method: 'GET' }));
  assert.equal(r.status, 404);
  r = await later(new Request(FN + '/fake/checkout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ s: t2, outcome: 'paid' }).toString() }));
  assert.equal(r.status, 404);
  assert.equal(t.db.row(RID, 'pay-2').status, 'initiated');
  // no such page without the secret, and no other provider has pages
  const u = await setup({ env: { FAKE_WEBHOOK_SECRET: '' } });
  r = await u.handle(new Request(FN + '/fake/checkout?s=x', { method: 'GET' }));
  assert.equal(r.status, 404);
  r = await t.handle(new Request(FN + '/whish/checkout', { method: 'GET' }));
  assert.equal(r.status, 404);
  r = await t.handle(new Request(FN + '/fake/checkout', { method: 'DELETE' }));
  assert.equal(r.status, 405);
});

test('CORS, method, size and rate limits', async () => {
  const t = await setup();
  let r = await t.handle(new Request(FN, { method: 'OPTIONS', headers: { Origin: 'https://aalayna.com', 'Access-Control-Request-Method': 'POST' } }));
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://aalayna.com');
  assert.equal(r.headers.get('Access-Control-Allow-Headers'), 'content-type, x-aalayna-key, x-aalayna-payer');
  assert.equal(r.headers.get('Vary'), 'Origin');
  r = await t.handle(new Request(FN, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  r = await read(await t.req('GET', { origin: 'https://evil.example' }));
  assert.equal(r.status, 200);   // the function answers; the browser withholds the answer
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  r = await read(await t.req('GET', { origin: 'http://127.0.0.1:8787' }));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8787');
  r = await read(await t.req('DELETE'));
  assert.equal(r.status, 405);
  r = await read(await t.start({ body: JSON.stringify({ paymentId: 'pay-1', returnUrl: RETURN, pad: 'x'.repeat(9000) }) }));
  assert.equal(r.status, 413);
  const u = await setup({ limiter: t.mod.createHandler && (await load('_shared/http.js')).createLimiter({ max: 2, windowMs: 60000 }) });
  assert.equal((await u.req('GET')).status, 200);
  assert.equal((await u.req('GET')).status, 200);
  r = await read(await u.req('GET'));
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
  // the database down is 500, nothing created
  const d = await setup({ dbDown: true });
  r = await read(await d.start());
  assert.equal(r.status, 500);
  assert.equal(d.db.sessions.length, 0);
});

test('helpers: routes, self base, return URL cleaning, base64url round trip', async () => {
  const mod = await load('payment-start/handler.js');
  const http = await load('_shared/http.js');
  assert.deepEqual(mod.routeFrom('/functions/v1/payment-start'), []);
  assert.deepEqual(mod.routeFrom('/functions/v1/payment-start/Fake/Checkout'), ['fake', 'checkout']);
  assert.deepEqual(mod.routeFrom('/other'), []);
  assert.equal(mod.selfBaseFrom('https://proj.supabase.co/functions/v1/payment-start/fake/checkout?s=1'), FN);
  assert.equal(mod.selfBaseFrom('http://127.0.0.1:9000/functions/v1/payment-start'), 'http://127.0.0.1:9000/functions/v1/payment-start');
  const env = (k) => ({})[k];
  assert.deepEqual(mod.cleanReturnUrl('https://aalayna.com/guest.html?k=chk_1&venue=M&pay=old&reset=1&s=tbl#x', 'p9', env), { url: 'https://aalayna.com/guest.html?venue=M&pay=p9' });
  assert.deepEqual(mod.cleanReturnUrl('https://aalayna.com/guest.html', 'p9', env), { url: 'https://aalayna.com/guest.html?pay=p9' });
  assert.match(mod.cleanReturnUrl('https://aalayna.com.evil.example/g', 'p9', env).error, /allowed origin/);
  assert.deepEqual(mod.allowedOrigins(env), mod.DEFAULT_ORIGINS);
  assert.deepEqual(mod.allowedOrigins((k) => ({ PAYMENT_RETURN_ORIGINS: ' https://a.example/, https://b.example ' })[k]), ['https://a.example', 'https://b.example']);
  for (const s of ['plain', '["مايدا","Hamra"]', 'a+b/c=', '']) assert.equal(http.unb64u(http.b64u(s)), s);
  assert.doesNotMatch(http.b64u('a+b/c='), /[+/=]/);
});
