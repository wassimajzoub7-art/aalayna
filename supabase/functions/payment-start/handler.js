/* Hosted payment pages (T15): the leg between a guest's reserve and the provider's callback.

   A digital payment on Aalayna is three steps, each on its own side of the money:
     1. reserve        the guest page (aal_mutate reserve, the bill key and a payer token):
                       an aal.settle row, status 'initiated', ten minutes to confirm
     2. hand over      THIS FUNCTION: the guest is sent to a page the provider hosts, with
                       the amount and our payment id; card details and wallet balances stay
                       with the provider, never with Aalayna
     3. confirm        payment-webhook: the provider's signed callback, and only that, turns
                       'initiated' into 'confirmed'
   Coming back to the guest page proves nothing: the page shows "confirming" until the
   snapshot carries the row the webhook confirmed. A redirect, a button or a screenshot is
   never confirmation (INTEGRATIONS.md).

   Routes (all answer CORS for the origins in PAYMENT_RETURN_ORIGINS)
     GET  /payment-start                 which digital rails this bill may pay, and by which
                                         provider: {rails: {card: 'fake', whish: 'fake'}}.
                                         A rail with no provider is absent; the guest page
                                         then offers cash only.
     POST /payment-start                 {paymentId, returnUrl} -> {url, provider, expiresAt}
                                         the page to send the guest to. The payment must be
                                         this bill's, 'initiated', not expired, a digital rail,
                                         and the payer token must be the one the reserve set.
     GET|POST /payment-start/<provider>/<page>
                                         pages a provider adapter serves itself; today the
                                         fake provider's checkout page (below).
   Headers from the guest page: x-aalayna-key (the chk_ bill key; the same credential the
   snapshot takes) and, on POST, x-aalayna-payer (the payer token the reserve was made with;
   its SHA-256 is in payment_secrets). returnUrl must be on an allowed origin; the function
   strips k, s and reset from it and adds pay=<paymentId>, so the page knows which payment to
   look at and no credential travels through the provider.

   Which provider: payment_providers (restaurant, rail) -> provider, config, Vault secret, via
   aal_payment_provider. No row, and demo payments on in admin.html, and FAKE_WEBHOOK_SECRET
   set: the fake provider. Otherwise the rail is not offered (409 'No payment provider is
   connected for this rail' on POST).

   A provider adapter is
     {name, enabled(env), create(ctx) -> {url, providerRef?}, pages?: {<page>: {get, post}}}
     create    ctx = {rid, pid, payment, amountCents, currency, rail, returnUrl, config, secret,
               selfBase, env, crypto, now, fetch}; selfBase is this function's own URL
               (…/functions/v1/payment-start). Throws {notImplemented: sentence} -> 501.
     pages     (request, ctx) -> Response, ctx = {env, crypto, now, fetch, selfBase, log}.
   Every handoff is a payment_sessions row (provider, rail, amount, return URL), written
   before the URL is answered; with payment_callbacks it is the reconciliation trail.

   The fake provider: a stand-in for Whish or a card gateway, for rehearsals at venues whose
   demo payments are on. create answers a page this function serves,
   /payment-start/fake/checkout?s=<signed token>: the amount, Pay and Decline. Pay posts a
   callback to /payment-webhook/fake signed with FAKE_WEBHOOK_SECRET exactly as a provider
   would, then sends the browser back to returnUrl. The token is HMAC-signed with the same
   secret and carries the venue, payment, amount, return URL and the reservation's expiry.
   No money moves; the page says so.

   Whish: create throws notImplemented until Whish shares its merchant API (the questions are
   in the sentence). Filling in create here and verify/parse in payment-webhook is the work.

   Answers (JSON unless a page)
     200 rails or {url}       400 bad request (missing header, unreadable body, return URL not
     allowed, cash rail)      401 wrong payer token   404 bill or payment unavailable
     405 wrong method         409 payment not 'initiated' (confirmed, expired, cancelled,
     failed), or no provider for the rail   413 body over 8 kB   429 rate limited
     501 adapter not built yet (whish)   502 the provider could not be reached
     500 the database refused, or the session row could not be written

   Plain ES module with injected dependencies, so node --test runs it without Deno:
     createHandler({fetch, now, env, crypto, log, adapters, limiter}) -> (Request) -> Response */

import { hmacHex, sha256Hex, timingSafeEqual } from '../_shared/verify.js';
import { createClient, envGetter, eq, SupabaseError } from '../_shared/supabase.js';
import { readCapped, createLimiter, reply, b64u, unb64u } from '../_shared/http.js';

export const MAX_BODY = 8 * 1024;
export const RATE_LIMIT = { max: 60, windowMs: 60 * 1000 };
export const DEFAULT_ORIGINS = ['https://aalayna.com', 'https://www.aalayna.com', 'http://127.0.0.1:8787', 'http://localhost:8787'];
const RAILS = ['card', 'whish'];
const KEY_RE = /^chk_[0-9a-f]{12,64}$/;

/* ------------------------------------------------------------------ helpers */

export function allowedOrigins(env) {
  const raw = String(env('PAYMENT_RETURN_ORIGINS') || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return raw.length ? raw : DEFAULT_ORIGINS;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-aalayna-key, x-aalayna-payer',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/* the path after "payment-start": ['fake', 'checkout'] or [] */
export function routeFrom(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  const i = parts.lastIndexOf('payment-start');
  return i >= 0 ? parts.slice(i + 1).map((p) => p.toLowerCase()) : [];
}

/* this function's own URL, up to and including payment-start */
export function selfBaseFrom(url) {
  const u = new URL(url);
  const i = u.pathname.lastIndexOf('/payment-start');
  return u.origin + (i >= 0 ? u.pathname.slice(0, i) : '') + '/payment-start';
}

/* The return URL the guest page asked for, checked and cleaned, or {error}. */
export function cleanReturnUrl(raw, paymentId, env) {
  let u;
  try { u = new URL(String(raw || '')); } catch (_) { return { error: 'returnUrl must be an absolute URL' }; }
  if (!allowedOrigins(env).includes(u.origin)) return { error: 'returnUrl is not on an allowed origin' };
  ['k', 's', 'reset', 'pay'].forEach((p) => u.searchParams.delete(p));
  u.searchParams.set('pay', paymentId);
  u.hash = '';
  return { url: u.toString() };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur) => (cur === 'USD' ? '$' : '') + (cents / 100).toFixed(2) + (cur === 'USD' ? '' : ' ' + cur);
/* the venue's name as the id stores it (lower case), with its initials back */
const venueName = (rid) => {
  let name = String(rid);
  try { const a = JSON.parse(rid); if (Array.isArray(a) && a[0]) name = String(a[0]); } catch (_) { /* not a JSON id */ }
  return name.replace(/(^|\s)(\S)/g, (m, sp, c) => sp + c.toUpperCase());
};
const page = (status, html, headers) => new Response(html, { status, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }, headers || {}) });

/* ------------------------------------------------------------------ fake provider */

export async function checkoutToken(payload, secret, cryptoImpl) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + await hmacHex(secret, 'checkout:' + body, cryptoImpl);
}

/* the payload, or null for a token that is not ours or has expired */
export async function readCheckoutToken(token, secret, cryptoImpl, nowMs) {
  const m = /^([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m || !secret) return null;
  if (!timingSafeEqual(m[2], await hmacHex(secret, 'checkout:' + m[1], cryptoImpl))) return null;
  let p;
  try { p = JSON.parse(unb64u(m[1])); } catch (_) { return null; }
  if (!p || typeof p !== 'object' || typeof p.pid !== 'string' || !Number.isSafeInteger(p.c) || typeof p.exp !== 'number') return null;
  if (p.exp <= nowMs) return null;
  return p;
}

function checkoutHtml(p, token, selfBase, state) {
  const amt = money(p.c, p.cur), venue = venueName(p.rid), action = selfBase + '/fake/checkout';
  const body = state === 'unreachable'
    ? '<p class="lead">The payment could not be reported to Aalayna.</p><p>Nothing was charged. Go back to your bill and try again.</p>' +
      '<p><a class="btn ghost" href="' + esc(p.ret) + '">Back to the bill</a></p>'
    : '<p class="lead">Pay <b>' + esc(amt) + '</b> to ' + esc(venue) + '</p>' +
      '<p class="sub">Reference ' + esc(p.pid) + '</p>' +
      '<form method="post" action="' + esc(action) + '">' +
      '<input type="hidden" name="s" value="' + esc(token) + '">' +
      '<button class="btn" name="outcome" value="paid">Pay ' + esc(amt) + '</button>' +
      '<button class="btn ghost" name="outcome" value="failed">Decline</button>' +
      '</form>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Demo payment provider</title>' +
    '<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f1ea;color:#1d1d1b;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
    '.card{background:#fff;border-radius:16px;padding:28px 24px;max-width:360px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.08)}' +
    '.tag{display:inline-block;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#7a7268;margin-bottom:12px}' +
    '.lead{font-size:20px;margin:0 0 4px}.sub{margin:0 0 20px;color:#7a7268;font-size:14px;word-break:break-all}' +
    '.btn{display:block;width:100%;box-sizing:border-box;border:0;border-radius:12px;padding:14px;font:inherit;font-weight:600;background:#C9414B;color:#fff;margin-top:10px;cursor:pointer;text-align:center;text-decoration:none}' +
    '.btn.ghost{background:transparent;color:#7a7268;border:1px solid #ddd3c0}.note{margin:18px 0 0;font-size:13px;color:#7a7268}</style></head>' +
    '<body><div class="card"><span class="tag">Demo payment provider</span>' + body +
    '<p class="note">This page stands in for the provider’s checkout. No money moves and no card is asked for.</p></div></body></html>';
}

export const fakeAdapter = {
  name: 'fake',
  enabled: (env) => Boolean(env('FAKE_WEBHOOK_SECRET')),
  async create(ctx) {
    const nonce = Array.from(ctx.crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    const exp = Math.min(Date.parse(ctx.payment.expiresAt) || 0, ctx.now().getTime() + 10 * 60000);
    const payload = { rid: ctx.rid, pid: ctx.pid, c: ctx.amountCents, cur: ctx.currency, rail: ctx.rail, ret: ctx.returnUrl, exp, n: nonce };
    const token = await checkoutToken(payload, ctx.env('FAKE_WEBHOOK_SECRET'), ctx.crypto);
    return { url: ctx.selfBase + '/fake/checkout?s=' + encodeURIComponent(token), providerRef: 'fake-session-' + nonce };
  },
  pages: {
    checkout: {
      async get(request, ctx) {
        const token = new URL(request.url).searchParams.get('s');
        const p = await readCheckoutToken(token, ctx.env('FAKE_WEBHOOK_SECRET'), ctx.crypto, ctx.now().getTime());
        if (!p) return page(404, '<!doctype html><meta charset="utf-8"><title>Demo payment provider</title><p>This payment page has expired. Go back to your bill and try again.</p>');
        return page(200, checkoutHtml(p, token, ctx.selfBase));
      },
      async post(request, ctx) {
        const body = await readCapped(request, MAX_BODY);
        if (!body.text) return page(400, '<!doctype html><meta charset="utf-8"><p>Unreadable form.</p>');
        const form = new URLSearchParams(body.text);
        const token = form.get('s'), outcome = form.get('outcome') === 'failed' ? 'failed' : 'paid';
        const secret = ctx.env('FAKE_WEBHOOK_SECRET');
        const p = await readCheckoutToken(token, secret, ctx.crypto, ctx.now().getTime());
        if (!p) return page(404, '<!doctype html><meta charset="utf-8"><title>Demo payment provider</title><p>This payment page has expired. Go back to your bill and try again.</p>');
        const event = JSON.stringify({
          externalRef: 'fake-' + p.pid + '-' + p.n, paymentId: p.pid, restaurantId: p.rid,
          amountCents: p.c, currency: p.cur, status: outcome, occurredAt: ctx.now().toISOString(),
        });
        const webhook = String(ctx.env('PAYMENT_WEBHOOK_URL') || ctx.selfBase.replace(/\/payment-start$/, '/payment-webhook')).replace(/\/+$/, '') + '/fake';
        let res;
        try {
          res = await ctx.fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': await hmacHex(secret, event, ctx.crypto) }, body: event });
        } catch (e) {
          ctx.log.warn('payment-start: fake callback not delivered', JSON.stringify({ paymentId: p.pid, error: String(e && e.message || e).slice(0, 200) }));
          return page(502, checkoutHtml(p, token, ctx.selfBase, 'unreachable'));
        }
        // 2xx confirmed or released; 4xx is the database's answer (expired, mismatch): the
        // guest page shows the payment's state either way. 5xx: the callback is not recorded.
        if (res.status >= 500) {
          ctx.log.warn('payment-start: fake callback refused', JSON.stringify({ paymentId: p.pid, status: res.status }));
          return page(502, checkoutHtml(p, token, ctx.selfBase, 'unreachable'));
        }
        ctx.log.info('payment-start: fake callback delivered', JSON.stringify({ paymentId: p.pid, outcome, status: res.status }));
        return new Response(null, { status: 303, headers: { Location: p.ret, 'Cache-Control': 'no-store' } });
      },
    },
  },
};

/* Whish Money. Nothing is guessed about its merchant API; create refuses with 501 naming what
   is unknown. After the documentation arrives: build the collect request here (their endpoint,
   authentication, amount units, our reference, return and callback URLs), answer its URL, and
   fill in verify/parse in payment-webhook/handler.js. */
export const whishAdapter = {
  name: 'whish',
  enabled: () => true,
  create() {
    const e = new Error('Whish is not connected yet');
    e.notImplemented = 'Whish checkout is not connected yet. Unknown until Whish shares its merchant API: ' +
      'the endpoint and authentication that create a collect, the amount units and currency codes, how our payment id ' +
      'travels as the merchant reference, the return URL after the customer confirms, and the callback (see payment-webhook).';
    throw e;
  },
};

export const ADAPTERS = { fake: fakeAdapter, whish: whishAdapter };

/* ------------------------------------------------------------------ handler */

export function createHandler(deps = {}) {
  const env = envGetter(deps.env || {});
  const now = deps.now || (() => new Date());
  const cryptoImpl = deps.crypto || globalThis.crypto;
  const log = deps.log || console;
  const adapters = deps.adapters || ADAPTERS;
  const limiter = deps.limiter || createLimiter(RATE_LIMIT);
  const fetchImpl = deps.fetch || ((...a) => globalThis.fetch(...a));
  const db = () => createClient({ url: env('SUPABASE_URL'), serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'), fetch: deps.fetch });

  /* the provider taking a rail at a venue, or null; {error} when a row names an adapter
     this server does not have */
  async function providerFor(client, rid, rail, demo) {
    const row = await client.rpc('aal_payment_provider', { p_rid: rid, p_rail: rail });
    if (row && row.provider) {
      const a = Object.prototype.hasOwnProperty.call(adapters, row.provider) ? adapters[row.provider] : null;
      if (!a || !a.enabled(env)) return { error: 'The ' + row.provider + ' provider is not available on this server' };
      return { name: row.provider, adapter: a, config: row.config && typeof row.config === 'object' ? row.config : {}, secret: row.secret || null };
    }
    if (adapters.fake && adapters.fake.enabled(env) && await demo()) return { name: 'fake', adapter: adapters.fake, config: {}, secret: null };
    return null;
  }

  return async function handle(request) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const route = routeFrom(new URL(request.url).pathname);
    const selfBase = selfBaseFrom(request.url);

    // a provider's own pages (the fake checkout)
    if (route.length) {
      const adapter = Object.prototype.hasOwnProperty.call(adapters, route[0]) ? adapters[route[0]] : null;
      const p = adapter && adapter.enabled(env) && adapter.pages && Object.prototype.hasOwnProperty.call(adapter.pages, route[1] || '') ? adapter.pages[route[1]] : null;
      if (!p) return reply(404, { error: 'No such page' }, cors);
      const method = request.method === 'GET' ? 'get' : request.method === 'POST' ? 'post' : null;
      if (!method || !p[method]) return reply(405, { error: 'Use GET or POST' }, Object.assign({ Allow: 'GET, POST' }, cors));
      if (!limiter.take('page|' + (request.headers.get('x-forwarded-for') || '').split(',')[0].trim(), now())) return reply(429, { error: 'Too many requests' }, Object.assign({ 'Retry-After': '60' }, cors));
      return p[method](request, { env, crypto: cryptoImpl, now, fetch: fetchImpl, selfBase, log });
    }

    if (request.method !== 'GET' && request.method !== 'POST') return reply(405, { error: 'Use GET or POST' }, Object.assign({ Allow: 'GET, POST, OPTIONS' }, cors));
    const key = String(request.headers.get('x-aalayna-key') || '').trim();
    if (!KEY_RE.test(key)) return reply(400, { error: 'Open a current bill link' }, cors);
    if (!limiter.take('key|' + key, now())) return reply(429, { error: 'Too many requests' }, Object.assign({ 'Retry-After': '60' }, cors));

    const client = db();
    try {
      const keys = await client.rest('check_keys?key=' + eq(key) + '&select=restaurant_id,check_id&limit=1');
      if (!keys || !keys.length) return reply(404, { error: 'Bill unavailable' }, cors);
      const rid = keys[0].restaurant_id, cid = keys[0].check_id;
      let demoKnown = null;
      const demo = async () => {
        if (demoKnown === null) {
          const p = await client.rest('venue_profiles?restaurant_id=' + eq(rid) + '&select=demo_payments');
          demoKnown = Boolean(p && p[0] && p[0].demo_payments === true);
        }
        return demoKnown;
      };

      if (request.method === 'GET') {
        const rails = {};
        for (const rail of RAILS) {
          const p = await providerFor(client, rid, rail, demo);
          if (p && !p.error) rails[rail] = p.name;
        }
        return reply(200, { rails }, Object.assign({ 'Cache-Control': 'no-store' }, cors));
      }

      // POST: the handoff
      const token = String(request.headers.get('x-aalayna-payer') || '');
      if (token.length < 32 || token.length > 200) return reply(400, { error: 'Missing payer token' }, cors);
      const body = await readCapped(request, MAX_BODY);
      if (body.tooLarge) return reply(413, { error: 'Request body is over 8 kB' }, cors);
      let j = null;
      try { j = body.text ? JSON.parse(body.text) : null; } catch (_) { j = null; }
      if (!j || typeof j !== 'object' || typeof j.paymentId !== 'string' || !j.paymentId.trim() || j.paymentId.length > 200) return reply(400, { error: 'paymentId is missing' }, cors);
      const pid = j.paymentId.trim();
      const ret = cleanReturnUrl(j.returnUrl, pid, env);
      if (ret.error) return reply(400, { error: ret.error }, cors);

      const rows = await client.rest('kv_rows?restaurant_id=' + eq(rid) + '&collection=eq.aal.settle&id=' + eq(pid) + '&select=body&limit=1');
      const payment = rows && rows[0] && rows[0].body;
      if (!payment || payment.checkId !== cid) return reply(404, { error: 'Payment unavailable' }, cors);
      const secrets = await client.rest('payment_secrets?restaurant_id=' + eq(rid) + '&payment_id=' + eq(pid) + '&select=token_hash&limit=1');
      const hash = secrets && secrets[0] && secrets[0].token_hash;
      if (!hash || !timingSafeEqual(String(hash), await sha256Hex(token, cryptoImpl))) return reply(401, { error: 'Wrong payer token' }, cors);
      if (!RAILS.includes(payment.rail)) return reply(400, { error: 'Only card and Whish payments open a provider page' }, cors);
      const status = payment.status || 'initiated';
      if (status !== 'initiated') return reply(409, { error: 'This payment is ' + status, status }, cors);
      const expiresMs = Date.parse(payment.expiresAt);
      if (!Number.isFinite(expiresMs) || expiresMs <= now().getTime()) return reply(409, { error: 'This payment request has expired; start again', status: 'expired' }, cors);
      const amountCents = Math.round(Number(payment.amount) * 100);
      const currency = String(payment.currency || 'USD');
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return reply(409, { error: 'This payment has no amount', status }, cors);

      const provider = await providerFor(client, rid, payment.rail, demo);
      if (!provider) return reply(409, { error: 'No payment provider is connected for this rail', status: 'no_provider' }, cors);
      if (provider.error) return reply(409, { error: provider.error, status: 'no_provider' }, cors);

      let session;
      try {
        session = await provider.adapter.create({
          rid, pid, payment, amountCents, currency, rail: payment.rail, returnUrl: ret.url,
          config: provider.config, secret: provider.secret, selfBase, env, crypto: cryptoImpl, now, fetch: fetchImpl,
        });
      } catch (e) {
        if (e && e.notImplemented) return reply(501, { error: e.notImplemented }, cors);
        log.warn('payment-start: provider refused', JSON.stringify({ provider: provider.name, paymentId: pid, error: String(e && e.message || e).slice(0, 200) }));
        return reply(502, { error: 'The payment provider could not be reached; try again' }, cors);
      }
      if (!session || typeof session.url !== 'string' || !/^https?:\/\//.test(session.url)) {
        log.warn('payment-start: provider answered no URL', JSON.stringify({ provider: provider.name, paymentId: pid }));
        return reply(502, { error: 'The payment provider gave no page to open; try again' }, cors);
      }
      await client.rest('payment_sessions', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: { restaurant_id: rid, payment_id: pid, provider: provider.name, rail: payment.rail, provider_ref: session.providerRef == null ? null : String(session.providerRef).slice(0, 200), amount_cents: amountCents, currency, return_url: ret.url },
      });
      log.info('payment-start', JSON.stringify({ provider: provider.name, paymentId: pid, rail: payment.rail, amountCents }));
      return reply(200, { url: session.url, provider: provider.name, expiresAt: new Date(expiresMs).toISOString() }, Object.assign({ 'Cache-Control': 'no-store' }, cors));
    } catch (e) {
      const m = String(e && e.message || e).slice(0, 300);
      log.warn('payment-start: failed', JSON.stringify({ error: m, status: e instanceof SupabaseError ? e.status : null }));
      return reply(500, { error: 'Temporary failure; try again' }, cors);
    }
  };
}
