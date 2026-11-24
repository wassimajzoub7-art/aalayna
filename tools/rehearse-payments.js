#!/usr/bin/env node
/* Rehearse card and Whish payments on this computer, without Supabase.

     node tools/rehearse-payments.js            (port 8788; --port N to change it)

   Serves the repository's pages and, in the same process, a stand-in for the parts of the
   shared store a guest page touches (aal_snapshot, aal_mutate reserve/cancel/receipt/event)
   plus the two real Edge Function handlers, payment-start and payment-webhook, run exactly
   as they are deployed (supabase/functions/<name>/handler.js) against an in-memory PostgREST.
   One venue (Mayda, demo payments on), one open bill at table 7, one bill key, printed at
   start as a guest link. Open it, split the bill, pay by card or Whish: payment-start sends the
   browser to the fake provider's checkout, pay-demo.html, a static page served from here as
   GitHub Pages serves it on aalayna.com. It finds the functions the way the guest page does,
   through aalayna-config.js, which this server answers itself with its own address (the
   address the browser used, so a phone's LAN address works too); it reads the amount from
   GET /functions/v1/payment-start/fake/checkout and Pay POSTs the outcome there, the function
   posts the signed callback to payment-webhook and answers the return URL, and the guest page
   comes back and reads Confirmed by the demo provider. Decline sends the guest back to the
   bill. The console says what happened at each step.

   The phone on the same Wi-Fi works too: the link is printed with this computer's LAN
   address, and those origins are allowed for the return (PAYMENT_ALLOW_LOCAL_ORIGINS, which
   live never sets). Nothing here is a test of the live project (supabase/README.md, "Hosted
   payment pages"). The stand-in is a copy of aal_mutate's guest and provider rules
   (supabase/auth-2026-09-24.sql), not the SQL itself, kept to the same checks in the same
   order with the same messages: amounts are read as ::numeric reads text and rounded as
   round() rounds (half away from zero, in exact decimals, never floats); the bill key's bill
   only; the payer token; a resend must be the same request; the balance; each dish claimed
   whole, on the bill and not past its quantity, the claims adding up to the amount less the
   tip; enough cash; confirm_digital's reference, currency and cents; the receipt's channel,
   contact and permissions. tests/rehearse-payments.test.cjs (with PGLITE_MODULE) runs the same
   requests through both and fails on any difference. Where the guest page depends on more,
   the stand-in behaves as live does: the snapshot strips externalRef (and the other fields
   aal_snapshot strips) from payments, a confirmed payment carries the server-derived demo
   flag (kv_rows_settle_demo, supabase/review-fixes-2026-11-10.sql), and POST
   /rest/v1/rpc/aal_now answers the server's time as a JSON string.

   require('./tools/rehearse-payments.js') runs nothing: it exports the stand-in for
   tests/rehearse-payments.test.cjs. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2), portAt = argv.indexOf('--port');
const PORT = portAt >= 0 ? Number(argv[portAt + 1]) : 8788;
const RID = JSON.stringify(['mayda', 'hamra']);
const KEY = 'chk_' + crypto.randomBytes(24).toString('hex');
const SERVICE = 'rehearsal-service-' + crypto.randomBytes(8).toString('hex');
const FAKE_SECRET = crypto.randomBytes(32).toString('hex');
const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
const ORIGINS = ['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT].concat(lan.map((a) => 'http://' + a + ':' + PORT));
const SELF = 'http://127.0.0.1:' + PORT;
const stamp = () => new Date().toISOString();
const say = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

/* ---------------------------------------------------------------- the venue and its bill */
let menu = null;
try {
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'venues', 'mayda.json'), 'utf8'));
  menu = { version: 1, sections: pack.sections, items: pack.items, at: stamp() };
} catch (_) { /* the seed menu then */ }
const lines = [{ id: 'i05', q: 2, p: 13, name: 'Fattoush' }, { id: 'i07', q: 1, p: 16, name: 'Mixed Grill platter' }, { id: 'i14', q: 4, p: 10, name: 'Lebanese coffee' }];
const CHECK = { id: 'bill-' + Date.now().toString(36), venueId: RID, table: 7, source: 'staff', openedAt: stamp(), lines, totalCents: lines.reduce((n, l) => n + Math.round(l.p * 100), 0), currency: 'USD', revision: 1 };
CHECK.amountUsd = CHECK.totalCents / 100;
const db = { settle: new Map(), secrets: new Map(), sessions: [], callbacks: [], events: [] };
const money = (n) => '$' + Number(n).toFixed(2);
const live = (s) => !s.refunded && !s.cancelled && (['pending', 'confirmed'].includes(s.status) || (s.status === 'initiated' && Date.parse(s.expiresAt) > Date.now()));
/* the fields aal_snapshot strips from every row but a bill for anyone but the owner */
const STRIPPED = ['deviceId', 'sessionId', 'customerId', 'identityId', 'payerRef', 'externalRef'];
/* kv_rows_settle_demo: on every write, a confirmed payment says whether the fake provider
   confirmed it; any other status carries no demo key */
function written(p) {
  if (p.status === 'confirmed') p.demo = /^fake-/.test(p.externalRef || ''); else delete p.demo;
  return p;
}
/* ---------------------------------------------------------------- PostgreSQL's numbers, as aal_mutate uses them */
/* aal_mutate reads every amount as text cast ::numeric and rounds with round() (half away
   from zero) into bigint cents; it never uses a float. The stand-in does the same with
   BigInt decimals {n, s} (the value n / 10^s), so a tip of 'x', 1.005, -0.004 or 1e999 is
   taken or refused exactly as live takes or refuses it, with live's message. */
const refusal = (m) => { const e = new Error(m); e.refused = true; return e; };
/* p_body->>'k': SQL NULL for a missing key or JSON null, else the value's text */
const txt = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));
const NUM_RE = /^\s*([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?\s*$/;
const SPECIAL_RE = /^\s*([+-]?)(nan|inf|infinity)\s*$/i;
/* (text)::numeric: null for SQL NULL; {special} for NaN and the infinities, which ::numeric
   takes and every later bigint cast refuses; a refusal for anything else that is not a number */
function numeric(v) {
  const t = txt(v);
  if (t === null) return null;
  const sp = SPECIAL_RE.exec(t);
  if (sp) return { special: /nan/i.test(sp[2]) ? 'NaN' : 'infinity', negative: sp[1] === '-' && !/nan/i.test(sp[2]) };
  const m = NUM_RE.exec(t);
  if (!m) throw refusal('invalid input syntax for type numeric: "' + t + '"');
  const [ip, fp = ''] = m[2].split('.');
  const e = m[3] ? Number(m[3]) : 0;
  let n = BigInt((ip + fp) || '0'), s = fp.length - e;
  if (n !== 0n && s < -400) throw refusal('bigint out of range');   // far past any bigint; every use casts to bigint
  if (s < 0) { n *= 10n ** BigInt(-s); s = 0; }
  return { n: m[1] === '-' ? -n : n, s: Math.min(s, 1000) };
}
const pow10 = (k) => 10n ** BigInt(k);
function halfAway(N, D) {   // N / D rounded half away from zero
  const neg = (N < 0n) !== (D < 0n), a = N < 0n ? -N : N, b = D < 0n ? -D : D;
  let q = a / b; if (2n * (a % b) >= b) q += 1n;
  return neg ? -q : q;
}
const mul = (a, b) => ({ n: a.n * b.n, s: a.s + b.s });
const add = (a, b) => { const s = Math.max(a.s, b.s); return { n: a.n * pow10(s - a.s) + b.n * pow10(s - b.s), s }; };
const ZERO = { n: 0n, s: 0 };
const HUNDRED = { n: 100n, s: 0 };
/* the weight and first digit of |d| in base 10000, as numeric.c stores it */
function weightFirst(d) {
  let a = d.n < 0n ? -d.n : d.n, s = d.s;
  if (a === 0n) return { w: 0, f: 0 };
  const pad = (4 - (s % 4)) % 4; a *= pow10(pad); s += pad;
  const digs = []; for (let x = a; x > 0n; x /= 10000n) digs.unshift(Number(x % 10000n));
  return { w: digs.length - 1 - s / 4, f: digs[0] };
}
/* a / b as numeric division rounds it (numeric.c select_div_scale: at least 16 significant
   digits, never fewer decimals than either input) */
function div(a, b) {
  if (b.n === 0n) throw refusal('division by zero');
  const wa = weightFirst(a), wb = weightFirst(b);
  let qw = wa.w - wb.w; if (wa.f <= wb.f) qw--;
  const rs = Math.min(Math.max(16 - qw * 4, a.s, b.s, 0), 1000);
  return { n: halfAway(a.n * pow10(b.s + rs), b.n * pow10(a.s)), s: rs };
}
const BIG = 2n ** 63n;
/* round(d)::bigint */
function bigint(d) {
  if (d.special) throw refusal('cannot convert ' + d.special + ' to bigint');
  const r = halfAway(d.n, pow10(d.s));
  if (r >= BIG || r < -BIG) throw refusal('bigint out of range');
  return r;
}
const cmp = (a, b) => { const s = Math.max(a.s, b.s), x = a.n * pow10(s - a.s), y = b.n * pow10(s - b.s); return x < y ? -1 : x > y ? 1 : 0; };
/* round(x::numeric*100) for x as aal_mutate reads it; null for SQL NULL */
const cents = (v) => { const d = numeric(v); return d === null ? null : bigint(d.special ? d : mul(d, HUNDRED)); };
/* a stored amount (written by this stand-in, so always a number) in cents */
const storedCents = (v) => cents(v == null ? 0 : v);
/* jsonb `is distinct from`: undefined is SQL NULL; numbers compare as numbers, objects by keys */
function jsonbSame(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') return cmp(numeric(a), numeric(b)) === 0;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => jsonbSame(x, b[i]));
  if (typeof a === 'object') { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => k in b && jsonbSame(a[k], b[k])); }
  return a === b;
}
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
/* the rows reserve counts as holding the bill: live, of this bill */
const holding = () => [...db.settle.values()].filter((s) => s.checkId === CHECK.id && live(s));
const usedCents = () => holding().reduce((n, s) => n + storedCents(s.amount) - storedCents(s.tip), 0n);
/* jsonb_each_text(coalesce(p_body->'items','{}')): an object's pairs in jsonb's key order
   (shorter keys first, then byte order), or the error SQL raises */
function eachItem(items) {
  if (items === undefined) return [];
  if (items === null || typeof items !== 'object') throw refusal('cannot call jsonb_each_text on a non-object');
  if (Array.isArray(items)) throw refusal('cannot call jsonb_each_text on a non-object');
  const bytes = (k) => Buffer.from(k, 'utf8');
  return Object.entries(items).map(([k, v]) => [k, txt(v)]).sort((a, b) => bytes(a[0]).length - bytes(b[0]).length || Buffer.compare(bytes(a[0]), bytes(b[0])));
}
const EVENTS = ['qr_scan', 'item_view', 'bill_requested', 'ui_action', 'review_submitted'];
const guests = new Map();   // aal.guests by contact

/* ---------------------------------------------------------------- the guest's store (anon key + bill key) */
/* aal_mutate (supabase/auth-2026-09-24.sql) for a guest holding the bill key and for the
   service role, check for check and in the same order, with the same messages. tests/
   rehearse-payments.test.cjs runs the same requests through this and through the SQL in PGlite
   and compares the answers. */
function mutate(op, body, token, service) {
  const refuse = refusal;
  body = body || {};
  token = token == null ? '' : String(token);
  if (op === 'event') {
    if (!EVENTS.includes(txt(body.eventType))) throw refuse('This event requires a server operation');
    if (txt(body.eventId) === null) throw refuse('null value in column "id" of relation "kv_rows" violates not-null constraint');
    const ev = Object.assign({}, body, { restaurantId: RID, createdAt: stamp(), customerId: null, tableId: String(CHECK.table) });
    db.events.push(ev); return ev;
  }
  const pid = txt(body.id);
  if (op === 'reserve') {
    const cid = txt(body.checkId);
    if (cid !== CHECK.id) throw refuse('Wrong bill');   // a guest reserves on the bill of its key only
    if (token.length < 32) throw refuse('Missing payer token');
    const previous = pid === null ? null : db.settle.get(pid);
    if (previous) {
      if (db.secrets.get(pid) !== sha(token)) throw refuse('Wrong payer token');
      if (previous.checkId !== cid || !jsonbSame(previous.amount, body.amount) || !jsonbSame(previous.tip, body.tip) || !jsonbSame(previous.rail, body.rail) || !jsonbSame(previous.items, body.items)) throw refuse('Payment request changed');
      return previous;
    }
    const amount = cents(body.amount), tip = cents(body.tip) ?? 0n, rail = txt(body.rail);
    if ((amount ?? 0n) <= 0n || tip < 0n || tip >= amount || !['cash', 'card', 'whish'].includes(rail)) throw refuse('Invalid amount');
    if (CHECK.closedAt) throw refuse('Bill closed or unavailable');
    if (usedCents() + amount - tip > BigInt(CHECK.totalCents)) throw refuse('Another payment already covers this balance. Refresh your bill.');
    // the dishes this payment claims: each on the bill, whole, not claimed past its quantity,
    // and together exactly the amount less the tip. A claim of null is skipped, as the SQL's
    // null arithmetic skips it (its sum turns null and no comparison fails).
    let used = 0n;
    const claims = eachItem(body.items);
    for (const [k, v] of claims) {
      const qty = numeric(v), line = CHECK.lines.find((l) => l.id === k);
      if (qty === null) { if (!line) throw refuse('Invalid item selection'); used = null; continue; }
      // NaN and +Infinity pass the SQL's `qty<=0 or qty<>trunc(qty)` and then exceed any quantity
      if (!line || (qty.special ? qty.negative : qty.n <= 0n || qty.n % pow10(qty.s) !== 0n)) throw refuse('Invalid item selection');
      if (qty.special) throw refuse('Item already reserved');
      const others = holding().reduce((n, s) => { const q = numeric(s.items && s.items[k]); return q === null ? n : add(n, q); }, ZERO);
      if (cmp(add(qty, others), numeric(line.q)) > 0) throw refuse('Item already reserved');
      if (used !== null) used += bigint(mul(div(mul(numeric(line.p), HUNDRED), numeric(line.q)), qty));
    }
    if (claims.length && used !== null && used !== amount - tip) throw refuse('Items do not match the amount');
    const note = numeric(body.note);
    if (rail === 'cash' && note !== null && !note.special && cmp(note, ZERO) > 0 && cmp(mul(note, HUNDRED), { n: amount, s: 0 }) < 0) throw refuse('Not enough cash');
    // a NaN or infinite note: not modelled (JSON cannot carry one back); refused here
    if (note && note.special) throw refuse('Invalid amount');
    const noteNum = note === null ? 0 : Number(note.n) / 10 ** note.s;
    if (pid === null) throw refuse('null value in column "id" of relation "kv_rows" violates not-null constraint');
    const row = {
      id: pid, requestId: txt(body.requestId), venueId: RID, checkId: cid, table: CHECK.table, rail, amount: Number(amount) / 100, tip: Number(tip) / 100,
      items: body.items === undefined ? {} : body.items, deviceId: txt(body.deviceId), sessionId: txt(body.sessionId), server: txt(body.server), currency: 'USD', amountUsd: Number(amount) / 100,
      fxRateUsed: CHECK.fxRateUsed == null ? null : CHECK.fxRateUsed, note: noteNum, change: rail === 'cash' ? Math.max(0, noteNum - Number(amount) / 100) : 0,
      status: rail === 'cash' ? 'pending' : 'initiated', ts: stamp(),
      expiresAt: rail === 'cash' ? null : new Date(Date.now() + 10 * 60000).toISOString(),
    };
    db.settle.set(row.id, written(row)); db.secrets.set(row.id, sha(token));
    say('reserve   ', row.id, money(row.amount), 'by', row.rail, row.status, row.rail === 'cash' ? '' : '(ten minutes to confirm)');
    return row;
  }
  const p = pid === null ? null : db.settle.get(pid);
  if (!p || (!service && p.checkId !== CHECK.id)) throw refuse('Payment unavailable');
  const tokenOk = db.secrets.get(pid) === sha(token);
  if (op === 'receipt') {
    if (!tokenOk) throw refuse('Wrong payer token');
    if (p.status !== 'confirmed' || p.refunded) throw refuse('Payment must be confirmed');
    if (typeof body.receipt !== 'boolean' || typeof body.marketing !== 'boolean') throw refuse('Separate permissions required');
    const channel = txt(body.channel);
    let contact = txt(body.contact); if (contact !== null) contact = contact.replace(/^ +| +$/g, '');
    // a missing contact passes both patterns, as `null !~ pattern` is null in the SQL
    if (channel === 'email') { if (contact !== null) { contact = contact.toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw refuse('Invalid email'); } }
    else if (channel === 'whatsapp') { if (contact !== null && !/^\+[1-9][0-9]{7,14}$/.test(contact)) throw refuse('International number required'); }
    else throw refuse('Invalid channel');
    const g = (contact !== null && guests.get(contact)) || { id: crypto.randomUUID(), contact };   // a null contact never matches
    if (p.customerId && p.customerId !== g.id) throw refuse('Payment already linked');
    if (contact !== null) guests.set(contact, g);
    p.customerId = g.id;
    say('receipt   ', p.id, 'asked for (not sent here)'); return { saved: true };
  }
  if (op === 'confirm_digital') {
    if (!service) throw refuse('Verified provider callback required');
    const ref = txt(body.externalRef);
    if (p.externalRef === ref && p.status === 'confirmed') return p;
    if (p.status !== 'initiated' || Date.parse(p.expiresAt) <= Date.now()) throw refuse('Reservation expired or changed; reconcile received funds');
    const ac = txt(body.amountCents);
    if (!ref || txt(body.currency) !== p.currency) throw refuse('Callback amount, currency or reference mismatch');
    if (ac !== null && !/^\s*[+-]?\d+\s*$/.test(ac)) throw refuse('invalid input syntax for type bigint: "' + ac + '"');
    if (ac !== null && (BigInt(ac.trim()) >= BIG || BigInt(ac.trim()) < -BIG)) throw refuse('value "' + ac + '" is out of range for type bigint');
    if (ac === null || BigInt(ac.trim()) !== storedCents(p.amount)) throw refuse('Callback amount, currency or reference mismatch');
    if ([...db.settle.values()].some((x) => x.externalRef === ref)) throw refuse('Duplicate provider reference');
    written(Object.assign(p, { status: 'confirmed', confirmedAt: stamp(), externalRef: ref })); say('confirmed ', p.id, money(p.amount), 'reference', ref); return p;
  }
  if (op === 'cancel') {
    if (!tokenOk) throw refuse('Wrong payer token');
    if (['cancelled', 'expired', 'failed'].includes(p.status)) return p;
    if (!['pending', 'initiated'].includes(p.status)) throw refuse('Payment already completed');
    written(Object.assign(p, { status: 'cancelled', cancelled: stamp() })); say('cancel    ', p.id, 'by the guest'); return p;
  }
  throw refuse('Unknown operation');
}
function snapshot() {
  const guestBody = (b) => { const o = Object.assign({}, b); STRIPPED.forEach((k) => delete o[k]); return o; };
  return { version: 2, role: 'guest', checkId: CHECK.id, rows: [{ collection: 'aal.checks', id: CHECK.id, body: CHECK }].concat([...db.settle.values()].map((s) => ({ collection: 'aal.settle', id: s.id, body: guestBody(s) }))), docs: menu ? [{ key: 'aal.live', body: menu }] : [] };
}

/* ---------------------------------------------------------------- the in-memory PostgREST the functions see */
const json = (status, obj) => new Response(obj == null ? '' : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const pgError = (m) => json(400, { code: 'P0001', message: m });
async function postgrest(url, init = {}) {
  const u = new URL(url), q = u.searchParams, h = init.headers || {}, body = init.body ? JSON.parse(init.body) : null;
  const val = (k) => (q.get(k) || '').replace(/^eq\./, '');
  const service = h.Authorization === 'Bearer ' + SERVICE;
  const guest = h['x-aalayna-key'] === KEY;
  if (u.pathname === '/rest/v1/rpc/aal_now') return json(200, new Date().toISOString());   // a JSON string, as PostgREST answers a timestamptz
  if (u.pathname === '/rest/v1/rpc/aal_snapshot') return guest ? json(200, snapshot()) : pgError('Open a current bill link.');
  if (u.pathname === '/rest/v1/rpc/aal_mutate') {
    if (!guest && !service) return pgError('Access denied');   // aal_mutate with no bill scope, as live
    try { return json(200, mutate(body.p_op, body.p_body, body.p_token, service)); } catch (e) { if (e.refused) return pgError(e.message); throw e; }
  }
  if (u.pathname === '/rest/v1/site_events') return json(201, null);   // the website funnel: accepted, not kept
  if (!service) return json(401, { message: 'service role required' });
  if (u.pathname === '/rest/v1/check_keys') return json(200, val('key') === KEY ? [{ restaurant_id: RID, check_id: CHECK.id }] : []);
  if (u.pathname === '/rest/v1/kv_rows') { const p = db.settle.get(val('id')); return json(200, p && (!q.get('restaurant_id') || val('restaurant_id') === RID) ? [{ restaurant_id: RID, body: p }] : []); }
  if (u.pathname === '/rest/v1/payment_secrets') { const t = db.secrets.get(val('payment_id')); return json(200, t ? [{ token_hash: t }] : []); }
  if (u.pathname === '/rest/v1/venue_profiles') return json(200, val('restaurant_id') === RID ? [{ demo_payments: true }] : []);
  if (u.pathname === '/rest/v1/rpc/aal_payment_provider') return json(200, null);   // no provider rows: the fake takes every rail
  if (u.pathname === '/rest/v1/payment_sessions') { db.sessions.push(body); say('handoff   ', body.payment_id, 'to', body.provider, 'for', body.rail); return json(201, null); }
  if (u.pathname === '/rest/v1/payment_callbacks') { db.callbacks.push(body); say('callback  ', body.payment_id, body.status, '->', body.outcome, '(' + body.http_status + ')'); return json(201, null); }
  if (u.pathname === '/rest/v1/rpc/aal_payment_failed') {
    const p = db.settle.get(body.p_id);
    if (!p) return pgError('Payment unavailable');
    if (['failed', 'cancelled', 'expired'].includes(p.status)) return json(200, p);
    if (p.status !== 'initiated') return pgError('Payment already completed');
    written(Object.assign(p, { status: 'failed', failedAt: stamp() })); say('declined  ', p.id, 'released'); return json(200, p);
  }
  return json(404, { message: 'no route ' + u.pathname });
}

/* ---------------------------------------------------------------- the functions, as deployed */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
async function functionHandlers(opts = {}) {
  const start = await import(path.join(ROOT, 'supabase', 'functions', 'payment-start', 'handler.js'));
  const hook = await import(path.join(ROOT, 'supabase', 'functions', 'payment-webhook', 'handler.js'));
  const env = { SUPABASE_URL: SELF, SUPABASE_SERVICE_ROLE_KEY: SERVICE, FAKE_WEBHOOK_SECRET: FAKE_SECRET, PAYMENT_RETURN_ORIGINS: ORIGINS.join(','), PAYMENT_ALLOW_LOCAL_ORIGINS: '1' };   // plain http: this computer and its Wi-Fi (never on live)
  const quiet = opts.log || { warn: (...a) => say('function  ', ...a), info: () => {} };
  const webhook = hook.createHandler({ fetch: postgrest, env, log: quiet });
  const fetchFromFunction = (url, init) => String(url).startsWith(SELF + '/functions/v1/payment-webhook/') ? webhook(new Request(url, init)) : postgrest(url, init);
  // the fake provider's callback goes to SELF, whichever address the browser used
  const startEnv = Object.assign({}, env, { PAYMENT_WEBHOOK_URL: SELF + '/functions/v1/payment-webhook' });
  return { 'payment-start': start.createHandler({ fetch: fetchFromFunction, env: startEnv, log: quiet }), 'payment-webhook': webhook };
}
async function main() {
  const handlers = await functionHandlers();

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, SELF);
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    try {
      if (u.pathname === '/aalayna-config.js') {
        res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        return res.end('/* rehearsal: the shared store and the functions are this computer */\nwindow.AalaynaConfig = { supabaseUrl: ' + JSON.stringify('http://' + req.headers.host) + ', anonKey: "rehearsal" };\n');
      }
      const fn = /^\/functions\/v1\/([a-z-]+)/.exec(u.pathname);
      if (fn || u.pathname.startsWith('/rest/v1/')) {
        const url = 'http://' + req.headers.host + req.url;
        let out;
        if (fn && handlers[fn[1]]) {
          out = await handlers[fn[1]](new Request(url, { method: req.method, headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body }));
        } else if (fn) out = json(404, { error: 'No such function' });
        else {
          if (req.method === 'OPTIONS') out = new Response(null, { status: 204 });
          else out = await postgrest(url, { method: req.method, headers: Object.assign({}, headers, { Authorization: headers.authorization, 'x-aalayna-key': headers['x-aalayna-key'] }), body: body.length ? body.toString('utf8') : undefined });
        }
        const hs = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': headers.origin || '*', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-aalayna-key, x-aalayna-payer, x-aalayna-device, prefer', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' };
        out.headers.forEach((v, k) => { hs[k] = v; });
        res.writeHead(out.status, hs);
        return res.end(Buffer.from(await out.arrayBuffer()));
      }
      // static files, never cached
      let file = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    } catch (e) {
      say('error     ', e && e.stack || e);
      res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('rehearsal error: ' + (e && e.message || e));
    }
  });
  server.listen(PORT, '0.0.0.0', () => {
    const link = (origin) => origin + '/guest.html?venue=Mayda&place=Hamra&k=' + KEY;
    console.log('\naalayna payments rehearsal\n');
    console.log('  Table 7, ' + money(CHECK.totalCents / 100) + ' on the bill, Mayda with demo payments on; card and Whish go to the fake provider.');
    console.log('  Guest link (this computer):  ' + link(SELF));
    lan.forEach((a) => console.log('  Guest link (phone on this Wi-Fi): ' + link('http://' + a + ':' + PORT)));
    console.log('\n  One browser holds one bill key: open the link once per device. Ctrl-C ends the rehearsal; nothing is kept.\n');
  });
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { postgrest, mutate, snapshot, functionHandlers, db, CHECK, KEY, RID, SELF, ORIGINS, numeric, cents };
