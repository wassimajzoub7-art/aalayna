/* Connecting a payment provider from admin.html: the two routes payment-start gained
   (supabase/functions/payment-start/handler.js), run in Node against a fake PostgREST that
   answers aal_admin_key_valid and aal_payment_provider. Proves that:
   - GET /payment-start/providers lists every adapter with label, rails, fields and ready, and
     nothing else: no function, no secret, no venue; fake is ready only with
     FAKE_WEBHOOK_SECRET, Whish never (not built); it needs no key, answers CORS for allowed
     origins only, and is rate limited per address;
   - POST /payment-start/admin/check needs an admin key: a missing or malformed header is
     refused before the database is asked, a well-formed key the database does not know is
     refused (401) and nothing else is read; the key is checked with the service role;
   - with a valid key it reads the row through aal_payment_provider and runs the adapter's
     check: fake answers ok, Whish 501 naming what is unknown, no row 404, an adapter the
     server lacks 409, a check that throws 502; a secret an adapter echoes is cut out;
   - no answer to either route ever carries the secret or the admin key;
   - the admin check is rate limited per address before any key lookup; bad bodies are 400. */
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const root = path.join(__dirname, '..');
const load = () => import(path.join(root, 'supabase', 'functions', 'payment-start', 'handler.js'));

const RID = JSON.stringify(['mayda', 'hamra']);
const SERVICE = 'test-service-role';
const URL_BASE = 'https://proj.supabase.co';
const FN = URL_BASE + '/functions/v1/payment-start';
const ADMIN = 'adm_' + '0a'.repeat(12);
const SECRET = '{"apiKey":"live-secret-value-9999"}';

function fakeDb() {
  const s = { calls: [], providers: new Map(), keys: new Set([ADMIN]) };
  const res = (status, obj) => new Response(obj == null ? 'null' : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  s.fetch = async (url, init = {}) => {
    const u = new URL(url), h = init.headers || {}, body = init.body ? JSON.parse(init.body) : null;
    s.calls.push({ path: u.pathname, body, auth: h.Authorization });
    if (h.Authorization !== 'Bearer ' + SERVICE || h.apikey !== SERVICE) return res(401, { message: 'bad key' });
    if (u.pathname === '/rest/v1/rpc/aal_admin_key_valid') return res(200, s.keys.has(body.p_key));
    if (u.pathname === '/rest/v1/rpc/aal_payment_provider') { const p = s.providers.get(body.p_rid + '|' + body.p_rail); return res(200, p || null); }
    return res(404, { message: 'no route ' + u.pathname });
  };
  return s;
}

async function setup(o = {}) {
  const mod = await load();
  const db = fakeDb();
  const logs = [];
  const log = { warn: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')) };
  const env = Object.assign({ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: SERVICE, FAKE_WEBHOOK_SECRET: 'fake-secret-' + 'x'.repeat(20) }, o.env || {});
  const handle = mod.createHandler({ fetch: db.fetch, env, log, adapters: o.adapters, adminLimiter: o.adminLimiter, limiter: o.limiter });
  const seen = [];
  const call = async (method, p, { body, admin = ADMIN, origin = 'https://aalayna.com', ip = '203.0.113.9' } = {}) => {
    const h = { 'x-forwarded-for': ip };
    if (admin !== null) h['x-aalayna-admin'] = admin;
    if (origin) h.Origin = origin;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await handle(new Request(FN + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));
    const text = await r.text();
    seen.push(text);
    let j = null; try { j = JSON.parse(text); } catch (_) { j = null; }
    return { status: r.status, body: j, headers: r.headers, text };
  };
  const check = (body, opts) => call('POST', '/admin/check', Object.assign({ body }, opts || {}));
  return { mod, db, logs, env, call, check, seen };
}

test('GET /providers: every adapter described, nothing secret or venue-specific, ready as the server is', async () => {
  const t = await setup();
  const r = await t.call('GET', '/providers', { admin: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://aalayna.com');
  assert.deepEqual(r.body.providers.map((p) => p.name), ['fake', 'whish']);
  const [fake, whish] = r.body.providers;
  assert.deepEqual(fake, { name: 'fake', label: 'Demo provider (no money moves)', rails: ['card', 'whish'], fields: [], ready: true });
  assert.equal(whish.label, 'Whish Money');
  assert.deepEqual(whish.rails, ['whish']);
  assert.equal(whish.ready, false, 'Whish is not built yet');
  assert.deepEqual(whish.fields.map((f) => [f.key, f.kind, f.required]), [['merchant', 'text', true], ['apiKey', 'secret', true]]);
  for (const f of whish.fields) assert.deepEqual(Object.keys(f).sort(), ['hint', 'key', 'kind', 'label', 'required']);
  for (const p of r.body.providers) assert.deepEqual(Object.keys(p).sort(), ['fields', 'label', 'name', 'rails', 'ready']);
  assert.doesNotMatch(r.text, /fake-secret|service|restaurant|mayda/i);
  assert.equal(t.db.calls.length, 0, 'no database call');
  // without FAKE_WEBHOOK_SECRET the fake provider is listed, not ready
  const t2 = await setup({ env: { FAKE_WEBHOOK_SECRET: '' } });
  assert.equal((await t2.call('GET', '/providers')).body.providers[0].ready, false);
  // another origin: no CORS; POST: 405
  const other = await t.call('GET', '/providers', { origin: 'https://evil.example' });
  assert.equal(other.status, 200);
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await t.call('POST', '/providers', { body: {} })).status, 405);
});

test('GET /providers: a custom adapter is described from its declaration only; unknown rails and fields kinds are normalised', async () => {
  const t = await setup({ adapters: { acme: { name: 'acme', label: 'Acme Cards', rails: ['card', 'cash'], fields: [{ key: 'merchant', label: 'Merchant', kind: 'text', required: true }, { key: 'k', kind: 'weird', secretDefault: 'nope' }], enabled: () => true, create() {}, check() { return { ok: true }; } } } });
  const r = await t.call('GET', '/providers');
  assert.deepEqual(r.body.providers, [{ name: 'acme', label: 'Acme Cards', rails: ['card'], ready: true,
    fields: [{ key: 'merchant', label: 'Merchant', kind: 'text', required: true }, { key: 'k', label: 'k', kind: 'text', required: false }] }]);
});

test('GET /providers is rate limited per address', async () => {
  const { createLimiter } = await import(path.join(root, 'supabase', 'functions', '_shared', 'http.js'));
  const t = await setup({ limiter: createLimiter({ max: 2, windowMs: 60000 }) });
  assert.equal((await t.call('GET', '/providers')).status, 200);
  assert.equal((await t.call('GET', '/providers')).status, 200);
  const r = await t.call('GET', '/providers');
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
  assert.equal((await t.call('GET', '/providers', { ip: '203.0.113.10' })).status, 200);
});

test('admin check: no key, a malformed key and an unknown key are refused; only the key lookup runs', async () => {
  const t = await setup();
  t.db.providers.set(RID + '|card', { provider: 'fake', rail: 'card', config: {}, secret: null });
  for (const admin of [null, '', 'own_' + 'a'.repeat(24), 'adm_XYZ', 'adm_' + 'g'.repeat(20)]) {
    const r = await t.check({ restaurantId: RID, rail: 'card' }, { admin });
    assert.equal(r.status, 401, String(admin));
    assert.deepEqual(r.body, { ok: false, detail: 'Admin key required.' });
  }
  assert.equal(t.db.calls.length, 0, 'a key of the wrong shape never reaches the database');
  const r = await t.check({ restaurantId: RID, rail: 'card' }, { admin: 'adm_' + 'ff'.repeat(12) });
  assert.equal(r.status, 401);
  assert.deepEqual(t.db.calls.map((c) => c.path), ['/rest/v1/rpc/aal_admin_key_valid'], 'nothing is read for an unknown key');
  assert.equal(t.db.calls[0].auth, 'Bearer ' + SERVICE, 'the key is checked with the service role');
  assert.equal(t.db.calls[0].body.p_key, 'adm_' + 'ff'.repeat(12));
});

test('admin check: fake answers ok, Whish 501, no row 404, an unknown adapter 409, bad bodies 400, GET 405', async () => {
  const t = await setup();
  t.db.providers.set(RID + '|card', { provider: 'fake', rail: 'card', config: {}, secret: null });
  t.db.providers.set(RID + '|whish', { provider: 'whish', rail: 'whish', config: { merchant: 'm-1' }, secret: SECRET });
  let r = await t.check({ restaurantId: RID, rail: 'card' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.provider, 'fake');
  assert.match(r.body.detail, /no money moves/);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(t.db.calls.slice(-2).map((c) => [c.path, c.body]), [['/rest/v1/rpc/aal_admin_key_valid', { p_key: ADMIN }], ['/rest/v1/rpc/aal_payment_provider', { p_rid: RID, p_rail: 'card' }]]);
  r = await t.check({ restaurantId: RID, rail: 'whish' });
  assert.equal(r.status, 501);
  assert.equal(r.body.ok, false);
  assert.match(r.body.detail, /not built yet.*merchant API/);
  r = await t.check({ restaurantId: JSON.stringify(['kababji', 'hamra']), rail: 'card' });
  assert.equal(r.status, 404);
  assert.match(r.body.detail, /No enabled provider/);
  t.db.providers.set(RID + '|card', { provider: 'stripe', rail: 'card', config: {}, secret: SECRET });
  r = await t.check({ restaurantId: RID, rail: 'card' });
  assert.equal(r.status, 409);
  assert.match(r.body.detail, /stripe provider is not available/);
  for (const body of [{}, { restaurantId: RID }, { restaurantId: RID, rail: 'cash' }, { restaurantId: 7, rail: 'card' }, 'not json', { restaurantId: 'x'.repeat(201), rail: 'card' }]) {
    assert.equal((await t.check(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await t.call('GET', '/admin/check')).status, 405);
  assert.equal((await t.call('POST', '/admin/other', { body: {} })).status, 404);
  assert.equal((await t.check('x'.repeat(9000))).status, 413);
  // the fake provider is unavailable without its secret
  const t2 = await setup({ env: { FAKE_WEBHOOK_SECRET: '' } });
  t2.db.providers.set(RID + '|card', { provider: 'fake', rail: 'card', config: {}, secret: null });
  assert.equal((await t2.check({ restaurantId: RID, rail: 'card' })).status, 409);
});

test('admin check: the adapter gets config and secret; an echoed secret is cut out; a throw is 502; nothing secret is answered or logged', async () => {
  let got = null;
  const acme = {
    name: 'acme', enabled: () => true, create() {},
    async check(ctx) { got = ctx; if (ctx.config.mode === 'throw') throw new Error('refused key ' + ctx.secret); return { ok: ctx.config.mode !== 'bad', detail: 'Merchant ' + ctx.config.merchant + ' answered; key live-secret-value-9999 and ' + ctx.secret }; },
  };
  const t = await setup({ adapters: { acme } });
  t.db.providers.set(RID + '|card', { provider: 'acme', rail: 'card', config: { merchant: 'a-1' }, secret: SECRET });
  let r = await t.check({ restaurantId: RID, rail: 'card' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.detail, 'Merchant a-1 answered; key [secret] and [secret]');
  assert.deepEqual(got.config, { merchant: 'a-1' });
  assert.equal(got.secret, SECRET);
  assert.equal(got.rid, RID); assert.equal(got.rail, 'card');
  assert.equal(got.payment, undefined, 'no payment in a check');
  assert.equal(typeof got.fetch, 'function'); assert.equal(got.selfBase, FN);
  t.db.providers.set(RID + '|card', { provider: 'acme', rail: 'card', config: { merchant: 'a-1', mode: 'bad' }, secret: SECRET });
  r = await t.check({ restaurantId: RID, rail: 'card' });
  assert.equal(r.status, 200); assert.equal(r.body.ok, false);
  t.db.providers.set(RID + '|card', { provider: 'acme', rail: 'card', config: { mode: 'throw' }, secret: SECRET });
  r = await t.check({ restaurantId: RID, rail: 'card' });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { ok: false, detail: 'The provider could not be reached; try again.', provider: 'acme' });
  const all = t.seen.join('\n') + '\n' + t.logs.join('\n');
  assert.doesNotMatch(all, /live-secret-value|apiKey/);
  assert.ok(!all.includes(ADMIN), 'the admin key is never answered or logged');
});

test('admin check: rate limited per address before the key is looked up; a missing SQL file is named', async () => {
  const { createLimiter } = await import(path.join(root, 'supabase', 'functions', '_shared', 'http.js'));
  const t = await setup({ adminLimiter: createLimiter({ max: 2, windowMs: 60000 }) });
  t.db.keys.clear();
  for (let i = 0; i < 2; i++) assert.equal((await t.check({ restaurantId: RID, rail: 'card' })).status, 401);
  const calls = t.db.calls.length;
  const r = await t.check({ restaurantId: RID, rail: 'card' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
  assert.equal(t.db.calls.length, calls, 'no lookup once limited');
  assert.equal((await t.check({ restaurantId: RID, rail: 'card' }, { ip: '198.51.100.4' })).status, 401, 'another address is not held');
  // aal_admin_key_valid missing (PostgREST PGRST202): 501 naming the file
  const t2 = await setup();
  const inner = t2.db.fetch;
  t2.db.fetch = async (url, init) => String(url).includes('aal_admin_key_valid') ? new Response(JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' }), { status: 404 }) : inner(url, init);
  const h2 = t2.mod.createHandler({ fetch: (u, i) => t2.db.fetch(u, i), env: t2.env, log: { warn() {}, info() {} } });
  const res = await h2(new Request(FN + '/admin/check', { method: 'POST', headers: { 'x-aalayna-admin': ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurantId: RID, rail: 'card' }) }));
  assert.equal(res.status, 501);
  assert.match((await res.json()).detail, /payment-connect-2026-11-24\.sql/);
});

test('admin check: CORS preflight allows the admin header for allowed origins only', async () => {
  const t = await setup();
  const r = await t.call('OPTIONS', '/admin/check');
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /x-aalayna-admin/);
  const o = await t.call('OPTIONS', '/admin/check', { origin: 'https://evil.example' });
  assert.equal(o.headers.get('Access-Control-Allow-Headers'), null);
});

test('helpers: secretFields reads the saved JSON object and a hand-set string; scrub cuts the secret and its fields', async () => {
  const m = await load();
  assert.deepEqual(m.secretFields(SECRET), { apiKey: 'live-secret-value-9999' });
  assert.deepEqual(m.secretFields('plain-token'), { value: 'plain-token' });
  assert.deepEqual(m.secretFields('[1,2]'), { value: '[1,2]' });
  assert.deepEqual(m.secretFields(null), {});
  assert.equal(m.scrub('a live-secret-value-9999 b', SECRET), 'a [secret] b');
  assert.equal(m.scrub('x'.repeat(400), null).length, 300);
  // the header comment documents the contract
  const src = require('node:fs').readFileSync(path.join(root, 'supabase', 'functions', 'payment-start', 'handler.js'), 'utf8');
  for (const s of ['GET  /payment-start/providers', 'POST /payment-start/admin/check', 'aal_admin_key_valid', "kind: 'text'|'secret'", 'check     ctx = {rid, rail, config, secret']) assert.ok(src.includes(s), s);
});
