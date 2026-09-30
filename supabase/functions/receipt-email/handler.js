/* Receipt emails (T14): POST /functions/v1/receipt-email, header X-Aalayna-Cron.

   The guest's receipt op (aal_mutate 'receipt') stores the contact and the consent and
   links the guest to the payment (customerId). A trigger in supabase/payments-2026-09-30.sql
   turns that link into one outbox_email row (kind 'receipt', ref = the settlement id, one
   per settlement ever) and pokes this function through pg_net; pg_cron pokes it every minute
   as well. Each call drains what is due:

     aal_outbox_claim('receipt', 10, 120)   rows due now, marked 'sending' with a 2 minute
                                            lease and attempts + 1 (skip locked, so two runs
                                            never take the same row)
     for each row: read the payment, the guest, the bill, the venue profile and the rate;
       sent     Resend accepted it (provider_id kept)
       skipped  the guest did not ask for a receipt, the contact is a WhatsApp number (not
                sent yet), the payment is not confirmed any more, or the contact changed
                after the request; last_error says which
       queued   a temporary failure: tried again 1, 5, 30, 120, 120 minutes later
       failed   the 6th failure, or one that cannot succeed (no such payment, an address
                Resend rejects)
   The address is never copied into the outbox (to_hash is its SHA-256) or into a log.

   Plain ES module with injected dependencies, so node --test runs it without Deno:
     createHandler({fetch, now, env, crypto, log, sleep}) -> (Request) -> Response
       env   object or getter: AALAYNA_CRON_SECRET, RESEND_API_KEY, SUPABASE_URL,
             SUPABASE_SERVICE_ROLE_KEY, RECEIPT_FROM (optional, default
             "Aalayna <receipts@aalayna.com>")
     composeReceipt(...) builds the subject, text and HTML and is exported for tests. */

import { sha256Hex, timingSafeEqual } from '../_shared/verify.js';
import { createClient, envGetter, eq } from '../_shared/supabase.js';
import { createResend, DEFAULT_FROM, ResendError, scrub } from '../_shared/resend.js';

export const BACKOFF_MINUTES = [1, 5, 30, 120];
export const MAX_ATTEMPTS = 6;
export const BATCH = 10;
export const LEASE_SECONDS = 120;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RAILS = { whish: 'Whish Money', card: 'card', cash: 'cash' };

/* minutes to wait after the attempts-th failure */
export const backoffMinutes = (attempts) => BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];

/* ------------------------------------------------------------------ the email */

const cents = (dollars) => Math.round(Number(dollars || 0) * 100);
const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lbp = (n) => 'LL ' + Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();
const validRate = (r) => (typeof r === 'number' && r >= 1000 && r <= 10000000 ? r : null);

function beirutTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  // assembled from parts, so the wording does not depend on the runtime's ICU version
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)) p[x.type] = x.value;
  return p.day + ' ' + p.month + ' ' + p.year + ', ' + p.hour + ':' + p.minute + ' (Beirut)';
}

/* The receipt for one payment.
   venue      {name, place}
   settle     the aal.settle body: amount (dollars, tip included), tip, rail, items
              ({lineId: qty} when the guest paid for chosen items), table, confirmedAt/ts,
              externalRef, id
   check      the aal.checks body or null: lines [{id, q, p (line total, dollars), name}],
              table, totalCents
   rate       LL per USD, or null: the LBP line is shown only with a rate
   marketing  true when the guest said yes to the venue's offers with this receipt */
export function composeReceipt({ venue, settle, check, rate, marketing }) {
  const name = oneLine(venue && venue.name) || 'the restaurant';
  const place = oneLine(venue && venue.place);
  const total = cents(settle.amount), tip = cents(settle.tip), principal = total - tip;
  const lines = check && Array.isArray(check.lines) ? check.lines : [];
  const items = settle.items && typeof settle.items === 'object' ? Object.entries(settle.items).filter(([, q]) => Number(q) > 0) : [];
  let heading = null, rows = [], billTotal = null;
  if (items.length) {
    heading = 'Your items';
    rows = items.map(([id, q]) => {
      const l = lines.find((x) => x && x.id === id);
      const qty = Number(q);
      return { label: qty + ' x ' + (oneLine(l && l.name) || 'Item'), amount: l && Number(l.q) > 0 ? Math.round(cents(l.p) / Number(l.q) * qty) : null };
    });
  } else if (lines.length) {
    heading = 'The bill';
    rows = lines.map((l) => ({ label: Number(l.q) + ' x ' + (oneLine(l.name) || 'Item'), amount: cents(l.p) }));
    billTotal = Number.isFinite(Number(check.totalCents)) ? Number(check.totalCents) : rows.reduce((a, r) => a + r.amount, 0);
  }
  const table = settle.table != null ? settle.table : check && check.table;
  const when = beirutTime(settle.confirmedAt || settle.ts);
  const r = validRate(rate);

  const sums = [];
  if (billTotal != null) sums.push(['Bill total', usd(billTotal)]);
  if (tip > 0 || (billTotal != null && principal !== billTotal)) sums.push(['Your payment', usd(principal)]);
  if (tip > 0) sums.push(['Tip', usd(tip)]);
  sums.push(['Total paid', usd(total)]);
  const lbpLine = r ? 'About ' + lbp(total / 100 * r) + ' at ' + lbp(r) + ' to the dollar' : null;
  const paidBy = 'Paid by ' + (RAILS[settle.rail] || 'digital payment') + (when ? ' on ' + when : '') + '.';
  const reference = settle.externalRef ? 'Payment reference: ' + oneLine(settle.externalRef) : null;
  const why = 'You are getting this email because you asked ' + name + ' for a receipt at the table. It was sent by Aalayna, the table payment service ' + name + ' uses.';
  const offers = marketing ? 'You also said yes to offers from ' + name + ', so they may write to you. To stop, reply STOP to any of their messages.' : null;

  const pad = (a, b) => a + ' '.repeat(Math.max(2, 34 - a.length)) + b;
  const text = [
    'Your receipt from ' + name,
    place ? name + ', ' + place : null,
    table != null && table !== '' ? 'Table ' + table : null,
    '',
    heading,
    ...rows.map((x) => pad(x.label, x.amount == null ? '' : usd(x.amount))),
    heading ? '' : null,
    ...sums.map(([a, b]) => pad(a, b)),
    lbpLine,
    '',
    paidBy,
    reference,
    '',
    why,
    offers,
  ].filter((x) => x !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const td = 'padding:4px 0;';
  const tr = (a, b, strong) => '<tr><td style="' + td + '">' + (strong ? '<strong>' + esc(a) + '</strong>' : esc(a)) + '</td><td style="' + td + 'text-align:right;white-space:nowrap">' + (strong ? '<strong>' + esc(b) + '</strong>' : esc(b)) + '</td></tr>';
  const html = '<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45">' +
    '<div style="max-width:480px;margin:0 auto">' +
    '<h1 style="font-size:20px;margin:0 0 4px">Your receipt from ' + esc(name) + '</h1>' +
    (place ? '<p style="margin:0;color:#555">' + esc(name + ', ' + place) + '</p>' : '') +
    (table != null && table !== '' ? '<p style="margin:0;color:#555">Table ' + esc(table) + '</p>' : '') +
    (heading ? '<h2 style="font-size:15px;margin:20px 0 4px">' + esc(heading) + '</h2><table style="width:100%;border-collapse:collapse">' +
      rows.map((x) => tr(x.label, x.amount == null ? '' : usd(x.amount))).join('') + '</table>' : '') +
    '<table style="width:100%;border-collapse:collapse;margin-top:16px;border-top:1px solid #ddd">' +
    sums.map(([a, b]) => tr(a, b, a === 'Total paid')).join('') + '</table>' +
    (lbpLine ? '<p style="margin:2px 0 0;color:#555;text-align:right">' + esc(lbpLine) + '</p>' : '') +
    '<p style="margin:20px 0 0">' + esc(paidBy) + '</p>' +
    (reference ? '<p style="margin:4px 0 0;color:#555">' + esc(reference) + '</p>' : '') +
    '<p style="margin:24px 0 0;color:#777;font-size:13px">' + esc(why) + '</p>' +
    (offers ? '<p style="margin:8px 0 0;color:#777;font-size:13px">' + esc(offers) + '</p>' : '') +
    '</div></body></html>';

  return { subject: 'Your receipt from ' + name, text, html, lbpLine };
}

/* ------------------------------------------------------------------ handler */

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/* "kababji" from '["kababji","hamra"]', the shape of a restaurant_id, for a venue without a profile */
function nameFromId(rid) {
  try { const a = JSON.parse(rid); if (Array.isArray(a) && a[0]) return String(a[0]).replace(/\b\w/g, (c) => c.toUpperCase()); } catch (_) { /* not that shape */ }
  return null;
}

export function createHandler(deps = {}) {
  const env = envGetter(deps.env || {});
  const now = deps.now || (() => new Date());
  const cryptoImpl = deps.crypto || globalThis.crypto;
  const log = deps.log || console;

  return async function handle(request) {
    if (request.method !== 'POST') return reply(405, { error: 'Use POST' });
    const secret = env('AALAYNA_CRON_SECRET');
    if (!secret) return reply(503, { error: 'AALAYNA_CRON_SECRET is not set' });
    if (!timingSafeEqual(request.headers.get('x-aalayna-cron') || '', secret)) return reply(401, { error: 'Unauthorised' });
    const apiKey = env('RESEND_API_KEY');
    if (!apiKey) return reply(503, { error: 'RESEND_API_KEY is not set' });

    const db = createClient({ url: env('SUPABASE_URL'), serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'), fetch: deps.fetch });
    const mail = createResend({ apiKey, fetch: deps.fetch, sleep: deps.sleep });
    const from = env('RECEIPT_FROM') || DEFAULT_FROM;
    const one = async (path) => { const r = await db.rest(path); return Array.isArray(r) && r.length ? r[0] : null; };
    const summary = { claimed: 0, sent: 0, skipped: 0, retry: 0, failed: 0 };

    let claimed;
    try {
      claimed = await db.rpc('aal_outbox_claim', { p_kind: 'receipt', p_limit: BATCH, p_lease_seconds: LEASE_SECONDS }) || [];
    } catch (e) {
      log.warn('receipt-email: claim failed', String(e && e.message || e).slice(0, 200));
      return reply(500, { error: 'Could not read the outbox' });
    }
    summary.claimed = claimed.length;

    /* the email for one row: {skip}, {fail} or {to, subject, text, html} */
    async function build(row) {
      const rid = row.restaurant_id;
      const settle = (await one('kv_rows?restaurant_id=' + eq(rid) + '&collection=eq.aal.settle&id=' + eq(row.ref) + '&select=body') || {}).body;
      if (!settle) return { fail: 'Payment not found' };
      if (settle.status !== 'confirmed' || settle.refunded) return { skip: 'The payment is not confirmed' };
      if (!settle.customerId) return { fail: 'The payment has no guest' };
      const guest = (await one('kv_rows?restaurant_id=' + eq(rid) + '&collection=eq.aal.guests&id=' + eq(settle.customerId) + '&select=body') || {}).body;
      if (!guest) return { fail: 'Guest not found' };
      const history = Array.isArray(guest.consentHistory) ? guest.consentHistory : [];
      const consent = history.filter((h) => h && h.settlementId === row.ref).pop();
      if (!consent || consent.receipt !== true) return { skip: 'The guest did not ask for a receipt' };
      if (guest.channel !== 'email') return { skip: 'WhatsApp receipts are not sent yet' };
      const to = String(guest.contact || '');
      if (!EMAIL_RE.test(to)) return { fail: 'The contact is not an email address' };
      if (row.to_hash && (await sha256Hex(to, cryptoImpl)) !== row.to_hash) return { skip: 'The contact changed after the request' };
      const check = settle.checkId ? (await one('kv_rows?restaurant_id=' + eq(rid) + '&collection=eq.aal.checks&id=' + eq(settle.checkId) + '&select=body') || {}).body : null;
      const profile = await one('venue_profiles?restaurant_id=' + eq(rid) + '&select=name,place');
      let rate = validRate(Number(settle.fxRateUsed)) ? Number(settle.fxRateUsed) : null;
      if (!rate) {
        const doc = await one('kv_docs?restaurant_id=' + eq(rid) + '&key=eq.aal.rate&select=body');
        rate = doc ? validRate(Number(doc.body)) : null;
      }
      const venue = { name: profile && profile.name || nameFromId(rid), place: profile && profile.place || '' };
      const marketing = consent.marketing === true && guest.marketing === true;
      return Object.assign({ to }, composeReceipt({ venue, settle, check, rate, marketing }));
    }

    async function finish(row, patch, counter) {
      summary[counter] += 1;
      await db.rest('outbox_email?id=' + eq(row.id), { method: 'PATCH', body: Object.assign({ locked_until: null }, patch), headers: { Prefer: 'return=minimal' } });
    }

    for (const row of claimed) {
      try {
        if (row.attempts > MAX_ATTEMPTS) {
          await finish(row, { status: 'failed', last_error: 'Gave up after ' + MAX_ATTEMPTS + ' attempts' }, 'failed');
          continue;
        }
        let built;
        try { built = await build(row); } catch (e) { built = { retry: 'Could not read the payment: ' + scrub(e && e.message || e) }; }
        if (built.skip) { await finish(row, { status: 'skipped', last_error: built.skip }, 'skipped'); continue; }
        if (built.fail) { await finish(row, { status: 'failed', last_error: built.fail }, 'failed'); continue; }
        let error = built.retry || null, permanent = false;
        if (!error) {
          try {
            const r = await mail.send({ to: built.to, from, subject: built.subject, text: built.text, html: built.html, idempotencyKey: 'receipt/' + row.id });
            await finish(row, { status: 'sent', sent_at: now().toISOString(), provider_id: r.id, last_error: null }, 'sent');
            continue;
          } catch (e) {
            error = scrub(e && e.message || e);
            permanent = e instanceof ResendError && (e.status === 400 || e.status === 422);
          }
        }
        if (permanent || row.attempts >= MAX_ATTEMPTS) {
          await finish(row, { status: 'failed', last_error: error }, 'failed');
        } else {
          const next = new Date(now().getTime() + backoffMinutes(row.attempts) * 60000).toISOString();
          await finish(row, { status: 'queued', next_attempt_at: next, last_error: error }, 'retry');
        }
      } catch (e) {
        // the outbox update itself failed: the lease runs out and the row is claimed again;
        // Resend's idempotency key stops a second email for the same row within 24 hours
        log.warn('receipt-email: outbox update failed', JSON.stringify({ id: row.id, error: scrub(e && e.message || e) }));
      }
    }
    log.info('receipt-email', JSON.stringify(summary));
    return reply(200, summary);
  };
}
