/* Daily close email (T15). Plain ES module with injected dependencies, so node --test
   runs it without Deno:
     createHandler({ rest, send, now, env })
       rest(path, opts)  the service-role PostgREST call from ../_shared/supabase.js.
                         path is relative to /rest/v1/, e.g. "kv_rows?collection=eq.aal.checks".
                         Resolves to the parsed JSON (or a fetch Response, which is unwrapped).
       send(message)     ../_shared/resend.js send({to, subject, text, html, from, attachments})
                         -> {id}. attachments is [{filename, content}] with content in base64.
       now()             milliseconds since the epoch (default Date.now)
       env               function name -> value, or a plain object
       narrate(input)    optional (T4): closeNarrative's input -> Promise<{text, lang}>. index.ts passes
                         createNarrator from ../_shared/close-narrative-model.js; without it the email
                         has no narrative and the loads are exactly the day's.
   The window is Asia/Beirut 04:00 of the business day to 04:00 of the next day, so a
   late-night service belongs to the night it started in.
   A cron call closes, for every venue, the latest finished business day that has no sent row
   (cronDecision), so a failed or missed send is retried by the next cron call. A window with no
   bill opened or closed and no payment record is logged skipped ('no activity') and not emailed,
   unless ?force=1.

   Definitions mirror owner-metrics.js (A.ownerReport summary(), A.eventMetrics):
     confirmed payment  A.settlementStatus(s) === 'confirmed' (a refunded payment is not confirmed),
                        placed in time by confirmedAt || ts (timestamp())
     net / tips / rails amount minus tip, tip, and rail totals of the gross amount (summary())
     paid at the till   rail 'pos' (POS bridge tenders): its own line by method, never in cash or digital;
                        its tips are listed under "Till"
     USD value          amountUsd when present, else amount (eventMetrics rails)
     bills closed       closedAt inside the window (summary() "completed")
     receipt contacts   guests whose latest receipt consent inside the window is tied to a confirmed
                        payment; marketing opt-ins are those whose latest choice was marketing:true
   One deliberate difference: every status is evaluated as of the window's end, not "now". A
   payment refunded or a bill closed after 04:00 does not change that day's figures, so a manual
   rerun a week later reproduces the email that went out.

   Owner groups (supabase/groups-2026-10-28.sql): a group with venues also gets one email a day, to
   its owners and managers (owner_group_staff), with the group's figures (the sum of its venues'),
   then a section per venue exactly as that venue's own close shows it, and one CSV with a venue
   column. It is logged in daily_close_group_log with the same claim, retry and force rules. A venue
   of a group still gets its own close, to its own owners and managers (staff_members), minus anyone
   who already gets the group's email. Single-venue owners see no change. Without the groups tables
   (the migration not installed) the function sends per-venue closes exactly as before. */

const TZ = 'Asia/Beirut';
const CLOSE_HOUR = 4;
const PAGE = 1000;
const IN_PROGRESS = 'in progress';
const IN_PROGRESS_MS = 10 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------------------------------------------------------- time */

const wallFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

export function beirutParts(ms) {
  const out = {};
  for (const p of wallFormat.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}
const pad = (n) => (n < 10 ? '0' : '') + n;
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export function beirutDate(ms) { const p = beirutParts(ms); return dateKey(p.year, p.month, p.day); }

function parseDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, mo, d };
}
export function addDays(day, n) {
  const p = parseDay(day), t = new Date(Date.UTC(p.y, p.mo - 1, p.d + n));
  return dateKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/* Wall clock in Beirut -> instant. Beirut changes the clocks at midnight, never at 04:00, so
   the local time asked for always exists exactly once; two passes settle the offset. */
function offsetAt(ms) {
  const s = Math.floor(ms / 1000) * 1000, p = beirutParts(s);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s;
}
export function beirutInstant(day, hour) {
  const p = parseDay(day), wall = Date.UTC(p.y, p.mo - 1, p.d, hour);
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return guess;
}
/* The business day D runs from D 04:00 to D+1 04:00, Beirut time. */
export function windowFor(day) {
  return { day, start: beirutInstant(day, CLOSE_HOUR), end: beirutInstant(addDays(day, 1), CLOSE_HOUR) };
}
/* The most recent business day that has ended at `at`. */
export function lastCompletedDay(at) {
  const today = beirutDate(at);
  return at >= beirutInstant(today, CLOSE_HOUR) ? addDays(today, -1) : addDays(today, -2);
}
/* What a call without ?venue or ?date (the pg_cron call) does: for every venue, close the latest
   business day that has ended, unless that day already has a row with status sent. pg_cron fires
   at 01:00 and 02:00 UTC. Whichever of the two is 04:00 in Beirut finds the day just ended with no
   sent row and sends; the other finds the sent row and does nothing, or, if the send failed or
   was missed, is the automatic retry. No clock hour is checked, so nothing depends on the offset. */
export function cronDecision(at) {
  return { day: lastCompletedDay(at) };
}
export function dayLabel(day) {
  const p = parseDay(day), wd = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${p.d} ${MONTHS[p.mo - 1]}`;
}

/* ------------------------------------------------------------- figures */

const cents = (n) => Math.round(Number(n) * 100);           // A.util.cents
const stamp = (v) => (v == null || v === '' || v === false ? NaN : Date.parse(v));
const within = (t, s, e) => Number.isFinite(t) && t >= s && t < e;
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

export function fmtCents(c) {
  const neg = c < 0, a = Math.abs(c), whole = Math.floor(a / 100), frac = a % 100;
  return (neg ? '-' : '') + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + pad(frac);
}
const usdText = (c) => '$' + fmtCents(c);
const csvMoney = (c) => (c < 0 ? '-' : '') + Math.floor(Math.abs(c) / 100) + '.' + pad(Math.abs(c) % 100);

/* A settlement's status as of `end`: what A.settlementStatus would say at that instant. */
function statusAt(s, end) {
  const open = s.rail === 'cash' ? 'pending' : 'initiated';
  const happened = (v) => { if (v == null || v === false || v === '') return false; const t = Date.parse(v); return !Number.isFinite(t) || t < end; };
  if (s.refunded && happened(s.refunded)) return 'refunded';
  let status = s.status || (s.rail === 'cash' ? 'pending' : 'confirmed');
  if (status === 'confirmed' && Number.isFinite(stamp(s.confirmedAt)) && stamp(s.confirmedAt) >= end) status = open;
  if (status === 'initiated' && s.expiresAt && stamp(s.expiresAt) <= end) return 'expired';
  if (s.cancelled) return happened(s.cancelled) ? 'cancelled' : (status === 'cancelled' ? open : status);
  if (status === 'cancelled') return 'cancelled';
  return status;
}

/* USD value of a payment in cents, and of its tip. amountUsd is the normalised amount
   (eventMetrics); without it USD rows use amount; LBP rows use their recorded rate. */
function usdValue(s) {
  const cur = String(s.currency || 'USD').toUpperCase();
  const amount = Number(s.amount), tip = Number(s.tip || 0);
  if (isNum(s.amountUsd)) {
    const a = cents(s.amountUsd), gross = cents(s.amount);
    const t = cur === 'USD' || !gross ? cents(tip) : Math.round(cents(tip) * a / gross);
    return { amount: a, tip: t, ok: true };
  }
  if (cur === 'USD' && isNum(s.amount)) return { amount: cents(amount), tip: cents(tip), ok: true };
  if (cur === 'LBP' && Number(s.fxRateUsed) > 0 && isNum(s.amount)) {
    return { amount: Math.round(amount / Number(s.fxRateUsed) * 100), tip: Math.round(tip / Number(s.fxRateUsed) * 100), ok: true };
  }
  return { amount: 0, tip: 0, ok: false };
}

function viewOf(s, end) {
  const created = stamp(s.ts);
  if (Number.isFinite(created) && created >= end) return null;      // did not exist yet at the close
  const status = statusAt(s, end), v = usdValue(s);
  const settled = status === 'confirmed' || status === 'refunded';
  return {
    s, id: String(s.id), status, rail: String(s.rail || ''), usd: v,
    created, at: settled ? stamp(s.confirmedAt || s.ts) : created,
    refundedAt: s.refunded ? (Number.isFinite(stamp(s.refunded)) ? stamp(s.refunded) : stamp(s.confirmedAt || s.ts)) : NaN
  };
}

const bodies = (rows) => { const by = new Map(); for (const r of rows || []) { const b = r.body || r; const id = String(r.id == null ? b.id : r.id); by.set(id, Object.assign({ id }, b)); } return [...by.values()]; };
const tableList = (tables) => [...new Set(tables.map(String))].sort((a, b) => { const x = Number(a), y = Number(b); return Number.isFinite(x) && Number.isFinite(y) ? x - y : a.localeCompare(b); });

export function readRate(docs) {
  const d = (docs || []).find((x) => x.key === 'aal.rate');
  const raw = d && d.body != null && typeof d.body === 'object' ? d.body.rate : d && d.body;
  const r = Number(raw);
  return Number.isFinite(r) && r >= 1000 && r <= 10000000 ? Math.round(r) : null;   // A.rate() accepts this range
}
function dishNames(docs) {
  const d = (docs || []).find((x) => x.key === 'aal.live'), names = {};
  if (d && d.body && Array.isArray(d.body.items)) for (const i of d.body.items) if (i && i.id != null && i.name) names[String(i.id)] = String(i.name);
  return names;
}

export function computeClose({ window: w, checks, settles, guests, events, docs }) {
  const { start, end } = w;
  const views = bodies(settles).map((s) => viewOf(s, end)).filter(Boolean);
  const confirmed = views.filter((v) => v.status === 'confirmed' && within(v.at, start, end));
  const sum = (list, f) => list.reduce((n, v) => n + f(v), 0);
  const cash = confirmed.filter((v) => v.rail === 'cash'), till = confirmed.filter((v) => v.rail === 'pos');
  const digital = confirmed.filter((v) => v.rail !== 'cash' && v.rail !== 'pos');   // paid at the till is its own line
  const digitalRails = {};
  for (const v of digital) { const k = v.rail || 'other'; const r = digitalRails[k] || (digitalRails[k] = { count: 0, usdCents: 0 }); r.count++; r.usdCents += v.usd.amount; }
  const tillMethods = {};
  for (const v of till) {
    const m = String(v.s.method || v.s.posRef && v.s.posRef.method || '').toLowerCase(), k = m === 'cash' || m === 'card' ? m : 'other';
    const r = tillMethods[k] || (tillMethods[k] = { count: 0, usdCents: 0 }); r.count++; r.usdCents += v.usd.amount;
  }
  const tipsByRail = {};
  for (const v of confirmed) if (v.usd.tip) tipsByRail[v.rail || 'other'] = (tipsByRail[v.rail || 'other'] || 0) + v.usd.tip;

  const pending = views.filter((v) => v.status === 'pending' && v.rail === 'cash');
  const dead = views.filter((v) => within(v.created, start, end));
  const refunds = views.filter((v) => v.status === 'refunded' && within(v.refundedAt, start, end));

  const allChecks = bodies(checks);
  const opened = allChecks.filter((c) => within(stamp(c.openedAt), start, end));
  const closed = allChecks.filter((c) => within(stamp(c.closedAt), start, end));
  const stillOpen = allChecks.filter((c) => {
    const o = stamp(c.openedAt);
    if (Number.isFinite(o) && o >= end) return false;
    return !c.closedAt || !(stamp(c.closedAt) < end);
  });

  const names = dishNames(docs), dishes = new Map();
  for (const c of closed) for (const l of Array.isArray(c.lines) ? c.lines : []) {
    const id = String(l.id), q = Number(l.q) || 0, cur = dishes.get(id) || { name: '', qty: 0 };
    cur.qty += q; cur.name = cur.name || (l.name ? String(l.name) : '') || names[id] || id; dishes.set(id, cur);
  }
  const allDishes = [...dishes.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  const topDishes = allDishes.slice(0, 5);

  const validPayments = new Set(views.filter((v) => v.status === 'confirmed').map((v) => v.id));
  let receiptContacts = 0, marketingOptIns = 0;
  for (const g of bodies(guests)) {
    const list = (g.consentHistory || [])
      .filter((h) => h.source === 'receipt' && h.receipt && validPayments.has(String(h.settlementId)) && within(stamp(h.at), start, end))
      .sort((a, b) => stamp(a.at) - stamp(b.at));
    if (list.length) { receiptContacts++; if (list[list.length - 1].marketing) marketingOptIns++; }
  }

  const ratings = bodies(events).filter((e) => e.eventType === 'review_submitted' && within(stamp(e.createdAt), start, end))
    .map((e) => Number(e.payload && e.payload.rating)).filter((r) => Number.isFinite(r) && r >= 1 && r <= 5);

  const rate = readRate(docs), cashUsdCents = sum(cash, (v) => v.usd.amount);
  const windowRows = views.filter((v) => within(v.at, start, end) || within(v.refundedAt, start, end))
    .sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id));
  return {
    day: w.day, start, end, rate,
    bills: { opened: opened.length, closed: closed.length, stillOpen: stillOpen.length, stillOpenTables: tableList(stillOpen.map((c) => c.table)) },
    cash: { count: cash.length, usdCents: cashUsdCents, lbp: rate ? Math.round(cashUsdCents / 100 * rate) : null },
    till: { count: till.length, usdCents: sum(till, (v) => v.usd.amount), methods: tillMethods },
    digital: { count: digital.length, usdCents: sum(digital, (v) => v.usd.amount), rails: digitalRails },
    tips: { usdCents: sum(confirmed, (v) => v.usd.tip), byRail: tipsByRail },
    pendingCash: {
      count: pending.length, usdCents: sum(pending, (v) => v.usd.amount), tables: tableList(pending.map((v) => v.s.table)),
      older: pending.filter((v) => Number.isFinite(v.created) && v.created < start).length,
      oldest: pending.reduce((m, v) => (Number.isFinite(v.created) && (m == null || v.created < m) ? v.created : m), null)
    },
    cancelledOrExpired: dead.filter((v) => v.status === 'cancelled' || v.status === 'expired').length,
    failed: dead.filter((v) => v.status === 'failed').length,
    refunds: { count: refunds.length, usdCents: sum(refunds, (v) => v.usd.amount) },
    receipts: { requested: receiptContacts, marketingOptIns },
    ratings: { count: ratings.length, average: ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 10) / 10 : null },
    topDishes,
    dishes: allDishes,                               // every dish on the day's closed bills: what a group close adds up
    ratingTotal: ratings.reduce((a, b) => a + b, 0),  // the sum of the ratings, so a group average is exact
    unconverted: views.filter((v) => !v.usd.ok && (within(v.at, start, end) || v.status === 'pending')).length,
    csvRows: windowRows
  };
}

/* ---------------------------------------------------- narrative facts (T4) */

/* What the narrative needs beyond computeClose, for the same window and with the same
   as-of-the-close statuses (docs/close-narrative.md):
     averageBillCents / Count  mean totalCents of the bills closed in the window that have one
     settleMinutes / Count     median minutes from request (ts) to confirmedAt over the payments
                               confirmed in the window (rail 'pos' excluded: the till times them)
     pendingCash               the cash requests still pending at the close that had waited at
                               least pendingMinutes (10) by then, with amount, tables and how many
                               are from before the window
     rateAgeDays               whole days from aal.rate_meta updatedAt to the close, when on file
     pos                       {count, lastStatus}: webhook deliveries created in the window and not
                               delivered by the close (at least one failed attempt); null = unknown
     returns                   computeReturns below, only when asked for (returns: true) */
const PENDING_MS = 10 * 60 * 1000;
export function computeFacts({ window: w, checks, settles, guests, docs, deliveries, customerSettles, returns }) {
  const { start, end } = w;
  const closedWithTotal = bodies(checks).filter((c) => within(stamp(c.closedAt), start, end) && Number(c.totalCents) > 0);
  const views = bodies(settles).map((s) => viewOf(s, end)).filter(Boolean);
  const timed = views.filter((v) => v.status === 'confirmed' && within(v.at, start, end) && v.rail !== 'pos' && Number.isFinite(v.created) && Number.isFinite(stamp(v.s.confirmedAt)))
    .map((v) => (stamp(v.s.confirmedAt) - v.created) / 60000).filter((m) => m >= 0).sort((a, b) => a - b);
  const median = timed.length ? (timed.length % 2 ? timed[(timed.length - 1) / 2] : (timed[timed.length / 2 - 1] + timed[timed.length / 2]) / 2) : null;
  const overdue = views.filter((v) => v.status === 'pending' && v.rail === 'cash' && Number.isFinite(v.created) && end - v.created >= PENDING_MS);
  const meta = (docs || []).find((d) => d.key === 'aal.rate_meta'), metaAt = meta && meta.body ? stamp(meta.body.updatedAt) : NaN;
  let pos = null;
  if (Array.isArray(deliveries)) {
    const failed = deliveries.filter((d) => within(stamp(d.created_at), start, end) && Number(d.attempts) > 0 && !(stamp(d.delivered_at) < end))
      .sort((a, b) => stamp(a.created_at) - stamp(b.created_at));
    pos = { count: failed.length, lastStatus: failed.length && failed[failed.length - 1].last_status != null ? Number(failed[failed.length - 1].last_status) : null };
  }
  return {
    averageBillCents: closedWithTotal.length ? Math.round(closedWithTotal.reduce((n, c) => n + Number(c.totalCents), 0) / closedWithTotal.length) : null,
    averageBillCount: closedWithTotal.length,
    settleMinutes: median == null ? null : Math.round(median), settleCount: timed.length,
    pendingCash: {
      count: overdue.length, usdCents: overdue.reduce((n, v) => n + v.usd.amount, 0), tables: tableList(overdue.map((v) => v.s.table)),
      older: overdue.filter((v) => v.created < start).length
    },
    rateAgeDays: readRate(docs) && Number.isFinite(metaAt) && metaAt <= end ? Math.floor((end - metaAt) / 86400000) : null,
    pos,
    returns: returns && Array.isArray(customerSettles) ? computeReturns({ window: w, guests, settles: [...(settles || []), ...customerSettles] }) : null
  };
}

/* Who came back, from the growth model (restaurant-growth.js A.customerProfiles,
   A.campaignAudience): a visit is a guest/bill pair with a payment confirmed by the close and
   linked to the guest (customerId), at its earliest payment. Counts only: no contact detail
   leaves this function.
     seen        guests with a visit in the window
     first       ... whose first visit it is
     returning   ... whose previous visit is under 30 days old and who have 2 visits
     regulars    ... whose previous visit is under 30 days old and who have 3 or more
     lapsed      ... whose previous visit is 30 days old or more
     secondVisit guests who entered the second-visit audience during the window: exactly one visit,
                 7 days old at some instant of the window, and offers permission (the latest
                 marketing choice before the close) */
export function computeReturns({ window: w, guests, settles }) {
  const { start, end } = w, DAYMS = 86400000;
  const visits = new Map();
  for (const v of bodies(settles).map((s) => viewOf(s, end)).filter(Boolean)) {
    if (v.status !== 'confirmed' || !v.s.customerId || !v.s.checkId || !(v.at < end)) continue;
    const g = String(v.s.customerId), byCheck = visits.get(g) || new Map(), k = String(v.s.checkId);
    if (!byCheck.has(k) || v.at < byCheck.get(k)) byCheck.set(k, v.at);
    visits.set(g, byCheck);
  }
  const out = { seen: 0, first: 0, returning: 0, regulars: 0, lapsed: 0, secondVisit: 0 };
  for (const g of bodies(guests)) {
    const times = [...(visits.get(String(g.id)) || new Map()).values()].sort((a, b) => a - b);
    if (!times.length) continue;
    const todayAt = times.find((t) => t >= start);
    if (todayAt != null && todayAt < end) {
      const before = times.filter((t) => t < todayAt), prev = before[before.length - 1];
      out.seen++;
      if (prev == null) out.first++;
      else if (todayAt - prev >= 30 * DAYMS) out.lapsed++;
      else if (times.length >= 3) out.regulars++;
      else out.returning++;
    }
    if (times.length === 1 && within(times[0] + 7 * DAYMS, start, end)) {
      const hist = (g.consentHistory || []).filter((h) => stamp(h.at) < end).sort((a, b) => stamp(a.at) - stamp(b.at));
      const marketing = hist.length ? !!hist[hist.length - 1].marketing : !!g.marketing;
      if (marketing) out.secondVisit++;
    }
  }
  return out;
}

/* The narrative's input for one venue and one day (closeNarrative in
   ../_shared/close-narrative.js): the day, the same weekday a week earlier, and the same
   weekday 7, 14, 21 and 28 days earlier, all computed from one load of the venue's rows. */
export const COMPARE_WEEKS = 4;
export function narrativeInput({ venue, window: w, data }) {
  const one = (d, full) => {
    const win = d === w.day ? w : windowFor(d);
    return { figures: computeClose({ window: win, ...data }), facts: computeFacts({ window: win, ...data, returns: full }) };
  };
  const trailing = [];
  for (let k = 1; k <= COMPARE_WEEKS; k++) trailing.push(one(addDays(w.day, -7 * k), false));
  return {
    lang: venue && venue.lang, currency: venue && venue.currency, day: w.day,
    today: one(w.day, true), lastWeek: trailing[0], trailing
  };
}

/* ------------------------------------------------------------------ csv */

export const CSV_HEADER = ['settlementId', 'checkId', 'table', 'rail', 'status', 'amountUsd', 'tipUsd', 'currency', 'confirmedAt', 'externalRef', 'refunded'];
/* Text that starts with = + - @ tab or CR is read as a formula by spreadsheets; provider
   references are not ours, so such text gets a leading apostrophe. */
function csvText(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function buildCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const v of rows) {
    const s = v.s;
    lines.push([
      csvText(v.id), csvText(s.checkId), csvText(s.table), csvText(v.rail), csvText(v.status),
      v.usd.ok ? csvMoney(v.usd.amount) : '', v.usd.ok ? csvMoney(v.usd.tip) : '', csvText(s.currency || 'USD'),
      csvText(s.confirmedAt), csvText(s.externalRef), csvText(v.status !== 'refunded' ? '' : s.refunded === true ? 'yes' : s.refunded)
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export const slugOf = (v) => String(v || 'venue').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'venue';

/* ---------------------------------------------------------------- email */

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const oneLine = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const railName = (r) => (r === 'card' ? 'Card' : r === 'whish' ? 'Whish' : r === 'pos' ? 'Till' : r.charAt(0).toUpperCase() + r.slice(1));
const lbp = (n) => 'LL ' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const tablesText = (t) => (t.length === 1 ? 'table ' : 'tables ') + t.join(', ');

/* The figure lines and the "Needs action" lines of one close: a venue's, or a group's sum. */
function closeRows(f, stillOpenText) {
  const cashLine = plural(f.cash.count, 'payment') + ', ' + usdText(f.cash.usdCents) + (f.cash.lbp != null ? ' (' + lbp(f.cash.lbp) + ')' : '');
  const railKeys = Object.keys(f.digital.rails).sort();
  const tipRails = Object.keys(f.tips.byRail).sort();
  const rows = [
    ['Bills opened', String(f.bills.opened)],
    ['Bills closed', String(f.bills.closed)],
    ['Still open at 04:00', f.bills.stillOpen ? `${f.bills.stillOpen} (${stillOpenText || tablesText(f.bills.stillOpenTables)})` : '0'],
    ['Cash confirmed', cashLine],
    ['Digital confirmed', plural(f.digital.count, 'payment') + ', ' + usdText(f.digital.usdCents)]
  ];
  for (const k of railKeys) rows.push(['   ' + railName(k), plural(f.digital.rails[k].count, 'payment') + ', ' + usdText(f.digital.rails[k].usdCents)]);
  if (f.till.count) {     // payments the POS bridge recorded (rail 'pos'); shown only for venues that have them
    rows.push(['Paid at the till', plural(f.till.count, 'payment') + ', ' + usdText(f.till.usdCents)]);
    for (const k of ['cash', 'card', 'other']) if (f.till.methods[k]) rows.push(['   ' + railName(k), plural(f.till.methods[k].count, 'payment') + ', ' + usdText(f.till.methods[k].usdCents)]);
  }
  rows.push(['Tips', usdText(f.tips.usdCents) + (tipRails.length ? ' (' + tipRails.map((k) => railName(k) + ' ' + usdText(f.tips.byRail[k])).join(', ') + ')' : '')]);
  rows.push(['Refunds', plural(f.refunds.count, 'refund') + ', ' + usdText(f.refunds.usdCents)]);
  rows.push(['Requests cancelled or expired', String(f.cancelledOrExpired) + (f.failed ? ` (and ${f.failed} failed)` : '')]);
  rows.push(['Receipts requested', `${f.receipts.requested}, of which ${f.receipts.marketingOptIns} agreed to restaurant offers`]);
  rows.push(['Guests who rated', f.ratings.count ? `${f.ratings.count}, average ${f.ratings.average.toFixed(1)} out of 5` : '0']);
  return rows;
}
function closeActions(f) {
  const actions = [];
  if (f.pendingCash.count) {
    let t = `Cash requested and never confirmed: ${f.pendingCash.count}, ${usdText(f.pendingCash.usdCents)}, ${tablesText(f.pendingCash.tables)}`;
    if (f.pendingCash.older) t += `; ${f.pendingCash.older} of them from before ${dayLabel(f.day)}`;
    actions.push(t + '. Confirm or cancel each one in the dashboard.');
  }
  if (f.bills.stillOpen) actions.push(`Bills still open: ${tablesText(f.bills.stillOpenTables)}.`);
  if (f.unconverted) actions.push(`${plural(f.unconverted, 'payment')} had no USD value on record and ${f.unconverted === 1 ? 'is' : 'are'} left out of the dollar totals (the CSV lists them).`);
  return actions;
}
const td = 'padding:4px 12px 4px 0;vertical-align:top';
const padRows = (rows) => { const width = Math.max(...rows.map((r) => r[0].length)) + 2; return rows.map((r) => (r[0] + ':').padEnd(width) + r[1]); };
const htmlTable = (rows) => `<table style="border-collapse:collapse">${rows.map((r) => `<tr><td style="${td};color:#555">${esc(r[0]).replace(/ /g, '&nbsp;')}</td><td style="${td}">${esc(r[1])}</td></tr>`).join('')}</table>`;
const htmlActions = (actions) => (actions.length ? '<ul style="margin:0;padding-left:18px">' + actions.map((a) => `<li>${esc(a)}</li>`).join('') + '</ul>' : '<p style="margin:0">Nothing.</p>');
const htmlDishes = (dishes) => (dishes.length ? '<ol style="margin:0;padding-left:22px">' + dishes.map((d) => `<li>${esc(d.name)}, ${d.qty}</li>`).join('') + '</ol>' : '<p style="margin:0">No closed bills with items.</p>');
const textDishes = (dishes) => (dishes.length ? dishes.map((d, i) => `${i + 1}. ${oneLine(d.name)}, ${d.qty}`) : ['- No closed bills with items.']);

/* The narrative paragraph (T4) above the figures: one line of text, or an HTML paragraph in the
   narrative's language, right to left for Arabic. Empty when there is no narrative. */
const storyText = (narrative) => (narrative && narrative.text ? oneLine(narrative.text) : '');
const storyHtml = (narrative, margin) => {
  const story = storyText(narrative);
  if (!story) return '';
  const lang = narrative.lang === 'fr' || narrative.lang === 'ar' ? narrative.lang : 'en';
  return `<p dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang}" style="margin:${margin || '0 0 16px'};line-height:1.5${lang === 'ar' ? ';text-align:right' : ''}">${esc(story)}</p>`;
};

export function buildEmail({ venue, figures: f, csvName, narrative }) {
  const name = oneLine(venue.name), label = dayLabel(f.day);
  const subject = `${name}: ${label}, on Aalayna`;
  const rows = closeRows(f), actions = closeActions(f), story = storyText(narrative);
  const textParts = [
    ...(story ? [story, ''] : []),
    `${name}, ${label}, 04:00 to 04:00 Beirut time.`,
    'Amounts are USD and include tips.', '',
    ...padRows(rows), '',
    'Needs action', ...(actions.length ? actions.map((a) => '- ' + a) : ['- Nothing.']), '',
    'Top dishes (quantity on closed bills)', ...textDishes(f.topDishes), '',
    `Attached: ${csvName}, one row per payment record of the day.`
  ];
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:560px">'
    + storyHtml(narrative)
    + `<p style="margin:0 0 4px"><strong>${esc(name)}</strong>, ${esc(label)}</p>`
    + '<p style="margin:0 0 12px;color:#555">04:00 to 04:00 Beirut time. Amounts are USD and include tips.</p>'
    + htmlTable(rows)
    + '<h3 style="margin:20px 0 6px;font-size:15px">Needs action</h3>'
    + htmlActions(actions)
    + '<h3 style="margin:20px 0 6px;font-size:15px">Top dishes (quantity on closed bills)</h3>'
    + htmlDishes(f.topDishes)
    + `<p style="margin:20px 0 0;color:#555">Attached: ${esc(csvName)}, one row per payment record of the day.</p></div>`;
  return { subject, text: textParts.join('\n'), html };
}

/* ------------------------------------------------------------- groups */

export const venueLabel = (v) => oneLine(v.name || v.restaurant_id) + (v.place ? ' · ' + oneLine(v.place) : '');
const addCount = (into, from) => { for (const k of Object.keys(from)) { const r = into[k] || (into[k] = { count: 0, usdCents: 0 }); r.count += from[k].count; r.usdCents += from[k].usdCents; } return into; };
const addCents = (into, from) => { for (const k of Object.keys(from)) into[k] = (into[k] || 0) + from[k]; return into; };
/* A group's figures: every count and amount is the sum of its venues'. The lira line is left out
   (each venue has its own rate; its section shows it), the average rating is worked out from the
   summed ratings, and the top dishes from every dish of every venue, by name. */
export function sumCloses(day, list) {
  const sum = (f) => list.reduce((n, x) => n + f(x), 0);
  const dishes = new Map();
  for (const f of list) for (const d of f.dishes || f.topDishes) { const cur = dishes.get(d.name) || { name: d.name, qty: 0 }; cur.qty += d.qty; dishes.set(d.name, cur); }
  const ranked = [...dishes.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  const ratingCount = sum((f) => f.ratings.count), ratingTotal = sum((f) => f.ratingTotal || 0);
  return {
    day, rate: null,
    bills: { opened: sum((f) => f.bills.opened), closed: sum((f) => f.bills.closed), stillOpen: sum((f) => f.bills.stillOpen), stillOpenTables: [] },
    cash: { count: sum((f) => f.cash.count), usdCents: sum((f) => f.cash.usdCents), lbp: null },
    till: { count: sum((f) => f.till.count), usdCents: sum((f) => f.till.usdCents), methods: list.reduce((m, f) => addCount(m, f.till.methods), {}) },
    digital: { count: sum((f) => f.digital.count), usdCents: sum((f) => f.digital.usdCents), rails: list.reduce((m, f) => addCount(m, f.digital.rails), {}) },
    tips: { usdCents: sum((f) => f.tips.usdCents), byRail: list.reduce((m, f) => addCents(m, f.tips.byRail), {}) },
    pendingCash: { count: sum((f) => f.pendingCash.count), usdCents: sum((f) => f.pendingCash.usdCents), tables: [], older: sum((f) => f.pendingCash.older), oldest: null },
    cancelledOrExpired: sum((f) => f.cancelledOrExpired),
    failed: sum((f) => f.failed),
    refunds: { count: sum((f) => f.refunds.count), usdCents: sum((f) => f.refunds.usdCents) },
    receipts: { requested: sum((f) => f.receipts.requested), marketingOptIns: sum((f) => f.receipts.marketingOptIns) },
    ratings: { count: ratingCount, average: ratingCount ? Math.round(ratingTotal / ratingCount * 10) / 10 : null },
    ratingTotal,
    dishes: ranked,
    topDishes: ranked.slice(0, 5),
    unconverted: sum((f) => f.unconverted),
    csvRows: list.reduce((all, f) => all.concat(f.csvRows), [])
  };
}
export const GROUP_CSV_HEADER = ['venue', ...CSV_HEADER];
/* One CSV for the group: each venue's rows exactly as its own CSV has them, with the venue in front. */
export function buildGroupCsv(sections) {
  const lines = [GROUP_CSV_HEADER.join(',')];
  for (const { venue, figures } of sections) {
    const label = csvText(venueLabel(venue));
    for (const row of buildCsv(figures.csvRows).split('\r\n').slice(1)) if (row) lines.push(label + ',' + row);
  }
  return lines.join('\r\n') + '\r\n';
}
export function buildGroupEmail({ group, sections, csvName }) {
  const name = oneLine(group.name), day = sections[0].figures.day, label = dayLabel(day);
  const total = sumCloses(day, sections.map((x) => x.figures));
  const subject = `${name}: ${label}, on Aalayna`;
  const open = sections.filter((x) => x.figures.bills.stillOpen).map((x) => venueLabel(x.venue) + ' ' + tablesText(x.figures.bills.stillOpenTables));
  const rows = closeRows(total, open.join('; '));
  const actions = [];
  for (const x of sections) for (const a of closeActions(x.figures)) actions.push(venueLabel(x.venue) + ': ' + a);
  const names = sections.map((x) => venueLabel(x.venue));
  const textParts = [
    `${name}, ${label}, 04:00 to 04:00 Beirut time.`,
    `${plural(sections.length, 'venue')}: ${names.join(', ')}.`,
    'Amounts are USD and include tips.', '',
    'All venues', ...padRows(rows), '',
    'Needs action', ...(actions.length ? actions.map((a) => '- ' + a) : ['- Nothing.']), '',
    'Top dishes across the venues (quantity on closed bills)', ...textDishes(total.topDishes)
  ];
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:560px">'
    + `<p style="margin:0 0 4px"><strong>${esc(name)}</strong>, ${esc(label)}</p>`
    + `<p style="margin:0 0 12px;color:#555">04:00 to 04:00 Beirut time. ${esc(plural(sections.length, 'venue'))}: ${esc(names.join(', '))}. Amounts are USD and include tips.</p>`
    + '<h2 style="margin:16px 0 6px;font-size:16px">All venues</h2>' + htmlTable(rows)
    + '<h3 style="margin:20px 0 6px;font-size:15px">Needs action</h3>' + htmlActions(actions)
    + '<h3 style="margin:20px 0 6px;font-size:15px">Top dishes across the venues (quantity on closed bills)</h3>' + htmlDishes(total.topDishes);
  for (const x of sections) {
    const vrows = closeRows(x.figures), vact = closeActions(x.figures), vname = venueLabel(x.venue), vstory = storyText(x.narrative);
    // each venue's section opens with that venue's narrative (T4), as its own close would
    textParts.push('', vname, ...(vstory ? [vstory, ''] : []), ...padRows(vrows), 'Needs action: ' + (vact.length ? vact.join(' ') : 'nothing.'),
      'Top dishes: ' + (x.figures.topDishes.length ? x.figures.topDishes.map((d) => `${oneLine(d.name)} ${d.qty}`).join(', ') : 'no closed bills with items') + '.');
    html += `<h2 style="margin:28px 0 6px;font-size:16px;border-top:1px solid #ddd;padding-top:16px">${esc(vname)}</h2>` + storyHtml(x.narrative, '0 0 12px') + htmlTable(vrows)
      + '<h3 style="margin:16px 0 6px;font-size:15px">Needs action</h3>' + htmlActions(vact)
      + '<h3 style="margin:16px 0 6px;font-size:15px">Top dishes</h3>' + htmlDishes(x.figures.topDishes);
  }
  textParts.push('', `Attached: ${csvName}, one row per payment record of the day at every venue, with its venue.`);
  html += `<p style="margin:20px 0 0;color:#555">Attached: ${esc(csvName)}, one row per payment record of the day at every venue, with its venue.</p></div>`;
  return { subject, text: textParts.join('\n'), html, total };
}

/* ------------------------------------------------------------- handler */

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const enc = encodeURIComponent;
const same = (a, b) => {
  const x = String(a || ''), y = String(b || '');
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return d === 0;
};

export function createHandler(deps) {
  const { rest, send } = deps, clock = deps.now || (() => Date.now());
  const env = (k) => (typeof deps.env === 'function' ? deps.env(k) : deps.env ? deps.env[k] : undefined);

  async function call(path, opts) {
    const r = await rest(path, opts);
    if (r && typeof r === 'object' && typeof r.text === 'function' && typeof r.status === 'number') {
      const t = await r.text();
      if (!r.ok) throw new Error(`database ${r.status}: ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    }
    return r;
  }
  async function all(path) {
    const out = [];
    for (let page = 0; page < 200; page++) {
      const rows = (await call(`${path}&limit=${PAGE}&offset=${page * PAGE}`)) || [];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }
  const rows = (rid, collection, more) => `kv_rows?select=id,body&restaurant_id=eq.${enc(rid)}&collection=eq.${collection}${more || ''}&order=id.asc`;

  /* since: the earliest window start the caller needs (with a narrator, 28 days earlier, so the
     comparable weekdays come from the same load). The growth rows (every payment linked to a guest)
     and the POS deliveries are read softly: if either read fails, the close goes out without the
     sentences that need them. */
  async function loadVenue(venue, w, since0) {
    const rid = venue.restaurant_id, since = enc(new Date(since0 == null ? w.start : since0).toISOString());
    const soft = (p) => p.catch(() => null);
    const [docs, checksTouched, checksOpen, settlesTouched, settlesPending, events, guests, customerSettles, deliveries] = await Promise.all([
      all(`kv_docs?select=key,body&restaurant_id=eq.${enc(rid)}&key=in.(aal.live,aal.rate,aal.rate_meta)&order=key.asc`),
      all(rows(rid, 'aal.checks', `&updated_at=gte.${since}`)),
      all(rows(rid, 'aal.checks', '&body->>closedAt=is.null')),
      all(rows(rid, 'aal.settle', `&updated_at=gte.${since}`)),
      all(rows(rid, 'aal.settle', '&body->>status=eq.pending')),
      all(rows(rid, 'aal.events', `&body->>eventType=eq.review_submitted&updated_at=gte.${since}`)),
      all(rows(rid, 'aal.guests', `&updated_at=gte.${since}`)),
      deps.narrate ? soft(all(rows(rid, 'aal.settle', '&body->>customerId=not.is.null'))) : null,
      deps.narrate ? soft(posDeliveries(rid, w)) : null
    ]);
    return { docs, checks: [...checksTouched, ...checksOpen], settles: [...settlesTouched, ...settlesPending], events, guests, customerSettles, deliveries };
  }
  async function posDeliveries(rid, w) {
    const ends = await all(`webhook_endpoints?select=id&restaurant_id=eq.${enc(rid)}&order=id.asc`);
    if (!ends.length) return [];
    return all(`webhook_deliveries?select=id,attempts,last_status,delivered_at,created_at&endpoint_id=in.(${ends.map((e) => enc(e.id)).join(',')})`
      + `&created_at=gte.${enc(new Date(w.start).toISOString())}&created_at=lt.${enc(new Date(w.end).toISOString())}&order=id.asc`);
  }
  /* The narrative, never in the way of the email: any error leaves the close without it. */
  async function narrativeFor(venue, w, data) {
    if (!deps.narrate) return null;
    try { const n = await deps.narrate(narrativeInput({ venue, window: w, data })); return n && n.text ? n : null; } catch (_) { return null; }
  }

  const cleanEmails = (rows) => {
    const seen = new Set(), out = [];
    for (const m of rows) {
      const email = String(m.email || '').trim().toLowerCase();
      if (m.revoked_at || (m.role !== 'owner' && m.role !== 'manager') || !EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email); out.push(email);
    }
    return out;
  };
  async function recipientsOf(rid, skip) {
    const staff = await all(`staff_members?select=email,role,revoked_at&restaurant_id=eq.${enc(rid)}&role=in.(owner,manager)&revoked_at=is.null&order=email.asc`);
    return cleanEmails(staff).filter((e) => !(skip && skip.has(e)));
  }

  /* Owner groups, read once per call. Without the groups migration the tables are missing: PostgREST
     answers 404 (PGRST205) or the relation does not exist, and the close carries on with venues only. */
  const MISSING = /database 404|PGRST205|PGRST200|42P01|does not exist|Could not find the table/i;
  async function loadGroups() {
    try {
      const [groups, links, staff] = await Promise.all([
        all('owner_groups?select=id,name&order=id.asc'),
        all('owner_group_venues?select=group_id,restaurant_id&order=restaurant_id.asc'),
        all('owner_group_staff?select=group_id,email,role,revoked_at&role=in.(owner,manager)&revoked_at=is.null&order=email.asc')
      ]);
      const byId = new Map(groups.map((g) => [g.id, { id: g.id, name: g.name, venues: [], staff: [] }]));
      for (const l of links) if (byId.has(l.group_id)) byId.get(l.group_id).venues.push(l.restaurant_id);
      for (const m of staff) if (byId.has(m.group_id)) byId.get(m.group_id).staff.push(m);
      const list = [...byId.values()].map((g) => Object.assign(g, { recipients: cleanEmails(g.staff) }));
      const ofVenue = new Map();
      for (const g of list) for (const rid of g.venues) ofVenue.set(rid, g);
      return { installed: true, list, ofVenue };
    } catch (e) {
      if (MISSING.test(String(e && e.message || e))) return { installed: false, list: [], ofVenue: new Map() };
      throw e;
    }
  }

  const logs = {
    venue: { table: 'daily_close_log', col: 'restaurant_id', key: 'restaurantId' },
    group: { table: 'daily_close_group_log', col: 'group_id', key: 'groupId' }
  };
  const logPath = (kind, id, day) => `${logs[kind].table}?${logs[kind].col}=eq.${enc(id)}&day=eq.${day}`;
  async function readLog(kind, id, day) {
    const r = await call(`${logPath(kind, id, day)}&select=*`);
    return r && r[0] ? r[0] : null;
  }
  const writeLog = (kind, id, day, patch) => call(logPath(kind, id, day), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(patch) });

  /* One close, a venue's or a group's: the claim on the log, then prepare() (recipients, figures and the
     email, or a reason to skip), then one message per recipient, then the log. */
  async function closeOne(kind, id, name, w, { force }, prepare) {
    const day = w.day, at = clock(), L = logs[kind], who = { [L.key]: id, name };
    let existing = await readLog(kind, id, day);
    if (existing && !force) {
      if (existing.status === 'sent') return Object.assign(who, { status: 'already sent' });
      if (existing.error === IN_PROGRESS && at - Date.parse(existing.created_at) < IN_PROGRESS_MS) return Object.assign(who, { status: 'in progress' });
    }
    const nowIso = new Date(at).toISOString();
    if (!existing) {
      // Claim the day before sending, so two calls at once cannot both send.
      const claimed = await call(`${L.table}?on_conflict=${L.col},day`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify([{ [L.col]: id, day, recipients: 0, status: 'failed', error: IN_PROGRESS, created_at: nowIso }])
      });
      if (!claimed || !claimed.length) return Object.assign(who, { status: 'in progress' });
    } else if (existing.status !== 'sent') {
      await writeLog(kind, id, day, { status: 'failed', error: IN_PROGRESS, recipients: 0, provider_id: null, created_at: nowIso });
    }
    const prior = existing && existing.status === 'sent';       // a forced rerun keeps the record of the send that worked
    const finish = async (patch) => { if (prior && patch.status !== 'sent') patch = { error: 'rerun failed: ' + (patch.error || patch.status) }; await writeLog(kind, id, day, patch); return patch; };

    try {
      const job = await prepare();
      if (job.skip) {
        await finish({ status: 'skipped', recipients: 0, provider_id: null, error: job.skip });
        return Object.assign(who, { status: 'skipped', reason: job.skip });
      }
      const from = env('DAILY_CLOSE_FROM');
      const ids = [], failures = [];
      for (const to of job.recipients) {
        try {
          const r = await send(Object.assign({ to, subject: job.mail.subject, text: job.mail.text, html: job.mail.html, attachments: job.attachments }, from ? { from } : {}));
          ids.push(r && r.id ? String(r.id) : '');
        } catch (e) { failures.push(String(e && e.message || e).slice(0, 200)); }
      }
      if (!ids.length) {
        const error = `send failed for all ${job.recipients.length}: ${failures[0]}`;
        await finish({ status: 'failed', recipients: 0, provider_id: null, error });
        return Object.assign(who, { status: 'failed', reason: error });
      }
      const error = failures.length ? `${failures.length} of ${job.recipients.length} sends failed: ${failures[0]}` : null;
      await finish({ status: 'sent', recipients: ids.length, provider_id: ids.filter(Boolean).join(',') || null, error, created_at: new Date(clock()).toISOString() });
      return Object.assign(who, { status: 'sent', recipients: ids.length }, error ? { warning: error } : {});
    } catch (e) {
      const error = String(e && e.message || e).slice(0, 500);
      try { await finish({ status: 'failed', recipients: 0, provider_id: null, error }); } catch (_) { /* the log itself is down; the response still says failed */ }
      return Object.assign(who, { status: 'failed', reason: error });
    }
  }

  const quiet = (f) => !f.bills.opened && !f.bills.closed && !f.csvRows.length;
  function closeVenue(venue, w, opts, ctx) {
    const rid = venue.restaurant_id, g = ctx.groups.ofVenue.get(rid);
    return closeOne('venue', rid, venue.name, w, opts, async () => {
      // the group's owners and managers have the group email; the venue's own close goes to the others
      const recipients = await recipientsOf(rid, g ? new Set(g.recipients) : null);
      if (!recipients.length) return { skip: 'no active owner or manager email' };
      const figures = await ctx.figures(venue);
      // A window with no bill opened or closed and no payment record is not worth an email; force sends it anyway.
      if (!opts.force && quiet(figures)) return { skip: 'no activity' };
      const csvName = `close-${slugOf(venue.slug)}-${w.day}.csv`;
      const narrative = await ctx.narrative(venue);
      return { recipients, mail: buildEmail({ venue, figures, csvName, narrative }), attachments: [{ filename: csvName, content: toBase64(buildCsv(figures.csvRows)) }] };
    });
  }
  function closeGroup(group, w, opts, ctx) {
    return closeOne('group', group.id, group.name, w, opts, async () => {
      if (!group.recipients.length) return { skip: 'no active group owner or manager email' };
      const venues = group.venues.map((rid) => ctx.venueById.get(rid) || { restaurant_id: rid, name: rid, place: '', slug: '' });
      if (!venues.length) return { skip: 'no venues in the group' };
      const sections = [];
      for (const venue of venues) sections.push({ venue, figures: await ctx.figures(venue) });
      if (!opts.force && sections.every((x) => quiet(x.figures))) return { skip: 'no activity' };
      for (const x of sections) x.narrative = await ctx.narrative(x.venue);   // T4: each venue's paragraph, read once per call
      const csvName = `close-${slugOf(group.name)}-${w.day}.csv`;
      return { recipients: group.recipients, mail: buildGroupEmail({ group, sections, csvName }), attachments: [{ filename: csvName, content: toBase64(buildGroupCsv(sections)) }] };
    });
  }

  return async function handle(req) {
    const secret = env('AALAYNA_CRON_SECRET'), given = req.headers.get('x-aalayna-cron');
    if (!secret || !given || !same(given, secret)) return json(401, { error: 'unauthorized' });
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'method not allowed' });

    const url = new URL(req.url), venueParam = url.searchParams.get('venue'), dateParam = url.searchParams.get('date');
    const groupParam = url.searchParams.get('group');
    const force = ['1', 'true'].includes(url.searchParams.get('force') || '');
    const at = clock();
    let day;
    if (venueParam == null && dateParam == null && groupParam == null) {
      day = cronDecision(at).day;                                 // the pg_cron call
    } else if (dateParam != null) {
      if (!parseDay(dateParam)) return json(400, { error: 'date must be YYYY-MM-DD' });
      day = dateParam;
    } else {
      day = lastCompletedDay(at);
    }
    const w = windowFor(day);
    if (w.end > at) return json(400, { error: `${day} has not ended yet (its window closes at ${new Date(w.end).toISOString()})` });

    let venues, groups;
    try {
      venues = await all(`venue_profiles?select=*${venueParam != null ? `&restaurant_id=eq.${enc(venueParam)}` : ''}&order=restaurant_id.asc`);
    } catch (e) { return json(500, { error: 'could not read venues: ' + String(e && e.message || e).slice(0, 200) }); }
    if (venueParam != null && !venues.length) return json(404, { error: 'unknown venue' });
    try { groups = await loadGroups(); } catch (e) { return json(500, { error: 'could not read owner groups: ' + String(e && e.message || e).slice(0, 200) }); }
    let groupList = venueParam != null ? [] : groups.list.filter((g) => g.venues.length);
    if (groupParam != null) {
      groupList = groups.list.filter((g) => g.id === groupParam);
      if (!groupList.length) return json(404, { error: 'unknown group' });
      venues = [];                                                // ?group= closes the group only
    }
    let venueById = new Map(venues.map((v) => [v.restaurant_id, v]));
    if (groupList.length && (venueParam != null || groupParam != null)) {
      const allVenues = await all('venue_profiles?select=*&order=restaurant_id.asc');
      venueById = new Map(allVenues.map((v) => [v.restaurant_id, v]));
    }
    /* A venue's rows are read once per call, for its own close and its group's: the figures, and the
       narrative (T4) when a narrator is given, from the same load (28 days back for the comparable days). */
    const since = deps.narrate ? windowFor(addDays(day, -7 * COMPARE_WEEKS)).start : w.start;
    const memo = new Map(), stories = new Map();
    const loaded = (v) => { if (!memo.has(v.restaurant_id)) memo.set(v.restaurant_id, loadVenue(v, w, since).then((data) => ({ data, figures: computeClose({ window: w, ...data }) }))); return memo.get(v.restaurant_id); };
    const ctx = {
      groups, venueById,
      figures: (v) => loaded(v).then((x) => x.figures),
      narrative: (v) => { if (!stories.has(v.restaurant_id)) stories.set(v.restaurant_id, loaded(v).then((x) => narrativeFor(v, w, x.data))); return stories.get(v.restaurant_id); }
    };

    const results = [], groupResults = [];
    for (const v of venues) results.push(await closeVenue(v, w, { force }, ctx));
    for (const g of groupList) groupResults.push(await closeGroup(g, w, { force }, ctx));
    const every = results.concat(groupResults);
    const failed = every.some((r) => r.status === 'failed');
    const allDone = every.length > 0 && every.every((r) => r.status === 'already sent');
    return json(failed ? 500 : 200, { ok: !failed, day, window: { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() }, ...(allDone ? { message: 'already sent' } : {}), results, groups: groupResults });
  };
}
