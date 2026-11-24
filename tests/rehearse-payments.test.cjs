/* tools/rehearse-payments.js: the stand-in for the shared store behaves as live does where the
   guest page depends on it (2026-11-10 review):
   - POST /rest/v1/rpc/aal_now answers the server's time as a JSON string (an ISO timestamp);
   - reserve refuses an amount or a tip that is not a number (the SQL casts both ::numeric),
     so a tip of 'x' cannot slip past the balance check, with the SQL's own message;
   - (2026-11-24, with PGLITE_MODULE) every request in CASES gets the same answer from the
     stand-in and from aal_mutate in PostgreSQL: rounding, casts, item claims, cash, resends,
     tokens, confirm_digital and the receipt rules;
   - a fake-provider payment, reserved, handed to the real payment-start, paid on the fake
     checkout and confirmed by the real payment-webhook, reaches the guest's snapshot without
     externalRef (aal_snapshot strips it) and with demo: true (kv_rows_settle_demo). */
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const tool = require('../tools/rehearse-payments.js');
const { postgrest, KEY, RID, CHECK, SELF, db } = tool;

const guest = (op, body, token = 'g'.repeat(40)) => postgrest(SELF + '/rest/v1/rpc/aal_mutate', {
  method: 'POST', headers: { 'x-aalayna-key': KEY }, body: JSON.stringify({ p_rid: RID, p_op: op, p_body: body, p_token: token }),
});
const read = async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || 'null') });
const quiet = (() => { const orig = console.log; return async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = orig; } }; })();

test('rehearsal stand-in: aal_now answers the server time as a JSON string', async () => {
  const before = Date.now();
  const r = await read(await postgrest(SELF + '/rest/v1/rpc/aal_now', { method: 'POST', headers: {}, body: '{}' }));
  assert.equal(r.status, 200);
  assert.equal(typeof r.body, 'string');
  assert.match(r.body, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/);
  const t = Date.parse(r.body);
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000);
});

test('rehearsal stand-in: reserve requires numbers for amount and tip, as the SQL casts do', async () => {
  await quiet(async () => {
    const base = { checkId: CHECK.id, rail: 'card', items: {} };
    for (const [id, over, message] of [['bad-tip', { amount: 1000, tip: 'x' }, 'invalid input syntax for type numeric: "x"'], ['bad-amount', { amount: 'lots', tip: 0 }, 'invalid input syntax for type numeric: "lots"'], ['obj-tip', { amount: 6, tip: {} }, 'invalid input syntax for type numeric: "{}"'], ['inf', { amount: 6, tip: '1e999' }, 'bigint out of range'], ['nan', { amount: 'NaN', tip: 0 }, 'cannot convert NaN to bigint']]) {
      const r = await read(await guest('reserve', Object.assign({ id, requestId: id }, base, over)));
      assert.equal(r.status, 400, id);
      assert.equal(r.body.message, message, id);   // live's own message (the SQL's cast), so the guest page words it as live does
      assert.equal(db.settle.has(id), false, id);
    }
    // a number is still checked against the balance
    let r = await read(await guest('reserve', Object.assign({ id: 'too-much', requestId: 'too-much', amount: 1000, tip: 0 }, base)));
    assert.match(r.body.message, /already covers this balance/);
    // numeric strings are what ::numeric accepts
    r = await read(await guest('reserve', Object.assign({ id: 'str-ok', requestId: 'str-ok', amount: '6', tip: '1' }, base)));
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.amount, r.body.tip, r.body.status], [6, 1, 'initiated']);
    await guest('cancel', { id: 'str-ok' });
  });
});

test('rehearsal stand-in: a demo confirmation reaches the guest with demo: true and without externalRef', async () => {
  await quiet(async () => {
    const logs = [];
    const fns = await tool.functionHandlers({ log: { warn: (...a) => logs.push(a.join(' ')), info() {} } });
    const token = crypto.randomBytes(24).toString('hex');
    let r = await read(await guest('reserve', { id: 'demo-1', requestId: 'demo-1', checkId: CHECK.id, amount: 13, tip: 1, rail: 'card', items: {} }, token));
    assert.equal(r.body.status, 'initiated');
    assert.equal('demo' in r.body, false, 'no demo key before confirmation');
    const headers = { 'x-aalayna-key': KEY, 'x-aalayna-payer': token, Origin: SELF, 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' };
    r = await read(await fns['payment-start'](new Request(SELF + '/functions/v1/payment-start', { method: 'POST', headers, body: JSON.stringify({ paymentId: 'demo-1', returnUrl: SELF + '/guest.html?venue=Mayda&place=Hamra&k=' + KEY }) })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = new URL(r.body.url).searchParams.get('s');
    r = await read(await fns['payment-start'](new Request(SELF + '/functions/v1/payment-start/fake/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SELF }, body: JSON.stringify({ s, outcome: 'paid' }) })));
    assert.deepEqual([r.status, r.body.outcome, r.body.result], [200, 'paid', 'confirmed'], JSON.stringify(r.body) + logs.join('\n'));
    // the store keeps the reference; the guest sees the flag, never the reference
    assert.match(db.settle.get('demo-1').externalRef, /^fake-demo-1-/);
    const snap = await read(await postgrest(SELF + '/rest/v1/rpc/aal_snapshot', { method: 'POST', headers: { 'x-aalayna-key': KEY }, body: JSON.stringify({ p_rid: RID }) }));
    const row = snap.body.rows.find((x) => x.id === 'demo-1').body;
    assert.equal(row.status, 'confirmed');
    assert.equal(row.demo, true);
    for (const k of ['externalRef', 'deviceId', 'sessionId', 'customerId', 'identityId', 'payerRef']) assert.equal(k in row, false, k);
    // the stand-in derives it as the trigger does: no other reference is a demo
    db.settle.set('real-1', { id: 'real-1', status: 'initiated', expiresAt: new Date(Date.now() + 60000).toISOString(), amount: 1, currency: 'USD' });
    tool.mutate('confirm_digital', { id: 'real-1', externalRef: 'whish-123', amountCents: 100, currency: 'USD' }, '', true);
    assert.equal(db.settle.get('real-1').demo, false);
    db.settle.delete('real-1');
  });
});

/* 2026-11-24: the stand-in is not laxer than the database. With PGLITE_MODULE (see
   supabase/README.md) the same requests run through aal_mutate in PostgreSQL (the files up to
   auth-2026-09-24.sql, the bill the stand-in holds) and through the stand-in, and every answer
   must match: accepted with the same amounts, or refused with the same message. */
const modulePath = process.env.PGLITE_MODULE;
const T = 't'.repeat(40), U = 'u'.repeat(40);
/* each case: steps [op, body, token?, asService?], run on both stores from an empty bill */
const CASES = {
  'tip x': [['reserve', { amount: 10, tip: 'x' }]],
  'amount words': [['reserve', { amount: 'lots', tip: 0 }]],
  'tip object': [['reserve', { amount: 6, tip: {} }]],
  'tip boolean': [['reserve', { amount: 6, tip: true }]],
  'amount 1e999': [['reserve', { amount: 6, tip: '1e999' }]],
  'amount NaN': [['reserve', { amount: 'NaN', tip: 0 }]],
  'amount Infinity': [['reserve', { amount: 'Infinity', tip: 0 }]],
  'amount missing': [['reserve', { tip: 0 }]],
  'amount null, tip null': [['reserve', { amount: 6, tip: null }]],
  'numeric strings': [['reserve', { amount: ' 6.5 ', tip: '+0.50' }]],
  'exponent': [['reserve', { amount: '6.5e0', tip: '5e-1' }]],
  'tip -0.004 rounds to 0': [['reserve', { amount: 6, tip: -0.004 }]],
  'tip -0.005 rounds to -1 cent': [['reserve', { amount: 6, tip: -0.005 }]],
  'amount 1.005 is 101 cents': [['reserve', { amount: 1.005, tip: 0 }]],
  'amount 0.004 is 0 cents': [['reserve', { amount: 0.004, tip: 0 }]],
  'tip equals amount': [['reserve', { amount: 5, tip: 5 }]],
  'rail with a space': [['reserve', { amount: 5, tip: 0, rail: 'card ' }]],
  'rail as a number': [['reserve', { amount: 5, tip: 0, rail: 1 }]],
  'whole bill with tip': [['reserve', { amount: 40, tip: 1 }]],
  'a cent over': [['reserve', { amount: 39.01, tip: 0 }]],
  'huge amount': [['reserve', { amount: 1e17, tip: 0 }]],
  'second payment over the balance': [['reserve', { id: 'a', amount: 26, tip: 0 }], ['reserve', { id: 'b', amount: 14, tip: 0 }]],
  'items: one of two fattoush': [['reserve', { amount: 6.5, tip: 0.5, items: { i05: 1 } }]],
  'items: wrong amount': [['reserve', { amount: 6, tip: 0, items: { i05: 1 } }]],
  'items: half a dish': [['reserve', { amount: 6.5, tip: 0, items: { i05: 1.5 } }]],
  'items: 1.0 is whole': [['reserve', { amount: 6.5, tip: 0, items: { i05: '1.0' } }]],
  'items: more than the bill': [['reserve', { amount: 39, tip: 0, items: { i05: 3 } }]],
  'items: zero': [['reserve', { amount: 6.5, tip: 0, items: { i05: 0 } }]],
  'items: not on the bill': [['reserve', { amount: 6.5, tip: 0, items: { nope: 1 } }]],
  'items: an array': [['reserve', { amount: 6.5, tip: 0, items: [] }]],
  'items: null': [['reserve', { amount: 6.5, tip: 0, items: null }]],
  'items: a string': [['reserve', { amount: 6.5, tip: 0, items: 'i05' }]],
  'items: words': [['reserve', { amount: 6.5, tip: 0, items: { i05: 'one' } }]],
  'items: a null claim': [['reserve', { amount: 6, tip: 0, items: { i05: null } }]],
  'items: NaN': [['reserve', { amount: 6.5, tip: 0, items: { i05: 'NaN' } }]],
  'items: -Infinity': [['reserve', { amount: 6.5, tip: 0, items: { i05: '-Infinity' } }]],
  'items: jsonb key order': [['reserve', { amount: 6.5, tip: 0, items: { i14: 0, i05: 3 } }]],
  'items: thirds of a coffee pot': [['reserve', { amount: 7.5, tip: 0, items: { i14: 3 } }]],
  'items: the whole bill': [['reserve', { amount: 39, tip: 0, items: { i05: 2, i07: 1, i14: 4 } }]],
  'items: claimed twice': [['reserve', { id: 'a', amount: 13, tip: 0, items: { i05: 2 } }], ['reserve', { id: 'b', amount: 6.5, tip: 0, items: { i05: 1 } }]],
  'items: the rest after a claim': [['reserve', { id: 'a', amount: 6.5, tip: 0, items: { i05: 1 } }], ['reserve', { id: 'b', amount: 6.5, tip: 0, items: { i05: 1 } }]],
  'a cancelled claim frees the dish': [['reserve', { id: 'a', amount: 13, tip: 0, items: { i05: 2 } }], ['cancel', { id: 'a' }], ['reserve', { id: 'b', amount: 13, tip: 0, items: { i05: 2 } }]],
  'cash: note short': [['reserve', { amount: 6, tip: 0, rail: 'cash', note: 5 }]],
  'cash: note enough, change': [['reserve', { amount: 6, tip: 0, rail: 'cash', note: 10 }]],
  'cash: no note': [['reserve', { amount: 6, tip: 0, rail: 'cash', note: 0 }]],
  'card: note words': [['reserve', { amount: 6, tip: 0, note: 'abc' }]],
  'short payer token': [['reserve', { amount: 6, tip: 0 }, 'x'.repeat(31)]],
  'another bill': [['reserve', { amount: 6, tip: 0, checkId: 'bill-other' }]],
  'resend: the same request': [['reserve', { amount: 6, tip: 1 }], ['reserve', { amount: 6, tip: 1 }]],
  'resend: another token': [['reserve', { amount: 6, tip: 1 }], ['reserve', { amount: 6, tip: 1 }, U]],
  'resend: another tip': [['reserve', { amount: 6, tip: 1 }], ['reserve', { amount: 6, tip: 2 }]],
  'resend: amount as a string': [['reserve', { amount: 6, tip: 1 }], ['reserve', { amount: '6', tip: 1 }]],
  'resend: no items key': [['reserve', { amount: 6, tip: 1 }], ['reserve', { amount: 6, tip: 1, items: undefined }]],
  'cancel: wrong token, unknown payment, twice': [['reserve', { amount: 6, tip: 0 }], ['cancel', { id: 'x' }, U], ['cancel', { id: 'nope' }], ['cancel', { id: 'x' }], ['cancel', { id: 'x' }]],
  'confirm: cents as a string, then the receipt rules': [
    ['reserve', { amount: 6.5, tip: 0 }],
    ['confirm_digital', { id: 'x', externalRef: 'fake-1', amountCents: '6.5e2', currency: 'USD' }, '', true],
    ['confirm_digital', { id: 'x', externalRef: '', amountCents: 'oops', currency: 'USD' }, '', true],
    ['confirm_digital', { id: 'x', externalRef: 'fake-1', amountCents: 651, currency: 'USD' }, '', true],
    ['confirm_digital', { id: 'x', externalRef: 'fake-1', amountCents: 650, currency: 'usd' }, '', true],
    ['confirm_digital', { id: 'x', externalRef: 'fake-1', amountCents: ' 650 ', currency: 'USD' }, '', true],
    ['confirm_digital', { id: 'x', externalRef: 'fake-1', amountCents: 650, currency: 'USD' }, '', true],
    ['cancel', { id: 'x' }],
    ['receipt', { id: 'x', contact: 'a@b.co', channel: 'sms', receipt: true, marketing: false, requestId: 'r1' }],
    ['receipt', { id: 'x', contact: 'not-an-email', channel: 'email', receipt: true, marketing: false, requestId: 'r1' }],
    ['receipt', { id: 'x', contact: '+96170123456', channel: 'whatsapp', receipt: 'yes', marketing: false, requestId: 'r1' }],
    ['receipt', { id: 'x', contact: '0096170123', channel: 'whatsapp', receipt: true, marketing: false, requestId: 'r1' }],
    ['receipt', { id: 'x', contact: '  Layla@Example.com ', channel: 'email', receipt: true, marketing: false, requestId: 'r1' }, U],
    ['receipt', { id: 'x', contact: '  Layla@Example.com ', channel: 'email', receipt: true, marketing: false, requestId: 'r1' }],
    ['receipt', { id: 'x', contact: 'other@example.com', channel: 'email', receipt: true, marketing: false, requestId: 'r2' }],
  ],
  'receipt before confirmation': [['reserve', { amount: 6, tip: 0 }], ['receipt', { id: 'x', contact: 'a@b.co', channel: 'email', receipt: true, marketing: false, requestId: 'r1' }]],
};

test('rehearsal stand-in and aal_mutate answer every request alike (accepted with the same amounts, or the same refusal)', { skip: !modulePath }, async () => {
  const fs = require('node:fs'), path = require('node:path');
  const { PGlite } = require(modulePath), pg = new PGlite();
  const sql = (f) => fs.readFileSync(path.join(__dirname, '..', 'supabase', f), 'utf8').replace('create extension if not exists pgcrypto;', '');
  try {
    await pg.exec('create role anon;create role authenticated;create role service_role bypassrls;');
    await pg.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
    await pg.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
    for (const f of ['migration.sql', 'site-events.sql', 'hardening-2026-09-15.sql', 'hardening-2026-09-24.sql', 'admin.sql', 'sessions-2026-09-24.sql', 'auth-2026-09-24.sql']) await pg.exec(sql(f));
    await pg.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
    const as = async (role, headers, claims) => { await pg.exec('reset role'); await pg.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)", [JSON.stringify(headers || {}), JSON.stringify(claims || { role })]); await pg.exec('set role ' + role); };
    const one = async (q, args) => (await pg.query(q, args)).rows[0].value;
    await as('anon', { 'x-aalayna-admin': 'adm_test' });
    const v = await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra','{}'::jsonb) as value");
    const rid = v.restaurant_id;
    const sqlMutate = (op, body, token) => one('select aal_mutate($1,$2,$3::jsonb,$4) as value', [rid, op, JSON.stringify(body), token]);
    await as('anon', { 'x-aalayna-key': v.owner_key });
    const bill = await sqlMutate('open_check', { id: CHECK.id, table: CHECK.table, lines: CHECK.lines, currency: 'USD' }, '');
    assert.equal(bill.totalCents, CHECK.totalCents);
    const key = (await sqlMutate('issue_key', { checkId: CHECK.id }, '')).key;
    let n = 0;
    const answer = async (fn) => {
      try { const r = await fn(); return r && typeof r === 'object' && 'id' in r ? { ok: true, status: r.status, amount: r.amount, tip: r.tip, note: Number(r.note), change: Number(r.change), items: r.items, rail: r.rail } : { ok: true, value: r }; }
      catch (e) { return { ok: false, message: String(e.message).replace(/^ERROR:\s*/, '') }; }
    };
    await quiet(async () => {
      for (const [name, steps] of Object.entries(CASES)) {
        db.settle.clear(); db.secrets.clear();
        await pg.exec('reset role');
        await pg.query("delete from kv_rows where restaurant_id=$1 and collection='aal.settle'", [rid]);
        await pg.query('delete from payment_secrets where restaurant_id=$1', [rid]);
        const ids = {};
        for (const [op, raw, token = T, service = false] of steps) {
          const label = raw.id || 'x';
          if (!ids[label]) ids[label] = 'case-' + (++n) + '-' + label;
          const body = Object.assign(op === 'reserve' ? { requestId: ids[label], checkId: CHECK.id, rail: 'card', items: {} } : {}, raw, { id: ids[label] });
          if ('items' in raw && raw.items === undefined) delete body.items;
          if (service) await as('service_role', {}, { role: 'service_role' }); else await as('anon', { 'x-aalayna-key': key });
          const live = await answer(() => sqlMutate(op, body, token));
          const stand = await answer(async () => tool.mutate(op, JSON.parse(JSON.stringify(body)), token, service));
          assert.deepEqual(stand, live, name + ': ' + op + ' ' + JSON.stringify(raw));
        }
      }
    });
  } finally { await pg.close(); db.settle.clear(); db.secrets.clear(); }
});
