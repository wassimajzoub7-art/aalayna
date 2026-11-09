'use strict';
/* Printed ticket -> bill. The lines tools/pos-printer/escpos.js reads from a printer stream
   are read with a vendor layout profile (tools/pos-printer/profiles/*.json, each extending
   generic.json) into a bill in the pos-bill contract (docs/pos-integration.md). Plain Node,
   no dependencies.

     const t = require('./ticket.js');
     const profile = t.loadProfile('foodics');
     const results = t.readStream(bytes, { profile, venue });   // one result per document
     // result.kind: 'bill' | 'kitchen' | 'report' | 'image' | 'unknown'
     // result.needsReview, result.confidence, result.issues: [{row, text, reason, blocking}]
     const ledger = new t.CheckLedger({ file, now });
     const step = ledger.accept(result, venueId);              // open | update | duplicate
     const body = t.toPosBill(result, venue, step);            // the POST /pos-bill body

   venue (from the listener's configuration): { system, currency, tables: {label: number},
   checkPrefix, sendTenders, minConfidence }. A bill is only good to push when
   result.kind === 'bill' and result.needsReview is false: every amount on it comes from
   the paper, the items, discount, service and VAT balance to the printed total to the
   cent, and the table and check number were found and mapped. Anything else is held for
   a person. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const escpos = require('./escpos.js');

const PROFILE_DIR = path.join(__dirname, 'profiles');
const CUR = '(?:USD|US\\$|LBP|L\\.L\\.?|LL|ل\\.ل\\.?|\\$|€|£)';
const AMOUNT = '(?:' + CUR + '\\s?)?[-−]?\\(?(?:\\d{1,3}(?:[,.\']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,3})?)\\)?(?:\\s?' + CUR + ')?-?';
const QTY = '\\d{1,3}(?:[.,]\\d{1,3})?';
const TRAILING = new RegExp('(?:^|\\s)(' + AMOUNT + ')\\s*$', 'u');
const SEPARATOR = /^[\s\-=_*~.#+|─━═┄┈╌]+$/u;

/* ---------- profiles ---------- */

function merge(base, over) {
  if (Array.isArray(base) && Array.isArray(over)) return over.concat(base.filter((x) => !over.some((y) => JSON.stringify(y) === JSON.stringify(x))));
  if (base && over && typeof base === 'object' && typeof over === 'object' && !Array.isArray(base) && !Array.isArray(over)) {
    const out = Object.assign({}, base);
    for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined ? base : over;
}
/* a profile id, a file path or an object -> the merged, compiled profile */
function loadProfile(p, dir) {
  dir = dir || PROFILE_DIR;
  let raw;
  if (p && typeof p === 'object') raw = p;
  else {
    const file = /[\\/]|\.json$/.test(String(p)) ? path.resolve(String(p)) : path.join(dir, String(p || 'generic') + '.json');
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  let merged = raw;
  const parent = raw.extends || (raw.id !== 'generic' ? 'generic' : null);
  if (parent) merged = merge(loadProfile(parent, dir).raw, Object.assign({}, raw, { extends: undefined }));
  return compile(merged);
}
function compile(raw) {
  const rx = (s) => new RegExp(String(s).replace(/\{A\}/g, AMOUNT).replace(/\{Q\}/g, QTY), 'iu');
  const f = raw.fields || {}, it = raw.item || {}, sm = raw.summary || {};
  const phrases = [];
  for (const cat of ['subtotal', 'discount', 'service', 'vat', 'total', 'change', 'ignore']) for (const p of sm[cat] || []) phrases.push({ p: p.toLowerCase(), cat });
  for (const [method, list] of Object.entries(sm.tender || {})) for (const p of list) phrases.push({ p: p.toLowerCase(), cat: 'tender', method });
  phrases.sort((a, b) => b.p.length - a.p.length);
  return {
    raw, id: raw.id || 'custom', system: raw.system || 'pos', columns: raw.columns || 48,
    columnTest: raw.columnTest !== false, visualOrder: !!raw.visualOrder, dateOrder: raw.dateOrder || 'dmy',
    parser: { codePages: raw.codePages || {}, encoding: raw.encoding || undefined, codePage: raw.codePage || undefined },
    currency: raw.currency || null,
    kitchen: (raw.kitchen || []).map((s) => s.toUpperCase()), report: (raw.report || []).map((s) => s.toUpperCase()),
    reprint: (raw.reprint || []).map((s) => s.toUpperCase()),
    fields: Object.fromEntries(Object.entries(f).map(([k, list]) => [k, list.map(rx)])),
    patterns: (it.patterns || []).map(rx), qtyLine: (it.qtyLine || []).map(rx),
    modifierPrefix: it.modifierPrefix ? new RegExp(it.modifierPrefix, 'u') : null,
    modifierWords: (it.modifierWords || []).map((w) => w.toLowerCase()), modifierIndent: it.modifierIndent || 2,
    voidWords: (it.voidWords || []).map((w) => w.toLowerCase()),
    wrapNames: !!it.wrapNames, phrases,
    currencies: raw.currencies || {},
  };
}

/* ---------- amounts ---------- */

/* a printed amount -> {cents, negative, currency}; 100 minor units per unit in USD and
   LBP alike, as pos-bill wants. The last separator is decimal when one or two digits
   follow it, else every separator groups thousands. */
function parseAmount(text, profile) {
  const s = String(text).trim();
  const currency = currencyOf(s, profile);
  const negative = /[-−]\s*(?:[$€£]|USD|LBP)?\s*\d/.test(s) || /\d\s*-\s*$/.test(s) || /\([^)]*\d[^)]*\)/.test(s);
  const digits = s.replace(/[^\d.,']/g, '');
  if (!/\d/.test(digits)) return null;
  const m = /^(.*?)([.,])(\d{1,2})$/.exec(digits);
  let units, frac;
  if (m) { units = m[1].replace(/[.,']/g, ''); frac = (m[3] + '0').slice(0, 2); }
  else { units = digits.replace(/[.,']/g, ''); frac = '00'; }
  if (!units) units = '0';
  const cents = Number(units) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents)) return null;
  return { cents, negative, currency };
}
/* the currency a piece of text names, by the profile's tokens; a token made of letters
   must stand alone, so BILL is not LL */
function currencyOf(text, profile) {
  const up = String(text || '').toUpperCase();
  for (const [code, toks] of Object.entries((profile && profile.currencies) || {})) {
    for (const t of toks) {
      const T = t.toUpperCase();
      let at = up.indexOf(T);
      while (at >= 0) {
        const bad = (/^[A-Z]/.test(T) && /[A-Z]/.test(up.charAt(at - 1))) || (/[A-Z]$/.test(T) && /[A-Z]/.test(up.charAt(at + T.length)));
        if (!bad) return code;
        at = up.indexOf(T, at + 1);
      }
    }
  }
  return null;
}
function parseQty(text) {
  const s = String(text).replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ---------- rows ---------- */

function startsPhrase(lower, p) {
  if (!lower.startsWith(p)) return false;
  const next = lower.charAt(p.length);
  return !next || !/[a-z\u00C0-\u024F\u0600-\u06FF]/i.test(next);
}
function rowsOf(doc, profile) {
  return doc.lines.map((line, i) => {
    let text = escpos.normalizeText(line.text).replace(/\s+$/u, '');
    const rtl = escpos.hasArabic(text);
    if (profile.visualOrder && rtl) text = escpos.visualToLogical(text).replace(/\s+$/u, '');
    const trimmed = text.trim();
    const indent = text.length - text.replace(/^\s+/u, '').length;
    const w = line.width || 1, printed = Array.from(text).length * w;
    const cols = profile.columns;
    const endCol = line.align === 'right' ? cols : line.align === 'center' ? Math.floor((cols - printed) / 2) + printed : printed;
    return { i, text, trimmed, indent, rtl, line, endCol, emphasis: (line.bold ? 1 : 0) + (w > 1 ? 2 : 0) + ((line.height || 1) > 1 ? 1 : 0) };
  });
}
function trailingAmount(row, profile) {
  const m = TRAILING.exec(row.trimmed);
  if (!m) return null;
  const a = parseAmount(m[1], profile);
  if (!a) return null;
  const label = row.trimmed.slice(0, row.trimmed.length - m[0].length).trim();
  return Object.assign(a, { raw: m[1], label, decimals: /[.,]\d{1,2}(?:\s?\D*)?$/.test(m[1]) });
}
function summaryOf(row, profile) {
  const lower = row.trimmed.toLowerCase();
  for (const ph of profile.phrases) if (startsPhrase(lower, ph.p)) return ph;
  return null;
}
const hasMarker = (rows, list) => rows.some((r) => list.some((m) => {
  const up = r.trimmed.toUpperCase();
  const at = up.indexOf(m);
  if (at < 0) return false;
  const before = up.charAt(at - 1), after = up.charAt(at + m.length);
  return !/[A-Z]/.test(before) && !/[A-Z]/.test(after);
}));
function slug(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

/* ---------- one document ---------- */

/* doc: a document from escpos.parse; opts: {profile, venue, receivedAt} */
function interpret(doc, opts) {
  opts = opts || {};
  const profile = opts.profile && opts.profile.patterns ? opts.profile : loadProfile(opts.profile || 'generic');
  const venue = opts.venue || {};
  const rows = rowsOf(doc, profile);
  const issues = [];
  const issue = (row, reason, blocking, penalty) => issues.push({ row: row ? row.i : null, text: row ? row.trimmed : null, reason, blocking: !!blocking, penalty: penalty || 0 });
  const codes = doc.events.filter((e) => e.type === 'qr' || e.type === 'barcode' || e.type === 'pdf417').map((e) => ({ type: e.type, data: e.data }));
  const result = { kind: 'unknown', profile: profile.id, confidence: 0, needsReview: false, issues, check: {}, currency: null,
    items: [], subtotalCents: null, discountCents: 0, serviceCents: 0, vat: null, totalCents: null, altTotals: [], tenders: [], changeCents: 0, codes };
  const text = rows.filter((r) => r.trimmed);

  if (!text.length) {
    result.kind = doc.events.some((e) => e.type === 'image') ? 'image' : 'unknown';
    if (result.kind === 'image') { issue(null, 'the ticket is printed as an image: there is no text to read', true); result.needsReview = true; }
    return finish(result, venue);
  }
  if (hasMarker(text, profile.report)) { result.kind = 'report'; return finish(result, venue); }

  /* header fields: the first match of each wins; their rows are never items */
  const fieldRows = new Set();
  const find = (key) => {
    for (const r of text) for (const re of profile.fields[key] || []) {
      const m = re.exec(r.trimmed);
      if (m) { fieldRows.add(r.i); return Object.assign({ _: m[0] }, m.groups); }
    }
    return null;
  };
  const table = find('table'), check = find('check'), date = find('date'), time = find('time'), covers = find('covers');
  if (table) result.check.table = table.v.toUpperCase();
  if (check) result.check.number = check.v.toUpperCase().replace(/^[#:]+/, '');
  if (covers) result.check.covers = Number(covers.v);
  result.check.reprint = hasMarker(text, profile.reprint);
  result.check.printedAt = localTime(date, time, profile.dateOrder);
  result.check.date = result.check.printedAt ? result.check.printedAt.slice(0, 10) : null;

  const kitchen = hasMarker(text, profile.kitchen);

  /* classify rows */
  for (const r of text) {
    r.amount = fieldRows.has(r.i) ? null : trailingAmount(r, profile);
    r.summary = r.amount ? summaryOf(r, profile) : null;
    if (!r.amount) { const s = summaryOf(r, profile); if (s && s.cat === 'ignore') r.summary = s; }
  }
  const amountRows = text.filter((r) => r.amount && !r.summary && r.line.width === 1);
  let column = null;
  if (profile.columnTest) {
    const counts = new Map();
    for (const r of text.filter((x) => x.amount && x.line.width === 1 && x.line.align === 'left')) counts.set(r.endCol, (counts.get(r.endCol) || 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (best && best[1] >= 2) column = best[0];
  }
  const aligned = (r) => column === null || Math.abs(r.endCol - column) <= 1;
  const isModifier = (r) => {
    const t = r.trimmed.toLowerCase();
    return (profile.modifierPrefix && profile.modifierPrefix.test(r.trimmed) && !/^[-−]?\d/.test(r.trimmed)) ||
      profile.modifierWords.some((w) => t.startsWith(w)) || (r.indent >= profile.modifierIndent && r.line.align === 'left');
  };
  const candidates = amountRows.filter((r) => aligned(r) && r.line.align === 'left' && !(isModifier(r) && r.indent > 0) && !profile.qtyLine.some((re) => re.test(r.trimmed)));
  const firstItem = candidates.length ? candidates[0].i : Infinity;
  const zoneEndRow = text.find((r) => r.i > firstItem && r.summary && r.summary.cat !== 'ignore' && r.summary.cat !== 'tender' && r.summary.cat !== 'change');
  const zoneEnd = zoneEndRow ? zoneEndRow.i : Infinity;
  const summaries = text.filter((r) => r.summary && r.amount && r.i >= zoneEnd);

  if (kitchen || (!summaries.length && !candidates.length)) {
    result.kind = kitchen ? 'kitchen' : 'unknown';
    return finish(result, venue);
  }
  result.kind = 'bill';

  /* items */
  const items = result.items;
  let last = null;
  for (const r of text) {
    if (r.i < firstItem || r.i >= zoneEnd || fieldRows.has(r.i)) continue;
    if (SEPARATOR.test(r.trimmed)) continue;
    if (candidates.includes(r)) { last = readItem(r, profile, issue); if (last) items.push(last); continue; }
    const q = last && profile.qtyLine.map((re) => re.exec(r.trimmed)).find(Boolean);
    if (q) {
      const qty = parseQty(q.groups.qty), unit = q.groups.unit ? parseAmount(q.groups.unit, profile) : null;
      if (Number.isInteger(qty) && qty > 0 && unit && qty * unit.cents === last.totalCents) { last.quantity = qty; last.unitPriceCents = unit.cents; }
      else issue(r, 'a quantity line that does not match the item above it', false, 0.2);
      continue;
    }
    if (last && isModifier(r)) {
      const name = (r.amount ? r.amount.label : r.trimmed).replace(profile.modifierPrefix || /^$/, '').trim();
      if (r.amount && r.amount.cents > 0) {
        if (r.amount.negative) { issue(r, 'a negative modifier', true); continue; }
        last.totalCents += r.amount.cents;
      }
      if (name) last.modifiers.push(name);
      continue;
    }
    if (r.amount && r.amount.negative) { applyVoid(r, items, profile, issue); continue; }
    if (last && profile.wrapNames && !r.amount) { last.name += ' ' + r.trimmed; continue; }
    if (/^[*=#\- ]{2,}.*[*=#\- ]{2,}$/.test(r.trimmed)) continue;  // a category heading such as ** DRINKS **
    issue(r, r.amount ? 'an amount row that is not aligned with the item column' : 'a row in the items that is not an item', false, 0.1);
  }
  for (const it of items) {
    if (it.totalCents % it.quantity !== 0) { issue({ i: it.row, trimmed: it.name }, 'the line total does not divide by the quantity', true); continue; }
    it.unitPriceCents = it.totalCents / it.quantity;
  }

  /* summary rows: in the bill's currency; the first total, the emphasised one when two compete */
  const venueCurrency = profile.currency || venue.currency || null;
  const totals = summaries.filter((r) => r.summary.cat === 'total');
  const detected = totals.map((r) => r.amount.currency || (r.amount.label && currencyIn(r.amount.label, profile))).find(Boolean);
  const currency = venueCurrency || detected || 'USD';
  result.currency = currency;
  const inCurrency = (r) => { const c = r.amount.currency || currencyIn(r.amount.label, profile); return !c || c === currency; };
  let tendersStarted = false;
  const totalRows = [];
  for (const r of summaries) {
    const cat = r.summary.cat, a = r.amount;
    if (cat === 'ignore') continue;
    if (!inCurrency(r)) { if (cat === 'total') result.altTotals.push({ currency: a.currency || currencyIn(a.label, profile), cents: a.cents }); continue; }
    if (cat === 'subtotal' && !tendersStarted) result.subtotalCents = (result.subtotalCents || 0) + a.cents;
    else if (cat === 'discount') result.discountCents += a.cents;
    else if (cat === 'service') result.serviceCents += a.cents;
    else if (cat === 'vat') {
      const rate = /(\d{1,2}(?:[.,]\d+)?)\s?%/.exec(a.label);
      const v = result.vat || { cents: 0, ratePercent: null, inclusive: null, label: a.label };
      v.cents += a.cents; if (rate) v.ratePercent = Number(rate[1].replace(',', '.'));
      if (/incl|dont|inclus|included|شامل/i.test(r.trimmed)) v.inclusive = true;
      result.vat = v;
    } else if (cat === 'total') { if (!tendersStarted) totalRows.push(r); }
    else if (cat === 'tender') { tendersStarted = true; result.tenders.push({ method: r.summary.method, amountCents: a.cents }); }
    else if (cat === 'change') { tendersStarted = true; result.changeCents += a.cents; }
  }

  /* the arithmetic: items, then discount, service, and VAT when it is added on top */
  const gross = items.reduce((s, it) => s + it.totalCents, 0);
  const base = gross - result.discountCents + result.serviceCents;
  const balances = (c) => c === base || (result.vat && result.vat.inclusive !== true && c === base + result.vat.cents);
  const chosen = totalRows.find((r) => balances(r.amount.cents)) ||
    totalRows.slice().sort((x, y) => y.emphasis - x.emphasis || x.i - y.i)[0];
  if (chosen) result.totalCents = chosen.amount.cents;
  if (!items.length) issue(null, 'no item lines were read', true);
  if (result.totalCents === null) issue(null, 'no total line was found', true);
  if (result.subtotalCents !== null && result.subtotalCents !== gross) issue(null, 'the items add up to ' + gross + ' but the subtotal says ' + result.subtotalCents, true);
  if (result.totalCents !== null && items.length) {
    if (result.totalCents === base) { if (result.vat) result.vat.inclusive = true; }
    else if (result.vat && result.vat.inclusive !== true && result.totalCents === base + result.vat.cents) result.vat.inclusive = false;
    else issue(null, 'the items, discount, service and VAT come to ' + base + (result.vat ? ' (+' + result.vat.cents + ' VAT)' : '') + ' but the total says ' + result.totalCents, true);
  }
  if (result.discountCents > gross) issue(null, 'the discount is larger than the items', true);

  if (!result.check.number) issue(null, 'no check number was found', true);
  if (!result.check.table) issue(null, 'no table was found', true);
  if (!result.check.printedAt) issue(null, 'no date was found; the time it arrived is used', false, 0.05);
  if (result.tenders.length) result.check.paid = true;
  return finish(result, venue);
}

function currencyIn(label, profile) {
  const up = String(label || '').toUpperCase();
  for (const [code, toks] of Object.entries(profile.currencies)) if (toks.some((t) => up.includes(t.toUpperCase()))) return code;
  return null;
}

function readItem(r, profile, issue) {
  for (const re of profile.patterns) {
    const m = re.exec(r.trimmed);
    if (!m) continue;
    const g = m.groups;
    const total = parseAmount(g.total, profile);
    if (!total) continue;
    const qty = g.qty ? parseQty(g.qty) : 1;
    if (qty === null || qty <= 0) continue;
    const unit = g.unit ? parseAmount(g.unit, profile) : null;
    const name = g.name.trim();
    if (!name || /^\d+([.,]\d+)?$/.test(name)) continue;
    if (!Number.isInteger(qty)) {
      issue(r, 'a fractional quantity (' + g.qty + '): sent as one line at its printed total', false, 0.2);
      return { row: r.i, name: name + ' ' + g.qty, quantity: 1, totalCents: total.cents, modifiers: [] };
    }
    if (unit && qty * unit.cents !== total.cents) continue;
    if (!unit && total.cents % qty !== 0) continue;
    if (total.negative) { applyVoid(r, null, profile, issue); return null; }
    return { row: r.i, name, quantity: qty, totalCents: total.cents, modifiers: [] };
  }
  issue(r, 'an item row no pattern could read', true);
  return null;
}
/* a negative row takes its quantity off the item of the same name above it */
function applyVoid(r, items, profile, issue) {
  const label = r.amount ? r.amount.label : r.trimmed;
  const lower = label.toLowerCase();
  let name = label;
  for (const w of profile.voidWords) if (lower.startsWith(w)) name = label.slice(w.length).replace(/^[\s:\-]+/, '');
  const qm = /^(\d{1,3})\s*[xX×]?\s+(.+)$/.exec(name);
  const qty = qm ? Number(qm[1]) : 1;
  if (qm) name = qm[2];
  const target = items && items.slice().reverse().find((it) => it.name.toLowerCase() === name.trim().toLowerCase());
  if (!target || !r.amount || target.totalCents % target.quantity !== 0 || r.amount.cents !== qty * (target.totalCents / target.quantity) || target.quantity < qty) {
    issue(r, 'a void or negative line that matches no item above it', true);
    return;
  }
  const unit = target.totalCents / target.quantity;
  target.quantity -= qty; target.totalCents -= qty * unit;
  if (target.quantity === 0) items.splice(items.indexOf(target), 1);
}

const MONTHS = { jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, avr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, aou: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function localTime(date, time, order) {
  if (!date) return null;
  let d = Number(date.d), m = Number(date.m), y = Number(date.y);
  if (date.mon) {
    const k = date.mon.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    m = k.startsWith('juin') ? 6 : k.startsWith('juil') ? 7 : MONTHS[k.slice(0, 3)] || 0;
  }
  if (order === 'mdy' && !/^\d{4}/.test(date._ || '')) { const t = d; d = m; m = t; }
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y < 2100)) return null;
  let h = 0, min = 0, s = 0;
  if (time) {
    h = Number(time.h); min = Number(time.min); s = Number(time.s || 0);
    if (time.ap) { const pm = /pm/i.test(time.ap); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    if (!(h < 24 && min < 60 && s < 60)) { h = 0; min = 0; s = 0; }
  }
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return p(y, 4) + '-' + p(m) + '-' + p(d) + 'T' + p(h) + ':' + p(min) + ':' + p(s);
}

/* lines, ids, confidence and the review flag */
function finish(result, venue) {
  const counts = {};
  result.lines = result.items.filter((it) => it.quantity > 0 && Number.isInteger(it.unitPriceCents)).map((it) => {
    const key = slug(it.name);
    counts[key] = (counts[key] || 0) + 1;
    const line = { externalId: counts[key] > 1 ? key + '~' + counts[key] : key, name: it.name.slice(0, 200), quantity: it.quantity, unitPriceCents: it.unitPriceCents };
    if (it.modifiers.length) line.modifiers = it.modifiers.map((m) => m.slice(0, 60)).slice(0, 20);
    return line;
  });
  if (result.vat && result.vat.inclusive === false && result.vat.cents > 0) {
    result.lines.push({ externalId: 'vat', name: (result.vat.label || 'VAT').slice(0, 200) || 'VAT', quantity: 1, unitPriceCents: result.vat.cents });
  }
  if (result.kind === 'bill') {
    const tables = venue.tables || {};
    const label = result.check.table;
    let n = null;
    const mapped = label ? Object.keys(tables).find((k) => k.trim().toUpperCase() === label) : undefined;
    if (mapped !== undefined) n = tables[mapped];
    else if (label && /^\d{1,4}$/.test(label) && venue.numericTables !== false) n = Number(label);
    if (label && !(Number.isInteger(n) && n >= 1 && n <= 9999)) result.issues.push({ row: null, text: label, reason: 'table "' + label + '" is not in the venue\'s table mapping', blocking: true, penalty: 0 });
    result.check.tableNumber = Number.isInteger(n) ? n : null;
  }
  const penalty = result.issues.reduce((s, i) => s + i.penalty, 0);
  const blocking = result.issues.some((i) => i.blocking);
  result.confidence = result.kind === 'bill' ? Math.max(0, Math.round((blocking ? Math.min(0.3, 1 - penalty) : 1 - penalty) * 100) / 100) : 0;
  const min = venue.minConfidence === undefined ? 0.8 : venue.minConfidence;
  result.needsReview = result.kind === 'image' || (result.kind === 'bill' && (blocking || result.confidence < min));
  result.hash = contentHash(result);
  return result;
}
function contentHash(r) {
  const basis = { table: r.check.tableNumber, currency: r.currency, lines: r.lines, discountCents: r.discountCents, serviceCents: r.serviceCents, totalCents: r.totalCents, tenders: r.tenders, changeCents: r.changeCents };
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 32);
}

/* a whole capture -> one result per document; opts: {profile, venue} */
function readStream(bytes, opts) {
  opts = opts || {};
  const profile = opts.profile && opts.profile.patterns ? opts.profile : loadProfile(opts.profile || 'generic');
  const parsed = escpos.parse(bytes, profile.parser);
  return parsed.documents.map((doc) => interpret(doc, { profile, venue: opts.venue }));
}

/* ---------- versions and superseded prints ---------- */

/* The same check prints again when a guest asks for the bill twice, when items are added
   after a first print, or when a cashier reprints it. The ledger remembers each check it
   has seen (per venue, by check number, for windowHours) with its externalId, version and
   content hash, so that:
   - the same content again is a duplicate: nothing is sent;
   - changed content supersedes the earlier print: the same externalId with a higher
     version, as pos-bill wants for an update;
   - a check number seen again past midnight keeps the externalId it was opened with.
   Versions are milliseconds (the spec's advice), never lower than the last one plus 1. A
   new check on a table that had another check open is noted (supersedesCheck); Aalayna
   itself closes the old bill when nobody paid on it. */
class CheckLedger {
  constructor(o) {
    o = o || {};
    this.file = o.file || null;
    this.now = o.now || (() => new Date());
    this.windowMs = (o.windowHours || 14) * 3600000;
    this.data = { checks: {} };
    if (this.file && fs.existsSync(this.file)) { try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.data = { checks: {} }; } }
    if (!this.data.checks) this.data.checks = {};
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
  prune() {
    const cutoff = this.now().getTime() - 3 * 86400000;
    for (const [k, e] of Object.entries(this.data.checks)) if (e.lastSeen < cutoff) delete this.data.checks[k];
  }
  /* result (a pushable bill) -> {action, externalId, version, previousVersion, supersedesCheck} */
  accept(result, venueId, venue) {
    venue = venue || {};
    const now = this.now().getTime();
    this.prune();
    const key = venueId + '|' + result.check.number;
    let entry = this.data.checks[key];
    if (entry && now - entry.lastSeen > this.windowMs) entry = null;
    const day = result.check.date || localDay(this.now());
    const externalId = entry ? entry.externalId : (venue.checkPrefix || '') + day + '/' + result.check.number;
    if (!entry) {
      // the same externalId from an earlier sighting outside the window still never repeats with older versions
      entry = Object.values(this.data.checks).find((e) => e.venueId === venueId && e.externalId === externalId) || null;
    }
    if (entry && entry.hash === result.hash) {
      entry.lastSeen = now; this.save();
      return { action: 'duplicate', externalId, version: entry.version, previousVersion: entry.version };
    }
    const previousVersion = entry ? entry.version : null;
    const version = Math.max(now, (previousVersion || 0) + 1);
    let supersedesCheck = null;
    if (!entry) {
      const open = Object.values(this.data.checks).find((e) => e.venueId === venueId && e.table === result.check.tableNumber && e.externalId !== externalId && now - e.lastSeen < this.windowMs && !e.closed);
      if (open) { supersedesCheck = open.externalId; open.closed = true; }
    }
    this.data.checks[key] = { venueId, externalId, version, hash: result.hash, table: result.check.tableNumber, firstSeen: entry ? entry.firstSeen : now, lastSeen: now,
      closed: !!(result.check.paid && venue.sendTenders) };
    this.save();
    return { action: entry ? 'update' : 'open', externalId, version, previousVersion, supersedesCheck };
  }
  /* a push refused as version_reused: the next version must be higher still */
  bump(venueId, checkNumber) {
    const e = this.data.checks[venueId + '|' + checkNumber];
    if (!e) return null;
    e.version = Math.max(this.now().getTime(), e.version + 1);
    this.save();
    return e.version;
  }
}
function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* result + the ledger's step -> the POST /pos-bill body */
function toPosBill(result, venue, step) {
  venue = venue || {};
  const body = {
    externalId: step.externalId, system: venue.system || result.system || 'pos', table: result.check.tableNumber,
    currency: result.currency, version: step.version, lines: result.lines.map((l) => Object.assign({}, l)), totalCents: result.totalCents,
  };
  if (result.discountCents) body.discountCents = result.discountCents;
  if (result.serviceCents) body.serviceCents = result.serviceCents;
  if (venue.sendTenders && result.tenders.length) {
    // what the till kept: the change comes off the cash tender, and nothing over the total
    let left = result.totalCents, change = result.changeCents;
    body.tenders = [];
    result.tenders.forEach((t, i) => {
      let amount = t.amountCents;
      if (t.method === 'cash' && change) { const c = Math.min(change, amount); amount -= c; change -= c; }
      amount = Math.min(amount, left); left -= amount;
      if (amount > 0) body.tenders.push({ externalId: step.externalId + ':t' + (i + 1), method: t.method, amountCents: amount });
    });
    if (left === 0) body.closed = true;
  }
  return body;
}

module.exports = { loadProfile, interpret, readStream, toPosBill, CheckLedger, parseAmount, AMOUNT, PROFILE_DIR };
