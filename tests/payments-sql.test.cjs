/* supabase/payments-2026-09-30.sql (T14): the payment callbacks log, the email outbox, the
   receipt trigger, the claim and payment-failed functions and the pg_cron job.
   Static checks always run. With PGLITE_MODULE pointing at @electric-sql/pglite (see
   supabase/README.md) the file is applied twice after the earlier files and behaves as stated:
   - a guest's receipt request on a confirmed digital payment queues exactly one outbox row,
     with the SHA-256 of the address and not the address; asking again queues nothing;
   - through pg_net (a stand-in net.http_post) the trigger posts to the project's
     /functions/v1/receipt-email (or aalayna_functions_url's) with X-Aalayna-Cron from Vault;
     without pg_net or the secret it does nothing and the receipt op still succeeds;
   - aal_outbox_claim takes due rows once (lease), service role only;
   - aal_payment_failed turns an initiated payment into 'failed' with an event, is a no-op
     the second time, refuses a confirmed payment, and is closed to anon;
   - payment_callbacks and outbox_email are closed to anon and authenticated; the service role
     may add callbacks but not change or delete them;
   - with pg_cron (a stand-in cron.schedule) the job 'aalayna-receipt-email' runs every minute. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const SQL = fs.readFileSync(path.join(root, 'supabase', 'payments-2026-09-30.sql'), 'utf8');
const code = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('payments SQL: one transaction, prerequisites checked first, nothing existing replaced', () => {
  assert.match(code, /^\s*begin;/m);
  assert.match(code.trim(), /commit;$/);
  assert.equal((code.match(/^\s*begin;/gm) || []).length, 1);
  const first = code.indexOf('raise exception \'Run auth-2026-09-24.sql before payments-2026-09-30.sql\'');
  assert.ok(first > 0 && first < code.indexOf('create table'), 'the check comes before any change');
  // aal_mutate and every earlier function are left alone
  const replaced = [...code.matchAll(/create or replace function (public\.\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(replaced, ['public.aal_outbox_claim', 'public.aal_payment_failed', 'public.aal_receipt_email_kick', 'public.aal_receipt_enqueue']);
  for (const other of fs.readdirSync(path.join(root, 'supabase')).filter((f) => f.endsWith('.sql') && f !== 'payments-2026-09-30.sql')) {
    const src = fs.readFileSync(path.join(root, 'supabase', other), 'utf8');
    for (const fn of replaced) assert.ok(!src.includes('function ' + fn + '('), fn + ' is new, not in ' + other);
  }
  assert.doesNotMatch(code, /\bdrop (table|function|policy)\b/i);
  assert.doesNotMatch(code, /alter table public\.(kv_rows|kv_docs|venue_profiles)/);
});

test('payments SQL: every function pins search_path; tables and functions are closed to anon and authenticated', () => {
  const fns = [...code.matchAll(/create or replace function[\s\S]*?\$\$/g)].map((m) => m[0]);
  assert.equal(fns.length, 4);
  for (const f of fns) assert.match(f, /set search_path = public, extensions, pg_temp as \$\$$/);
  for (const f of fns) assert.match(f, /security definer/);
  for (const t of ['payment_callbacks', 'outbox_email']) {
    assert.match(code, new RegExp('alter table public\\.' + t + ' enable row level security;'));
    assert.match(code, new RegExp('revoke all on public\\.' + t + ' from public, anon, authenticated;'));
    assert.doesNotMatch(code, new RegExp('grant [^;]* on public\\.' + t + ' to [^;]*(anon|authenticated)'));
  }
  assert.match(code, /revoke update, delete, truncate on public\.payment_callbacks from service_role;/);
  for (const sig of ['aal_receipt_email_kick(boolean)', 'aal_receipt_enqueue()', 'aal_outbox_claim(text, integer, integer)', 'aal_payment_failed(text, text, text)']) {
    assert.ok(code.includes('revoke all on function public.' + sig + ' from public, anon, authenticated;'), sig);
  }
  assert.match(code, /grant execute on function public\.aal_outbox_claim\(text, integer, integer\) to service_role;/);
  assert.match(code, /grant execute on function public\.aal_payment_failed\(text, text, text\) to service_role;/);
  assert.doesNotMatch(code, /grant execute on function public\.aal_receipt_email_kick/);
  assert.doesNotMatch(code, /to (anon|authenticated)\b/);
});

test('payments SQL: one receipt per settlement, a trigger only on the first customerId, no secret in the file', () => {
  assert.match(code, /create unique index if not exists outbox_email_once on public\.outbox_email \(restaurant_id, kind, ref\);/);
  assert.match(code, /on conflict \(restaurant_id, kind, ref\) do nothing/);
  assert.match(code, /create trigger kv_rows_receipt_enqueue after update on public\.kv_rows\s+for each row\s+when \(new\.collection = 'aal\.settle' and \(new\.body->>'customerId'\) is not null and \(old\.body->>'customerId'\) is null\)/);
  assert.match(code, /drop trigger if exists kv_rows_receipt_enqueue on public\.kv_rows;/);
  assert.match(code, /status in \('queued', 'sending', 'sent', 'failed', 'skipped'\)/);
  // the trigger never fails the guest's request
  const enqueue = code.slice(code.indexOf('function public.aal_receipt_enqueue'), code.indexOf('revoke all on function public.aal_receipt_enqueue'));
  assert.match(enqueue, /exception when others then\s+raise warning/);
  // the address is hashed, never stored
  assert.match(enqueue, /encode\(sha256\(convert_to\(v_contact, 'UTF8'\)\), 'hex'\)/);
  assert.doesNotMatch(code, /\bcontact\s+text/);
  // pg_net, Vault and pg_cron are optional and reached through execute
  assert.match(code, /to_regprocedure\('net\.http_post\(text,jsonb,jsonb,jsonb,integer\)'\) is null/);
  assert.match(code, /to_regprocedure\('cron\.schedule\(text,text,text\)'\) is not null/);
  assert.match(code, /cron\.schedule\('aalayna-receipt-email', '\* \* \* \* \*', 'select public\.aal_receipt_email_kick\(true\)'\)/);
  assert.match(code, /'X-Aalayna-Cron', v_secret/);
  assert.doesNotMatch(SQL, /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|re_[A-Za-z0-9]{8,}|service_role_key\s*=/);
});

test('payments SQL: aal_payment_failed takes the venue lock and requires the service role', () => {
  const f = code.slice(code.indexOf('function public.aal_payment_failed'), code.indexOf('revoke all on function public.aal_payment_failed'));
  const role = f.indexOf("<> 'service_role'"), lock = f.indexOf('pg_advisory_xact_lock(hashtextextended(p_rid, 0))'), upd = f.indexOf('update public.kv_rows');
  assert.ok(role > 0 && lock > role && upd > lock);
  assert.match(f, /if p->>'status' <> 'initiated' then raise exception 'Payment already completed'/);
  assert.match(f, /'eventType', 'payment_cancelled'/);
});

const modulePath = process.env.PGLITE_MODULE;
test('payments SQL against PostgreSQL: receipt queue, pg_net poke, claim, payment failed, privileges, cron', { skip: !modulePath }, async () => {
  const { PGlite } = require(modulePath), db = new PGlite();
  const sql = (f) => fs.readFileSync(path.join(root, 'supabase', f), 'utf8').replace('create extension if not exists pgcrypto;', '');
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');   // as on Supabase: the service role bypasses RLS
    await db.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
    await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
    await assert.rejects(db.exec(sql('payments-2026-09-30.sql')), /Run auth-2026-09-24\.sql/);
    await db.exec('rollback');
    for (const f of ['migration.sql', 'site-events.sql', 'hardening-2026-09-15.sql', 'hardening-2026-09-24.sql', 'admin.sql', 'sessions-2026-09-24.sql', 'auth-2026-09-24.sql', 'followups-2026-09-24.sql', 'theme-2026-09-28.sql']) await db.exec(sql(f));
    await db.exec(sql('payments-2026-09-30.sql'));   // no pg_net, Vault or pg_cron: installs, schedules nothing
    await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
    const as = async (role, headers, claims) => { await db.exec('reset role'); await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)", [JSON.stringify(headers || {}), JSON.stringify(claims || { role })]); await db.exec('set role ' + role); };
    const one = async (q, args) => (await db.query(q, args)).rows[0].value;
    const asOwner = async () => { await db.exec('reset role'); return (await db.query('select * from outbox_email order by created_at')).rows; };
    await as('anon', { 'x-aalayna-admin': 'adm_test' });
    const v = await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra','{}'::jsonb) as value");
    const rid = v.restaurant_id;
    const mutate = (op, body, token = '') => one('select aal_mutate($1,$2,$3::jsonb,$4) as value', [rid, op, JSON.stringify(body), token]);
    await as('anon', { 'x-aalayna-key': v.owner_key });
    await mutate('open_check', { id: 'bill-7', table: 7, lines: [{ id: 'k1', q: 2, p: 20, name: 'Shish taouk' }], currency: 'USD' });
    const key = (await mutate('issue_key', { checkId: 'bill-7' })).key;
    const T1 = 't'.repeat(40), T2 = 'u'.repeat(40), T3 = 'v'.repeat(40);
    await as('anon', { 'x-aalayna-key': key });
    const p1 = await mutate('reserve', { id: 'p1', checkId: 'bill-7', amount: 11, tip: 1, rail: 'whish', items: {} }, T1);
    assert.equal(p1.status, 'initiated');
    await as('service_role', {}, { role: 'service_role' });
    assert.equal((await mutate('confirm_digital', { id: 'p1', externalRef: 'fake-1', amountCents: 1100, currency: 'USD' })).status, 'confirmed');
    // the receipt request queues one row, hashed, and nothing else
    await as('anon', { 'x-aalayna-key': key });
    assert.deepEqual(await mutate('receipt', { id: 'p1', contact: 'Layla@Example.com', channel: 'email', receipt: true, marketing: true, requestId: 'r1' }, T1), { saved: true });
    let rows = await asOwner();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].kind, rows[0].ref, rows[0].restaurant_id, rows[0].status, rows[0].attempts], ['receipt', 'p1', rid, 'queued', 0]);
    assert.equal(rows[0].to_hash, crypto.createHash('sha256').update('layla@example.com').digest('hex'));
    assert.doesNotMatch(JSON.stringify(rows[0]), /layla/i);
    await as('anon', { 'x-aalayna-key': key });
    await mutate('receipt', { id: 'p1', contact: 'layla@example.com', channel: 'email', receipt: true, marketing: false, requestId: 'r2' }, T1);
    assert.equal((await asOwner()).length, 1, 'one receipt per settlement');
    // closed to anon and authenticated
    for (const role of ['anon', 'authenticated']) {
      await as(role, { 'x-aalayna-key': v.owner_key });
      await assert.rejects(db.query('select * from outbox_email'), /permission denied/);
      await assert.rejects(db.query('select * from payment_callbacks'), /permission denied/);
      await assert.rejects(db.query("insert into payment_callbacks(provider,outcome,http_status) values('fake','x',200)"), /permission denied/);
      await assert.rejects(db.query("select aal_outbox_claim('receipt',10,120)"), /permission denied/);
      await assert.rejects(db.query("select aal_payment_failed($1,'p1','x')", [rid]), /permission denied/);
      await assert.rejects(db.query('select aal_receipt_email_kick(false)'), /permission denied/);
    }
    // the sender's claim: once, then leased
    await as('service_role', {}, { role: 'service_role' });
    const claimed = (await db.query("select * from aal_outbox_claim('receipt',10,120)")).rows;
    assert.equal(claimed.length, 1);
    assert.deepEqual([claimed[0].status, claimed[0].attempts], ['sending', 1]);
    assert.ok(new Date(claimed[0].locked_until) > new Date());
    assert.equal((await db.query("select * from aal_outbox_claim('receipt',10,120)")).rows.length, 0);
    assert.equal((await db.query("select * from aal_outbox_claim('daily_close',10,120)")).rows.length, 0);
    await db.query("update outbox_email set status='sent', sent_at=now(), provider_id='rs_1', locked_until=null where id=$1", [claimed[0].id]);
    await assert.rejects(db.query('delete from outbox_email'), /permission denied/);
    // the callbacks log: the service role adds, never changes
    await db.query("insert into payment_callbacks(provider,external_ref,payment_id,restaurant_id,amount_cents,currency,status,outcome,http_status,server_reply) values('fake','fake-1','p1',$1,1100,'USD','paid','confirmed',200,'Confirmed')", [rid]);
    await assert.rejects(db.query("update payment_callbacks set outcome='x'"), /permission denied/);
    await assert.rejects(db.query('delete from payment_callbacks'), /permission denied/);
    // a provider says a payment failed
    await as('anon', { 'x-aalayna-key': key });
    await mutate('reserve', { id: 'p2', checkId: 'bill-7', amount: 5, tip: 0, rail: 'card', items: {} }, T2);
    await as('service_role', {}, { role: 'service_role' });
    const failed = await one("select aal_payment_failed($1,'p2','fake-2') as value", [rid]);
    assert.deepEqual([failed.status, failed.failureRef], ['failed', 'fake-2']);
    assert.equal((await one("select aal_payment_failed($1,'p2','fake-2') as value", [rid])).failedAt, failed.failedAt);
    await assert.rejects(db.query("select aal_payment_failed($1,'p1','fake-1')", [rid]), /Payment already completed/);
    await assert.rejects(db.query("select aal_payment_failed($1,'nope','x')", [rid]), /Payment unavailable/);
    await db.exec('reset role');
    const evs = (await db.query("select body from kv_rows where collection='aal.events' and body->>'eventType'='payment_cancelled'")).rows;
    assert.equal(evs.length, 1);
    assert.equal(evs[0].body.payload.reason, 'failed');
    // the released amount is reservable again: the whole remaining balance ($20 bill, $10 paid)
    await as('anon', { 'x-aalayna-key': key });
    await mutate('reserve', { id: 'p3', checkId: 'bill-7', amount: 10, tip: 0, rail: 'cash', items: {} }, T3);
    // pg_net, Vault and pg_cron present: re-run the file, then a receipt pokes the sender
    await db.exec('reset role');
    await db.exec(`create schema net; create table net.calls(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer);
      create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
        language sql as $$ insert into net.calls values (url, body, params, headers, timeout_milliseconds) returning 7::bigint $$;
      create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);
      create schema cron; create table cron.jobs(name text primary key, schedule text, command text);
      create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
        insert into cron.jobs values (job_name, schedule, command) on conflict (name) do update set schedule = excluded.schedule, command = excluded.command returning 1::bigint $$;`);
    await db.exec(sql('payments-2026-09-30.sql'));
    await db.exec(sql('payments-2026-09-30.sql'));
    assert.deepEqual((await db.query('select * from cron.jobs')).rows, [{ name: 'aalayna-receipt-email', schedule: '* * * * *', command: 'select public.aal_receipt_email_kick(true)' }]);
    // no secrets in Vault yet: nothing is posted, and the receipt op still works
    await as('anon', { 'x-aalayna-key': v.owner_key });
    await mutate('confirm_cash', { id: 'p3' });
    await mutate('receipt', { id: 'p3', contact: '+9613123456', channel: 'whatsapp', receipt: true, marketing: false, requestId: 'r3' });
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int n from net.calls')).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from outbox_email where ref='p3'")).rows[0].n, 1);
    // with the secrets, the next receipt posts once to the function with the cron header
    await db.exec("insert into vault.decrypted_secrets values ('aalayna_cron_secret','cron-test-value')");
    await as('anon', { 'x-aalayna-key': v.owner_key });
    await mutate('open_check', { id: 'bill-8', table: 8, lines: [{ id: 'k1', q: 1, p: 9, name: 'Hummus' }], currency: 'USD' });
    await mutate('reserve', { id: 'p4', checkId: 'bill-8', amount: 9, tip: 0, rail: 'cash', items: {} }, 'w'.repeat(40));
    await mutate('confirm_cash', { id: 'p4' });
    await mutate('receipt', { id: 'p4', contact: 'sami@example.com', channel: 'email', receipt: true, marketing: false, requestId: 'r4' });
    await db.exec('reset role');
    const calls = (await db.query('select * from net.calls')).rows;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1/receipt-email');
    assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json', 'X-Aalayna-Cron': 'cron-test-value' });
    // the cron kick posts only when something is due
    await db.exec("update outbox_email set status='sent'");
    assert.equal(await one('select aal_receipt_email_kick(true) as value'), null);
    await db.exec("update outbox_email set status='queued', next_attempt_at=now() where ref='p4'");
    assert.equal(await one('select aal_receipt_email_kick(true) as value'), 7);
    // another project: the URL comes from Vault
    await db.exec("insert into vault.decrypted_secrets values ('aalayna_functions_url','https://staging.supabase.co/functions/v1/')");
    await one('select aal_receipt_email_kick(true) as value');
    assert.deepEqual((await db.query('select url from net.calls')).rows.map((r) => r.url).slice(-2),
      ['https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1/receipt-email', 'https://staging.supabase.co/functions/v1/receipt-email']);
    // a broken outbox never refuses the guest: the trigger only warns
    await db.exec('alter table outbox_email add constraint no_more check (false) not valid');
    await as('anon', { 'x-aalayna-key': v.owner_key });
    await mutate('open_check', { id: 'bill-9', table: 9, lines: [{ id: 'k1', q: 1, p: 9, name: 'Hummus' }], currency: 'USD' });
    await mutate('reserve', { id: 'p5', checkId: 'bill-9', amount: 9, tip: 0, rail: 'cash', items: {} }, 'y'.repeat(40));
    await mutate('confirm_cash', { id: 'p5' });
    assert.deepEqual(await mutate('receipt', { id: 'p5', contact: 'nour@example.com', channel: 'email', receipt: true, marketing: false, requestId: 'r5' }), { saved: true });
    await db.exec('reset role');
    assert.equal((await db.query("select body->>'customerId' c from kv_rows where collection='aal.settle' and id='p5'")).rows[0].c.length > 0, true);
    assert.equal((await db.query("select count(*)::int n from outbox_email where ref='p5'")).rows[0].n, 0);
  } finally { await db.close(); }
});
