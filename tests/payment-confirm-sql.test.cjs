/* confirm_digital as live has it (supabase/auth-2026-09-24.sql), against PostgreSQL in PGlite
   (PGLITE_MODULE, see supabase/README.md). The 2026-11-24 mutation pass found no test that
   failed when these rules were broken (tests/database.test.cjs runs an older aal_mutate):
   - only the service role (a payment provider's verified callback) confirms a digital
     payment: neither the guest's bill key nor the owner's key can, and nothing changes;
   - an expired reservation is never confirmed, even with the right amount and reference;
   - a wrong amount or currency is refused; the right callback confirms once, and the same
     reference again answers the confirmed payment.
   And the demo store (aalayna-store.js, the no-key demo) keeps the same two rules: a tip must
   be less than the amount, and an expired reservation is never confirmed. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const modulePath = process.env.PGLITE_MODULE;

test('confirm_digital: the service role only, never an expired reservation, the exact amount', { skip: !modulePath }, async () => {
  const { PGlite } = require(modulePath), db = new PGlite();
  const sql = (f) => fs.readFileSync(path.join(root, 'supabase', f), 'utf8').replace('create extension if not exists pgcrypto;', '');
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
    await db.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
    await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
    for (const f of ['migration.sql', 'site-events.sql', 'hardening-2026-09-15.sql', 'hardening-2026-09-24.sql', 'admin.sql', 'sessions-2026-09-24.sql', 'auth-2026-09-24.sql']) await db.exec(sql(f));
    await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
    const as = async (role, headers, claims) => { await db.exec('reset role'); await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)", [JSON.stringify(headers || {}), JSON.stringify(claims || { role })]); await db.exec('set role ' + role); };
    const one = async (q, args) => (await db.query(q, args)).rows[0].value;
    await as('anon', { 'x-aalayna-admin': 'adm_test' });
    const v = await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra','{}'::jsonb) as value");
    const rid = v.restaurant_id;
    const mutate = (op, body, token = '') => one('select aal_mutate($1,$2,$3::jsonb,$4) as value', [rid, op, JSON.stringify(body), token]);
    const status = async (id) => { await db.exec('reset role'); return (await db.query("select body->>'status' s from kv_rows where restaurant_id=$1 and collection='aal.settle' and id=$2", [rid, id])).rows[0].s; };
    await as('anon', { 'x-aalayna-key': v.owner_key });
    await mutate('open_check', { id: 'bill-7', table: 7, lines: [{ id: 'k1', q: 2, p: 40, name: 'Shish taouk' }], currency: 'USD' });
    const key = (await mutate('issue_key', { checkId: 'bill-7' })).key;
    const T = 't'.repeat(40);
    await as('anon', { 'x-aalayna-key': key });
    await mutate('reserve', { id: 'p1', requestId: 'p1', checkId: 'bill-7', amount: 11, tip: 1, rail: 'card', items: {} }, T);
    await mutate('reserve', { id: 'p2', requestId: 'p2', checkId: 'bill-7', amount: 12, tip: 0, rail: 'whish', items: {} }, T);
    const cb = (id, cents, over = {}) => Object.assign({ id, externalRef: 'fake-' + id, amountCents: cents, currency: 'USD' }, over);
    // the guest's bill key and the owner's key are not a provider
    for (const headers of [{ 'x-aalayna-key': key }, { 'x-aalayna-key': v.owner_key }]) {
      await as('anon', headers);
      await assert.rejects(mutate('confirm_digital', cb('p1', 1100)), /Verified provider callback required/);
      await assert.rejects(mutate('confirm_digital', cb('p1', 1100), T), /Verified provider callback required/);
    }
    await as('authenticated', { 'x-aalayna-key': key }, { role: 'authenticated' });
    await assert.rejects(mutate('confirm_digital', cb('p1', 1100)), /Verified provider callback required/);
    assert.equal(await status('p1'), 'initiated');
    // the provider: the exact amount and currency only
    await as('service_role', {}, { role: 'service_role' });
    await assert.rejects(mutate('confirm_digital', cb('p1', 1000)), /Callback amount, currency or reference mismatch/);   // less the tip is not the amount
    await assert.rejects(mutate('confirm_digital', cb('p1', 1100, { currency: 'LBP' })), /Callback amount, currency or reference mismatch/);
    await assert.rejects(mutate('confirm_digital', cb('p1', 1100, { externalRef: '' })), /Callback amount, currency or reference mismatch/);
    assert.equal((await mutate('confirm_digital', cb('p1', 1100))).status, 'confirmed');
    assert.equal((await mutate('confirm_digital', cb('p1', 1100))).status, 'confirmed');   // the same callback again
    // an expired reservation: never confirmed, whatever the callback says
    await db.exec('reset role');
    await db.query("update kv_rows set body = body || jsonb_build_object('expiresAt', to_jsonb(now() - interval '1 second')) where restaurant_id=$1 and collection='aal.settle' and id='p2'", [rid]);
    await as('service_role', {}, { role: 'service_role' });
    await assert.rejects(mutate('confirm_digital', cb('p2', 1200)), /Reservation expired or changed/);
    assert.equal(await status('p2'), 'initiated');
  } finally { await db.close(); }
});

test('the demo store: a tip must be less than the amount, and an expired reservation is never confirmed', () => {
  const source = fs.readFileSync(path.join(root, 'aalayna-store.js'), 'utf8');
  const map = new Map();
  const window = { location: { search: '' }, addEventListener() {}, localStorage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) } };
  vm.runInNewContext(source, { window, localStorage: window.localStorage, URLSearchParams });
  const A = window.Aalayna;
  for (const [amount, tip] of [[5, 5], [5, 6], [5, -1], [0, 0]]) assert.throws(() => A.settle({ rail: 'card', amount, tip, requestId: 'r-' + amount + '-' + tip }), /Enter a valid payment and tip/, amount + '/' + tip);
  const p = A.requestPayment({ rail: 'card', amount: 10, tip: 1, requestId: 'late' });
  assert.equal(p.status, 'initiated');
  const all = JSON.parse([...map.entries()].find(([k]) => /aal\.settle/.test(k))[1]);
  all.forEach((s) => { if (s.requestId === 'late') s.expiresAt = new Date(Date.now() - 1000).toISOString(); });
  map.set([...map.keys()].find((k) => /aal\.settle/.test(k)), JSON.stringify(all));
  assert.throws(() => A.confirmPayment('late', { externalRef: 'fake-late' }), /expired|cannot be confirmed/);
  assert.notEqual(A.settlements().find((s) => s.requestId === 'late').status, 'confirmed');
});
