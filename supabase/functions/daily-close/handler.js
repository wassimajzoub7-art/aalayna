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
   rerun a week later reproduces the email that went out. */

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
  const topDishes = [...dishes.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)).slice(0, 5);

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
    unconverted: views.filter((v) => !v.usd.ok && (within(v.at, start, end) || v.status === 'pending')).length,
    csvRows: windowRows
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

export function buildEmail({ venue, figures: f, csvName }) {
  const name = oneLine(venue.name), label = dayLabel(f.day);
  const subject = `${name}: ${label}, on Aalayna`;
  const cashLine = plural(f.cash.count, 'payment') + ', ' + usdText(f.cash.usdCents) + (f.cash.lbp != null ? ' (' + lbp(f.cash.lbp) + ')' : '');
  const railKeys = Object.keys(f.digital.rails).sort();
  const tipRails = Object.keys(f.tips.byRail).sort();
  const rows = [
    ['Bills opened', String(f.bills.opened)],
    ['Bills closed', String(f.bills.closed)],
    ['Still open at 04:00', f.bills.stillOpen ? `${f.bills.stillOpen} (${tablesText(f.bills.stillOpenTables)})` : '0'],
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

  const actions = [];
  if (f.pendingCash.count) {
    let t = `Cash requested and never confirmed: ${f.pendingCash.count}, ${usdText(f.pendingCash.usdCents)}, ${tablesText(f.pendingCash.tables)}`;
    if (f.pendingCash.older) t += `; ${f.pendingCash.older} of them from before ${dayLabel(f.day)}`;
    actions.push(t + '. Confirm or cancel each one in the dashboard.');
  }
  if (f.bills.stillOpen) actions.push(`Bills still open: ${tablesText(f.bills.stillOpenTables)}.`);
  if (f.unconverted) actions.push(`${plural(f.unconverted, 'payment')} had no USD value on record and ${f.unconverted === 1 ? 'is' : 'are'} left out of the dollar totals (the CSV lists them).`);

  const width = Math.max(...rows.map((r) => r[0].length)) + 2;
  const textParts = [
    `${name}, ${label}, 04:00 to 04:00 Beirut time.`,
    'Amounts are USD and include tips.', '',
    ...rows.map((r) => (r[0] + ':').padEnd(width) + r[1]), '',
    'Needs action', ...(actions.length ? actions.map((a) => '- ' + a) : ['- Nothing.']), '',
    'Top dishes (quantity on closed bills)', ...(f.topDishes.length ? f.topDishes.map((d, i) => `${i + 1}. ${oneLine(d.name)}, ${d.qty}`) : ['- No closed bills with items.']), '',
    `Attached: ${csvName}, one row per payment record of the day.`
  ];

  const td = 'padding:4px 12px 4px 0;vertical-align:top';
  const htmlRows = rows.map((r) => `<tr><td style="${td};color:#555">${esc(r[0]).replace(/ /g, '&nbsp;')}</td><td style="${td}">${esc(r[1])}</td></tr>`).join('');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:560px">'
    + `<p style="margin:0 0 4px"><strong>${esc(name)}</strong>, ${esc(label)}</p>`
    + '<p style="margin:0 0 12px;color:#555">04:00 to 04:00 Beirut time. Amounts are USD and include tips.</p>'
    + `<table style="border-collapse:collapse">${htmlRows}</table>`
    + '<h3 style="margin:20px 0 6px;font-size:15px">Needs action</h3>'
    + (actions.length ? '<ul style="margin:0;padding-left:18px">' + actions.map((a) => `<li>${esc(a)}</li>`).join('') + '</ul>' : '<p style="margin:0">Nothing.</p>')
    + '<h3 style="margin:20px 0 6px;font-size:15px">Top dishes (quantity on closed bills)</h3>'
    + (f.topDishes.length ? '<ol style="margin:0;padding-left:22px">' + f.topDishes.map((d) => `<li>${esc(d.name)}, ${d.qty}</li>`).join('') + '</ol>' : '<p style="margin:0">No closed bills with items.</p>')
    + `<p style="margin:20px 0 0;color:#555">Attached: ${esc(csvName)}, one row per payment record of the day.</p></div>`;
  return { subject, text: textParts.join('\n'), html };
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

  async function loadVenue(venue, w) {
    const rid = venue.restaurant_id, since = enc(new Date(w.start).toISOString());
    const [docs, checksTouched, checksOpen, settlesTouched, settlesPending, events, guests] = await Promise.all([
      all(`kv_docs?select=key,body&restaurant_id=eq.${enc(rid)}&key=in.(aal.live,aal.rate)&order=key.asc`),
      all(rows(rid, 'aal.checks', `&updated_at=gte.${since}`)),
      all(rows(rid, 'aal.checks', '&body->>closedAt=is.null')),
      all(rows(rid, 'aal.settle', `&updated_at=gte.${since}`)),
      all(rows(rid, 'aal.settle', '&body->>status=eq.pending')),
      all(rows(rid, 'aal.events', `&body->>eventType=eq.review_submitted&updated_at=gte.${since}`)),
      all(rows(rid, 'aal.guests', `&updated_at=gte.${since}`))
    ]);
    return { docs, checks: [...checksTouched, ...checksOpen], settles: [...settlesTouched, ...settlesPending], events, guests };
  }

  async function recipientsOf(rid) {
    const staff = await all(`staff_members?select=email,role,revoked_at&restaurant_id=eq.${enc(rid)}&role=in.(owner,manager)&revoked_at=is.null&order=email.asc`);
    const seen = new Set(), out = [];
    for (const m of staff) {
      const email = String(m.email || '').trim().toLowerCase();
      if (m.revoked_at || (m.role !== 'owner' && m.role !== 'manager') || !EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email); out.push(email);
    }
    return out;
  }

  const logPath = (rid, day) => `daily_close_log?restaurant_id=eq.${enc(rid)}&day=eq.${day}`;
  async function readLog(rid, day) {
    const r = await call(`${logPath(rid, day)}&select=*`);
    return r && r[0] ? r[0] : null;
  }
  const writeLog = (rid, day, patch) => call(logPath(rid, day), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(patch) });

  async function closeVenue(venue, w, { force }) {
    const rid = venue.restaurant_id, day = w.day, at = clock();
    let existing = await readLog(rid, day);
    if (existing && !force) {
      if (existing.status === 'sent') return { restaurantId: rid, name: venue.name, status: 'already sent' };
      if (existing.error === IN_PROGRESS && at - Date.parse(existing.created_at) < IN_PROGRESS_MS) return { restaurantId: rid, name: venue.name, status: 'in progress' };
    }
    const nowIso = new Date(at).toISOString();
    if (!existing) {
      // Claim the day before sending, so two calls at once cannot both send.
      const claimed = await call('daily_close_log?on_conflict=restaurant_id,day', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify([{ restaurant_id: rid, day, recipients: 0, status: 'failed', error: IN_PROGRESS, created_at: nowIso }])
      });
      if (!claimed || !claimed.length) return { restaurantId: rid, name: venue.name, status: 'in progress' };
    } else if (existing.status !== 'sent') {
      await writeLog(rid, day, { status: 'failed', error: IN_PROGRESS, recipients: 0, provider_id: null, created_at: nowIso });
    }
    const prior = existing && existing.status === 'sent';       // a forced rerun keeps the record of the send that worked
    const finish = async (patch) => { if (prior && patch.status !== 'sent') patch = { error: 'rerun failed: ' + (patch.error || patch.status) }; await writeLog(rid, day, patch); return patch; };

    try {
      const recipients = await recipientsOf(rid);
      if (!recipients.length) {
        await finish({ status: 'skipped', recipients: 0, provider_id: null, error: 'no active owner or manager email' });
        return { restaurantId: rid, name: venue.name, status: 'skipped', reason: 'no active owner or manager email' };
      }
      const figures = computeClose({ window: w, ...(await loadVenue(venue, w)) });
      // A window with no bill opened or closed and no payment record is not worth an email; force sends it anyway.
      if (!force && !figures.bills.opened && !figures.bills.closed && !figures.csvRows.length) {
        await finish({ status: 'skipped', recipients: 0, provider_id: null, error: 'no activity' });
        return { restaurantId: rid, name: venue.name, status: 'skipped', reason: 'no activity' };
      }
      const csvName = `close-${slugOf(venue.slug)}-${day}.csv`;
      const mail = buildEmail({ venue, figures, csvName });
      const attachments = [{ filename: csvName, content: toBase64(buildCsv(figures.csvRows)) }];
      const from = env('DAILY_CLOSE_FROM');
      const ids = [], failures = [];
      for (const to of recipients) {
        try {
          const r = await send(Object.assign({ to, subject: mail.subject, text: mail.text, html: mail.html, attachments }, from ? { from } : {}));
          ids.push(r && r.id ? String(r.id) : '');
        } catch (e) { failures.push(String(e && e.message || e).slice(0, 200)); }
      }
      if (!ids.length) {
        const error = `send failed for all ${recipients.length}: ${failures[0]}`;
        await finish({ status: 'failed', recipients: 0, provider_id: null, error });
        return { restaurantId: rid, name: venue.name, status: 'failed', reason: error };
      }
      const error = failures.length ? `${failures.length} of ${recipients.length} sends failed: ${failures[0]}` : null;
      await finish({ status: 'sent', recipients: ids.length, provider_id: ids.filter(Boolean).join(',') || null, error, created_at: new Date(clock()).toISOString() });
      return { restaurantId: rid, name: venue.name, status: 'sent', recipients: ids.length, ...(error ? { warning: error } : {}) };
    } catch (e) {
      const error = String(e && e.message || e).slice(0, 500);
      try { await finish({ status: 'failed', recipients: 0, provider_id: null, error }); } catch (_) { /* the log itself is down; the response still says failed */ }
      return { restaurantId: rid, name: venue.name, status: 'failed', reason: error };
    }
  }

  return async function handle(req) {
    const secret = env('AALAYNA_CRON_SECRET'), given = req.headers.get('x-aalayna-cron');
    if (!secret || !given || !same(given, secret)) return json(401, { error: 'unauthorized' });
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'method not allowed' });

    const url = new URL(req.url), venueParam = url.searchParams.get('venue'), dateParam = url.searchParams.get('date');
    const force = ['1', 'true'].includes(url.searchParams.get('force') || '');
    const at = clock();
    let day;
    if (venueParam == null && dateParam == null) {
      day = cronDecision(at).day;                                 // the pg_cron call
    } else if (dateParam != null) {
      if (!parseDay(dateParam)) return json(400, { error: 'date must be YYYY-MM-DD' });
      day = dateParam;
    } else {
      day = lastCompletedDay(at);
    }
    const w = windowFor(day);
    if (w.end > at) return json(400, { error: `${day} has not ended yet (its window closes at ${new Date(w.end).toISOString()})` });

    let venues;
    try {
      venues = await all(`venue_profiles?select=restaurant_id,name,place,slug${venueParam != null ? `&restaurant_id=eq.${enc(venueParam)}` : ''}&order=restaurant_id.asc`);
    } catch (e) { return json(500, { error: 'could not read venues: ' + String(e && e.message || e).slice(0, 200) }); }
    if (venueParam != null && !venues.length) return json(404, { error: 'unknown venue' });

    const results = [];
    for (const v of venues) results.push(await closeVenue(v, w, { force }));
    const failed = results.some((r) => r.status === 'failed');
    const allDone = results.length > 0 && results.every((r) => r.status === 'already sent');
    return json(failed ? 500 : 200, { ok: !failed, day, window: { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() }, ...(allDone ? { message: 'already sent' } : {}), results });
  };
}
