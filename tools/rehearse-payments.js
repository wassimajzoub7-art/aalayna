#!/usr/bin/env node
/* Rehearse card and Whish payments on this computer, without Supabase.

     node tools/rehearse-payments.js            (port 8788; --port N to change it)

   Serves the repository's pages and, in the same process, a stand-in for the parts of the
   shared store a guest page touches (aal_snapshot, aal_mutate reserve/cancel/receipt/event)
   plus the two real Edge Function handlers, payment-start and payment-webhook, run exactly
   as they are deployed (supabase/functions/<name>/handler.js) against an in-memory PostgREST.
   One venue (Mayda, demo payments on), one open bill at table 7, one bill key, printed at
   start as a guest link. Open it, split the bill, pay by card or Whish: the fake provider's
   checkout page opens, Pay posts the signed callback to payment-webhook, the guest page
   comes back and reads Confirmed by the demo provider. Decline sends the guest back to the
   bill. The console says what happened at each step.

   The phone on the same Wi-Fi works too: the link is printed with this computer's LAN
   address, and those origins are allowed for the return. Nothing here is a test of the
   SQL (tests/*.test.cjs with PGLITE_MODULE) or of the live project (supabase/README.md,
   "Hosted payment pages"): the rules of aal_mutate are approximated, not run. */
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
const usedCents = () => [...db.settle.values()].filter(live).reduce((n, s) => n + Math.round(s.amount * 100) - Math.round((s.tip || 0) * 100), 0);

/* ---------------------------------------------------------------- the guest's store (anon key + bill key) */
function mutate(op, body, token, service) {
  const refuse = (m) => { const e = new Error(m); e.refused = true; return e; };
  if (op === 'event') { const ev = Object.assign({}, body, { restaurantId: RID, createdAt: stamp() }); db.events.push(ev); return ev; }
  if (op === 'reserve') {
    const prev = db.settle.get(body.id);
    if (prev) return prev;
    const amount = Math.round(body.amount * 100), tip = Math.round((body.tip || 0) * 100);
    if (!(amount > 0) || tip < 0 || tip >= amount || !['cash', 'card', 'whish'].includes(body.rail)) throw refuse('Invalid amount');
    if (!token || token.length < 32) throw refuse('Missing payer token');
    if (usedCents() + amount - tip > CHECK.totalCents) throw refuse('Another payment already covers this balance. Refresh your bill.');
    const row = {
      id: body.id, requestId: body.requestId, venueId: RID, checkId: CHECK.id, table: CHECK.table, rail: body.rail, amount: amount / 100, tip: tip / 100,
      items: body.items || {}, deviceId: body.deviceId, sessionId: body.sessionId, server: body.server, currency: 'USD', amountUsd: amount / 100,
      note: body.note || 0, change: body.change || 0, status: body.rail === 'cash' ? 'pending' : 'initiated', ts: stamp(),
      expiresAt: body.rail === 'cash' ? null : new Date(Date.now() + 10 * 60000).toISOString(),
    };
    db.settle.set(row.id, row); db.secrets.set(row.id, crypto.createHash('sha256').update(token).digest('hex'));
    say('reserve   ', row.id, money(row.amount), 'by', row.rail, row.status, row.rail === 'cash' ? '' : '(ten minutes to confirm)');
    return row;
  }
  const p = db.settle.get(body.id);
  if (!p) throw refuse('Payment unavailable');
  const tokenOk = token && db.secrets.get(body.id) === crypto.createHash('sha256').update(token).digest('hex');
  if (op === 'cancel') {
    if (!tokenOk) throw refuse('Wrong payer token');
    if (['cancelled', 'expired', 'failed'].includes(p.status)) return p;
    if (!['pending', 'initiated'].includes(p.status)) throw refuse('Payment already completed');
    Object.assign(p, { status: 'cancelled', cancelled: stamp() }); say('cancel    ', p.id, 'by the guest'); return p;
  }
  if (op === 'receipt') { if (!tokenOk) throw refuse('Wrong payer token'); if (p.status !== 'confirmed') throw refuse('Payment must be confirmed'); say('receipt   ', p.id, 'asked for (not sent here)'); return { saved: true }; }
  if (op === 'confirm_digital') {
    if (!service) throw refuse('Verified provider callback required');
    if (p.externalRef === body.externalRef && p.status === 'confirmed') return p;
    if (p.status !== 'initiated' || Date.parse(p.expiresAt) <= Date.now()) throw refuse('Reservation expired or changed; reconcile received funds');
    if (!body.externalRef || body.currency !== p.currency || body.amountCents !== Math.round(p.amount * 100)) throw refuse('Callback amount, currency or reference mismatch');
    if ([...db.settle.values()].some((x) => x.externalRef === body.externalRef)) throw refuse('Duplicate provider reference');
    Object.assign(p, { status: 'confirmed', confirmedAt: stamp(), externalRef: body.externalRef }); say('confirmed ', p.id, money(p.amount), 'reference', body.externalRef); return p;
  }
  throw refuse('Unknown operation');
}
function snapshot() {
  return { version: 2, role: 'guest', checkId: CHECK.id, rows: [{ collection: 'aal.checks', id: CHECK.id, body: CHECK }].concat([...db.settle.values()].map((s) => ({ collection: 'aal.settle', id: s.id, body: s }))), docs: menu ? [{ key: 'aal.live', body: menu }] : [] };
}

/* ---------------------------------------------------------------- the in-memory PostgREST the functions see */
const json = (status, obj) => new Response(obj == null ? '' : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const pgError = (m) => json(400, { code: 'P0001', message: m });
async function postgrest(url, init = {}) {
  const u = new URL(url), q = u.searchParams, h = init.headers || {}, body = init.body ? JSON.parse(init.body) : null;
  const val = (k) => (q.get(k) || '').replace(/^eq\./, '');
  const service = h.Authorization === 'Bearer ' + SERVICE;
  const guest = h['x-aalayna-key'] === KEY;
  if (u.pathname === '/rest/v1/rpc/aal_snapshot') return guest ? json(200, snapshot()) : pgError('Open a current bill link.');
  if (u.pathname === '/rest/v1/rpc/aal_mutate') {
    if (!guest && !service) return pgError('Open a current bill link.');
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
    Object.assign(p, { status: 'failed', failedAt: stamp() }); say('declined  ', p.id, 'released'); return json(200, p);
  }
  return json(404, { message: 'no route ' + u.pathname });
}

/* ---------------------------------------------------------------- the functions, as deployed */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
async function main() {
  const start = await import(path.join(ROOT, 'supabase', 'functions', 'payment-start', 'handler.js'));
  const hook = await import(path.join(ROOT, 'supabase', 'functions', 'payment-webhook', 'handler.js'));
  const env = { SUPABASE_URL: SELF, SUPABASE_SERVICE_ROLE_KEY: SERVICE, FAKE_WEBHOOK_SECRET: FAKE_SECRET, PAYMENT_RETURN_ORIGINS: ORIGINS.join(',') };
  const quiet = { warn: (...a) => say('function  ', ...a), info: () => {} };
  const webhook = hook.createHandler({ fetch: postgrest, env, log: quiet });
  const fetchFromFunction = (url, init) => String(url).startsWith(SELF + '/functions/v1/payment-webhook/') ? webhook(new Request(url, init)) : postgrest(url, init);
  const handlers = { 'payment-start': start.createHandler({ fetch: fetchFromFunction, env, log: quiet }), 'payment-webhook': webhook };

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
          // the function sees the address the browser used, so its own pages and the webhook stay on it
          const h = fn[1] === 'payment-start' ? start.createHandler({ fetch: (x, i) => fetchFromFunction(String(x).replace('http://' + req.headers.host, SELF), i), env: Object.assign({}, env, { PAYMENT_WEBHOOK_URL: SELF + '/functions/v1/payment-webhook' }), log: quiet }) : handlers[fn[1]];
          out = await h(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body }));
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
main().catch((e) => { console.error(e); process.exit(1); });
