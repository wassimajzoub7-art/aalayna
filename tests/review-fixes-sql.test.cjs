/* supabase/review-fixes-2026-11-10.sql: demo payments off by default, a server-derived demo flag
   on confirmed payments, and aal_now(). Static checks always run. With PGLITE_MODULE pointing at
   @electric-sql/pglite (see supabase/README.md) the files up to payment-start-2026-10-14.sql are
   applied as the live project has them (demo payments defaulting to on), this file twice, and:
   - a venue whose demo payments are on keeps them, including one that got them by the old
     default; a venue registered afterwards without naming the flag has them off, and the
     column's default is false;
   - a payment confirmed by the fake provider ('fake-...') carries demo: true, any other
     confirmed payment demo: false, any other status none; the guest's snapshot keeps demo and
     still has no externalRef; no write, even by the table owner, can set or clear it;
   - the payments stored before the file are backfilled, and a second run rewrites nothing;
   - aal_now() is the database's time for anon and authenticated, and no one else. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SQL = read('supabase/review-fixes-2026-11-10.sql');
const code = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const fn = (src, name) => { const s = src.slice(src.indexOf('create or replace function public.' + name + '(')); return s.slice(0, s.indexOf('end $$;') + 7); };

test('review-fixes SQL: one transaction, prerequisites first, every function pins search_path, nothing dropped', () => {
  assert.match(code, /^\s*begin;/m);
  assert.match(code.trim(), /commit;$/);
  assert.equal((code.match(/^\s*begin;/gm) || []).length, 1);
  const first = code.indexOf("raise exception 'Run payment-start-2026-10-14.sql before review-fixes-2026-11-10.sql'");
  assert.ok(first > 0 && first < code.indexOf('alter table'), 'the check comes before any change');
  assert.match(code, /raise exception 'Run admin\.sql and theme-2026-09-28\.sql before review-fixes-2026-11-10\.sql'/);
  const fns = [...SQL.matchAll(/create or replace function (public\.\w+)\([^)]*\)[^\n]*\n([^\n]*)/g)];
  assert.deepEqual(fns.map((m) => m[1]), ['public.aal_admin_write_profile', 'public.aal_settle_demo', 'public.aal_now']);
  for (const m of fns) assert.match(m[2], /set search_path = public, extensions, pg_temp as \$\$/, m[1]);
  assert.doesNotMatch(code, /\bdrop (table|function|policy)\b/i);
  assert.doesNotMatch(code, /function public\.(aal_snapshot|aal_mutate)\b/);
  assert.match(code, /alter table public\.venue_profiles alter column demo_payments set default false;/);
  assert.match(code, /drop trigger if exists kv_rows_settle_demo on public\.kv_rows;\s*create trigger kv_rows_settle_demo before insert or update on public\.kv_rows\s*for each row when \(new\.collection = 'aal\.settle'\) execute function public\.aal_settle_demo\(\);/);
  assert.match(code, /revoke all on function public\.aal_now\(\) from public;\s*grant execute on function public\.aal_now\(\) to anon, authenticated;/);
  assert.match(code, /revoke all on function public\.aal_admin_write_profile\(text, jsonb\) from public, anon, authenticated;/);
  assert.match(code, /revoke all on function public\.aal_settle_demo\(\) from public, anon, authenticated;/);
  assert.doesNotMatch(SQL, /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role_key\s*=/);
  // listed in the install order
  assert.match(read('supabase/README.md'), /review-fixes-2026-11-10\.sql/);
});

test('review-fixes SQL: aal_admin_write_profile is theme-2026-09-28.sql\'s text with only the "-- review" lines changed; the base files are off by default too', () => {
  const theme = fn(read('supabase/theme-2026-09-28.sql'), 'aal_admin_write_profile');
  const mine = fn(SQL, 'aal_admin_write_profile');
  const marked = mine.split('\n').filter((l) => /-- review$/.test(l));
  assert.equal(marked.length, 2);
  const expected = theme
    .replace('language plpgsql volatile set search_path = public, pg_temp as $$', () => 'language plpgsql volatile set search_path = public, extensions, pg_temp as $$ -- review')
    .replace('cur.demo_payments, false);', () => 'cur.demo_payments, false); -- review');
  assert.equal(mine, expected);
  // a fresh install is right too: the column default and both earlier fallbacks are off
  assert.match(read('supabase/admin.sql'), /demo_payments boolean not null default false,/);
  for (const f of ['supabase/admin.sql', 'supabase/theme-2026-09-28.sql']) {
    const body = fn(read(f), 'aal_admin_write_profile');
    assert.match(body, /cur\.demo_payments, false\);/, f);
    assert.doesNotMatch(body, /cur\.demo_payments, true\)/, f);
  }
  // the admin page reads a missing flag as off
  assert.match(read('admin.html'), /demo:p\.demo_payments===true\}/);
});

test('admin.html: a profile without demo_payments reads as demo payments off', () => {
  const html = read('admin.html');
  const m = /function profileOf\(v\)\{[\s\S]*?\n {2}\}/.exec(html);
  assert.ok(m);
  const vm = require('node:vm'), ctx = {};
  vm.runInNewContext('function ridParts(rid){ try{ var a=JSON.parse(rid); if(Array.isArray(a))return a; }catch(e){} return ["",""]; }\n' + m[0] + '\nthis.profileOf=profileOf;', ctx);
  assert.equal(ctx.profileOf({ restaurant_id: '["x",""]', profile: { name: 'X' } }).demo, false);
  assert.equal(ctx.profileOf({ restaurant_id: '["x",""]', profile: null }).demo, false);
  assert.equal(ctx.profileOf({ restaurant_id: '["x",""]', profile: { demo_payments: true } }).demo, true);
  assert.equal(ctx.profileOf({ restaurant_id: '["x",""]', profile: { demo_payments: false } }).demo, false);
});

const modulePath = process.env.PGLITE_MODULE;
test('review-fixes SQL against PostgreSQL: default off, flags kept, demo derived and backfilled, aal_now', { skip: !modulePath }, async () => {
  const { PGlite } = require(modulePath), db = new PGlite();
  const sql = (f) => read('supabase/' + f).replace('create extension if not exists pgcrypto;', '');
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create role nobody;');
    await db.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
    await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
    await assert.rejects(db.exec(sql('review-fixes-2026-11-10.sql')), /Run payment-start-2026-10-14\.sql/);
    await db.exec('rollback');
    for (const f of ['migration.sql', 'site-events.sql', 'hardening-2026-09-15.sql', 'hardening-2026-09-24.sql', 'admin.sql', 'sessions-2026-09-24.sql',
      'auth-2026-09-24.sql', 'followups-2026-09-24.sql']) await db.exec(sql(f));
    // the live project as it stands: demo payments on by default (the text before this review)
    await db.exec(sql('theme-2026-09-28.sql').replace('cur.demo_payments, false);', 'cur.demo_payments, true);'));
    await db.exec('alter table public.venue_profiles alter column demo_payments set default true');
    for (const f of ['payments-2026-09-30.sql', 'integrations-2026-09-30.sql', 'groups-2026-10-28.sql', 'payment-start-2026-10-14.sql']) await db.exec(sql(f));
    await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
    const as = async (role, headers, claims) => { await db.exec('reset role'); await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)", [JSON.stringify(headers || {}), JSON.stringify(claims || { role })]); await db.exec('set role ' + role); };
    const one = async (q, args) => (await db.query(q, args)).rows[0].value;
    const admin = () => as('anon', { 'x-aalayna-admin': 'adm_test' });
    const register = (name, profile) => one("select aal_admin_register_venue($1,'Hamra',$2,$3::jsonb) as value", [name, name.toLowerCase() + '-hamra', JSON.stringify(profile)]);
    await admin();
    const mayda = await register('Mayda', { demo_payments: true });
    const kababji = await register('Kababji', {});   // on by the old default
    assert.equal(kababji.profile.demo_payments, true, 'the bug as it is live');
    // payments stored before the file: two confirmed, one cash, one initiated with a stale flag
    await db.exec('reset role');
    const rid = mayda.restaurant_id;
    const put = (id, body) => db.query("insert into kv_rows values($1,'aal.settle',$2,$3,now())", [rid, id, JSON.stringify(Object.assign({ id, venueId: rid, checkId: 'old-bill', rail: 'card', amount: 5, tip: 0, currency: 'USD' }, body))]);
    await put('old-fake', { status: 'confirmed', externalRef: 'fake-old-1' });
    await put('old-real', { status: 'confirmed', externalRef: 'whish-9' });
    await put('old-cash', { status: 'confirmed', rail: 'cash' });
    await put('old-init', { status: 'initiated', demo: true });
    await put('old-ok', { status: 'cancelled' });

    await db.exec(sql('review-fixes-2026-11-10.sql'));
    const bodies = async () => Object.fromEntries((await db.query("select id, body, updated_at from kv_rows where collection='aal.settle' and restaurant_id=$1", [rid])).rows.map((r) => [r.id, r]));
    let b = await bodies();
    assert.deepEqual(['old-fake', 'old-real', 'old-cash', 'old-init', 'old-ok'].map((id) => b[id].body.demo), [true, false, false, undefined, undefined]);
    assert.equal(b['old-fake'].body.externalRef, 'fake-old-1', 'nothing else changes');
    const stamps = Object.fromEntries(Object.entries(b).map(([id, r]) => [id, String(r.updated_at)]));
    await db.exec(sql('review-fixes-2026-11-10.sql'));   // safe to re-run: nothing is rewritten
    b = await bodies();
    assert.deepEqual(Object.fromEntries(Object.entries(b).map(([id, r]) => [id, String(r.updated_at)])), stamps);

    // flags already on stay on; new venues are off unless the admin says otherwise
    await admin();
    const list = await one('select aal_admin_list_venues() as value');
    const flag = (r) => list.find((v) => v.restaurant_id === r).profile.demo_payments;
    assert.equal(flag(mayda.restaurant_id), true);
    assert.equal(flag(kababji.restaurant_id), true);
    const tawlet = await register('Tawlet', {});
    assert.equal(tawlet.profile.demo_payments, false);
    assert.equal((await one('select aal_admin_update_profile($1,$2::jsonb) as value', [tawlet.restaurant_id, JSON.stringify({ font: 'Cairo' })])).profile.demo_payments, false);
    assert.equal((await one('select aal_admin_update_profile($1,$2::jsonb) as value', [tawlet.restaurant_id, JSON.stringify({ demo_payments: true })])).profile.demo_payments, true);
    assert.equal((await one('select aal_admin_update_profile($1,$2::jsonb) as value', [tawlet.restaurant_id, JSON.stringify({ font: 'Inter' })])).profile.demo_payments, true, 'a profile without the flag keeps it');
    await db.exec('reset role');
    const col = (await db.query("select column_default from information_schema.columns where table_schema='public' and table_name='venue_profiles' and column_name='demo_payments'")).rows[0];
    assert.equal(col.column_default, 'false');

    // a live payment, confirmed by the fake provider, then a cash one
    await as('anon', { 'x-aalayna-key': mayda.owner_key });
    const call = (op, body, token = '') => one('select aal_mutate($1,$2,$3::jsonb,$4) as value', [rid, op, JSON.stringify(body), token]);
    await call('open_check', { id: 'bill-1', table: 4, lines: [{ id: 'i1', q: 2, p: 40, name: 'Grill' }], currency: 'USD' });
    const guestKey = (await call('issue_key', { checkId: 'bill-1' })).key;
    const payer = 'p'.repeat(40);
    await as('anon', { 'x-aalayna-key': guestKey });
    const reserved = await call('reserve', { id: 'pay-1', requestId: 'pay-1', checkId: 'bill-1', amount: 10, tip: 0, rail: 'card', items: {}, demo: true }, payer);
    assert.equal(reserved.status, 'initiated');
    assert.equal('demo' in reserved, false, 'a guest cannot set it');
    await as('service_role', {}, { role: 'service_role' });
    const confirmed = await call('confirm_digital', { id: 'pay-1', externalRef: 'fake-pay-1-abcd', amountCents: 1000, currency: 'USD' });
    assert.equal(confirmed.status, 'confirmed');
    await as('anon', { 'x-aalayna-key': guestKey });
    await call('reserve', { id: 'cash-1', requestId: 'cash-1', checkId: 'bill-1', amount: 30, tip: 0, rail: 'cash', items: {} }, payer);
    await as('anon', { 'x-aalayna-key': mayda.owner_key });
    await call('confirm_cash', { id: 'cash-1' });
    // the guest's snapshot: demo kept, externalRef still stripped
    await as('anon', { 'x-aalayna-key': guestKey });
    const snap = await one('select aal_snapshot($1) as value', [rid]);
    const row = (id) => snap.rows.find((r) => r.collection === 'aal.settle' && r.id === id).body;
    assert.equal(row('pay-1').demo, true);
    assert.equal('externalRef' in row('pay-1'), false);
    assert.equal(row('cash-1').demo, false);
    // the owner sees the reference and the same flag
    await as('anon', { 'x-aalayna-key': mayda.owner_key });
    const own = await one('select aal_snapshot($1) as value', [rid]);
    const ownRow = own.rows.find((r) => r.id === 'pay-1').body;
    assert.deepEqual([ownRow.externalRef, ownRow.demo], ['fake-pay-1-abcd', true]);
    // no write sets or clears it, not even the table owner's
    await db.exec('reset role');
    await db.query("update kv_rows set body = body || '{\"demo\": true}' where restaurant_id=$1 and id='cash-1'", [rid]);
    await db.query("update kv_rows set body = body - 'demo' where restaurant_id=$1 and id='pay-1'", [rid]);
    await db.query("update kv_rows set body = jsonb_set(body, '{demo}', 'false') where restaurant_id=$1 and id='old-fake'", [rid]);
    b = await bodies();
    assert.deepEqual([b['cash-1'].body.demo, b['pay-1'].body.demo, b['old-fake'].body.demo], [false, true, true]);
    // other collections are untouched
    await db.query("insert into kv_rows values($1,'aal.campaigns','c-1',$2,now())", [rid, JSON.stringify({ venueId: rid, status: 'confirmed', externalRef: 'fake-x', demo: 'kept' })]);
    assert.equal((await db.query("select body->>'demo' as d from kv_rows where id='c-1'")).rows[0].d, 'kept');

    // the database's clock
    for (const role of ['anon', 'authenticated']) {
      await as(role, {});
      const r = (await db.query('select aal_now() as now, pg_typeof(aal_now())::text as type, aal_now() = now() as same')).rows[0];
      assert.equal(r.type, 'timestamp with time zone');
      assert.equal(r.same, true);
      assert.ok(r.now instanceof Date && Math.abs(r.now.getTime() - Date.now()) < 60000);
    }
    await as('nobody', {});
    await assert.rejects(db.query('select aal_now()'), /permission denied/);
  } finally { await db.close(); }
});
