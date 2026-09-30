/* pos-webhook-deliver: sends the webhook deliveries that are due (bill.paid, bill.closed,
   ping) to the venues' endpoints. Called every minute by pg_cron through
   aal_pos_kick(), and by the kv_rows trigger right after it queues a delivery (pg_net),
   always with header X-Aalayna-Cron. All logic is here, as a plain ES module with its
   dependencies passed in, so node --test runs it (tests/pos-bridge.test.cjs); index.ts
   only wires it to Deno.serve.

   One run: aal_pos_claim_deliveries leases up to 50 due rows for five minutes; each is
   POSTed (10 at a time, 10 s timeout, redirects not followed) with X-Aalayna-Event,
   X-Aalayna-Delivery and X-Aalayna-Signature (HMAC-SHA256 of the exact body with the
   endpoint's secret, lower-case hex); aal_pos_delivery_result records a 2xx as delivered,
   anything else as a failed attempt with the next one 1, 5, 30, 120, then 720 minutes
   later, and gives up after the 8th failure (next_attempt_at null, last_error kept).
   Nothing here logs a payload. */

import { fromEnv } from '../_shared/supabase.js';
import { hmacHex, timingSafeEqual } from '../_shared/verify.js';

export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = 8;
export const BATCH = 50;
export const CONCURRENCY = 10;
export const TIMEOUT_MS = 10000;

/* attempts: how many have failed, this one included. null means give up. */
export function nextAttemptAt(attempts, now) {
  if (attempts >= MAX_ATTEMPTS) return null;
  const minutes = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
  return new Date(now.getTime() + minutes * 60000);
}

/* The same rule as aal_webhooks add: https and a public host name, never an IP literal
   or a local name. Checked again here in case a row was written some other way. */
export function allowedUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|localdomain|home|lan|test|invalid)$/.test(host);
}

export const signature = (secret, body, crypto) => hmacHex(secret, body, crypto);

function reply(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const silent = { info() {}, warn() {}, error() {} };

async function post(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, Object.assign({}, init, { signal: controller.signal, redirect: 'manual' }));
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (e) { /* already consumed */ }
    return { status: res.status };
  } catch (e) {
    return { status: null, error: controller.signal.aborted ? 'timed out after ' + Math.round(timeoutMs / 1000) + ' s' : 'network error: ' + (e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function handle(request, deps) {
  const log = deps.log || silent, crypto = deps.crypto || globalThis.crypto, now = deps.now || (() => new Date());
  const env = typeof deps.env === 'function' ? deps.env : (k) => (deps.env || {})[k];
  const rpc = deps.rpc || fromEnv(deps.env, deps.fetch).rpc;
  const send = deps.send || deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;

  if (request.method !== 'POST') return reply(405, { error: { code: 'method_not_allowed', message: 'Use POST.' } });
  const secret = env('AALAYNA_CRON_SECRET') || '';
  if (!secret) {
    log.error(JSON.stringify({ fn: 'pos-webhook-deliver', status: 500, code: 'not_configured' }));
    return reply(500, { error: { code: 'not_configured', message: 'AALAYNA_CRON_SECRET is not set.' } });
  }
  if (!timingSafeEqual(request.headers.get('x-aalayna-cron') || '', secret)) {
    return reply(401, { error: { code: 'unauthorized', message: 'X-Aalayna-Cron is missing or wrong.' } });
  }

  let due;
  try { due = (await rpc('aal_pos_claim_deliveries', { p_limit: BATCH })) || []; } catch (err) {
    log.error(JSON.stringify({ fn: 'pos-webhook-deliver', status: 503, code: 'claim_failed', dbStatus: err && err.status }));
    return reply(503, { error: { code: 'unavailable', message: 'Could not read the deliveries.' } });
  }

  const tally = { claimed: due.length, delivered: 0, failed: 0, gaveUp: 0, unrecorded: 0 };
  async function one(d) {
    let status = null, error = null;
    if (!d.active) error = 'endpoint removed';
    else if (!allowedUrl(d.url)) error = 'address not allowed';
    else {
      const body = JSON.stringify(d.payload);
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Aalayna-Webhooks/1',
        'X-Aalayna-Event': String(d.eventType),
        'X-Aalayna-Delivery': String(d.id),
        'X-Aalayna-Signature': await signature(d.secret, body, crypto),
      };
      const r = await post(send, d.url, { method: 'POST', headers, body }, timeoutMs);
      status = r.status;
      if (r.error) error = r.error;
      else if (status < 200 || status > 299) error = 'HTTP ' + status;
    }
    const ok = !error;
    // an endpoint that is gone, or an address that is not allowed, is not retried
    const attempts = (Number(d.attempts) || 0) + 1;
    const next = ok || !d.active || error === 'address not allowed' ? null : nextAttemptAt(attempts, now());
    if (ok) tally.delivered++; else if (next) tally.failed++; else tally.gaveUp++;
    const lastError = ok ? null : next ? error : (d.active && error !== 'address not allowed' ? 'gave up after ' + attempts + ' attempts: ' : '') + error;
    try {
      await rpc('aal_pos_delivery_result', { p_id: d.id, p_ok: ok, p_status: status, p_error: lastError, p_next_attempt_at: next ? next.toISOString() : null });
    } catch (err) {
      // the lease runs out in five minutes and the delivery is tried again
      tally.unrecorded++;
    }
  }
  const queue = due.slice();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await one(queue.shift());
  }));
  log.info(JSON.stringify(Object.assign({ fn: 'pos-webhook-deliver', status: 200 }, tally)));
  return reply(200, tally);
}
