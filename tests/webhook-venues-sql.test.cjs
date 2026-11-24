/* supabase/webhook-venues-2026-11-24.sql: payment_providers.webhook_route and
   aal_payment_provider_by_route, for payment-webhook's venue-scoped providers. Static checks
   always run. With PGLITE_MODULE pointing at @electric-sql/pglite (see supabase/README.md) the
   file is applied twice after the earlier files and behaves as stated:
   - rows that existed before it get a distinct 'whk_' + 32 hex route, kept on a second run;
     new rows get one by default; routes are unique, not null and of the checked shape;
   - aal_payment_provider_by_route answers the enabled row with that provider and route as
     {restaurant_id, rail, provider, config, secret} (secret null without Vault), null for an
     unknown route, another provider's route or a disabled row, and is closed to anon and
     authenticated; aal_payment_provider still answers as before;
   - the service role still only reads payment_providers. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const FILE = 'webhook-venues-2026-11-24.sql';
const SQL = fs.readFileSync(path.join(root, 'supabase', FILE), 'utf8');
const code = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('webhook-venues SQL: one transaction, prerequisites checked first, nothing existing replaced', () => {
  assert.match(code, /^\s*begin;/m);
  assert.match(code.trim(), /commit;$/);
  assert.equal((code.match(/^\s*begin;/gm) || []).length, 1);
  const first = code.indexOf("raise exception 'Run payment-start-2026-10-14.sql before webhook-venues-2026-11-24.sql'");
  assert.ok(first > 0 && first < code.indexOf('alter table'), 'the check comes before any change');
  const replaced = [...code.matchAll(/create or replace function (public\.\w+)/g)].map((m) => m[1]);
  assert.deepEqual(replaced, ['public.aal_payment_provider_by_route']);
  for (const other of fs.readdirSync(path.join(root, 'supabase')).filter((f) => f.endsWith('.sql') && f !== FILE)) {
    const src = fs.readFileSync(path.join(root, 'supabase', other), 'utf8');
    assert.ok(!src.includes('aal_payment_provider_by_route'), 'aal_payment_provider_by_route is new, not in ' + other);
  }
  assert.doesNotMatch(code, /\bdrop (table|function|policy|column)\b/i);
  assert.doesNotMatch(code, /alter table public\.(kv_rows|kv_docs|venue_profiles|venue_keys|payment_sessions|payment_callbacks)/);
  assert.doesNotMatch(code, /\bgrant [^;]* on public\.payment_providers/);
  assert.doesNotMatch(SQL, /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|re_[A-Za-z0-9]{8,}|service_role_key\s*=/);
});

test('webhook-venues SQL: the route column and the lookup are as documented', () => {
  assert.match(code, /add column if not exists webhook_route text;/);
  assert.match(code, /set default 'whk_' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\);/);
  assert.match(code, /update public\.payment_providers set webhook_route = default where webhook_route is null;/);
  assert.match(code, /create unique index if not exists payment_providers_webhook_route on public\.payment_providers \(webhook_route\);/);
  const f = code.slice(code.indexOf('function public.aal_payment_provider_by_route'), code.indexOf('revoke all on function public.aal_payment_provider_by_route'));
  assert.match(f, /stable security definer set search_path = public, extensions, pg_temp as \$\$/);
  assert.match(f, /<> 'service_role'/);
  assert.match(f, /where provider = p_provider and webhook_route = p_route and enabled/);
  assert.match(f, /to_regclass\('vault\.decrypted_secrets'\) is not null/);
  assert.match(f, /from vault\.decrypted_secrets where name = r\.secret_name/);
  assert.match(code, /revoke all on function public\.aal_payment_provider_by_route\(text, text\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.aal_payment_provider_by_route\(text, text\) to service_role;/);
  assert.doesNotMatch(code, /to (anon|authenticated)\b/);
  // the handler refuses unread what the column could never hold
  const handler = fs.readFileSync(path.join(root, 'supabase', 'functions', 'payment-webhook', 'handler.js'), 'utf8');
  const check = code.match(/check \(webhook_route ~ '([^']+)'\)/)[1];
  assert.ok(handler.includes('ROUTE_RE = /' + check + '/;'), 'handler ROUTE_RE matches the check constraint');
});

const modulePath = process.env.PGLITE_MODULE;
test('webhook-venues SQL against PostgreSQL: backfill, defaults, uniqueness, lookup, privileges', { skip: !modulePath }, async () => {
  const { PGlite } = require(modulePath), db = new PGlite();
  const sql = (f) => fs.readFileSync(path.join(root, 'supabase', f), 'utf8').replace('create extension if not exists pgcrypto;', '');
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
    await db.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
    await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
    for (const f of ['migration.sql', 'site-events.sql', 'hardening-2026-09-15.sql', 'hardening-2026-09-24.sql', 'admin.sql', 'sessions-2026-09-24.sql', 'auth-2026-09-24.sql', 'followups-2026-09-24.sql', 'theme-2026-09-28.sql', 'payments-2026-09-30.sql']) await db.exec(sql(f));
    await assert.rejects(db.exec(sql(FILE)), /Run payment-start-2026-10-14\.sql/);
    await db.exec('rollback');
    await db.exec(sql('payment-start-2026-10-14.sql'));
    await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
    const as = async (role, headers, claims) => { await db.exec('reset role'); await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)", [JSON.stringify(headers || {}), JSON.stringify(claims || { role })]); await db.exec('set role ' + role); };
    const one = async (q, args) => (await db.query(q, args)).rows[0].value;
    await as('anon', { 'x-aalayna-admin': 'adm_test' });
    const a = await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra','{}'::jsonb) as value");
    const b = await one("select aal_admin_register_venue('Kababji','Hamra','kababji-hamra','{}'::jsonb) as value");
    await db.exec('reset role');
    // rows from before the file
    await db.query("insert into payment_providers(restaurant_id,rail,provider,config,secret_name) values($1,'card','areeba','{\"merchant\":\"M-A\"}','areeba_mayda')", [a.restaurant_id]);
    await db.query("insert into payment_providers(restaurant_id,rail,provider,config) values($1,'card','areeba','{\"merchant\":\"M-B\"}')", [b.restaurant_id]);

    await db.exec(sql(FILE));
    const routes = async () => (await db.query('select restaurant_id, rail, webhook_route from payment_providers order by restaurant_id, rail')).rows;
    const first = await routes();
    assert.equal(first.length, 2);
    for (const r of first) assert.match(r.webhook_route, /^whk_[0-9a-f]{32}$/);
    assert.notEqual(first[0].webhook_route, first[1].webhook_route);
    await db.exec(sql(FILE));   // safe to re-run: every route is kept
    assert.deepEqual(await routes(), first);

    // a new row gets its own route by default; a route must be unique, present and well formed
    await db.query("insert into payment_providers(restaurant_id,rail,provider,enabled) values($1,'whish','areeba',false)", [a.restaurant_id]);
    const all = await routes();
    assert.equal(new Set(all.map((r) => r.webhook_route)).size, 3);
    for (const r of all) assert.match(r.webhook_route, /^whk_[0-9a-f]{32}$/);
    await assert.rejects(db.query("insert into payment_providers(restaurant_id,rail,provider,webhook_route) values($1,'whish','areeba',$2)", [b.restaurant_id, all[0].webhook_route]), /duplicate|unique/);
    await assert.rejects(db.query("insert into payment_providers(restaurant_id,rail,provider,webhook_route) values($1,'whish','areeba',null)", [b.restaurant_id]), /null/);
    await assert.rejects(db.query("insert into payment_providers(restaurant_id,rail,provider,webhook_route) values($1,'whish','areeba','short')", [b.restaurant_id]), /check/);
    await assert.rejects(db.query("insert into payment_providers(restaurant_id,rail,provider,webhook_route) values($1,'whish','areeba','whk_has a space and slash/xxxx')", [b.restaurant_id]), /check/);

    const route = (rid, rail) => all.find((r) => r.restaurant_id === rid && r.rail === rail).webhook_route;
    await as('service_role', {}, { role: 'service_role' });
    assert.deepEqual(await one("select aal_payment_provider_by_route('areeba',$1) as value", [route(a.restaurant_id, 'card')]),
      { restaurant_id: a.restaurant_id, rail: 'card', provider: 'areeba', config: { merchant: 'M-A' }, secret: null });
    assert.equal((await one("select aal_payment_provider_by_route('areeba',$1) as value", [route(b.restaurant_id, 'card')])).restaurant_id, b.restaurant_id);
    assert.equal(await one("select aal_payment_provider_by_route('areeba',$1) as value", ['whk_' + '0'.repeat(32)]), null);
    assert.equal(await one("select aal_payment_provider_by_route('fake',$1) as value", [route(a.restaurant_id, 'card')]), null);
    assert.equal(await one("select aal_payment_provider_by_route('areeba',$1) as value", [route(a.restaurant_id, 'whish')]), null, 'a disabled row is not found');
    assert.equal(await one("select aal_payment_provider_by_route('areeba',$1) as value", [route(a.restaurant_id, 'card').toUpperCase()]), null);
    // payment-start's lookup is unchanged
    assert.deepEqual(await one("select aal_payment_provider($1,'card') as value", [a.restaurant_id]), { provider: 'areeba', rail: 'card', config: { merchant: 'M-A' }, secret: null });
    await assert.rejects(db.query("update payment_providers set webhook_route = default"), /permission denied/);
    // a role other than the service role is refused, even when allowed to execute
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims','{\"role\":\"authenticated\"}',false)");
    await assert.rejects(db.query("select aal_payment_provider_by_route('areeba',$1)", [route(a.restaurant_id, 'card')]), /Verified provider callback required/);
    for (const role of ['anon', 'authenticated']) {
      await as(role, { 'x-aalayna-key': a.owner_key });
      await assert.rejects(db.query("select aal_payment_provider_by_route('areeba',$1)", [route(a.restaurant_id, 'card')]), /permission denied/);
      await assert.rejects(db.query('select webhook_route from payment_providers'), /permission denied/);
    }
  } finally { await db.close(); }
});
