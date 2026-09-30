/* Receipt emails (T14): supabase/functions/receipt-email/handler.js and _shared/resend.js,
   run in Node against a fake PostgREST (the outbox with aal_outbox_claim's rules, the payment,
   guest, bill, venue profile and rate) and a fake Resend. Proves that:
   - only a caller with X-Aalayna-Cron equal to AALAYNA_CRON_SECRET gets in (401 otherwise,
     503 when the secret is not set), and nothing is claimed before that;
   - a queued receipt is drained: one POST to Resend from "Aalayna <receipts@aalayna.com>",
     no reply_to, subject "Your receipt from <venue>", text and HTML, an Idempotency-Key;
     the row becomes sent with Resend's id; a second drain sends nothing;
   - the email has the venue name and place, the table, the lines, the total, the tip, the
     LBP line when a rate is known (none without), the payment reference, no links or images,
     and the offers line only when the guest ticked it;
   - a guest who paid for chosen items sees those items only;
   - WhatsApp contacts, a receipt not asked for, and a contact that changed are skipped with
     a reason and never sent;
   - failures back off 1, 5, 30, 120 minutes and give up after the 6th; a 429 is retried once
     after Retry-After; an address Resend rejects fails at once; the address never reaches
     last_error. */
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const load = (rel) => import(path.join(root, 'supabase', 'functions', rel));

const RID = JSON.stringify(['kababji', 'hamra']);
const CRON = 'test-cron-secret-' + 'c'.repeat(16);
const SERVICE = 'test-service-role', RESEND_KEY = 'test-resend-key';
const URL_BASE = 'https://proj.supabase.co';
const NOW = new Date('2026-09-30T19:00:00.000Z');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GUEST_EMAIL = 'layla@example.com';

function world(o = {}) {
  const s = {
    calls: [], sent: [], resendReplies: o.resendReplies || [], patches: [],
    outbox: [], rows: new Map(), docs: new Map(), profiles: new Map([[RID, { name: 'Kababji', place: 'Hamra' }]]),
  };
  const key = (rid, col, id) => rid + '|' + col + '|' + id;
  s.put = (col, body, rid = RID) => s.rows.set(key(rid, col, body.id), body);
  s.queue = (over = {}) => { const r = Object.assign({ id: crypto.randomUUID(), restaurant_id: RID, kind: 'receipt', ref: 'pay-1', to_hash: sha(GUEST_EMAIL), status: 'queued', attempts: 0, next_attempt_at: new Date(NOW.getTime() - 1000).toISOString(), locked_until: null }, over); s.outbox.push(r); return r; };
  const res = (status, obj, headers) => new Response(obj == null ? null : JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
  s.fetch = async (url, init = {}) => {
    const u = new URL(url), q = u.searchParams, h = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : null;
    s.calls.push({ url, path: u.pathname, method: init.method, headers: h, body });
    if (u.origin === 'https://api.resend.com') {
      assert.equal(h.Authorization, 'Bearer ' + RESEND_KEY);
      s.sent.push({ body, headers: h });
      const next = s.resendReplies.shift() || [200, { id: 'rs_' + s.sent.length }];
      return res(next[0], next[1], next[2]);
    }
    if (h.Authorization !== 'Bearer ' + SERVICE) return res(401, { message: 'bad key' });
    const val = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/rest/v1/rpc/aal_outbox_claim') {
      const now = NOW.getTime();
      const due = s.outbox.filter((r) => r.kind === body.p_kind && ((r.status === 'queued' && Date.parse(r.next_attempt_at) <= now) || (r.status === 'sending' && Date.parse(r.locked_until) < now))).slice(0, body.p_limit);
      due.forEach((r) => Object.assign(r, { status: 'sending', attempts: r.attempts + 1, locked_until: new Date(now + body.p_lease_seconds * 1000).toISOString() }));
      return res(200, due.map((r) => Object.assign({}, r)));
    }
    if (u.pathname === '/rest/v1/outbox_email' && init.method === 'PATCH') {
      const r = s.outbox.find((x) => x.id === val('id'));
      s.patches.push(Object.assign({ id: val('id') }, body));
      Object.assign(r, body);
      return res(204, null);
    }
    if (u.pathname === '/rest/v1/kv_rows') { const b = s.rows.get(key(val('restaurant_id'), val('collection'), val('id'))); return res(200, b ? [{ body: b }] : []); }
    if (u.pathname === '/rest/v1/kv_docs') { const b = s.docs.get(val('restaurant_id') + '|' + val('key')); return res(200, b == null ? [] : [{ body: b }]); }
    if (u.pathname === '/rest/v1/venue_profiles') { const p = s.profiles.get(val('restaurant_id')); return res(200, p ? [p] : []); }
    return res(404, { message: 'no route ' + u.pathname });
  };
  return s;
}

const bill = () => ({ id: 'bill-7', table: 7, totalCents: 4400, lines: [{ id: 'l1', q: 2, p: 18, name: 'Shish taouk' }, { id: 'l2', q: 1, p: 6, name: 'Hummus' }, { id: 'l3', q: 2, p: 20, name: 'Mixed grill <large>' }] });
const payment = (over = {}) => Object.assign({ id: 'pay-1', checkId: 'bill-7', table: 7, rail: 'whish', amount: 48.4, tip: 4.4, items: {}, currency: 'USD', status: 'confirmed', confirmedAt: '2026-09-30T18:40:00.000Z', externalRef: 'fake-ref-1', customerId: 'g-1' }, over);
const guest = (over = {}) => Object.assign({ id: 'g-1', contact: GUEST_EMAIL, channel: 'email', receipt: true, marketing: false, consentHistory: [{ settlementId: 'pay-1', receipt: true, marketing: false, requestId: 'r1' }] }, over);

async function setup(o = {}) {
  const mod = await load('receipt-email/handler.js');
  const w = world(o);
  w.put('aal.checks', bill());
  w.put('aal.settle', payment(o.payment));
  w.put('aal.guests', guest(o.guest));
  if (o.rate !== null) w.docs.set(RID + '|aal.rate', o.rate || 89500);
  const logs = [], sleeps = [];
  const env = Object.assign({ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: SERVICE, RESEND_API_KEY: RESEND_KEY, AALAYNA_CRON_SECRET: CRON }, o.env || {});
  const handle = mod.createHandler({ fetch: w.fetch, env, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); }, log: { warn: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')) } });
  const run = async (secret = CRON, method = 'POST') => {
    const headers = secret == null ? {} : { 'X-Aalayna-Cron': secret };
    const r = await handle(new Request(URL_BASE + '/functions/v1/receipt-email', { method, headers, body: method === 'POST' ? '{}' : undefined }));
    return { status: r.status, body: await r.json() };
  };
  return { mod, w, run, logs, sleeps };
}

test('an unauthorised call is 401 and claims nothing; no secret configured is 503; GET is 405', async () => {
  const t = await setup();
  t.w.queue();
  assert.equal((await t.run(null)).status, 401);
  assert.equal((await t.run('wrong')).status, 401);
  assert.equal((await t.run(CRON + 'x')).status, 401);
  assert.equal((await t.run(CRON, 'GET')).status, 405);
  assert.equal(t.w.calls.length, 0);
  const t2 = await setup({ env: { AALAYNA_CRON_SECRET: '' } });
  t2.w.queue();
  assert.equal((await t2.run('')).status, 503);
  const t3 = await setup({ env: { RESEND_API_KEY: '' } });
  t3.w.queue();
  assert.equal((await t3.run()).status, 503);
  assert.equal(t2.w.calls.length + t3.w.calls.length, 0);
});

test('a queued receipt is drained: one Resend call, the row becomes sent, a second drain sends nothing', async () => {
  const t = await setup();
  const row = t.w.queue();
  const r = await t.run();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { claimed: 1, sent: 1, skipped: 0, retry: 0, failed: 0 });
  assert.equal(t.w.sent.length, 1);
  const m = t.w.sent[0];
  assert.equal(m.body.from, 'Aalayna <receipts@aalayna.com>');
  assert.deepEqual(m.body.to, [GUEST_EMAIL]);
  assert.equal(m.body.subject, 'Your receipt from Kababji');
  assert.equal('reply_to' in m.body, false);
  assert.equal('tags' in m.body, false);
  assert.equal(typeof m.body.text, 'string');
  assert.equal(typeof m.body.html, 'string');
  assert.equal(m.headers['Idempotency-Key'], 'receipt/' + row.id);
  const claim = t.w.calls.find((c) => c.path === '/rest/v1/rpc/aal_outbox_claim');
  assert.deepEqual(claim.body, { p_kind: 'receipt', p_limit: 10, p_lease_seconds: 120 });
  assert.equal(row.status, 'sent');
  assert.equal(row.provider_id, 'rs_1');
  assert.equal(row.sent_at, NOW.toISOString());
  assert.equal(row.locked_until, null);
  assert.equal(row.last_error, null);
  assert.equal(row.attempts, 1);
  const again = await t.run();
  assert.deepEqual(again.body, { claimed: 0, sent: 0, skipped: 0, retry: 0, failed: 0 });
  assert.equal(t.w.sent.length, 1);
});

test('the email: venue, place, table, lines, totals, tip, LBP line, reference; no links, no images, no offers line', async () => {
  const t = await setup();
  t.w.queue();
  await t.run();
  const { text, html } = t.w.sent[0].body;
  assert.match(text, /^Your receipt from Kababji\nKababji, Hamra\nTable 7\n/);
  assert.match(text, /The bill\n2 x Shish taouk +\$18\.00\n1 x Hummus +\$6\.00\n2 x Mixed grill <large> +\$20\.00\n/);
  assert.match(text, /Bill total +\$44\.00\nYour payment +\$44\.00\nTip +\$4\.40\nTotal paid +\$48\.40\nAbout LL 4,331,800 at LL 89,500 to the dollar\n/);
  assert.match(text, /Paid by Whish Money on 30 September 2026, 21:40 \(Beirut\)\./);
  assert.match(text, /Payment reference: fake-ref-1/);
  assert.match(text, /because you asked Kababji for a receipt at the table/);
  assert.doesNotMatch(text, /offers|STOP/);
  assert.doesNotMatch(text, /\u2014/);
  for (const s of [text, html]) assert.doesNotMatch(s, /https?:|<img|<a /i);
  assert.match(html, /Your receipt from Kababji/);
  assert.match(html, /Mixed grill &lt;large&gt;/);
  assert.doesNotMatch(html, /Mixed grill <large>/);
  assert.match(html, /About LL 4,331,800 at LL 89,500 to the dollar/);
  assert.doesNotMatch(html, /offers|STOP/);
});

test('the offers line appears only when the guest ticked it (and has not since opted out)', async () => {
  const yes = await setup({ guest: { marketing: true, consentHistory: [{ settlementId: 'pay-1', receipt: true, marketing: true }] } });
  yes.w.queue();
  await yes.run();
  const line = 'You also said yes to offers from Kababji, so they may write to you. To stop, reply STOP to any of their messages.';
  assert.ok(yes.w.sent[0].body.text.includes(line));
  assert.ok(yes.w.sent[0].body.html.includes(line));
  const later = await setup({ guest: { marketing: false, consentHistory: [{ settlementId: 'pay-1', receipt: true, marketing: true }, { settlementId: 'pay-9', receipt: true, marketing: false }] } });
  later.w.queue();
  await later.run();
  assert.doesNotMatch(later.w.sent[0].body.text, /STOP/);
});

test('no rate known: no LBP line; the payment rate snapshot wins over the venue rate', async () => {
  const none = await setup({ rate: null });
  none.w.queue();
  await none.run();
  assert.doesNotMatch(none.w.sent[0].body.text, /LL /);
  const snap = await setup({ payment: { fxRateUsed: 90000 } });
  snap.w.queue();
  await snap.run();
  assert.match(snap.w.sent[0].body.text, /About LL 4,356,000 at LL 90,000 to the dollar/);
});

test('a guest who paid for chosen items sees those items and their share only', async () => {
  const t = await setup({ payment: { items: { l1: 1, l3: 1 }, amount: 29, tip: 0 } });
  t.w.queue();
  await t.run();
  const { text } = t.w.sent[0].body;
  assert.match(text, /Your items\n1 x Shish taouk +\$9\.00\n1 x Mixed grill <large> +\$10\.00\n/);
  assert.doesNotMatch(text, /Hummus|Bill total|Your payment|Tip/);
  assert.match(text, /Total paid +\$29\.00/);
});

test('WhatsApp contacts, a receipt not asked for, and a changed contact are skipped with a reason', async () => {
  const wa = await setup({ guest: { contact: '+9613123456', channel: 'whatsapp' } });
  const r1 = wa.w.queue({ to_hash: sha('+9613123456') });
  assert.deepEqual((await wa.run()).body, { claimed: 1, sent: 0, skipped: 1, retry: 0, failed: 0 });
  assert.equal(r1.status, 'skipped');
  assert.equal(r1.last_error, 'WhatsApp receipts are not sent yet');
  const no = await setup({ guest: { consentHistory: [{ settlementId: 'pay-1', receipt: false, marketing: true }] } });
  const r2 = no.w.queue();
  await no.run();
  assert.equal(r2.status, 'skipped');
  assert.equal(r2.last_error, 'The guest did not ask for a receipt');
  const moved = await setup();
  const r3 = moved.w.queue({ to_hash: sha('someone.else@example.com') });
  await moved.run();
  assert.equal(r3.status, 'skipped');
  assert.equal(r3.last_error, 'The contact changed after the request');
  const refunded = await setup({ payment: { refunded: '2026-09-30T19:00:00Z' } });
  const r4 = refunded.w.queue();
  await refunded.run();
  assert.equal(r4.status, 'skipped');
  assert.equal(wa.w.sent.length + no.w.sent.length + moved.w.sent.length + refunded.w.sent.length, 0);
});

test('failures back off 1, 5, 30, 120, 120 minutes and give up after the 6th; the address never reaches last_error', async () => {
  const t = await setup({ resendReplies: Array.from({ length: 20 }, () => [500, { message: 'Internal error for layla@example.com' }]) });
  const row = t.w.queue();
  const waits = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    row.next_attempt_at = new Date(NOW.getTime() - 1).toISOString();
    const r = await t.run();
    assert.equal(row.attempts, attempt);
    if (attempt < 6) {
      assert.deepEqual(r.body, { claimed: 1, sent: 0, skipped: 0, retry: 1, failed: 0 });
      assert.equal(row.status, 'queued');
      waits.push((Date.parse(row.next_attempt_at) - NOW.getTime()) / 60000);
    } else {
      assert.deepEqual(r.body, { claimed: 1, sent: 0, skipped: 0, retry: 0, failed: 1 });
      assert.equal(row.status, 'failed');
    }
    assert.doesNotMatch(row.last_error, /layla|example\.com/);
    assert.match(row.last_error, /Resend 500/);
  }
  assert.deepEqual(waits, [1, 5, 30, 120, 120]);
  assert.equal(t.w.sent.length, 12);                 // each attempt is two tries: one retry inside send
  assert.deepEqual(t.mod.BACKOFF_MINUTES, [1, 5, 30, 120]);
  assert.equal(t.mod.MAX_ATTEMPTS, 6);
  // not due yet: nothing is claimed
  const u = await setup();
  u.w.queue({ next_attempt_at: new Date(NOW.getTime() + 60000).toISOString() });
  assert.equal((await u.run()).body.claimed, 0);
});

test('a row whose sender died is claimed again after its lease; past 6 attempts it fails without sending', async () => {
  const t = await setup();
  const stale = t.w.queue({ status: 'sending', attempts: 6, locked_until: new Date(NOW.getTime() - 1000).toISOString() });
  const r = await t.run();
  assert.deepEqual(r.body, { claimed: 1, sent: 0, skipped: 0, retry: 0, failed: 1 });
  assert.equal(stale.status, 'failed');
  assert.equal(stale.last_error, 'Gave up after 6 attempts');
  assert.equal(t.w.sent.length, 0);
  const live = await setup();
  live.w.queue({ status: 'sending', attempts: 1, locked_until: new Date(NOW.getTime() + 60000).toISOString() });
  assert.equal((await live.run()).body.claimed, 0);
});

test('429 is retried once after Retry-After; a rejected address fails at once', async () => {
  const t = await setup({ resendReplies: [[429, { message: 'Too many requests' }, { 'Retry-After': '2' }], [200, { id: 'rs_ok' }]] });
  const row = t.w.queue();
  await t.run();
  assert.deepEqual(t.sleeps, [2000]);
  assert.equal(row.status, 'sent');
  assert.equal(row.provider_id, 'rs_ok');
  const bad = await setup({ resendReplies: [[422, { name: 'validation_error', message: 'Invalid `to` field.' }]] });
  const r2 = bad.w.queue();
  await bad.run();
  assert.equal(bad.w.sent.length, 1);
  assert.equal(r2.status, 'failed');
  assert.match(r2.last_error, /Resend 422/);
});

test('one email per settlement: a second drain, even with the row forced back to queued, repeats the same idempotency key', async () => {
  const t = await setup();
  const row = t.w.queue();
  await t.run();
  Object.assign(row, { status: 'sending', locked_until: new Date(NOW.getTime() - 1).toISOString() });   // as if the sent update had been lost
  await t.run();
  assert.equal(t.w.sent.length, 2);
  assert.equal(t.w.sent[0].headers['Idempotency-Key'], t.w.sent[1].headers['Idempotency-Key']);
  assert.deepEqual(t.w.sent[0].body, t.w.sent[1].body);   // same payload, so Resend returns the first email instead of sending
});

test('shared resend: payload shape, attachments, one retry on 5xx and network errors, none on 4xx', async () => {
  const { createResend, ResendError, DEFAULT_FROM } = await load('_shared/resend.js');
  const calls = [];
  const replies = [];
  const r = createResend({ apiKey: 'k', sleep: async () => {}, fetch: async (u, i) => { calls.push({ u, i }); const x = replies.shift(); if (x instanceof Error) throw x; return new Response(JSON.stringify(x[1]), { status: x[0] }); } });
  replies.push([200, { id: 'a' }]);
  assert.deepEqual(await r.send({ to: 'x@y.co', subject: 's', text: 't', attachments: [{ filename: 'f.csv', content: 'YQ==' }] }), { id: 'a' });
  assert.equal(calls[0].u, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(calls[0].i.body), { from: DEFAULT_FROM, to: ['x@y.co'], subject: 's', text: 't', attachments: [{ filename: 'f.csv', content: 'YQ==' }] });
  assert.equal(calls[0].i.headers['Idempotency-Key'], undefined);
  replies.push(new TypeError('fetch failed'), [200, { id: 'b' }]);
  assert.deepEqual(await r.send({ to: ['x@y.co'], subject: 's', text: 't', from: 'Other <o@aalayna.com>' }), { id: 'b' });
  assert.equal(JSON.parse(calls[2].i.body).from, 'Other <o@aalayna.com>');
  replies.push([503, {}], [503, {}]);
  await assert.rejects(r.send({ to: 'x@y.co', subject: 's', text: 't' }), (e) => e instanceof ResendError && e.status === 503 && e.retryable);
  replies.push([403, { message: 'domain not verified' }]);
  const before = calls.length;
  await assert.rejects(r.send({ to: 'x@y.co', subject: 's', text: 't' }), (e) => e.status === 403 && !e.retryable);
  assert.equal(calls.length, before + 1);
  await assert.rejects(createResend({ apiKey: '' }).send({ to: 'x@y.co', subject: 's', text: 't' }), /RESEND_API_KEY is not set/);
  await assert.rejects(r.send({ to: '', subject: 's', text: 't' }), /No recipient/);
});

test('the Deno wrapper only wires the handler', () => {
  const src = require('node:fs').readFileSync(path.join(root, 'supabase', 'functions', 'receipt-email', 'index.ts'), 'utf8');
  assert.match(src, /import \{ createHandler \} from '\.\/handler\.js'/);
  assert.match(src, /Deno\.serve\(createHandler\(/);
  assert.match(src, /verify_jwt false/);
});
