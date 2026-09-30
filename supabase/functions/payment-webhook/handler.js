/* Payment provider callbacks (T14): POST /functions/v1/payment-webhook/<provider>.

   The guest's reserve creates an aal.settle row with status 'initiated' and an expiresAt ten
   minutes out. Only a call carrying the service role may run aal_mutate confirm_digital
   (supabase/auth-2026-09-24.sql), which checks the reference, currency and amount. This
   function is that call: it verifies the provider's signature, reads the callback, finds the
   payment and asks the database to confirm it. It never decides on its own that money moved.

   Plain ES module with injected dependencies, so node --test runs it without Deno:
     createHandler({fetch, now, env, crypto, log, adapters, limiter}) -> (Request) -> Response
       fetch    the fetch used for PostgREST (default the global one)
       now      () -> Date
       env      object or getter: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FAKE_WEBHOOK_SECRET
       crypto   Web Crypto (default globalThis.crypto)
       log      {warn, info} (default console); never given a request body

   A provider adapter is {name, enabled(env), verify(request, rawBody, env, crypto) ->
   boolean or Promise<boolean>, parse(rawBody) -> event}. rawBody is the exact body as a
   string (UTF-8, at most 64 kB); env is a getter, env('NAME') -> value. event is
     {externalRef, paymentId, restaurantId?, amountCents, currency, status, occurredAt}
     externalRef   the provider's transaction reference (stored on the payment)
     paymentId     the aal.settle id the guest's reserve created
     restaurantId  optional; when absent the payment is looked up by id alone
     amountCents   integer, the whole amount charged including the tip
     currency      ISO 4217 upper case; the server compares it with the payment's ('USD')
     status        'paid' | 'failed' | 'refunded'
     occurredAt    ISO 8601 time at the provider
   Optional flags: demoOnly (confirms only at venues whose venue_profiles.demo_payments is
   true) and notImplemented (a sentence: the route answers 501 with it and reads nothing).

   Answers
     200 {status:'confirmed'}        confirm_digital accepted, or the same reference again
     200 {status:'duplicate'}        the server said 'Duplicate provider reference': this
                                     reference already confirmed another payment. Retrying
                                     cannot change that, so the provider is told to stop; the
                                     callbacks row is what someone reconciles.
     200 {status:'failed'}           a failed payment released (aal_payment_failed), or it was
                                     already released
     202 {status:'recorded'}         a refund: recorded only, digital refunds are not modelled
     400 unreadable or incomplete callback (after a good signature)
     401 bad or missing signature    403 fake provider at a venue with demo payments off
     404 unknown or disabled provider, or no such payment
     409 the server refused: reservation expired or changed, amount/currency mismatch, a
         failure for a payment already confirmed, or a payment id found at two venues
     413 body over 64 kB   429 rate limited   501 adapter not built yet (whish)
     500 the database refused for another reason, or the callbacks row could not be written;
         the provider retries, and every retry is idempotent
   Every call that passes the signature check writes one payment_callbacks row, whatever the
   outcome. A request body is never logged or stored; the row keeps the parsed fields. */

import { hmacHex, timingSafeEqual } from '../_shared/verify.js';
import { createClient, envGetter, eq, SupabaseError } from '../_shared/supabase.js';

export const MAX_BODY = 64 * 1024;
export const RATE_LIMIT = { max: 120, windowMs: 60 * 1000 };
const STATUSES = ['paid', 'failed', 'refunded'];

/* ------------------------------------------------------------------ adapters */

/* The test and rehearsal provider. Body: the event as JSON. Header X-Signature: the
   lower-case hex HMAC-SHA256 of the exact body bytes with FAKE_WEBHOOK_SECRET (a "sha256="
   prefix is accepted). With FAKE_WEBHOOK_SECRET unset the route does not exist (404), and it
   only ever confirms payments at venues marked "demo payments on" in admin.html. */
export const fakeAdapter = {
  name: 'fake',
  demoOnly: true,
  enabled: (env) => Boolean(env('FAKE_WEBHOOK_SECRET')),
  async verify(request, rawBody, env, cryptoImpl) {
    const given = String(request.headers.get('x-signature') || '').trim().toLowerCase().replace(/^sha256=/, '');
    if (!/^[0-9a-f]{64}$/.test(given)) return false;
    return timingSafeEqual(given, await hmacHex(env('FAKE_WEBHOOK_SECRET'), rawBody, cryptoImpl));
  },
  parse(rawBody) {
    const j = JSON.parse(rawBody);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('The callback is not a JSON object');
    return {
      externalRef: j.externalRef, paymentId: j.paymentId, restaurantId: j.restaurantId,
      amountCents: j.amountCents, currency: j.currency, status: j.status, occurredAt: j.occurredAt,
    };
  },
};

/* Whish Money. Its merchant callback is not public, so nothing is guessed: every call is
   refused with 501 and nothing is read or confirmed. After the Whish meeting, the work is:
   fill in verify and parse from their documentation, delete notImplemented, add the secret
   they issue (e.g. WHISH_WEBHOOK_SECRET) and a test in tests/payment-webhook.test.cjs.
   Questions for the meeting are the list in notImplemented. */
export const whishAdapter = {
  name: 'whish',
  notImplemented: 'Whish callbacks are not connected yet. Unknown until Whish shares its merchant API: ' +
    'how a callback is signed (header, algorithm, key, timestamp and replay window), the body format, ' +
    'which field carries our payment id, the transaction reference, amount units and currency codes, ' +
    'the status values for paid, failed and refunded, and the source addresses or retry policy.',
  enabled: () => true,
  verify() { return false; },   // e.g. timingSafeEqual(request.headers.get('<their header>'), await hmacHex(env('WHISH_WEBHOOK_SECRET'), rawBody))
  parse() { throw new Error('Whish callback format unknown'); },
};

export const ADAPTERS = { fake: fakeAdapter, whish: whishAdapter };

/* ------------------------------------------------------------------ helpers */

export function createLimiter({ max = RATE_LIMIT.max, windowMs = RATE_LIMIT.windowMs } = {}) {
  const hits = new Map();
  return {
    take(key, at) {
      const t = at instanceof Date ? at.getTime() : Number(at);
      let h = hits.get(key);
      if (!h || t - h.start >= windowMs) {
        if (hits.size > 10000) hits.clear();
        h = { start: t, n: 0 };
        hits.set(key, h);
      }
      h.n += 1;
      return h.n <= max;
    },
  };
}

function reply(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
}

/* the segment after "payment-webhook" in the path, lower case; '' if none */
export function providerFrom(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  const i = parts.lastIndexOf('payment-webhook');
  return (i >= 0 ? parts[i + 1] || '' : '').toLowerCase();
}

/* Reads at most max bytes. {tooLarge} past the cap (by Content-Length or by counting),
   {invalid} for a body that is not UTF-8, else {text}. */
export async function readCapped(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  const chunks = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { try { await reader.cancel(); } catch (_) { /* already closed */ } return { tooLarge: true }; }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(all) }; } catch (_) { return { invalid: true }; }
}

const str = (v, n) => typeof v === 'string' && v.trim() !== '' && v.length <= n;

/* the reason an event cannot be used, or null */
export function checkEvent(e) {
  if (!e || typeof e !== 'object') return 'The callback has no event';
  if (!str(e.externalRef, 200)) return 'externalRef is missing';
  if (!str(e.paymentId, 200)) return 'paymentId is missing';
  if (e.restaurantId != null && !str(e.restaurantId, 300)) return 'restaurantId is not a string';
  if (!Number.isSafeInteger(e.amountCents) || e.amountCents <= 0) return 'amountCents must be a positive integer';
  if (typeof e.currency !== 'string' || !/^[A-Z]{3}$/.test(e.currency)) return 'currency must be a three-letter code';
  if (!STATUSES.includes(e.status)) return 'status must be paid, failed or refunded';
  if (typeof e.occurredAt !== 'string' || !Number.isFinite(Date.parse(e.occurredAt))) return 'occurredAt must be an ISO time';
  return null;
}

const clientKey = (request, provider) =>
  provider + '|' + (String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown');

/* ------------------------------------------------------------------ handler */

export function createHandler(deps = {}) {
  const env = envGetter(deps.env || {});
  const now = deps.now || (() => new Date());
  const cryptoImpl = deps.crypto || globalThis.crypto;
  const log = deps.log || console;
  const adapters = deps.adapters || ADAPTERS;
  const limiter = deps.limiter || createLimiter();
  const db = () => createClient({ url: env('SUPABASE_URL'), serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'), fetch: deps.fetch });

  return async function handle(request) {
    if (request.method !== 'POST') return reply(405, { error: 'Use POST' }, { Allow: 'POST' });
    const provider = providerFrom(new URL(request.url).pathname);
    const adapter = Object.prototype.hasOwnProperty.call(adapters, provider) ? adapters[provider] : null;
    if (!adapter || !adapter.enabled(env)) return reply(404, { error: 'Unknown payment provider' });
    if (!limiter.take(clientKey(request, provider), now())) return reply(429, { error: 'Too many callbacks' }, { 'Retry-After': '60' });
    if (adapter.notImplemented) return reply(501, { error: adapter.notImplemented });

    const body = await readCapped(request, MAX_BODY);
    if (body.tooLarge) return reply(413, { error: 'Callback body is over 64 kB' });
    if (body.invalid) return reply(400, { error: 'Callback body is not UTF-8' });

    let verified = false;
    try { verified = (await adapter.verify(request, body.text, env, cryptoImpl)) === true; } catch (_) { verified = false; }
    if (!verified) {
      log.warn('payment-webhook: signature refused', JSON.stringify({ provider }));
      return reply(401, { error: 'Invalid signature' });
    }

    const client = db();
    const row = { provider, external_ref: null, payment_id: null, restaurant_id: null, amount_cents: null, currency: null, status: null, occurred_at: null };
    /* Writes the callbacks row, then answers. A row that cannot be written turns the answer
       into 500 so the provider sends it again; every path below is safe to repeat. */
    async function finish(status, outcome, serverReply, bodyOut) {
      const record = Object.assign({}, row, { outcome, http_status: status, server_reply: serverReply ? String(serverReply).slice(0, 500) : null });
      try {
        await client.rest('payment_callbacks', { method: 'POST', body: record, headers: { Prefer: 'return=minimal' } });
      } catch (e) {
        log.warn('payment-webhook: callback not recorded', JSON.stringify({ provider, paymentId: row.payment_id, outcome, error: String(e && e.message || e).slice(0, 200) }));
        return reply(500, { error: 'Callback not recorded; send it again' });
      }
      log.info('payment-webhook', JSON.stringify({ provider, paymentId: row.payment_id, outcome, status }));
      return reply(status, bodyOut);
    }

    let event;
    try { event = adapter.parse(body.text); } catch (_) { return finish(400, 'invalid', 'Unreadable callback', { error: 'Unreadable callback' }); }
    const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
    Object.assign(row, {
      external_ref: cut(event && event.externalRef, 200), payment_id: cut(event && event.paymentId, 200),
      restaurant_id: cut(event && event.restaurantId, 300),
      amount_cents: event && Number.isSafeInteger(event.amountCents) ? event.amountCents : null,
      currency: cut(event && event.currency, 3), status: cut(event && event.status, 20),
      occurred_at: event && typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt)) ? new Date(event.occurredAt).toISOString() : null,
    });
    const problem = checkEvent(event);
    if (problem) return finish(400, 'invalid', problem, { error: problem });

    try {
      // the payment, and so its venue when the provider does not send one
      const rows = await client.rest('kv_rows?collection=eq.aal.settle&id=' + eq(event.paymentId) +
        (event.restaurantId ? '&restaurant_id=' + eq(event.restaurantId) : '') + '&select=restaurant_id,body&limit=2');
      if (!rows || !rows.length) return finish(404, 'unknown_payment', 'Payment unavailable', { error: 'Payment unavailable' });
      if (rows.length > 1) {
        const m = 'This payment id exists at more than one venue; the callback must name the restaurant';
        return finish(409, 'ambiguous', m, { error: m });
      }
      const rid = rows[0].restaurant_id, settle = rows[0].body || {};
      row.restaurant_id = rid;

      if (adapter.demoOnly) {
        const p = await client.rest('venue_profiles?restaurant_id=' + eq(rid) + '&select=demo_payments');
        if (!(p && p[0] && p[0].demo_payments === true)) {
          const m = 'The ' + provider + ' provider only confirms payments at venues with demo payments on';
          return finish(403, 'refused_live_venue', m, { error: m });
        }
      }

      if (event.status === 'refunded') {
        return finish(202, 'refund_recorded', 'Recorded only: digital refunds are not modelled yet', { status: 'recorded', paymentId: event.paymentId });
      }

      if (event.status === 'failed') {
        if (settle.status === 'initiated') {
          try {
            await client.rpc('aal_payment_failed', { p_rid: rid, p_id: event.paymentId, p_external_ref: event.externalRef });
          } catch (e) {
            // the payment changed between the read and the call (e.g. confirmed meanwhile)
            if (!(e instanceof SupabaseError) || e.status === 0 || e.status >= 500) throw e;
            return finish(409, 'failed_conflict', e.message, { error: e.message });
          }
          return finish(200, 'failed_released', 'Payment marked failed', { status: 'failed', paymentId: event.paymentId });
        }
        if (['failed', 'cancelled', 'expired'].includes(settle.status)) {
          return finish(200, 'failed_already', 'Payment was already ' + settle.status, { status: 'failed', paymentId: event.paymentId });
        }
        const m = 'A failure arrived for a payment that is ' + (settle.status || 'unknown') + '; reconcile with the provider';
        return finish(409, 'failed_conflict', m, { error: m });
      }

      // paid
      try {
        await client.rpc('aal_mutate', {
          p_rid: rid, p_op: 'confirm_digital', p_token: '',
          p_body: { id: event.paymentId, externalRef: event.externalRef, amountCents: event.amountCents, currency: event.currency },
        });
        return finish(200, 'confirmed', 'Confirmed', { status: 'confirmed', paymentId: event.paymentId });
      } catch (e) {
        if (!(e instanceof SupabaseError) || e.status === 0 || e.status >= 500) throw e;
        const m = e.message;
        if (m === 'Duplicate provider reference') {
          return finish(200, 'duplicate', m, { status: 'duplicate', idempotent: true, paymentId: event.paymentId });
        }
        if (/^Reservation expired or changed/.test(m) || /^Callback amount, currency or reference mismatch/.test(m)) {
          return finish(409, 'refused', m, { error: m });
        }
        if (m === 'Payment unavailable') return finish(404, 'unknown_payment', m, { error: m });
        return finish(500, 'error', m, { error: 'The server refused the confirmation' });
      }
    } catch (e) {
      const m = String(e && e.message || e).slice(0, 300);
      return finish(500, 'error', m, { error: 'Temporary failure; send the callback again' });
    }
  };
}
