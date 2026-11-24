/* supabase/payment-connect-2026-11-24.sql: connecting a venue's payment provider from
   admin.html. Static checks always run. With PGLITE_MODULE pointing at @electric-sql/pglite
   (see supabase/README.md) the file is applied twice after the earlier files, once on a
   database without Vault and once with a stand-in for Supabase Vault (vault.secrets,
   vault.decrypted_secrets, vault.create_secret, vault.update_secret), and behaves as stated:
   - the three aal_admin_* functions need an admin key; aal_admin_key_valid is the service
     role's only; the helpers are nobody's;
   - list answers every column (a column added later, webhook_route, appears) and has_secret,
     never the secret;
   - set inserts and updates, validates rail, provider and config, keeps config, secret and
     enabled when they are null, writes the secret to Vault under a deterministic name and
     updates it in place, drops it when the provider changes; without Vault a secret is
     refused with a clear sentence and nothing changes;
   - remove deletes the row and its Vault secret;
   - aal_payment_provider (the function's read) sees what set wrote, secret included. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const FILE = 'payment-connect-2026-11-24.sql';
const SQL = fs.readFileSync(path.join(root, 'supabase', FILE), 'utf8');
const code = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('payment-connect SQL: one transaction, prerequisites first, only new functions, nothing dropped or altered', () => {
  assert.match(code, /^\s*begin;/m);
  assert.match(code.trim(), /commit;$/);
  assert.equal((code.match(/^\s*begin;/gm) || []).length, 1);
  const first = code.indexOf("raise exception 'Run payment-start-2026-10-14.sql before payment-connect-2026-11-24.sql'");
  assert.ok(first > 0 && first < code.indexOf('create or replace function'), 'the check comes before any change');
  const made = [...code.matchAll(/create or replace function (public\.\w+)/g)].map((m) => m[1]);
  assert.deepEqual(made, ['public.aal_admin_payment_secret_name', 'public.aal_admin_vault_has', 'public.aal_admin_vault_drop', 'public.aal_admin_payment_provider_json',
    'public.aal_admin_list_payment_providers', 'public.aal_admin_set_payment_provider', 'public.aal_admin_remove_payment_provider', 'public.aal_admin_key_valid']);
  for (const other of fs.readdirSync(path.join(root, 'supabase')).filter((f) => f.endsWith('.sql') && f !== FILE)) {
    const src = fs.readFileSync(path.join(root, 'supabase', other), 'utf8');
    for (const fn of made) assert.ok(!src.includes('function ' + fn + '('), fn + ' is new, not in ' + other);
  }
  assert.doesNotMatch(code, /\bdrop (table|function|policy|trigger)\b/i);
  assert.doesNotMatch(code, /\balter table\b/i);
  assert.doesNotMatch(code, /function public\.aal_payment_provider\(/);
  assert.doesNotMatch(SQL, /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role_key\s*=/);
});

test('payment-connect SQL: search_path pinned, admin key first, grants as admin.sql, the secret never raised or answered', () => {
  const fns = [...code.matchAll(/create or replace function[\s\S]*?\$\$/g)].map((m) => m[0]);
  for (const f of fns) assert.match(f, /set search_path = public, extensions, pg_temp as \$\$$/);
  const body = (name) => { const i = code.indexOf('function public.' + name + '('); return code.slice(i, code.indexOf('end $$;', i)); };
  for (const f of ['aal_admin_list_payment_providers', 'aal_admin_set_payment_provider', 'aal_admin_remove_payment_provider']) {
    const b = body(f);
    assert.match(b, /security definer/);
    assert.match(b.split('\n').find((l) => /\bif\b/.test(l)), /if not public\.aal_is_admin\(\) then raise exception 'Admin key required\.' using errcode = '42501'; end if;/, f + ' checks the key first');
    assert.match(code, new RegExp('grant execute on function public\\.' + f + '\\([^)]*\\) to anon, authenticated;'));
    assert.match(code, new RegExp('revoke all on function public\\.' + f + '\\([^)]*\\) from public;'));
  }
  assert.match(body('aal_admin_key_valid'), /<> 'service_role'/);
  assert.match(code, /revoke all on function public\.aal_admin_key_valid\(text\) from public, anon, authenticated;\s*grant execute on function public\.aal_admin_key_valid\(text\) to service_role;/);
  for (const h of ['aal_admin_payment_secret_name(text, text)', 'aal_admin_vault_has(text)', 'aal_admin_vault_drop(text)', 'aal_admin_payment_provider_json(text, text)']) {
    assert.ok(code.includes('revoke all on function public.' + h + ' from public, anon, authenticated;'), h);
    assert.ok(!new RegExp('grant [^;]*' + h.replace(/[()]/g, '\\$&')).test(code), h + ' is granted to nobody');
  }
  // the secret parameter is never in a raise, a notice or an answer
  for (const l of code.split('\n').filter((x) => /raise|jsonb_build_object|return/.test(x))) assert.doesNotMatch(l, /p_secret\b(?!\s+is\b)/, l);
  assert.doesNotMatch(code, /raise (notice|log|info|debug|warning)/);
  // Vault only through dynamic SQL, so the file installs where Vault is missing
  assert.doesNotMatch(code.replace(/'[^']*'/g, "''"), /\bvault\./);
});

const modulePath = process.env.PGLITE_MODULE;
const VAULT = `create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text default '', secret text not null, updated_at timestamptz default now());
create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null) returns uuid
 language sql as $$ insert into vault.secrets(name, description, secret) values (new_name, new_description, new_secret) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null) returns void
 language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret), updated_at = now() where id = secret_id $$;`;

async function database(withVault) {
  const { PGlite } = require(modulePath), db = new PGlite();
  const sql = (f) => fs.readFileSync(path.join(root, 'supabase', f), 'utf8').replace('create extension if not exists pgcrypto;', '');
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  await db.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
  await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
  if (withVault) await db.exec(VAULT);
  await assert.rejects(db.exec(sql(FILE)), /Run payment-start-2026-10-14\.sql before payment-connect/);
  await db.exec('rollback');
  for (const f of ['migration.sql', 'site-events.sql', 'hardening-2026-09-15.sql', 'hardening-2026-09-24.sql', 'admin.sql', 'sessions-2026-09-24.sql', 'auth-2026-09-24.sql',
    'followups-2026-09-24.sql', 'theme-2026-09-28.sql', 'payments-2026-09-30.sql', 'payment-start-2026-10-14.sql', 'review-fixes-2026-11-10.sql']) await db.exec(sql(f));
  await db.exec(sql(FILE));
  await db.exec(sql(FILE));   // safe to re-run
  await db.query("insert into admin_keys(admin_key,label) values('adm_0123456789abcdef','test')");
  const as = async (role, headers, claims) => { await db.exec('reset role'); await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)", [JSON.stringify(headers || {}), JSON.stringify(claims || { role })]); await db.exec('set role ' + role); };
  const one = async (q, args) => (await db.query(q, args)).rows[0].value;
  const admin = () => as('anon', { 'x-aalayna-admin': 'adm_0123456789abcdef' });
  await admin();
  const v = await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra','{}'::jsonb) as value");
  const set = (rail, provider, config, secret, enabled) => one('select aal_admin_set_payment_provider($1,$2,$3,$4::jsonb,$5,$6) as value', [v.restaurant_id, rail, provider, config === null ? null : JSON.stringify(config), secret, enabled]);
  const list = () => one('select aal_admin_list_payment_providers($1) as value', [v.restaurant_id]);
  const remove = (rail) => one('select aal_admin_remove_payment_provider($1,$2) as value', [v.restaurant_id, rail]);
  const lookup = async (rail) => { await as('service_role', {}, { role: 'service_role' }); const r = await one("select aal_payment_provider($1,$2) as value", [v.restaurant_id, rail]); await admin(); return r; };
  return { db, as, one, admin, v, rid: v.restaurant_id, set, list, remove, lookup };
}

test('payment-connect SQL against PostgreSQL, without Vault: admin key, validation, list, set, remove, privileges', { skip: !modulePath }, async () => {
  const t = await database(false);
  const { db, as, one, admin, rid, set, list, remove, lookup } = t;
  try {
    assert.deepEqual(await list(), []);
    // no key, a wrong key, an owner key: refused
    for (const h of [{}, { 'x-aalayna-admin': 'adm_ffffffffffffffff' }, { 'x-aalayna-key': t.v.owner_key }]) {
      await as('anon', h);
      await assert.rejects(list(), /Admin key required/);
      await assert.rejects(set('whish', 'whish', {}, null, true), /Admin key required/);
      await assert.rejects(remove('whish'), /Admin key required/);
    }
    await admin();
    // validation
    await assert.rejects(set('cash', 'whish', {}, null, true), /Rail must be card or whish/);
    await assert.rejects(set('whish', 'Whish Pay', {}, null, true), /Provider must be an adapter name/);
    await assert.rejects(one("select aal_admin_set_payment_provider('[\"nowhere\",\"\"]','whish','whish','{}'::jsonb,null,true) as value"), /Unknown venue/);
    await assert.rejects(set('whish', 'whish', ['a'], null, true), /Config must be a JSON object/);
    await assert.rejects(set('whish', 'whish', { merchant: { id: 1 } }, null, true), /must be text, a number/);
    await assert.rejects(set('whish', 'whish', { 'bad key': 'x' }, null, true), /Config keys start with a letter/);
    await assert.rejects(set('whish', 'whish', { merchant: 'x'.repeat(301) }, null, true), /over 300 characters/);
    await assert.rejects(set('whish', 'whish', Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['k' + i, i])), null, true), /more than 20 keys/);
    // without Vault, credentials are refused with a clear sentence, and nothing changes
    const SECRET = '{"apiKey":"whish-live-secret-0000"}';
    await assert.rejects(set('whish', 'whish', { merchant: 'm-1' }, SECRET, true), (e) => /Supabase Vault is not available/.test(e.message) && !e.message.includes('whish-live-secret'));
    await assert.rejects(set('whish', 'whish', {}, '   ', true), /Credentials must be 1 to 4,000 characters/);
    assert.deepEqual(await list(), []);
    // a row without credentials still works
    let r = await set('whish', 'whish', { merchant: 'm-1' }, null, false);
    assert.equal(r.provider, 'whish'); assert.equal(r.rail, 'whish'); assert.deepEqual(r.config, { merchant: 'm-1' });
    assert.equal(r.enabled, false); assert.equal(r.has_secret, false); assert.equal(r.secret_name, null);
    assert.ok(r.updated_at && r.created_at && r.restaurant_id === rid);
    assert.equal(await lookup('whish'), null, 'disabled rows are not taken');
    r = await set('whish', 'whish', null, null, null);   // nulls keep everything
    assert.deepEqual(r.config, { merchant: 'm-1' }); assert.equal(r.enabled, false);
    r = await set('whish', 'whish', null, null, true);
    assert.equal(r.enabled, true);
    assert.deepEqual(await lookup('whish'), { provider: 'whish', rail: 'whish', config: { merchant: 'm-1' }, secret: null });
    await set('card', 'fake', {}, null, null);
    assert.deepEqual((await list()).map((x) => x.rail), ['card', 'whish'], 'card first');
    // a column another file adds (webhook-venues-2026-11-24.sql) comes through untouched
    await db.exec('reset role');
    await db.exec('alter table public.payment_providers add column webhook_route text');
    await db.query("update payment_providers set webhook_route='mayda-7f3a' where rail='whish'");
    await admin();
    const w = (await list()).find((x) => x.rail === 'whish');
    assert.equal(w.webhook_route, 'mayda-7f3a');
    assert.equal((await set('whish', 'whish', { merchant: 'm-2' }, null, null)).webhook_route, 'mayda-7f3a', 'set keeps columns it does not know');
    // remove deletes
    assert.deepEqual(await remove('card'), { removed: true });
    assert.deepEqual(await remove('card'), { removed: false });
    assert.deepEqual((await list()).map((x) => x.rail), ['whish']);
    // privileges
    for (const role of ['anon', 'authenticated']) {
      await as(role, { 'x-aalayna-admin': 'adm_0123456789abcdef' });
      for (const q of ["select aal_admin_key_valid('adm_0123456789abcdef')", "select aal_admin_vault_has('x')", "select aal_admin_vault_drop('x')",
        "select aal_admin_payment_secret_name('a','card')", "select aal_admin_payment_provider_json('a','card')"]) await assert.rejects(db.query(q), /permission denied/, role + ': ' + q);
      await assert.rejects(db.query('select * from payment_providers'), /permission denied/);
    }
    await as('service_role', {}, { role: 'anon' });
    await assert.rejects(db.query("select aal_admin_key_valid('adm_0123456789abcdef')"), /Service role required/);
    await as('service_role', {}, { role: 'service_role' });
    assert.equal(await one("select aal_admin_key_valid('adm_0123456789abcdef') as value"), true);
    assert.equal(await one("select aal_admin_key_valid('adm_ffffffffffffffff') as value"), false);
    assert.equal(await one("select aal_admin_key_valid('') as value"), false);
    assert.equal(await one('select aal_admin_key_valid(null) as value'), false);
  } finally { await db.close(); }
});

test('payment-connect SQL against PostgreSQL, with Vault: credentials stored, updated in place, dropped, never answered', { skip: !modulePath }, async () => {
  const t = await database(true);
  const { db, one, rid, set, list, remove, lookup } = t;
  const vault = async () => { await db.exec('reset role'); const r = (await db.query('select name, secret from vault.secrets order by name')).rows; await t.admin(); return r; };
  try {
    const SECRET = '{"apiKey":"whish-live-secret-0000"}';
    let r = await set('whish', 'whish', { merchant: 'm-1' }, SECRET, true);
    const name = 'aalayna_pay_whish_' + require('node:crypto').createHash('md5').update(rid).digest('hex');
    assert.equal(r.secret_name, name);
    assert.equal(r.has_secret, true);
    assert.ok(!JSON.stringify(r).includes('whish-live-secret'), 'set never answers the secret');
    assert.ok(!JSON.stringify(await list()).includes('whish-live-secret'), 'list never answers the secret');
    assert.deepEqual(await vault(), [{ name, secret: SECRET }]);
    assert.deepEqual(await lookup('whish'), { provider: 'whish', rail: 'whish', config: { merchant: 'm-1' }, secret: SECRET });
    // null keeps the secret; a new one updates the same Vault row
    r = await set('whish', 'whish', { merchant: 'm-2' }, null, null);
    assert.equal(r.has_secret, true);
    assert.equal((await lookup('whish')).secret, SECRET);
    const NEW = '{"apiKey":"whish-live-secret-1111"}';
    await set('whish', 'whish', null, NEW, null);
    assert.deepEqual(await vault(), [{ name, secret: NEW }]);
    assert.deepEqual(await lookup('whish'), { provider: 'whish', rail: 'whish', config: { merchant: 'm-2' }, secret: NEW });
    // a hand-made row's secret name is kept and its secret written in place
    await db.exec('reset role');
    await db.query("insert into payment_providers(restaurant_id,rail,provider,secret_name) values($1,'card','whish','whish_mayda')", [rid]);
    await t.admin();
    assert.equal((await list()).find((x) => x.rail === 'card').has_secret, false, 'named but not in Vault yet');
    r = await set('card', 'whish', null, 'card-secret-2222', null);
    assert.equal(r.secret_name, 'whish_mayda'); assert.equal(r.has_secret, true);
    // another provider without new credentials: the old secret goes
    r = await set('card', 'acme_cards', { merchant: 'a-1' }, null, null);
    assert.equal(r.secret_name, null); assert.equal(r.has_secret, false); assert.deepEqual(r.config, { merchant: 'a-1' });
    assert.deepEqual((await vault()).map((x) => x.name), [name]);
    // remove: the row and its secret
    assert.deepEqual(await remove('whish'), { removed: true });
    assert.deepEqual(await vault(), []);
    assert.equal(await lookup('whish'), null);
    assert.deepEqual((await list()).map((x) => x.rail), ['card']);
    await assert.rejects(one("select aal_admin_set_payment_provider($1,'whish','whish','{}'::jsonb,$2,true) as value", [rid, 'x'.repeat(4001)]), /Credentials must be 1 to 4,000/);
  } finally { await db.close(); }
});
