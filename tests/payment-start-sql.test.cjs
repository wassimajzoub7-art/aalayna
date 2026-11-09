/* supabase/payment-start-2026-10-14.sql (T15): the provider table, the handoff log and the
   provider lookup. Static checks always run. With PGLITE_MODULE pointing at
   @electric-sql/pglite (see supabase/README.md) the file is applied twice after the earlier
   files and behaves as stated:
   - aal_payment_provider is null for a venue without a row, answers the enabled row with its
     config and a null secret when Vault is absent, ignores a disabled row, and is closed to
     anon and authenticated;
   - payment_providers and payment_sessions are closed to anon and authenticated; the service
     role may read providers (not change them) and add sessions (not change or delete them);
   - a session row needs a rail, an amount and a currency. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const SQL = fs.readFileSync(path.join(root, 'supabase', 'payment-start-2026-10-14.sql'), 'utf8');
const code = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('payment-start SQL: one transaction, prerequisites checked first, nothing existing replaced', () => {
  assert.match(code, /^\s*begin;/m);
  assert.match(code.trim(), /commit;$/);
  assert.equal((code.match(/^\s*begin;/gm) || []).length, 1);
  const first = code.indexOf("raise exception 'Run payments-2026-09-30.sql before payment-start-2026-10-14.sql'");
  assert.ok(first > 0 && first < code.indexOf('create table'), 'the check comes before any change');
  const replaced = [...code.matchAll(/create or replace function (public\.\w+)/g)].map((m) => m[1]);
  assert.deepEqual(replaced, ['public.aal_payment_provider']);
  for (const other of fs.readdirSync(path.join(root, 'supabase')).filter((f) => f.endsWith('.sql') && f !== 'payment-start-2026-10-14.sql')) {
    const src = fs.readFileSync(path.join(root, 'supabase', other), 'utf8');
    assert.ok(!src.includes('function public.aal_payment_provider('), 'aal_payment_provider is new, not in ' + other);
  }
  assert.doesNotMatch(code, /\bdrop (table|function|policy)\b/i);
  assert.doesNotMatch(code, /alter table public\.(kv_rows|kv_docs|venue_profiles|venue_keys)/);
  assert.doesNotMatch(SQL, /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|re_[A-Za-z0-9]{8,}|service_role_key\s*=/);
});

test('payment-start SQL: the function pins search_path and requires the service role; both tables are closed; sessions are append only', () => {
  const fns = [...code.matchAll(/create or replace function[\s\S]*?\$\$/g)].map((m) => m[0]);
  assert.equal(fns.length, 1);
  assert.match(fns[0], /set search_path = public, extensions, pg_temp as \$\$$/);
  assert.match(fns[0], /security definer/);
  const f = code.slice(code.indexOf('function public.aal_payment_provider'), code.indexOf('revoke all on function public.aal_payment_provider'));
  assert.match(f, /<> 'service_role'/);
  assert.match(f, /where restaurant_id = p_rid and rail = p_rail and enabled/);
  assert.match(f, /to_regclass\('vault\.decrypted_secrets'\) is not null/);
  assert.match(f, /from vault\.decrypted_secrets where name = r\.secret_name/);
  for (const t of ['payment_providers', 'payment_sessions']) {
    assert.match(code, new RegExp('alter table public\\.' + t + ' enable row level security;'));
    assert.match(code, new RegExp('revoke all on public\\.' + t + ' from public, anon, authenticated;'));
    assert.doesNotMatch(code, new RegExp('grant [^;]* on public\\.' + t + ' to [^;]*(anon|authenticated)'));
    assert.doesNotMatch(code, new RegExp('create policy[^;]*' + t));
  }
  assert.match(code, /revoke all on public\.payment_providers from service_role;\s*grant select on public\.payment_providers to service_role;/);
  assert.match(code, /revoke update, delete, truncate on public\.payment_sessions from service_role;\s*grant select, insert on public\.payment_sessions to service_role;/);
  assert.match(code, /revoke all on function public\.aal_payment_provider\(text, text\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.aal_payment_provider\(text, text\) to service_role;/);
  assert.doesNotMatch(code, /to (anon|authenticated)\b/);
  assert.match(code, /rail\s+text not null check \(rail in \('card', 'whish'\)\)/);
  assert.match(code, /primary key \(restaurant_id, rail\)/);
  assert.match(code, /secret_name\s+text check/);
  assert.doesNotMatch(code, /\bsecret\s+text\b/);   // the secret itself is never a column
});

const modulePath = process.env.PGLITE_MODULE;
test('payment-start SQL against PostgreSQL: lookup, disabled rows, privileges, append-only sessions', { skip: !modulePath }, async () => {
  const { PGlite } = require(modulePath), db = new PGlite();
  const sql = (f) => fs.readFileSync(path.join(root, 'supabase', f), 'utf8').replace('create extension if not exists pgcrypto;', '');
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
    await db.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
    await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
    await assert.rejects(db.exec(sql('payment-start-2026-10-14.sql')), /Run payments-2026-09-30\.sql/);
    await db.exec('rollback');
    for (const f of ['migration.sql', 'site-events.sql', 'hardening-2026-09-15.sql', 'hardening-2026-09-24.sql', 'admin.sql', 'sessions-2026-09-24.sql', 'auth-2026-09-24.sql', 'followups-2026-09-24.sql', 'theme-2026-09-28.sql', 'payments-2026-09-30.sql']) await db.exec(sql(f));
    await db.exec(sql('payment-start-2026-10-14.sql'));
    await db.exec(sql('payment-start-2026-10-14.sql'));   // safe to re-run
    await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
    const as = async (role, headers, claims) => { await db.exec('reset role'); await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)", [JSON.stringify(headers || {}), JSON.stringify(claims || { role })]); await db.exec('set role ' + role); };
    const one = async (q, args) => (await db.query(q, args)).rows[0].value;
    await as('anon', { 'x-aalayna-admin': 'adm_test' });
    const v = await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra','{}'::jsonb) as value");
    const rid = v.restaurant_id;
    await as('service_role', {}, { role: 'service_role' });
    assert.equal(await one("select aal_payment_provider($1,'card') as value", [rid]), null);
    await db.exec('reset role');
    await db.query("insert into payment_providers(restaurant_id,rail,provider,config,secret_name) values($1,'card','whish','{\"merchant\":\"m-1\"}','whish_mayda')", [rid]);
    await db.query("insert into payment_providers(restaurant_id,rail,provider,enabled) values($1,'whish','whish',false)", [rid]);
    await assert.rejects(db.query("insert into payment_providers(restaurant_id,rail,provider) values($1,'cash','fake')", [rid]), /check/);
    await assert.rejects(db.query("insert into payment_providers(restaurant_id,rail,provider) values($1,'card','Bad Name')", [rid]), /check|duplicate/);
    await as('service_role', {}, { role: 'service_role' });
    assert.deepEqual(await one("select aal_payment_provider($1,'card') as value", [rid]), { provider: 'whish', rail: 'card', config: { merchant: 'm-1' }, secret: null });
    assert.equal(await one("select aal_payment_provider($1,'whish') as value", [rid]), null);
    await assert.rejects(db.query("update payment_providers set enabled=false"), /permission denied/);
    await db.query("insert into payment_sessions(restaurant_id,payment_id,provider,rail,provider_ref,amount_cents,currency,return_url) values($1,'p1','fake','card','fake-session-1',2200,'USD','https://aalayna.com/guest.html?pay=p1')", [rid]);
    assert.equal((await db.query('select * from payment_sessions')).rows.length, 1);
    await assert.rejects(db.query("update payment_sessions set provider_ref='x'"), /permission denied/);
    await assert.rejects(db.query('delete from payment_sessions'), /permission denied/);
    await assert.rejects(db.query("insert into payment_sessions(restaurant_id,payment_id,provider,rail,currency) values($1,'p2','fake','card','USD')", [rid]), /null/);
    for (const role of ['anon', 'authenticated']) {
      await as(role, { 'x-aalayna-key': v.owner_key });
      await assert.rejects(db.query('select * from payment_providers'), /permission denied/);
      await assert.rejects(db.query('select * from payment_sessions'), /permission denied/);
      await assert.rejects(db.query("select aal_payment_provider($1,'card')", [rid]), /permission denied/);
    }
  } finally { await db.close(); }
});
