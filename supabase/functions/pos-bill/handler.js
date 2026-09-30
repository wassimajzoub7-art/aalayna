/* pos-bill: a point-of-sale system pushes a table's bill into Aalayna.
   POST /functions/v1/pos-bill, header X-Aalayna-Integration-Key. docs/pos-integration.md
   is the contract. All logic is here, as a plain ES module with its dependencies passed
   in, so node --test runs it (tests/pos-bridge.test.cjs); index.ts only wires it to
   Deno.serve.

   The request is checked here and then handed whole to aal_pos_bill (supabase/
   integrations-2026-09-30.sql), which does the open, update and close in one transaction
   under the venue lock. The plain key never reaches the database: only its sha256 does.
   Nothing here logs a request or response body. */

import { fromEnv } from '../_shared/supabase.js';
import { sha256Hex } from '../_shared/verify.js';

export const LIMIT_PER_MINUTE = 600;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_LINES = 500;
export const MAX_TENDERS = 50;
export const TENDER_METHODS = ['cash', 'card', 'other'];
export const SERVICE_LINE_ID = 'aalayna:service';

const MAX_CENTS = Number.MAX_SAFE_INTEGER;

const isInt = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function idOf(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= 100 && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

/* A bill-level discount has no line of its own (Aalayna lines cannot be negative): it is
   spread over the item lines in proportion to their value, to the cent, largest
   remainder first, so each line shows what the guest pays for it. */
export function spreadDiscount(grossCents, discountCents) {
  const gross = grossCents.map(BigInt), total = gross.reduce((a, b) => a + b, 0n), d = BigInt(discountCents);
  if (d === 0n || total === 0n) return grossCents.map(() => 0);
  const share = gross.map((g) => (d * g) / total);
  const rest = gross.map((g, i) => ({ i, frac: (d * g) % total }));
  let left = d - share.reduce((a, b) => a + b, 0n);
  rest.sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  for (const r of rest) {
    if (left === 0n) break;
    if (share[r.i] < gross[r.i]) { share[r.i] += 1n; left -= 1n; }
  }
  return share.map(Number);
}

/* The POS body -> {errors} or {bill}, bill being what aal_pos_bill takes:
   {system, externalId, table, currency, totalCents, discountCents, serviceCents, version,
    closed, items:[{id,q,unitCents,name}], lines:[{id,q,p,name}],
    tenders:[{externalId,method,amountCents,tipCents,takenAt}]}
   lines are aal_mutate's format (p the line total in units, the discount spread, the
   service charge as its own line) and are used while no payment exists; items are the
   POS lines at full price, from which aal_pos_bill adds lines once a payment exists.
   Notes are accepted and dropped: they can carry guest details and Aalayna does not show
   them. */
export function validateBill(body) {
  const errors = [], bad = (field, message) => errors.push({ field, message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: '(body)', message: 'must be a JSON object' }] };
  const externalId = idOf(body.externalId);
  if (externalId === null) bad('externalId', 'required: a string of 1 to 100 characters, unique for this venue forever');
  let system = 'pos';
  if (body.system !== undefined) {
    if (typeof body.system === 'string' && /^[a-z0-9][a-z0-9_.-]{0,31}$/i.test(body.system)) system = body.system.toLowerCase();
    else bad('system', 'optional: 1 to 32 letters, digits, dot, dash or underscore');
  }
  if (!isInt(body.table, 1, 9999)) bad('table', 'required: a whole table number from 1 to 9999');
  if (body.currency !== 'USD' && body.currency !== 'LBP') bad('currency', 'required: USD or LBP');
  if (!isInt(body.version, 1, MAX_CENTS)) bad('version', 'required: a whole number of at least 1 that grows with every change');
  if (body.closed !== undefined && typeof body.closed !== 'boolean') bad('closed', 'optional: true or false');
  for (const f of ['discountCents', 'serviceCents']) {
    if (body[f] !== undefined && !isInt(body[f], 0, MAX_CENTS)) bad(f, 'optional: a whole number of cents, 0 or more');
  }
  if (!isInt(body.totalCents, 0, MAX_CENTS)) bad('totalCents', 'required: a whole number of cents, 0 or more');

  const items = [];
  if (!Array.isArray(body.lines)) bad('lines', 'required: a list of lines');
  else if (body.lines.length > MAX_LINES) bad('lines', 'at most ' + MAX_LINES + ' lines');
  else {
    const seen = new Set();
    body.lines.forEach((l, i) => {
      const at = 'lines[' + i + ']';
      if (!l || typeof l !== 'object' || Array.isArray(l)) { bad(at, 'must be an object'); return; }
      const id = idOf(l.externalId);
      if (id === null) bad(at + '.externalId', 'required: a string of 1 to 100 characters');
      else if (id.toLowerCase().startsWith('aalayna:')) bad(at + '.externalId', 'must not start with "aalayna:"');
      else if (seen.has(id)) bad(at + '.externalId', 'appears twice on this bill');
      else seen.add(id);
      const name = typeof l.name === 'string' ? clean(l.name) : '';
      if (!name || name.length > 200) bad(at + '.name', 'required: 1 to 200 characters');
      if (!isInt(l.quantity, 0, 999)) bad(at + '.quantity', 'required: a whole number from 0 to 999 (0 or a missing line voids it)');
      if (!isInt(l.unitPriceCents, 0, MAX_CENTS)) bad(at + '.unitPriceCents', 'required: a whole number of cents, 0 or more, modifiers included');
      let mods = [];
      if (l.modifiers !== undefined) {
        const ok = Array.isArray(l.modifiers) && l.modifiers.length <= 20 && l.modifiers.every((m) => {
          const n = typeof m === 'string' ? m : m && typeof m === 'object' ? m.name : null;
          return typeof n === 'string' && clean(n).length >= 1 && clean(n).length <= 60;
        });
        if (!ok) bad(at + '.modifiers', 'optional: up to 20 names (strings or {name}), 1 to 60 characters each');
        else mods = l.modifiers.map((m) => clean(typeof m === 'string' ? m : m.name));
      }
      if (l.note !== undefined && (typeof l.note !== 'string' || l.note.length > 500)) bad(at + '.note', 'optional: up to 500 characters');
      if (id !== null && name && isInt(l.quantity, 0, 999) && isInt(l.unitPriceCents, 0, MAX_CENTS)) {
        const gross = l.quantity * l.unitPriceCents;
        if (!Number.isSafeInteger(gross) || gross > 1e15) bad(at, 'quantity times unitPriceCents is too large');
        else if (l.quantity > 0) items.push({ id, q: l.quantity, unit: l.unitPriceCents, gross, name: (mods.length ? name + ' (' + mods.join(', ') + ')' : name).slice(0, 120) });
      }
    });
  }
  const tenders = [];
  if (body.tenders !== undefined) {
    if (!Array.isArray(body.tenders)) bad('tenders', 'optional: a list of tenders');
    else if (body.tenders.length > MAX_TENDERS) bad('tenders', 'at most ' + MAX_TENDERS + ' tenders');
    else {
      const seen = new Set();
      body.tenders.forEach((t, i) => {
        const at = 'tenders[' + i + ']';
        if (!t || typeof t !== 'object' || Array.isArray(t)) { bad(at, 'must be an object'); return; }
        const id = idOf(t.externalId);
        if (id === null) bad(at + '.externalId', 'required: a string of 1 to 100 characters');
        else if (seen.has(id)) bad(at + '.externalId', 'appears twice on this bill');
        else seen.add(id);
        if (!TENDER_METHODS.includes(t.method)) bad(at + '.method', 'required: cash, card or other');
        if (!isInt(t.amountCents, 1, MAX_CENTS)) bad(at + '.amountCents', 'required: a whole number of cents, tip included, at least 1');
        if (t.tipCents !== undefined && !isInt(t.tipCents, 0, MAX_CENTS)) bad(at + '.tipCents', 'optional: a whole number of cents, 0 or more');
        else if (isInt(t.amountCents, 1, MAX_CENTS) && (t.tipCents || 0) >= t.amountCents) bad(at + '.tipCents', 'must be less than amountCents');
        let takenAt = null;
        if (t.takenAt !== undefined && t.takenAt !== null) {
          const ms = typeof t.takenAt === 'string' ? Date.parse(t.takenAt) : NaN;
          if (!Number.isFinite(ms)) bad(at + '.takenAt', 'optional: an ISO 8601 date and time');
          else takenAt = new Date(ms).toISOString();
        }
        tenders.push({ externalId: id, method: t.method, amountCents: t.amountCents, tipCents: t.tipCents || 0, takenAt });
      });
    }
  }
  if (errors.length) return { errors };

  const discount = body.discountCents || 0, service = body.serviceCents || 0;
  const gross = items.reduce((a, l) => a + l.gross, 0);
  if (discount > gross) return { errors: [{ field: 'discountCents', message: 'is larger than the items it discounts (' + gross + ' cents)' }] };
  const expected = gross - discount + service;
  if (expected !== body.totalCents) {
    return { errors: [{ field: 'totalCents', message: 'must equal the lines minus discountCents plus serviceCents: ' + expected }] };
  }
  const off = spreadDiscount(items.map((l) => l.gross), discount);
  const lines = items.map((l, i) => ({ id: l.id, q: l.q, p: (l.gross - off[i]) / 100, name: l.name }));
  if (service > 0) lines.push({ id: SERVICE_LINE_ID, q: 1, p: service / 100, name: 'Service' });
  return { bill: { system, externalId, table: body.table, currency: body.currency, totalCents: body.totalCents,
    discountCents: discount, serviceCents: service, version: body.version, closed: body.closed === true,
    items: items.map((l) => ({ id: l.id, q: l.q, unitCents: l.unit, name: l.name })), lines, tenders } };
}

function reply(status, obj, extra) {
  return new Response(JSON.stringify(obj), {
    status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {})
  });
}
const failure = (status, code, message, more, headers) => reply(status, { error: Object.assign({ code, message }, more || {}) }, headers);

/* A refusal raised by aal_pos_bill carries hint 'pos:<status>:<code>' and a JSON detail;
   err is the SupabaseError that _shared/supabase.js throws. */
export function mapDatabaseError(err) {
  const m = err && typeof err.hint === 'string' && /^pos:(\d{3}):([a-z_]+)$/.exec(err.hint);
  if (m) {
    let detail = {};
    try { detail = err.details ? JSON.parse(err.details) : {}; } catch (e) { detail = {}; }
    return { status: Number(m[1]), code: m[2], message: String(err.message || ''), detail };
  }
  if (!err || !err.status || err.status >= 500) {
    return { status: 503, code: 'unavailable', message: 'Aalayna is unavailable. Retry the same request later.', detail: {} };
  }
  return { status: 500, code: 'internal', message: 'Aalayna could not process this bill. Retry later; if it persists, contact Aalayna.', detail: {} };
}

const silent = { info() {}, warn() {}, error() {} };

export async function handle(request, deps) {
  const log = deps.log || silent, crypto = deps.crypto || globalThis.crypto, now = deps.now || (() => new Date());
  const rpc = deps.rpc || fromEnv(deps.env, deps.fetch).rpc;
  const started = Date.now();
  let keyId = null;
  const done = (res, code, dbCode) => {
    // status and codes only: never a body, never a key, never a database message
    log.info(JSON.stringify({ fn: 'pos-bill', status: res.status, code: code || 'ok', db: dbCode || undefined, key: keyId, ms: Date.now() - started }));
    return res;
  };

  if (request.method !== 'POST') return done(failure(405, 'method_not_allowed', 'Use POST.', null, { Allow: 'POST' }), 'method_not_allowed');
  const key = (request.headers.get('x-aalayna-integration-key') || '').trim();
  if (!/^pos_[0-9a-f]{64}$/.test(key)) return done(failure(401, 'unknown_key', 'Unknown or revoked integration key.'), 'unknown_key');
  const hash = await sha256Hex(key, crypto);

  let who;
  try { who = await rpc('aal_pos_resolve', { p_key_hash: hash }); } catch (err) {
    const e = mapDatabaseError(err);
    return done(failure(e.status, e.code, e.message), e.code, err && err.code);
  }
  if (!who || !who.restaurant_id) return done(failure(401, 'unknown_key', 'Unknown or revoked integration key.'), 'unknown_key');
  keyId = who.key_id || null;
  const limit = Number(who.limit) || LIMIT_PER_MINUTE, calls = Number(who.calls) || 0;
  const rate = { 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': String(Math.max(0, limit - calls)) };
  if (calls > limit) {
    const reset = Date.parse(who.resetAt), wait = Math.min(60, Math.max(1, Math.ceil(((reset || 0) - now().getTime()) / 1000)));
    return done(failure(429, 'rate_limited', 'More than ' + limit + ' requests this minute for this key. Retry after ' + wait + ' s.',
      { retryAfterSeconds: wait }, Object.assign({ 'Retry-After': String(wait) }, rate)), 'rate_limited');
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return done(failure(413, 'too_large', 'The body is larger than 256 KB.', null, rate), 'too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return done(failure(413, 'too_large', 'The body is larger than 256 KB.', null, rate), 'too_large');
  let body;
  try { body = JSON.parse(text); } catch (e) {
    return done(failure(400, 'bad_json', 'The body is not valid JSON.', { fields: [{ field: '(body)', message: 'not valid JSON' }] }, rate), 'bad_json');
  }
  const checked = validateBill(body);
  if (checked.errors) return done(failure(400, 'bad_body', 'Some fields are missing or wrong.', { fields: checked.errors }, rate), 'bad_body');

  let out;
  try { out = (await rpc('aal_pos_bill', { p_key_hash: hash, p_bill: checked.bill })) || {}; } catch (err) {
    const e = mapDatabaseError(err);
    return done(failure(e.status, e.code, e.message, e.detail, rate), e.code, err && err.code);
  }
  return done(reply(out.created || out.status === 'opened' ? 201 : 200, out, rate), out.status);
}
