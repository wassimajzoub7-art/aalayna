'use strict';
/* Demo activity for the morning close (T4): five weeks of service at Mayda, the fictional
   Lebanese grill of venues/mayda.json, ending on a given business day, in the shape the
   daily-close function reads from Supabase (kv_rows, kv_docs, webhook tables). Seeded, so
   the same arguments always give the same rows. Nothing here is real: names, dishes and
   prices are Mayda's, guests are numbered, there are no contact details.

     demoRows({day, scenario, windowFor, addDays, lang, currency}) -> {venue, kv_rows, kv_docs,
       webhook_endpoints, webhook_deliveries}
       scenario  'good'  a busy night: more bills than usual, better tips, regulars back
                 'bad'   a thin night: few bills, cash heavy, slow to settle, a cash request
                         left waiting, a bill left open, a refund, a stale rate, a failed POS push
                 'empty' nothing on the day itself (the weeks before are as usual)
       windowFor, addDays  from supabase/functions/daily-close/handler.js (passed in, because
                 that file is an ES module and this one is CommonJS) */

const MAYDA = require('../../venues/mayda.json');
const RID = JSON.stringify(['mayda', 'hamra']);
const MIN = 60000;

function rng(seed) {
  let a = seed >>> 0;
  return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const iso = (ms) => new Date(ms).toISOString();

function demoRows({ day, scenario, windowFor, addDays, lang, currency }) {
  const rand = rng(20261028), pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const dishes = MAYDA.items.filter((i) => Number(i.price) > 0);
  const kv_rows = [], guests = new Map(), deliveries = [];
  const row = (collection, id, body, updated) => kv_rows.push({ restaurant_id: RID, collection, id, body, updated_at: updated });
  let n = 0;
  const guestPool = Array.from({ length: 30 }, (_, i) => 'guest-' + (i + 1));

  for (let k = 35; k >= 0; k--) {
    const d = addDays(day, -k), w = windowFor(d), isDay = k === 0, sameWeekday = k % 7 === 0;
    if (isDay && scenario === 'empty') continue;
    const good = isDay && scenario === 'good', bad = isDay && scenario === 'bad';
    const bills = good ? 30 : bad ? 7 : sameWeekday ? 20 + Math.floor(rand() * 5) : 12 + Math.floor(rand() * 6);
    for (let b = 0; b < bills; b++) {
      const id = `${d}-b${b + 1}`, table = 1 + (b % 18);
      const opened = w.start + (15 + rand() * 4) * 3600000;          // 19:00 to 23:00 Beirut
      const lines = [];
      for (let j = 0, m = 2 + Math.floor(rand() * 4); j < m; j++) { const it = pick(dishes), q = 1 + Math.floor(rand() * 2); lines.push({ id: it.id, q, p: Math.round(it.price * q * 100) / 100, name: it.name }); }
      const total = Math.round(lines.reduce((s, l) => s + l.p, 0) * 100);
      const leftOpen = bad && b === bills - 1;
      const closed = opened + (60 + rand() * 60) * MIN;
      row('aal.checks', id, { id, venueId: RID, table, openedAt: iso(opened), ...(leftOpen ? {} : { closedAt: iso(closed) }), totalCents: total, lines }, iso(leftOpen ? opened : closed));
      if (leftOpen) continue;
      const rail = bad ? (rand() < 0.75 ? 'cash' : 'card') : (rand() < 0.35 ? 'cash' : rand() < 0.7 ? 'card' : 'whish');
      const tipRate = good ? 0.12 : bad ? 0.04 : 0.08;
      const tip = Math.round(total * tipRate) / 100, amount = total / 100 + tip;
      const ts = closed - 8 * MIN, settle = (bad ? 9 : good ? 3 : 4) + rand() * 2;
      const pid = `${d}-p${++n}`;
      const p = { id: pid, venueId: RID, checkId: id, table, rail, amount, tip, currency: 'USD', amountUsd: amount, status: 'confirmed', ts: iso(ts), confirmedAt: iso(ts + settle * MIN) };
      // about a third of payers leave a receipt contact; a few faces come back every week
      // regulars (guests 1-6) on this weekday, three first-timers and one lapsed guest on a good
      // night, a single visit a week ago that is now a second-visit candidate, others at random
      let g = null;
      if (good && b < 6) g = guestPool[b];
      else if (good && b < 9) g = guestPool[18 + b];          // guests 25 to 27, never seen before
      else if (good && b === 9) g = 'guest-lapsed';
      else if (k === 35 && b === 10) g = 'guest-lapsed';       // ... whose previous visit was 5 weeks ago
      else if (k === 7 && b === 10) g = guestPool[27];          // guest 28: once, a week ago
      else if (sameWeekday && b < 6 && rand() < 0.8) g = guestPool[b];
      else if (rand() < 0.3) g = guestPool[6 + Math.floor(rand() * 18)];
      if (g) {
        p.customerId = g;
        const rec = guests.get(g) || { id: g, venueId: RID, channel: 'email', consentHistory: [] };
        rec.consentHistory.push({ at: iso(ts + settle * MIN + MIN), source: 'receipt', settlementId: pid, receipt: true, marketing: Number(g.split('-')[1]) % 3 !== 0, version: 'restaurant-offers-v1' });
        rec.updatedAt = iso(ts + settle * MIN + MIN);
        guests.set(g, rec);
      }
      if (bad && b === 0) p.refunded = iso(ts + 60 * MIN);
      row('aal.settle', pid, p, p.refunded || p.confirmedAt);
      deliveries.push({ id: `dl-${pid}`, endpoint_id: 'ep-1', event_type: 'bill.paid', event_id: pid, attempts: 1, last_status: 200, delivered_at: iso(ts + settle * MIN + 2000), created_at: iso(ts + settle * MIN) });
    }
    if (bad) {
      const pid = `${d}-pending`, ts = w.end - 50 * MIN;
      row('aal.settle', pid, { id: pid, venueId: RID, checkId: `${d}-b${bills}`, table: 9, rail: 'cash', amount: 24, tip: 0, currency: 'USD', amountUsd: 24, status: 'pending', ts: iso(ts) }, iso(ts));
      deliveries.push({ id: 'dl-failed', endpoint_id: 'ep-1', event_type: 'bill.closed', event_id: 'x', attempts: 3, last_status: 502, delivered_at: null, created_at: iso(w.start + 18 * 3600000) });
    }
  }
  // the guests who only came once, a week ago, and stay single-visit for the second-visit audience
  for (const g of guests.values()) row('aal.guests', g.id, g, g.updatedAt);

  const end = windowFor(day).end;
  const rateAge = scenario === 'bad' ? 20 : 3;
  return {
    venue: { restaurant_id: RID, name: 'Mayda', place: 'Hamra', slug: 'mayda', lang: lang || 'en', currency: currency || 'USD' },
    kv_rows,
    kv_docs: [
      { restaurant_id: RID, key: 'aal.rate', body: 89500 },
      { restaurant_id: RID, key: 'aal.rate_meta', body: { updatedAt: iso(end - rateAge * 86400000 - 3600000), updatedBy: 'owner' } },
      { restaurant_id: RID, key: 'aal.live', body: { items: MAYDA.items.map((i) => ({ id: i.id, name: i.name })) } }
    ],
    webhook_endpoints: [{ id: 'ep-1', restaurant_id: RID }],
    webhook_deliveries: deliveries
  };
}

/* The rows a venue's close reads, from a {venue, kv_rows, kv_docs, webhook_*} set: what
   loadVenue in handler.js returns, without its updated_at filters (computeClose and
   computeFacts filter by time themselves, so a superset gives the same figures). */
function venueData(set, w) {
  const rid = set.venue.restaurant_id, mine = (set.kv_rows || []).filter((r) => r.restaurant_id === rid);
  const of = (c) => mine.filter((r) => r.collection === c).map((r) => ({ id: r.id, body: r.body }));
  const settles = of('aal.settle');
  const eps = new Set((set.webhook_endpoints || []).filter((e) => e.restaurant_id === rid).map((e) => e.id));
  return {
    docs: (set.kv_docs || []).filter((d) => d.restaurant_id === rid).map((d) => ({ key: d.key, body: d.body })),
    checks: of('aal.checks'), settles, events: of('aal.events'), guests: of('aal.guests'),
    customerSettles: settles.filter((s) => s.body && s.body.customerId),
    deliveries: (set.webhook_deliveries || []).filter((d) => eps.has(d.endpoint_id) && Date.parse(d.created_at) >= w.start && Date.parse(d.created_at) < w.end)
  };
}

module.exports = { demoRows, venueData, RID };
