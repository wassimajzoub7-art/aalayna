/* 2026-11-24 payment leftovers: origins and rate limits of the payment functions.
   - payment-start accepts the production site only by default; plain http (localhost,
     127.0.0.1, a LAN address) only with PAYMENT_ALLOW_LOCAL_ORIGINS, whatever
     PAYMENT_RETURN_ORIGINS names; live answers no CORS to localhost;
   - the limiters key on an address the caller cannot forge (CF-Connecting-IP, else the last
     X-Forwarded-For entry), and a caller cycling made-up bill keys meets a per-address limit;
   - the limiter evicts oldest first, one key at a time: a flood of new keys cannot reset
     everyone's count at once (it used to clear the whole map past 10,000 keys). */
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const root = path.join(__dirname, '..');
const load = (rel) => import(path.join(root, 'supabase', 'functions', rel));
const FN = 'https://proj.supabase.co/functions/v1/payment-start';
const KEY = 'chk_' + 'ab'.repeat(24);

/* a PostgREST that knows one bill key, at a demo venue with no provider rows */
function db() {
  const res = (status, obj) => new Response(obj == null ? '' : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  return async (url, init = {}) => {
    const u = new URL(url), q = u.searchParams, val = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/rest/v1/check_keys') return res(200, val('key') === KEY ? [{ restaurant_id: 'r', check_id: 'c' }] : []);
    if (u.pathname === '/rest/v1/venue_profiles') return res(200, [{ demo_payments: true }]);
    if (u.pathname === '/rest/v1/rpc/aal_payment_provider') return res(200, null);
    if (u.pathname === '/rest/v1/kv_rows') return res(200, []);
    return res(404, { message: 'no route' });
  };
}
async function start(deps = {}) {
  const mod = await load('payment-start/handler.js');
  const env = Object.assign({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', FAKE_WEBHOOK_SECRET: 'f'.repeat(32) }, deps.env || {});
  return { mod, handle: mod.createHandler(Object.assign({ fetch: db(), log: { warn() {}, info() {} } }, deps, { env })) };
}

test('origins: production only by default; localhost and other plain http only with PAYMENT_ALLOW_LOCAL_ORIGINS', async () => {
  const mod = await load('payment-start/handler.js');
  const env = (o) => (k) => o[k];
  assert.deepEqual(mod.DEFAULT_ORIGINS, ['https://aalayna.com', 'https://www.aalayna.com']);
  for (const bad of ['http://127.0.0.1:8787/guest.html', 'http://localhost:8787/guest.html', 'http://aalayna.com/guest.html', 'http://192.168.1.20:8788/guest.html']) {
    assert.match(mod.cleanReturnUrl(bad, 'p1', env({})).error, /allowed origin/, bad);
    // named in the list is not enough on its own
    assert.match(mod.cleanReturnUrl(bad, 'p1', env({ PAYMENT_RETURN_ORIGINS: new URL(bad).origin + ',https://aalayna.com' })).error, /allowed origin/, bad);
  }
  assert.deepEqual(mod.allowedOrigins(env({ PAYMENT_RETURN_ORIGINS: 'http://localhost:8787, https://staging.example' })), ['https://staging.example']);
  // the opt-in: the local dev ports join the default; a named list is taken as it is
  for (const on of ['1', 'true', 'TRUE', ' yes ', 'on']) assert.deepEqual(mod.allowedOrigins(env({ PAYMENT_ALLOW_LOCAL_ORIGINS: on })), mod.DEFAULT_ORIGINS.concat(mod.LOCAL_ORIGINS), on);
  for (const off of [undefined, '', '0', 'false', 'no', 'localhost']) assert.deepEqual(mod.allowedOrigins(env({ PAYMENT_ALLOW_LOCAL_ORIGINS: off })), mod.DEFAULT_ORIGINS, String(off));
  assert.deepEqual(mod.allowedOrigins(env({ PAYMENT_ALLOW_LOCAL_ORIGINS: '1', PAYMENT_RETURN_ORIGINS: 'http://192.168.1.20:8788' })), ['http://192.168.1.20:8788']);
  assert.deepEqual(mod.cleanReturnUrl('http://localhost:8787/guest.html?k=chk_1', 'p1', env({ PAYMENT_ALLOW_LOCAL_ORIGINS: '1' })), { url: 'http://localhost:8787/guest.html?pay=p1' });
  // through the handler: no CORS for localhost on live, with the opt-in there is
  const live = await start();
  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787']) {
    let r = await live.handle(new Request(FN, { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, origin);
    r = await live.handle(new Request(FN, { headers: { Origin: origin, 'x-aalayna-key': KEY } }));
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, origin);
  }
  const local = await start({ env: { PAYMENT_ALLOW_LOCAL_ORIGINS: 'true' } });
  const r = await local.handle(new Request(FN, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8787' } }));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8787');
});

test('clientAddress: CF-Connecting-IP, else the last X-Forwarded-For entry, never one the caller wrote', async () => {
  const http = await load('_shared/http.js');
  const addr = (h) => http.clientAddress(new Request(FN, { headers: h }));
  assert.equal(addr({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.1' }), '198.51.100.7');
  // X-Forwarded-For is appended to: the caller writes the first entry, the platform the last
  assert.equal(addr({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), '198.51.100.7');
  assert.equal(addr({ 'x-forwarded-for': '1.2.3.4,2001:DB8::1' }), '2001:db8::1');
  assert.equal(addr({ 'x-forwarded-for': '198.51.100.7, not-an-ip' }), 'unknown');
  assert.equal(addr({ 'x-real-ip': '1.2.3.4' }), 'unknown');   // not documented for Edge Functions, not trusted
  assert.equal(addr({ 'cf-connecting-ip': 'evil|key' }), 'unknown');
  assert.equal(addr({}), 'unknown');
});

test('rate limits: rotating the first X-Forwarded-For entry or the bill key does not escape them', async () => {
  const http = await load('_shared/http.js');
  // the fake checkout's routes, per address
  const t = await start({ limiter: http.createLimiter({ max: 2, windowMs: 60000 }) });
  const page = (h) => t.handle(new Request(FN + '/fake/checkout?s=x', { headers: h }));
  assert.deepEqual([
    (await page({ 'x-forwarded-for': '10.0.0.1, 198.51.100.7' })).status,
    (await page({ 'x-forwarded-for': '10.0.0.2, 198.51.100.7' })).status,
    (await page({ 'x-forwarded-for': '10.0.0.3, 198.51.100.7' })).status,
  ], [404, 404, 429]);
  assert.deepEqual([
    (await page({ 'cf-connecting-ip': '198.51.100.8', 'x-forwarded-for': '10.0.0.4' })).status,
    (await page({ 'cf-connecting-ip': '198.51.100.8', 'x-forwarded-for': '10.0.0.5' })).status,
    (await page({ 'cf-connecting-ip': '198.51.100.8', 'x-forwarded-for': '10.0.0.6' })).status,
  ], [404, 404, 429]);
  // made-up bill keys, each under its own per-key limit, still meet the per-address one
  const u = await start({ addressLimiter: http.createLimiter({ max: 3, windowMs: 60000 }) });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await u.handle(new Request(FN, { headers: { 'x-aalayna-key': 'chk_' + String(i).repeat(24), 'cf-connecting-ip': '198.51.100.9' } }))).status);
  assert.deepEqual(codes, [404, 404, 404, 429, 429]);
  assert.equal((await u.handle(new Request(FN, { headers: { 'x-aalayna-key': KEY, 'cf-connecting-ip': '198.51.100.10' } }))).status, 200);   // another caller is not held
  // the default per-address limit is far above one phone's per-key limit
  assert.ok(t.mod.ADDRESS_LIMIT.max >= 4 * t.mod.RATE_LIMIT.max);
  // payment-webhook: per address, the caller's own first entry does not matter
  const hook = await load('payment-webhook/handler.js');
  const w = hook.createHandler({ env: { FAKE_WEBHOOK_SECRET: 'f'.repeat(32) }, limiter: http.createLimiter({ max: 1, windowMs: 60000 }), log: { warn() {}, info() {} } });
  const cb = (first) => w(new Request('https://proj.supabase.co/functions/v1/payment-webhook/fake', { method: 'POST', headers: { 'x-forwarded-for': first + ', 198.51.100.11' }, body: '{}' }));
  assert.equal((await cb('10.1.1.1')).status, 401);   // through the limit, refused at the signature
  assert.equal((await cb('10.1.1.2')).status, 429);
});

test('the limiter evicts oldest first: a flood of new keys cannot reset everyone at once', async () => {
  const http = await load('_shared/http.js');
  const lim = http.createLimiter({ max: 2, windowMs: 60000, maxKeys: 100 });
  const t0 = 1e12;
  lim.take('flood-0', t0);
  assert.equal(lim.take('victim', t0), true);
  assert.equal(lim.take('victim', t0), true);
  assert.equal(lim.take('victim', t0), false);
  // fill the map to the brim: the victim is still held
  for (let i = 1; i < 99; i++) lim.take('flood-' + i, t0 + 1);
  assert.equal(lim.size(), 100);
  assert.equal(lim.take('victim', t0 + 2), false);
  // one more key drops one key, the oldest window (flood-0), never the whole map
  lim.take('flood-new', t0 + 3);
  assert.equal(lim.size(), 100);
  assert.equal(lim.take('victim', t0 + 4), false, 'still held');
  assert.equal(lim.take('flood-1', t0 + 5), true);   // later keys keep their counts (flood-1 had 1)
  assert.equal(lim.take('flood-1', t0 + 5), false);
  // windows that ended go first, before any live count
  const l2 = http.createLimiter({ max: 1, windowMs: 1000, maxKeys: 3 });
  l2.take('a', 0); l2.take('b', 10); l2.take('c', 2000);   // a and b ended: both dropped
  assert.equal(l2.size(), 1);
  l2.take('d', 2001); l2.take('e', 2002);
  assert.equal(l2.take('c', 2003), false, 'c still counted');
  l2.take('f', 2004);   // full: c (the oldest window) goes, d and e stay
  assert.equal(l2.take('d', 2005), false);
  assert.equal(l2.take('e', 2005), false);
  assert.equal(l2.take('c', 2006), true, 'c was the one evicted');
  // a key whose window restarts moves to the back of the line
  const l3 = http.createLimiter({ max: 1, windowMs: 100, maxKeys: 2 });
  l3.take('x', 0); l3.take('y', 50); l3.take('x', 120);   // x restarts at 120, after y
  l3.take('z', 130);   // y (from 50) is still live, the map is full: y, now the oldest window, goes
  assert.equal(l3.take('x', 131), false, 'x kept its new window');
  assert.equal(l3.take('y', 132), true, 'y was the one evicted');
  // the default is 10,000 keys, and a flood past it never empties the map
  const l4 = http.createLimiter({ max: 1, windowMs: 60000 });
  l4.take('victim', 0);
  for (let i = 0; i < 10500; i++) l4.take('k' + i, 1);
  assert.equal(l4.size(), http.LIMITER_MAX_KEYS);
  assert.equal(l4.take('k10499', 2), false);
});
