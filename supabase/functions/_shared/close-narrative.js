/* The morning close, in words (T4). A short plain-language narrative of one venue's business
   day, written from the close's own figures by fixed rules. Plain JavaScript with no imports:
   Deno runs it in the daily-close function, node --test runs it in tests/, and
   tools/close-preview.js runs it on the founder's machine. Nothing here reads the clock, the
   network or the environment: the same input always gives the same text.

     closeNarrative({lang, currency, day, today, lastWeek, trailing}) -> narrative
       lang      'en' | 'fr' | 'ar' (anything else is 'en')
       currency  'USD' (default) or 'LBP': with 'LBP' and a rate on file, takings are given in
                 lira first and dollars in brackets
       day       the business day, YYYY-MM-DD (its weekday names the comparable day)
       today     the day's figures; lastWeek the same weekday 7 days earlier (or null);
       trailing  the same weekday 7, 14, 21 and 28 days earlier (any of them may be null).
                 Each is either {figures, facts} (computeClose and computeFacts from
                 daily-close/handler.js, turned into a Day by toDay) or a Day already.
     -> {lang, dir, sentences: [{rule, text}], text}
        dir is 'rtl' for Arabic. text is the sentences joined by a space.

   The rules, their order and every threshold are in docs/close-narrative.md; THRESHOLDS below
   is the one place the numbers live. Every number in the text comes from the input; no
   sentence is written unless its numbers are there. No em dash, no contact detail: the input
   has none (counts only), and the text names tables and amounts, never guests.

   numbersIn(text, lang) and sameNumbers(a, b, lang) are the numeric check the optional model
   path (close-narrative-model.js) uses: the multiset of numbers in a rewrite must equal the
   multiset in the rules' text. */

export const THRESHOLDS = Object.freeze({
  takingsChangePct: 10,     // a change in takings under 10% (either way) is "in line"
  trailingMinDays: 2,       // the 4-week average needs at least 2 of those weekdays with takings
  tipRatePoints: 3,         // tips as a share of takings: 3 percentage points or more moved
  cashSharePoints: 10,      // cash as a share of takings: 10 percentage points or more moved
  averageBillPct: 15,       // the average bill: 15% or more moved
  averageBillMinBills: 3,   // ... and both days had at least 3 closed bills with a total
  settleMinutes: 2,         // median request-to-confirmation time: 2 minutes or more moved
  settlePct: 25,            // ... and 25% or more of the earlier median
  settleMinPayments: 3,     // ... and both days had at least 3 timed payments
  maxMoved: 2,              // at most 2 "what moved" sentences
  pendingMinutes: 10,       // a cash request counts once it has waited 10 minutes at the close
  staleRateDays: 14,        // the lira rate is stale once unchanged for 14 days (A.rateInfo)
  lapsedDays: 30,           // a returning guest whose previous visit is 30+ days old was lapsed
  regularVisits: 3,         // a regular has 3+ visits, the previous under 30 days ago
  secondVisitDays: 7,       // the second-visit audience starts 7 days after a single visit
  maxSentences: 6
});

const T = THRESHOLDS;

/* ------------------------------------------------------------- formatting */

const NNBSP = ' ', NBSP = ' ';
const group = (digits, sep) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
const pad2 = (n) => (n < 10 ? '0' : '') + n;

function intText(n, lang) { const s = String(Math.round(Math.abs(n))); return (n < 0 ? '-' : '') + group(s, lang === 'fr' ? NNBSP : ','); }
function centsText(c, lang) {
  const a = Math.abs(Math.round(c)), whole = group(String(Math.floor(a / 100)), lang === 'fr' ? NNBSP : ','), frac = pad2(a % 100);
  return (c < 0 ? '-' : '') + whole + (lang === 'fr' ? ',' : '.') + frac;
}
export function usd(c, lang) {
  if (lang === 'fr') return centsText(c, 'fr') + NBSP + '$';
  if (lang === 'ar') return centsText(c, 'ar') + ' دولار';
  return '$' + centsText(c, 'en');
}
export function lira(n, lang) {
  if (lang === 'fr') return intText(n, 'fr') + NBSP + 'LL';
  if (lang === 'ar') return intText(n, 'ar') + ' ل.ل.';
  return 'LL ' + intText(n, 'en');
}
const pct = (n, lang) => String(Math.round(n)) + (lang === 'fr' ? NBSP + '%' : '%');
const semi = (lang) => (lang === 'fr' ? NNBSP + '; ' : lang === 'ar' ? '؛ ' : '; ');
const colon = (lang) => (lang === 'fr' ? NBSP + ': ' : ': ');

const WEEKDAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
};
function weekdayIndex(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() : null;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/* English and French: "1 bill", "3 bills". */
const en = (n, one, many) => `${intText(n, 'en')} ${n === 1 ? one : many || one + 's'}`;
const fr = (n, one, many) => `${intText(n, 'fr')} ${n <= 1 ? one : many || one + 's'}`;
/* Arabic counted nouns, in a genitive or accusative slot (after a verbal noun such as
   "تم إغلاق"): 1 and 2 are words, 3 to 10 take the plural, 11 and up the singular. */
function ar(n, forms) {
  if (n === 1) return forms[0];
  if (n === 2) return forms[1];
  const h = n % 100;
  return `${intText(n, 'ar')} ${h >= 3 && h <= 10 ? forms[2] : forms[3]}`;
}
function list(items, lang) {
  if (items.length <= 1) return items.join('');
  if (lang === 'ar') return items.join(' و');
  const and = lang === 'fr' ? ' et ' : ' and ';
  return items.slice(0, -1).join(', ') + and + items[items.length - 1];
}
function tables(t, lang) {
  const xs = (t || []).map(String);
  if (lang === 'ar') return (xs.length === 1 ? 'الطاولة ' : 'الطاولات ') + xs.join('، ');
  return (xs.length === 1 ? 'table ' : 'tables ') + xs.join(', ');
}

/* -------------------------------------------------------------- the input */

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const nOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/* computeClose figures + computeFacts facts -> the Day the rules read. */
export function toDay(x) {
  if (!x) return null;
  if (!x.figures) return x;
  const f = x.figures, k = x.facts || {};
  const takings = num(f.cash && f.cash.usdCents) + num(f.digital && f.digital.usdCents) + num(f.till && f.till.usdCents);
  const payments = Array.isArray(f.csvRows) ? f.csvRows.length : num(f.payments);
  const opened = num(f.bills && f.bills.opened), closed = num(f.bills && f.bills.closed);
  return {
    day: f.day,
    empty: !opened && !closed && !payments,
    billsOpened: opened, billsClosed: closed,
    takingsCents: takings, tipsCents: num(f.tips && f.tips.usdCents), cashCents: num(f.cash && f.cash.usdCents),
    rate: nOrNull(f.rate),
    averageBillCents: nOrNull(k.averageBillCents), averageBillCount: num(k.averageBillCount),
    settleMinutes: nOrNull(k.settleMinutes), settleCount: num(k.settleCount),
    pendingCash: k.pendingCash || { count: 0, usdCents: 0, tables: [], older: 0 },
    stillOpen: { count: num(f.bills && f.bills.stillOpen), tables: (f.bills && f.bills.stillOpenTables) || [] },
    refunds: { count: num(f.refunds && f.refunds.count), usdCents: num(f.refunds && f.refunds.usdCents) },
    rateAgeDays: nOrNull(k.rateAgeDays),
    pos: k.pos || null,
    returns: k.returns || null
  };
}

const active = (d) => !!d && num(d.takingsCents) > 0;
const share = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

/* The baseline the "what moved" rules compare with: last week's same weekday when it had
   takings, else the average of the trailing same weekdays that had takings (at least
   trailingMinDays of them), else none. Shares are pooled (sum of tips / sum of takings);
   the average bill is weighted by bills; the settlement time is the mean of the daily medians. */
export function baselineOf(lastWeek, trailing) {
  if (active(lastWeek)) {
    return { kind: 'lastWeek', days: 1, takingsCents: lastWeek.takingsCents, billsClosed: lastWeek.billsClosed,
      tipRate: share(lastWeek.tipsCents, lastWeek.takingsCents), cashShare: share(lastWeek.cashCents, lastWeek.takingsCents),
      averageBillCents: lastWeek.averageBillCents, averageBillCount: lastWeek.averageBillCount,
      settleMinutes: lastWeek.settleMinutes, settleCount: lastWeek.settleCount };
  }
  const t = trailingAverage(trailing);
  return t ? Object.assign({ kind: 'trailing' }, t) : null;
}
export function trailingAverage(trailing) {
  const days = (trailing || []).filter(active);
  if (days.length < T.trailingMinDays) return null;
  const sum = (f) => days.reduce((n, d) => n + num(f(d)), 0);
  const takings = sum((d) => d.takingsCents);
  const billed = days.filter((d) => d.averageBillCents != null && d.averageBillCount > 0);
  const timed = days.filter((d) => d.settleMinutes != null && d.settleCount > 0);
  const billCount = billed.reduce((n, d) => n + d.averageBillCount, 0);
  return {
    days: days.length,
    takingsCents: Math.round(takings / days.length),
    tipRate: share(sum((d) => d.tipsCents), takings), cashShare: share(sum((d) => d.cashCents), takings),
    averageBillCents: billCount ? Math.round(billed.reduce((n, d) => n + d.averageBillCents * d.averageBillCount, 0) / billCount) : null,
    averageBillCount: billed.length ? Math.min(...billed.map((d) => d.averageBillCount)) : 0,
    settleMinutes: timed.length ? Math.round(timed.reduce((n, d) => n + d.settleMinutes, 0) / timed.length) : null,
    settleCount: timed.length ? Math.min(...timed.map((d) => d.settleCount)) : 0
  };
}

/* ---------------------------------------------------------------- the words */

/* The day's takings in the venue's currency: with LBP and a rate on file, lira at that day's
   rate and dollars in brackets; a comparison amount (short) is in lira alone, at its own day's
   rate (or today's), so brackets never nest. */
function takingsText(d, lang, currency, short, rate) {
  const r = d.rate || rate;
  if (currency === 'LBP' && r) {
    const ll = lira(Math.round(d.takingsCents / 100 * r), lang);
    return short ? ll : `${ll} (${usd(d.takingsCents, lang)})`;
  }
  return usd(d.takingsCents, lang);
}

const W = {
  en: {
    empty: (wd) => `Nothing was recorded on ${wd}: no bill was opened or closed and no payment came in.`,
    evening: (wd, d, money) => d.billsClosed
      ? `On ${wd}, ${en(d.billsClosed, 'bill')} ${d.billsClosed === 1 ? 'was' : 'were'} closed and ${money} was taken, tips included`
      : `On ${wd}, no bill was closed and ${money} was taken, tips included`,
    vsLast: (wd, change, lastMoney, lastBills) => (change == null
      ? `, in line with last ${wd} (${lastMoney} from ${en(lastBills, 'bill')})`
      : `, ${change > 0 ? 'up' : 'down'} ${pct(Math.abs(change), 'en')} on last ${wd} (${lastMoney} from ${en(lastBills, 'bill')})`),
    lastEmpty: (wd) => `; last ${wd} had no takings on record`,
    vsTrail: (wd, change, n, avg) => (change == null
      ? `; that is in line with the average of the previous ${n} ${wd}s with takings (${avg})`
      : `; that is ${pct(Math.abs(change), 'en')} ${change > 0 ? 'above' : 'below'} the average of the previous ${n} ${wd}s with takings (${avg})`),
    vs: (b, wd) => (b.kind === 'lastWeek' ? `last ${wd}` : `on average over the previous ${b.days} ${wd}s`),
    near: (b, wd) => (b.kind === 'lastWeek' ? `last ${wd}` : `the average of the previous ${b.days} ${wd}s`),
    tips: (now, money, before, vs) => `Tips were ${now} of takings (${money}), against ${before} ${vs}.`,
    cash: (now, before, vs) => `Cash was ${now} of takings, against ${before} ${vs}.`,
    bill: (now, before, vs) => `The average bill was ${now}, against ${before} ${vs}.`,
    settle: (now, before, vs) => `Payments took a median of ${en(now, 'minute')} from request to confirmation, against ${en(before, 'minute')} ${vs}.`,
    steady: (parts, near) => `${cap(list(parts, 'en'))} ${parts.length === 1 ? 'was' : 'were'} close to ${near}.`,
    steadyTips: (p) => `tips (${p} of takings)`, steadyCash: (p) => `the cash share (${p})`, steadyBill: (m) => `the average bill (${m})`,
    firstOfKind: (tipsMoney, tipP, cashP, wd) => `Tips came to ${tipsMoney} (${tipP} of takings) and cash was ${cashP} of takings; there is no earlier ${wd} with takings on record to compare with.`,
    pos: (n, status) => `${en(n, 'bill update')} sent to the till ${n === 1 ? 'was' : 'were'} not delivered${status ? ` (last answer: HTTP ${status})` : ''}; check the POS connection under Integrations in the dashboard.`,
    pending: (p, lang) => `${en(p.count, 'cash request')} (${usd(p.usdCents, lang)}, ${tables(p.tables, lang)}) ${p.count === 1 ? 'was' : 'were'} still waiting for confirmation at the close${p.older ? `, ${intText(p.older, lang)} of ${p.count === 1 ? 'it' : 'them'} from an earlier day` : ''}; check with the floor, then confirm or cancel ${p.count === 1 ? 'it' : 'them'} in the dashboard.`,
    open: (o, lang) => `${en(o.count, 'bill')} ${o.count === 1 ? 'was' : 'were'} still open at the close (${tables(o.tables, lang)}); check whether ${o.count === 1 ? 'it was' : 'they were'} paid, then close ${o.count === 1 ? 'it' : 'them'}.`,
    refund: (r, lang) => `${en(r.count, 'refund')} (${usd(r.usdCents, lang)}) ${r.count === 1 ? 'was' : 'were'} recorded; check ${r.count === 1 ? 'it' : 'each one'} against ${r.count === 1 ? 'its' : 'their'} bill.`,
    rate: (rate, days) => `The lira rate on file (${intText(rate, 'en')}) was last changed ${en(days, 'day')} ago; check it against the rate used at the till.`,
    calm: () => 'Nothing needs checking: no cash request was left waiting, no bill was left open and no refund was recorded.',
    nobody: () => 'No paying guest was recognised from a receipt contact, so there are no return visits to report',
    seen: (n, parts) => `Of the ${en(n, 'guest')} recognised from a receipt contact, ${list(parts, 'en')}`,
    regulars: (n) => `${en(n, 'regular')} (${T.regularVisits} visits or more) came back`,
    lapsed: (n) => `${intText(n, 'en')} came back after ${T.lapsedDays} days or more away`,
    returning: (n) => `${intText(n, 'en')} came back within ${T.lapsedDays} days`,
    first: (n) => `${intText(n, 'en')} came for the first time`,
    second: (n, wd) => `; ${en(n, 'first-time guest')} from last ${wd} who agreed to offers ${n === 1 ? 'is' : 'are'} now in the second-visit audience`
  },
  fr: {
    empty: (wd) => `Rien n'a été enregistré ${wd}${colon('fr')}aucune addition ouverte ni clôturée, aucun paiement reçu.`,
    evening: (wd, d, money) => d.billsClosed
      ? `${cap(wd)}, ${fr(d.billsClosed, 'addition')} ${d.billsClosed === 1 ? 'a été clôturée' : 'ont été clôturées'} et ${money} encaissés, pourboires compris`
      : `${cap(wd)}, aucune addition n'a été clôturée et ${money} ont été encaissés, pourboires compris`,
    vsLast: (wd, change, lastMoney, lastBills) => (change == null
      ? `, au niveau de ${wd} dernier (${lastMoney} pour ${fr(lastBills, 'addition')})`
      : `, en ${change > 0 ? 'hausse' : 'baisse'} de ${pct(Math.abs(change), 'fr')} par rapport à ${wd} dernier (${lastMoney} pour ${fr(lastBills, 'addition')})`),
    lastEmpty: (wd) => `${semi('fr')}${wd} dernier, aucun encaissement n'avait été enregistré`,
    vsTrail: (wd, change, n, avg) => (change == null
      ? `${semi('fr')}c'est du même ordre que la moyenne des ${intText(n, 'fr')} ${wd}s précédents avec des encaissements (${avg})`
      : `${semi('fr')}c'est ${pct(Math.abs(change), 'fr')} ${change > 0 ? 'au-dessus' : 'en dessous'} de la moyenne des ${intText(n, 'fr')} ${wd}s précédents avec des encaissements (${avg})`),
    vs: (b, wd) => (b.kind === 'lastWeek' ? `${wd} dernier` : `en moyenne sur les ${intText(b.days, 'fr')} ${wd}s précédents`),
    near: (b, wd) => (b.kind === 'lastWeek' ? `ceux de ${wd} dernier` : `la moyenne des ${intText(b.days, 'fr')} ${wd}s précédents`),
    tips: (now, money, before, vs) => `Les pourboires ont représenté ${now} des encaissements (${money}), contre ${before} ${vs}.`,
    cash: (now, before, vs) => `Les espèces ont représenté ${now} des encaissements, contre ${before} ${vs}.`,
    bill: (now, before, vs) => `L'addition moyenne était de ${now}, contre ${before} ${vs}.`,
    settle: (now, before, vs) => `Entre la demande et la confirmation, un paiement a pris en médiane ${fr(now, 'minute')}, contre ${fr(before, 'minute')} ${vs}.`,
    steady: (parts, near) => `${cap(list(parts, 'fr'))} ${parts.length === 1 ? 'est resté proche' : 'sont restés proches'} de ${near}.`,
    steadyTips: (p) => `les pourboires (${p} des encaissements)`, steadyCash: (p) => `la part des espèces (${p})`, steadyBill: (m) => `l'addition moyenne (${m})`,
    firstOfKind: (tipsMoney, tipP, cashP, wd) => `Les pourboires ont atteint ${tipsMoney} (${tipP} des encaissements) et les espèces ${cashP} des encaissements${semi('fr')}aucun ${wd} précédent avec des encaissements n'est enregistré pour comparer.`,
    pos: (n, status) => (n === 1
      ? `1 mise à jour d'addition envoyée à la caisse n'a pas été livrée${status ? ` (dernière réponse${colon('fr')}HTTP ${status})` : ''}${semi('fr')}vérifiez la connexion à la caisse dans Intégrations, sur le tableau de bord.`
      : `${intText(n, 'fr')} mises à jour d'addition envoyées à la caisse n'ont pas été livrées${status ? ` (dernière réponse${colon('fr')}HTTP ${status})` : ''}${semi('fr')}vérifiez la connexion à la caisse dans Intégrations, sur le tableau de bord.`),
    pending: (p, lang) => (p.count === 1
      ? `1 demande de paiement en espèces (${usd(p.usdCents, lang)}, ${tables(p.tables, lang)}) attendait encore d'être confirmée à la clôture${p.older ? `, et elle date d'un jour précédent` : ''}${semi('fr')}vérifiez auprès de la salle, puis confirmez-la ou annulez-la dans le tableau de bord.`
      : `${intText(p.count, 'fr')} demandes de paiement en espèces (${usd(p.usdCents, lang)}, ${tables(p.tables, lang)}) attendaient encore d'être confirmées à la clôture${p.older ? `, dont ${intText(p.older, 'fr')} d'un jour précédent` : ''}${semi('fr')}vérifiez auprès de la salle, puis confirmez-les ou annulez-les dans le tableau de bord.`),
    open: (o, lang) => (o.count === 1
      ? `1 addition était encore ouverte à la clôture (${tables(o.tables, lang)})${semi('fr')}vérifiez si elle a été payée, puis clôturez-la.`
      : `${intText(o.count, 'fr')} additions étaient encore ouvertes à la clôture (${tables(o.tables, lang)})${semi('fr')}vérifiez si elles ont été payées, puis clôturez-les.`),
    refund: (r, lang) => (r.count === 1
      ? `1 remboursement (${usd(r.usdCents, lang)}) a été enregistré${semi('fr')}vérifiez-le par rapport à son addition.`
      : `${intText(r.count, 'fr')} remboursements (${usd(r.usdCents, lang)}) ont été enregistrés${semi('fr')}vérifiez chacun par rapport à son addition.`),
    rate: (rate, days) => `Le taux de la livre enregistré (${intText(rate, 'fr')}) a été modifié pour la dernière fois il y a ${fr(days, 'jour')}${semi('fr')}vérifiez-le par rapport au taux utilisé à la caisse.`,
    calm: () => `Rien à vérifier${colon('fr')}aucune demande en espèces n'est restée en attente, aucune addition n'est restée ouverte et aucun remboursement n'a été enregistré.`,
    nobody: () => `Aucun client payant n'a été reconnu grâce à un contact de reçu, il n'y a donc pas de retour à signaler`,
    seen: (n, parts) => `${n === 1 ? '1 client a été reconnu' : `${intText(n, 'fr')} clients ont été reconnus`} grâce à un contact de reçu${colon('fr')}${list(parts, 'fr')}`,
    regulars: (n) => `${fr(n, 'habitué')} (${T.regularVisits} visites ou plus)`,
    lapsed: (n) => `${intText(n, 'fr')} ${n === 1 ? 'revenu' : 'revenus'} après ${T.lapsedDays} jours d'absence ou plus`,
    returning: (n) => `${intText(n, 'fr')} ${n === 1 ? 'revenu' : 'revenus'} en moins de ${T.lapsedDays} jours`,
    first: (n) => `${intText(n, 'fr')} ${n === 1 ? 'venu' : 'venus'} pour la première fois`,
    second: (n, wd) => `${semi('fr')}${n === 1 ? `1 client venu pour la première fois ${wd} dernier et ayant accepté les offres entre` : `${intText(n, 'fr')} clients venus pour la première fois ${wd} dernier et ayant accepté les offres entrent`} maintenant dans le public «${NBSP}deuxième visite${NBSP}»`
  },
  ar: {
    empty: (wd) => `لم يُسجَّل أي نشاط يوم ${wd}: لم تُفتح أي فاتورة ولم تُغلق أي فاتورة، ولم يصل أي دفع.`,
    evening: (wd, d, money) => d.billsClosed
      ? `يوم ${wd}، تم إغلاق ${ar(d.billsClosed, BILLS)} وبلغت المقبوضات ${money}، بما فيها الإكراميات`
      : `يوم ${wd}، لم تُغلق أي فاتورة وبلغت المقبوضات ${money}، بما فيها الإكراميات`,
    vsLast: (wd, change, lastMoney, lastBills) => (change == null
      ? `، أي في مستوى يوم ${wd} الماضي (${lastMoney} من ${ar(lastBills, BILLS)})`
      : `، ${change > 0 ? 'بارتفاع' : 'بانخفاض'} نسبته ${pct(Math.abs(change), 'ar')} عن يوم ${wd} الماضي (${lastMoney} من ${ar(lastBills, BILLS)})`),
    lastEmpty: (wd) => `؛ ولم تُسجَّل أي مقبوضات يوم ${wd} الماضي`,
    vsTrail: (wd, change, n, avg) => (change == null
      ? `؛ وهي في مستوى متوسط أيام ${wd} السابقة التي سُجّلت فيها مقبوضات (عددها ${intText(n, 'ar')}، والمتوسط ${avg})`
      : `؛ وهي ${change > 0 ? 'أعلى' : 'أدنى'} بنسبة ${pct(Math.abs(change), 'ar')} من متوسط أيام ${wd} السابقة التي سُجّلت فيها مقبوضات (عددها ${intText(n, 'ar')}، والمتوسط ${avg})`),
    vs: (b, wd) => (b.kind === 'lastWeek' ? `يوم ${wd} الماضي` : `في متوسط أيام ${wd} السابقة (عددها ${intText(b.days, 'ar')})`),
    near: (b, wd) => (b.kind === 'lastWeek' ? `أرقام يوم ${wd} الماضي` : `متوسط أيام ${wd} السابقة (عددها ${intText(b.days, 'ar')})`),
    tips: (now, money, before, vs) => `شكّلت الإكراميات ${now} من المقبوضات (${money})، مقابل ${before} ${vs}.`,
    cash: (now, before, vs) => `شكّل الدفع النقدي ${now} من المقبوضات، مقابل ${before} ${vs}.`,
    bill: (now, before, vs) => `بلغ متوسط الفاتورة ${now}، مقابل ${before} ${vs}.`,
    settle: (now, before, vs) => `استغرق الدفع من الطلب إلى التأكيد ${ar(now, MINUTES)} في الوسيط، مقابل ${ar(before, MINUTES)} ${vs}.`,
    steady: (parts, near) => `بقيت ${list(parts, 'ar')} قريبة من ${near}.`,
    steadyTips: (p) => `الإكراميات (${p} من المقبوضات)`, steadyCash: (p) => `حصة الدفع النقدي (${p})`, steadyBill: (m) => `متوسط الفاتورة (${m})`,
    firstOfKind: (tipsMoney, tipP, cashP, wd) => `بلغت الإكراميات ${tipsMoney} (${tipP} من المقبوضات) وشكّل الدفع النقدي ${cashP} من المقبوضات؛ ولا يوجد يوم ${wd} سابق سُجّلت فيه مقبوضات للمقارنة.`,
    pos: (n, status) => `تعذّر إيصال ${ar(n, UPDATES)} للفواتير إلى نظام الصندوق${status ? ` (آخر ردّ: HTTP ${status})` : ''}؛ يُرجى التحقق من ربط نظام الصندوق في قسم التكاملات في لوحة التحكم.`,
    pending: (p, lang) => `عند الإقفال، كان عدد طلبات الدفع النقدي التي لم تُؤكَّد بعد ${intText(p.count, 'ar')} (${usd(p.usdCents, lang)}، ${tables(p.tables, lang)})${p.older ? `، منها ${intText(p.older, 'ar')} من يوم سابق` : ''}؛ يُرجى التحقق مع فريق الصالة ثم ${p.count === 1 ? 'تأكيده أو إلغاؤه' : 'تأكيدها أو إلغاؤها'} من لوحة التحكم.`,
    open: (o, lang) => `عند الإقفال، كان عدد الفواتير التي ما زالت مفتوحة ${intText(o.count, 'ar')} (${tables(o.tables, lang)})؛ يُرجى التحقق مما إذا كانت قد دُفعت ثم إغلاقها.`,
    refund: (r, lang) => `تم تسجيل ${ar(r.count, REFUNDS)} بقيمة ${usd(r.usdCents, lang)}؛ يُرجى ${r.count === 1 ? 'مطابقتها مع فاتورتها' : 'مطابقة كل منها مع فاتورتها'}.`,
    rate: (rate, days) => `آخر تعديل لسعر صرف الليرة المسجّل (${intText(rate, 'ar')}) كان قبل ${ar(days, DAYS)}؛ يُرجى مطابقته مع السعر المعتمد على الصندوق.`,
    calm: () => 'لا شيء يستدعي التحقق: لم يبقَ أي طلب دفع نقدي معلّقاً، ولم تبقَ أي فاتورة مفتوحة، ولم تُسجَّل أي عملية استرداد.',
    nobody: () => 'لم يُتعرَّف على أي زبون دافع من خلال جهة الاتصال المسجّلة للإيصال، لذا لا توجد زيارات عائدة للإبلاغ عنها',
    seen: (n, parts) => `تم التعرّف على ${intText(n, 'ar')} من الزبائن الدافعين من خلال جهة الاتصال المسجّلة للإيصال، منهم: ${parts.join('، ')}`,
    regulars: (n) => `الزبائن الدائمون (${T.regularVisits} زيارات أو أكثر): ${intText(n, 'ar')}`,
    lapsed: (n) => `العائدون بعد غياب ${T.lapsedDays} يوماً أو أكثر: ${intText(n, 'ar')}`,
    returning: (n) => `العائدون خلال أقل من ${T.lapsedDays} يوماً: ${intText(n, 'ar')}`,
    first: (n) => `القادمون للمرة الأولى: ${intText(n, 'ar')}`,
    second: (n, wd) => `؛ وانضم ${intText(n, 'ar')} من زبائن يوم ${wd} الماضي الجدد الذين وافقوا على تلقي العروض إلى جمهور الزيارة الثانية`
  }
};
const BILLS = ['فاتورة واحدة', 'فاتورتين', 'فواتير', 'فاتورة'];
const MINUTES = ['دقيقة واحدة', 'دقيقتين', 'دقائق', 'دقيقة'];
const UPDATES = ['تحديث واحد', 'تحديثين', 'تحديثات', 'تحديثاً'];
const REFUNDS = ['عملية استرداد واحدة', 'عمليتي استرداد', 'عمليات استرداد', 'عملية استرداد'];
const DAYS = ['يوم واحد', 'يومين', 'أيام', 'يوماً'];

/* percent change from b to a, rounded; null when under the "in line" threshold */
function change(a, b, threshold) {
  if (!(b > 0)) return undefined;
  const c = Math.round(((a - b) / b) * 100);
  return Math.abs(c) < threshold ? null : c;
}

/* ---------------------------------------------------------------- the rules */

export function closeNarrative(input) {
  const o = input || {};
  const lang = o.lang === 'fr' || o.lang === 'ar' ? o.lang : 'en';
  const currency = String(o.currency || 'USD').toUpperCase() === 'LBP' ? 'LBP' : 'USD';
  const w = W[lang];
  const today = toDay(o.today) || { empty: true };
  const lastWeek = toDay(o.lastWeek);
  const trailing = (o.trailing || []).map(toDay).filter(Boolean);
  const wi = weekdayIndex(o.day || today.day);
  const wd = wi == null ? '' : WEEKDAYS[lang][wi];
  const out = (sentences) => ({ lang, dir: lang === 'ar' ? 'rtl' : 'ltr', sentences, text: sentences.map((s) => s.text).join(' ') });

  // empty day: one line
  if (today.empty) return out([{ rule: 'empty', text: w.empty(wd) }]);

  /* 1. what the evening was */
  let s1 = w.evening(wd, today, takingsText(today, lang, currency));
  if (active(lastWeek)) {
    const c = change(today.takingsCents, lastWeek.takingsCents, T.takingsChangePct);
    s1 += w.vsLast(wd, c, takingsText(lastWeek, lang, currency, true, today.rate), lastWeek.billsClosed);
  } else if (lastWeek) {
    s1 += w.lastEmpty(wd);
  }
  const trail = trailingAverage(trailing);
  if (trail) {
    const c = change(today.takingsCents, trail.takingsCents, T.takingsChangePct);
    if (c !== undefined) s1 += w.vsTrail(wd, c, trail.days, takingsText({ takingsCents: trail.takingsCents }, lang, currency, true, today.rate));
  }
  const evening = { rule: 'evening', text: s1 + '.' };

  /* 3. what to look at (computed before 2 because it has priority for the sentence budget) */
  const look = [];
  if (today.pos && today.pos.count > 0) look.push({ rule: 'look.pos', text: w.pos(today.pos.count, today.pos.lastStatus) });
  if (today.pendingCash && today.pendingCash.count > 0) look.push({ rule: 'look.pendingCash', text: w.pending(today.pendingCash, lang) });
  if (today.stillOpen && today.stillOpen.count > 0) look.push({ rule: 'look.openBills', text: w.open(today.stillOpen, lang) });
  if (today.refunds && today.refunds.count > 0) look.push({ rule: 'look.refunds', text: w.refund(today.refunds, lang) });
  if (today.rate && today.rateAgeDays != null && today.rateAgeDays >= T.staleRateDays) look.push({ rule: 'look.staleRate', text: w.rate(today.rate, today.rateAgeDays) });

  /* 4. who came back */
  let back = null;
  const r = today.returns;
  if (r) {
    let t;
    if (!r.seen) t = w.nobody();
    else {
      const parts = [];
      if (r.regulars) parts.push(w.regulars(r.regulars));
      if (r.lapsed) parts.push(w.lapsed(r.lapsed));
      if (r.returning) parts.push(w.returning(r.returning));
      if (r.first) parts.push(w.first(r.first));
      t = w.seen(r.seen, parts);
    }
    if (r.secondVisit) t += w.second(r.secondVisit, wd);
    back = { rule: r.seen ? 'back.seen' : 'back.none', text: t + '.' };
  }

  /* the sentence budget: the evening, the checks, who came back, then what moved */
  let room = T.maxSentences - 1 - (back ? 1 : 0);
  if (look.length > room) {
    const keep = look.slice(0, room - 1), rest = look.slice(room - 1);
    const merged = rest.map((x, i) => (i === 0 ? x.text : lang === 'ar' ? x.text : low(x.text)).replace(/\.$/, '')).join(semi(lang)) + '.';
    look.length = 0; look.push(...keep, { rule: rest.map((x) => x.rule).join('+'), text: merged });
  }
  if (!look.length && room > 1) look.push({ rule: 'look.none', text: w.calm() });
  room -= look.length;

  /* 2. what moved */
  const moved = [];
  if (room > 0 && today.takingsCents > 0) {
    const b = baselineOf(lastWeek, trailing);
    const tipNow = share(today.tipsCents, today.takingsCents), cashNow = share(today.cashCents, today.takingsCents);
    if (!b) {
      moved.push({ rule: 'moved.noBaseline', text: w.firstOfKind(usd(today.tipsCents, lang), pct(tipNow, lang), pct(cashNow, lang), wd) });
    } else {
      const vs = w.vs(b, wd), cands = [];
      if (b.tipRate != null) {
        const d = Math.round(tipNow) - Math.round(b.tipRate);
        if (Math.abs(d) >= T.tipRatePoints) cands.push({ score: Math.abs(d) / T.tipRatePoints, rule: 'moved.tips', text: w.tips(pct(tipNow, lang), usd(today.tipsCents, lang), pct(b.tipRate, lang), vs) });
      }
      if (b.cashShare != null) {
        const d = Math.round(cashNow) - Math.round(b.cashShare);
        if (Math.abs(d) >= T.cashSharePoints) cands.push({ score: Math.abs(d) / T.cashSharePoints, rule: 'moved.cashShare', text: w.cash(pct(cashNow, lang), pct(b.cashShare, lang), vs) });
      }
      const billsOk = today.averageBillCents != null && b.averageBillCents != null && today.averageBillCount >= T.averageBillMinBills && b.averageBillCount >= T.averageBillMinBills;
      if (billsOk) {
        const c = Math.round(((today.averageBillCents - b.averageBillCents) / b.averageBillCents) * 100);
        if (Math.abs(c) >= T.averageBillPct) cands.push({ score: Math.abs(c) / T.averageBillPct, rule: 'moved.averageBill', text: w.bill(usd(today.averageBillCents, lang), usd(b.averageBillCents, lang), vs) });
      }
      const timedOk = today.settleMinutes != null && b.settleMinutes != null && today.settleCount >= T.settleMinPayments && b.settleCount >= T.settleMinPayments && b.settleMinutes > 0;
      if (timedOk) {
        const d = Math.round(today.settleMinutes) - Math.round(b.settleMinutes);
        if (Math.abs(d) >= T.settleMinutes && Math.abs(d) / b.settleMinutes * 100 >= T.settlePct) cands.push({ score: Math.abs(d) / T.settleMinutes, rule: 'moved.settleTime', text: w.settle(Math.round(today.settleMinutes), Math.round(b.settleMinutes), vs) });
      }
      cands.sort((x, y) => y.score - x.score);
      if (cands.length) moved.push(...cands.slice(0, Math.min(T.maxMoved, room)).map((c) => ({ rule: c.rule, text: c.text })));
      else {
        const parts = [w.steadyTips(pct(tipNow, lang)), w.steadyCash(pct(cashNow, lang))];
        if (billsOk) parts.push(w.steadyBill(usd(today.averageBillCents, lang)));
        moved.push({ rule: 'moved.steady', text: w.steady(parts, w.near(b, wd)) });
      }
    }
  }

  return out([evening, ...moved, ...look, ...(back ? [back] : [])]);
}

/* ------------------------------------------------------- the numeric check */

/* Every number in a text, as numbers: Arabic-Indic digits read as 0-9, thousands
   separators dropped, the decimal mark of the language read as a point. */
export function numbersIn(text, lang) {
  let s = String(text == null ? '' : text)
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, '.').replace(/٬/g, ',');
  if (lang === 'fr') s = s.replace(/(\d)[   .](?=\d{3}(?!\d))/g, '$1').replace(/(\d),(\d)/g, '$1.$2');
  else s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  return (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
}
export function sameNumbers(a, b, lang) {
  const x = numbersIn(a, lang).sort((p, q) => p - q), y = numbersIn(b, lang).sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
