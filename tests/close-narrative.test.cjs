/* The morning close, in words (T4): supabase/functions/_shared/close-narrative.js (the rules),
   _shared/close-narrative-model.js (the optional model rewrite, against a stubbed fetch),
   the facts and the input daily-close/handler.js computes for it, the email with the narrative
   on top, and tools/close-preview.js. Proves every rule and threshold in
   docs/close-narrative.md at its boundary, the three languages, the comparable-day logic, the
   empty day, the numeric check of the model path, and the email composition (CSV unchanged). */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const N = () => import(pathToFileURL(path.join(root, 'supabase/functions/_shared/close-narrative.js')).href);
const M = () => import(pathToFileURL(path.join(root, 'supabase/functions/_shared/close-narrative-model.js')).href);
let handler;
const H = () => handler || (handler = (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-narrative-')), file = path.join(dir, 'handler.mjs');
  fs.copyFileSync(path.join(root, 'supabase/functions/daily-close/handler.js'), file); return import(pathToFileURL(file).href);
})());
const { demoRows, venueData, RID } = require('../tools/lib/close-demo.js');
const DASH = /[\u2014]/;
const DAY = '2026-10-27';   // a Tuesday

/* A Day as toDay returns it; every field the rules read, with a quiet default. */
function day(o) {
  return Object.assign({
    day: DAY, empty: false, billsOpened: 20, billsClosed: 20, takingsCents: 100000, tipsCents: 8000, cashCents: 35000, rate: 89500,
    averageBillCents: 5000, averageBillCount: 20, settleMinutes: 5, settleCount: 20,
    pendingCash: { count: 0, usdCents: 0, tables: [], older: 0 }, stillOpen: { count: 0, tables: [] }, refunds: { count: 0, usdCents: 0 },
    rateAgeDays: 2, pos: { count: 0, lastStatus: null }, returns: null
  }, o);
}
const base = (o) => day(Object.assign({ day: '2026-10-20' }, o));
const rules = (n) => n.sentences.map((s) => s.rule);
const say = async (today, lastWeek, trailing, extra) => (await N()).closeNarrative(Object.assign({ lang: 'en', day: DAY, today, lastWeek, trailing: trailing || (lastWeek ? [lastWeek] : []) }, extra));

/* ---------------------------------------------------------- 1. the evening */
test('the evening: bills, takings and the same weekday last week, with the 10% in-line threshold', async () => {
  let n = await say(day({ takingsCents: 109000 }), base({ takingsCents: 100000, billsClosed: 18 }));
  assert.equal(n.sentences[0].rule, 'evening');
  assert.equal(n.sentences[0].text, 'On Tuesday, 20 bills were closed and $1,090.00 was taken, tips included, in line with last Tuesday ($1,000.00 from 18 bills).');
  n = await say(day({ takingsCents: 110000 }), base({ takingsCents: 100000 }));
  assert.match(n.sentences[0].text, /, up 10% on last Tuesday \(\$1,000\.00 from 20 bills\)\.$/);
  n = await say(day({ takingsCents: 90000 }), base({ takingsCents: 100000 }));
  assert.match(n.sentences[0].text, /, down 10% on last Tuesday/);
  n = await say(day({ takingsCents: 91000, billsClosed: 1 }), base({ takingsCents: 100000 }));
  assert.match(n.sentences[0].text, /^On Tuesday, 1 bill was closed and \$910\.00 was taken, tips included, in line/);
  n = await say(day({ billsClosed: 0 }), null);
  assert.match(n.sentences[0].text, /^On Tuesday, no bill was closed and \$1,000\.00 was taken/);
});
test('the comparable days: last week with no takings is said; the trailing average needs 2 weekdays with takings', async () => {
  const quiet = base({ takingsCents: 0, billsClosed: 0 });
  let n = await say(day(), quiet, [quiet, null, base({ day: '2026-10-06', takingsCents: 50000 }), null]);
  assert.equal(n.sentences[0].text, 'On Tuesday, 20 bills were closed and $1,000.00 was taken, tips included; last Tuesday had no takings on record.');
  n = await say(day(), quiet, [quiet, base({ day: '2026-10-13', takingsCents: 50000 }), base({ day: '2026-10-06', takingsCents: 70000 }), null]);
  assert.match(n.sentences[0].text, /; that is 67% above the average of the previous 2 Tuesdays with takings \(\$600\.00\)\.$/);
  n = await say(day({ takingsCents: 63000 }), null, [null, base({ takingsCents: 60000 }), base({ takingsCents: 60000 })]);
  assert.match(n.sentences[0].text, /in line with the average of the previous 2 Tuesdays with takings \(\$600\.00\)/);
  const N2 = await N();
  assert.equal(N2.trailingAverage([base({}), null]), null);
  assert.equal(N2.baselineOf(quiet, [quiet, base({})]), null);
  assert.equal(N2.baselineOf(base({}), []).kind, 'lastWeek');
  const t = N2.trailingAverage([base({ takingsCents: 100000, tipsCents: 10000, cashCents: 20000, averageBillCents: 4000, averageBillCount: 10, settleMinutes: 4, settleCount: 5 }),
    base({ takingsCents: 300000, tipsCents: 10000, cashCents: 60000, averageBillCents: 6000, averageBillCount: 30, settleMinutes: 8, settleCount: 4 })]);
  assert.deepEqual(t, { days: 2, takingsCents: 200000, tipRate: 5, cashShare: 20, averageBillCents: 5500, averageBillCount: 10, settleMinutes: 6, settleCount: 4 });
});
test('takings in lira when the venue keeps LBP and a rate is on file; comparisons in lira alone', async () => {
  const n = await say(day({ takingsCents: 120000 }), base({ takingsCents: 100000, rate: 89000 }), null, { currency: 'LBP' });
  assert.match(n.sentences[0].text, /and LL 107,400,000 \(\$1,200\.00\) was taken, tips included, up 20% on last Tuesday \(LL 89,000,000 from 20 bills\)/);
  const noRate = await say(day({ rate: null }), null, [], { currency: 'LBP' });
  assert.match(noRate.sentences[0].text, /and \$1,000\.00 was taken/);
});

/* ---------------------------------------------------------- 2. what moved */
test('what moved: each threshold at its boundary', async () => {
  const lw = base({});   // 8% tips, 35% cash, $50.00 average, 5 minutes
  const moved = async (o, l) => (await say(day(o), l || lw)).sentences.filter((s) => s.rule.startsWith('moved.')).map((s) => s.rule);
  assert.deepEqual(await moved({ tipsCents: 10000 }), ['moved.steady']);          // 10% vs 8%: 2 points
  assert.deepEqual(await moved({ tipsCents: 11000 }), ['moved.tips']);            // 3 points
  assert.deepEqual(await moved({ cashCents: 44000 }), ['moved.steady']);          // 9 points
  assert.deepEqual(await moved({ cashCents: 45000 }), ['moved.cashShare']);       // 10 points
  assert.deepEqual(await moved({ averageBillCents: 5700 }), ['moved.steady']);    // 14%
  assert.deepEqual(await moved({ averageBillCents: 5750 }), ['moved.averageBill']); // 15%
  assert.deepEqual(await moved({ averageBillCents: 5750, averageBillCount: 2 }), ['moved.steady']);   // too few bills
  assert.deepEqual(await moved({ averageBillCents: 5750 }, base({ averageBillCount: 2 })), ['moved.steady']);
  assert.deepEqual(await moved({ settleMinutes: 6 }), ['moved.steady']);          // 1 minute
  assert.deepEqual(await moved({ settleMinutes: 7 }), ['moved.settleTime']);      // 2 minutes, 40%
  assert.deepEqual(await moved({ settleMinutes: 22 }, base({ settleMinutes: 20 })), ['moved.steady']);   // 2 minutes but 10%
  assert.deepEqual(await moved({ settleMinutes: 7, settleCount: 2 }), ['moved.steady']);   // too few timed payments
  // ranked by how many thresholds they moved, at most 2
  assert.deepEqual(await moved({ tipsCents: 14000, cashCents: 55000, averageBillCents: 9000 }), ['moved.averageBill', 'moved.tips']);   // 80%/15 > 6/3 > 20/10
  const n = await say(day({ tipsCents: 11000 }), lw);
  assert.equal(n.sentences[1].text, 'Tips were 11% of takings ($110.00), against 8% last Tuesday.');
  const s = await say(day({ settleMinutes: 9 }), lw);
  assert.equal(s.sentences[1].text, 'Payments took a median of 9 minutes from request to confirmation, against 5 minutes last Tuesday.');
  const c = await say(day({ cashCents: 60000 }), lw);
  assert.equal(c.sentences[1].text, 'Cash was 60% of takings, against 35% last Tuesday.');
  const steady = await say(day(), lw);
  assert.equal(steady.sentences[1].text, 'Tips (8% of takings), the cash share (35%) and the average bill ($50.00) were close to last Tuesday.');
});
test('what moved: against the trailing average when last week had no takings; no baseline; no takings', async () => {
  const quiet = base({ takingsCents: 0 });
  const n = await say(day({ tipsCents: 12000 }), quiet, [quiet, base({}), base({})]);
  assert.equal(n.sentences[1].text, 'Tips were 12% of takings ($120.00), against 8% on average over the previous 2 Tuesdays.');
  const first = await say(day(), null, []);
  assert.deepEqual(rules(first).slice(0, 2), ['evening', 'moved.noBaseline']);
  assert.equal(first.sentences[1].text, 'Tips came to $80.00 (8% of takings) and cash was 35% of takings; there is no earlier Tuesday with takings on record to compare with.');
  const none = await say(day({ takingsCents: 0, tipsCents: 0, cashCents: 0 }), base({}));
  assert.ok(!rules(none).some((r) => r.startsWith('moved.')));
});

/* ---------------------------------------------------------- 3. what to look at */
test('what to look at: every check, its wording and what it asks, in priority order', async () => {
  const n = await say(day({
    pos: { count: 2, lastStatus: 502 },
    pendingCash: { count: 2, usdCents: 2800, tables: ['6', '9'], older: 1 },
    stillOpen: { count: 1, tables: ['12'] }
  }), base({}));
  assert.deepEqual(rules(n), ['evening', 'moved.steady', 'look.pos', 'look.pendingCash', 'look.openBills']);
  assert.equal(n.sentences[2].text, '2 bill updates sent to the till were not delivered (last answer: HTTP 502); check the POS connection under Integrations in the dashboard.');
  assert.equal(n.sentences[3].text, '2 cash requests ($28.00, tables 6, 9) were still waiting for confirmation at the close, 1 of them from an earlier day; check with the floor, then confirm or cancel them in the dashboard.');
  assert.equal(n.sentences[4].text, '1 bill was still open at the close (table 12); check whether it was paid, then close it.');
  const r = await say(day({ refunds: { count: 1, usdCents: 1200 }, rateAgeDays: 14 }), base({}));
  assert.deepEqual(rules(r).slice(2), ['look.refunds', 'look.staleRate']);
  assert.equal(r.sentences[2].text, '1 refund ($12.00) was recorded; check it against its bill.');
  assert.equal(r.sentences[3].text, 'The lira rate on file (89,500) was last changed 14 days ago; check it against the rate used at the till.');
  assert.ok(!rules(await say(day({ rateAgeDays: 13 }), base({}))).includes('look.staleRate'));
  assert.ok(!rules(await say(day({ rateAgeDays: 40, rate: null }), base({}))).includes('look.staleRate'));
  assert.ok(!rules(await say(day({ pos: null }), base({}))).includes('look.pos'));   // unknown is not a failure
  const calm = await say(day(), base({}));
  assert.equal(calm.sentences[2].text, 'Nothing needs checking: no cash request was left waiting, no bill was left open and no refund was recorded.');
});
test('the sentence budget: never more than 6, checks before what moved, the last checks joined into one sentence', async () => {
  const busy = day({
    tipsCents: 15000,
    pos: { count: 1, lastStatus: null }, pendingCash: { count: 1, usdCents: 900, tables: ['3'], older: 0 },
    stillOpen: { count: 2, tables: ['4', '5'] }, refunds: { count: 2, usdCents: 3000 }, rateAgeDays: 30,
    returns: { seen: 0, first: 0, returning: 0, regulars: 0, lapsed: 0, secondVisit: 0 }
  });
  const n = await say(busy, base({}));
  assert.equal(n.sentences.length, 6);
  assert.deepEqual(rules(n), ['evening', 'look.pos', 'look.pendingCash', 'look.openBills', 'look.refunds+look.staleRate', 'back.none']);
  assert.equal(n.sentences[4].text, '2 refunds ($30.00) were recorded; check each one against their bill; the lira rate on file (89,500) was last changed 30 days ago; check it against the rate used at the till.');
  for (const lang of ['en', 'fr', 'ar']) {
    const x = await say(busy, base({}), null, { lang });
    assert.ok(x.sentences.length >= 3 && x.sentences.length <= 6, lang);
    assert.doesNotMatch(x.text, DASH);
  }
  // with room left, what moved fills it up to 2
  const room = await say(day({ tipsCents: 15000, cashCents: 60000, stillOpen: { count: 1, tables: ['4'] } }), base({}));
  assert.deepEqual(rules(room), ['evening', 'moved.cashShare', 'moved.tips', 'look.openBills']);   // 25 points / 10 ranks above 7 points / 3
});

/* ---------------------------------------------------------- 4. who came back */
test('who came back: counts only, every category, the second-visit audience, nobody recognised', async () => {
  const r = (o) => day({ returns: Object.assign({ seen: 0, first: 0, returning: 0, regulars: 0, lapsed: 0, secondVisit: 0 }, o) });
  let n = await say(r({ seen: 6, regulars: 2, lapsed: 1, returning: 1, first: 2, secondVisit: 3 }), base({}));
  const back = n.sentences[n.sentences.length - 1];
  assert.equal(back.rule, 'back.seen');
  assert.equal(back.text, 'Of the 6 guests recognised from a receipt contact, 2 regulars (3 visits or more) came back, 1 came back after 30 days or more away, 1 came back within 30 days and 2 came for the first time; 3 first-time guests from last Tuesday who agreed to offers are now in the second-visit audience.');
  n = await say(r({}), base({}));
  assert.equal(n.sentences[n.sentences.length - 1].text, 'No paying guest was recognised from a receipt contact, so there are no return visits to report.');
  n = await say(r({ secondVisit: 1 }), base({}));
  assert.match(n.sentences[n.sentences.length - 1].text, /; 1 first-time guest from last Tuesday who agreed to offers is now in the second-visit audience\.$/);
  n = await say(day({ returns: null }), base({}));
  assert.ok(!rules(n).some((x) => x.startsWith('back.')));
  assert.doesNotMatch(JSON.stringify(n), /@|\+961/);
});

/* ---------------------------------------------------------- empty day */
test('an empty day is one line, in each language', async () => {
  const N2 = await N();
  const e = { empty: true };
  const en = N2.closeNarrative({ lang: 'en', day: DAY, today: e, lastWeek: base({}), trailing: [base({})] });
  assert.deepEqual(rules(en), ['empty']);
  assert.equal(en.text, 'Nothing was recorded on Tuesday: no bill was opened or closed and no payment came in.');
  assert.equal(N2.closeNarrative({ lang: 'fr', day: DAY, today: e }).text, "Rien n'a été enregistré mardi : aucune addition ouverte ni clôturée, aucun paiement reçu.");
  const ar = N2.closeNarrative({ lang: 'ar', day: DAY, today: e });
  assert.equal(ar.text, 'لم يُسجَّل أي نشاط يوم الثلاثاء: لم تُفتح أي فاتورة ولم تُغلق أي فاتورة، ولم يصل أي دفع.');
  assert.equal(ar.dir, 'rtl');
  // toDay: no bill opened or closed and no payment record of any kind
  assert.equal(N2.toDay({ figures: { day: DAY, bills: { opened: 0, closed: 0 }, csvRows: [] }, facts: {} }).empty, true);
  assert.equal(N2.toDay({ figures: { day: DAY, bills: { opened: 0, closed: 0 }, csvRows: [{}] }, facts: {} }).empty, false);
});

/* ---------------------------------------------------------- languages */
test('French and Arabic: the same rules, the same numbers, their own typography and grammar', async () => {
  const N2 = await N();
  const today = day({ takingsCents: 123456, tipsCents: 15000, billsClosed: 2, averageBillCount: 2, pendingCash: { count: 3, usdCents: 4500, tables: ['6', '9', '12'], older: 0 }, rateAgeDays: 21,
    returns: { seen: 3, first: 1, returning: 0, regulars: 2, lapsed: 0, secondVisit: 0 } });
  const lw = base({ takingsCents: 100000 });
  const en = N2.closeNarrative({ lang: 'en', day: DAY, today, lastWeek: lw, trailing: [lw] });
  const fr = N2.closeNarrative({ lang: 'fr', day: DAY, today, lastWeek: lw, trailing: [lw] });
  const ar = N2.closeNarrative({ lang: 'ar', day: DAY, today, lastWeek: lw, trailing: [lw] });
  assert.deepEqual(rules(fr), rules(en)); assert.deepEqual(rules(ar), rules(en));
  const sorted = (t, l) => N2.numbersIn(t, l).sort((a, b) => a - b);
  assert.deepEqual(sorted(fr.text, 'fr'), sorted(en.text, 'en'));
  assert.match(fr.text, /^Mardi, 2 additions ont été clôturées et 1 234,56 \$ encaissés, pourboires compris, en hausse de 23 % par rapport à mardi dernier \(1 000,00 \$ pour 20 additions\)\./);
  assert.match(fr.text, /3 demandes de paiement en espèces \(45,00 \$, tables 6, 9, 12\) attendaient encore d'être confirmées à la clôture ; vérifiez auprès de la salle, puis confirmez-les ou annulez-les/);
  assert.match(fr.text, /Le taux de la livre enregistré \(89 500\) a été modifié pour la dernière fois il y a 21 jours/);
  assert.match(fr.text, /3 clients ont été reconnus grâce à un contact de reçu : 2 habitués \(3 visites ou plus\) et 1 venu pour la première fois\./);
  assert.equal(ar.dir, 'rtl'); assert.equal(fr.dir, 'ltr');
  assert.match(ar.text, /^يوم الثلاثاء، تم إغلاق فاتورتين وبلغت المقبوضات 1,234\.56 دولار، بما فيها الإكراميات، بارتفاع نسبته 23% عن يوم الثلاثاء الماضي \(1,000\.00 دولار من 20 فاتورة\)\./);
  assert.match(ar.text, /عند الإقفال، كان عدد طلبات الدفع النقدي التي لم تُؤكَّد بعد 3 \(45\.00 دولار، الطاولات 6، 9، 12\)؛ يُرجى التحقق مع فريق الصالة ثم تأكيدها أو إلغاؤها من لوحة التحكم\./);
  assert.match(ar.text, /كان قبل 21 يوماً/);
  assert.match(ar.text, /منهم: الزبائن الدائمون \(3 زيارات أو أكثر\): 2، القادمون للمرة الأولى: 1\./);
  // Arabic counted nouns: 1 and 2 as words, 3 to 10 plural, 11 and up singular
  const bills = (k) => N2.closeNarrative({ lang: 'ar', day: DAY, today: day({ billsClosed: k }) }).sentences[0].text.split('وبلغت')[0];
  assert.match(bills(1), /فاتورة واحدة $/); assert.match(bills(2), /فاتورتين $/); assert.match(bills(3), /3 فواتير $/); assert.match(bills(10), /10 فواتير $/);
  assert.match(bills(11), /11 فاتورة $/); assert.match(bills(103), /103 فواتير $/); assert.match(bills(100), /100 فاتورة $/);
  for (const t of [en.text, fr.text, ar.text]) assert.doesNotMatch(t, DASH);
  assert.equal(N2.closeNarrative({ lang: 'de', day: DAY, today: day() }).lang, 'en');
});
test('the numeric check reads each language\'s notation and Arabic-Indic digits', async () => {
  const N2 = await N();
  assert.deepEqual(N2.numbersIn('On Tuesday, 20 bills and $1,234.50, up 23% (tables 6, 9, 12); LL 4,117,000.', 'en'), [20, 1234.5, 23, 6, 9, 12, 4117000]);
  assert.deepEqual(N2.numbersIn('1 234,50 $ et 4 117 000 LL, 23 %, tables 6, 9', 'fr'), [1234.5, 4117000, 23, 6, 9]);
  assert.deepEqual(N2.numbersIn('١٬٢٣٤٫٥٠ دولار و23%', 'ar'), [1234.5, 23]);
  assert.equal(N2.sameNumbers('20 bills, $1,234.50', 'Twenty... no: 20 bills and $1,234.50 in all', 'en'), true);
  assert.equal(N2.sameNumbers('20 bills, $1,234.50', '20 bills, $1,234.51', 'en'), false);
  assert.equal(N2.sameNumbers('20 bills, $1,234.50', '20 bills', 'en'), false);
  assert.equal(N2.sameNumbers('20 bills', '20 bills, 2 tables', 'en'), false);
  assert.equal(N2.sameNumbers('بلغت 1,234.50 دولار من 20 فاتورة', 'بلغت المقبوضات ١٬٢٣٤٫٥٠ دولار من ٢٠ فاتورة', 'ar'), true);
});

/* ---------------------------------------------------------- the handler's facts */
const iso = (ms) => new Date(ms).toISOString(), MIN = 60000, DMS = 86400000;
test('computeFacts: average bill, median settlement time, cash waiting 10 minutes, rate age, POS failures', async () => {
  const m = await H(), w = m.windowFor(DAY), at = (h) => iso(w.start + h * 3600000);
  const checks = [
    { id: 'a', body: { id: 'a', table: 1, openedAt: at(15), closedAt: at(16), totalCents: 3000 } },
    { id: 'b', body: { id: 'b', table: 2, openedAt: at(15), closedAt: at(17), totalCents: 5000 } },
    { id: 'c', body: { id: 'c', table: 3, openedAt: at(15), closedAt: at(17) } }   // no total: not in the average
  ];
  const pay = (id, o) => ({ id, body: Object.assign({ id, currency: 'USD', status: 'confirmed', tip: 0 }, o) });
  const settles = [
    pay('p1', { rail: 'card', amount: 30, amountUsd: 30, ts: at(16), confirmedAt: iso(w.start + 16 * 3600000 + 2 * MIN) }),
    pay('p2', { rail: 'cash', amount: 50, amountUsd: 50, ts: at(17), confirmedAt: iso(w.start + 17 * 3600000 + 6 * MIN) }),
    pay('p3', { rail: 'whish', amount: 5, amountUsd: 5, ts: at(18), confirmedAt: iso(w.start + 18 * 3600000 + 9 * MIN) }),
    pay('p4', { rail: 'pos', amount: 5, amountUsd: 5, ts: at(18), confirmedAt: iso(w.start + 18 * 3600000 + 60 * MIN) }),   // the till: not timed
    pay('q1', { rail: 'cash', table: 7, amount: 12, amountUsd: 12, status: 'pending', ts: iso(w.end - 10 * MIN) }),          // waited exactly 10 minutes
    pay('q2', { rail: 'cash', table: 8, amount: 4, amountUsd: 4, status: 'pending', ts: iso(w.end - 9 * MIN) }),             // not yet
    pay('q3', { rail: 'cash', table: 2, amount: 6, amountUsd: 6, status: 'pending', ts: iso(w.start - DMS) })               // from the day before
  ];
  const docs = [{ key: 'aal.rate', body: 89500 }, { key: 'aal.rate_meta', body: { updatedAt: iso(w.end - 14 * DMS - 1) } }];
  const deliveries = [
    { created_at: at(17), attempts: 2, last_status: 500, delivered_at: null },
    { created_at: at(18), attempts: 1, last_status: 502, delivered_at: iso(w.end + 3600000) },   // delivered after the close
    { created_at: at(18), attempts: 1, last_status: 200, delivered_at: at(18) },
    { created_at: at(18), attempts: 0, last_status: null, delivered_at: null },                 // not tried yet
    { created_at: iso(w.start - 1), attempts: 5, last_status: 500, delivered_at: null }          // another day
  ];
  const f = m.computeFacts({ window: w, checks, settles, guests: [], docs, deliveries });
  assert.equal(f.averageBillCents, 4000); assert.equal(f.averageBillCount, 2);
  assert.equal(f.settleMinutes, 6); assert.equal(f.settleCount, 3);
  assert.deepEqual(f.pendingCash, { count: 2, usdCents: 1800, tables: ['2', '7'], older: 1 });
  assert.equal(f.rateAgeDays, 14);
  assert.deepEqual(f.pos, { count: 2, lastStatus: 502 });
  assert.equal(f.returns, null);
  const unknown = m.computeFacts({ window: w, checks: [], settles: [], guests: [], docs: [{ key: 'aal.rate', body: 89500 }], deliveries: null });
  assert.equal(unknown.pos, null); assert.equal(unknown.rateAgeDays, null); assert.equal(unknown.settleMinutes, null); assert.equal(unknown.averageBillCents, null);
});
test('computeReturns: first, returning, regular and lapsed visits, and the guests who entered the second-visit audience', async () => {
  const m = await H(), w = m.windowFor(DAY), t = (daysBefore, h = 18) => iso(w.start + h * 3600000 - daysBefore * DMS);
  let n = 0;
  const visit = (g, when, o) => { const id = 's' + (++n); return { id, body: Object.assign({ id, checkId: 'k' + n, customerId: g, rail: 'card', amount: 10, amountUsd: 10, currency: 'USD', status: 'confirmed', ts: when, confirmedAt: when }, o) }; };
  const guest = (id, marketing, at) => ({ id, body: { id, consentHistory: [{ at: at || t(40), source: 'receipt', receipt: true, marketing }] } });
  const settles = [
    visit('first', t(0)),
    visit('back', t(10)), visit('back', t(0)),
    visit('reg', t(20)), visit('reg', t(10)), visit('reg', t(0)),
    visit('lapsed', t(30, 19)), visit('lapsed', t(0, 19)),                 // exactly 30 days between the two
    visit('cand', t(7, 17)),                                                // one visit, 7 days old during the window
    visit('nooffer', t(7, 17)),                                             // same, without offers permission
    visit('twice', t(7, 17)), visit('twice', t(3)),                         // came back already: not a candidate
    visit('old', t(8, 0)),                                                  // 7 days old before this window started
    visit('refunded', t(0), { refunded: t(0, 20) }),                        // a refunded payment is not a visit
    visit('later', iso(w.end + MIN))                                        // after the close
  ];
  // two payments on the same bill are one visit
  settles.push({ id: 'dup', body: Object.assign({}, settles[0].body, { id: 'dup', ts: t(0, 20), confirmedAt: t(0, 20) }) });
  const guests = ['first', 'back', 'reg', 'lapsed', 'twice', 'old', 'refunded', 'later'].map((g) => guest(g, true))
    .concat([guest('cand', true), guest('nooffer', false), { id: 'withdrew', body: { id: 'withdrew', consentHistory: [] } }]);
  // a guest who said yes, then no before the close, is not in the audience
  settles.push(visit('withdrew', t(7, 17)));
  guests[guests.length - 1].body.consentHistory.push({ at: t(9), marketing: true }, { at: t(0, 2), marketing: false });
  const r = m.computeReturns({ window: w, guests, settles });
  assert.deepEqual(r, { seen: 4, first: 1, returning: 1, regulars: 1, lapsed: 1, secondVisit: 1 });
});
test('narrativeInput: the day, the same weekday a week earlier, and the 4 weekdays before, from one load', async () => {
  const m = await H(), N2 = await N(), w = m.windowFor(DAY);
  const set = demoRows({ day: DAY, scenario: 'good', windowFor: m.windowFor, addDays: m.addDays });
  const input = m.narrativeInput({ venue: set.venue, window: w, data: venueData(set, w) });
  assert.equal(input.day, DAY); assert.equal(input.lang, 'en');
  assert.deepEqual([input.lastWeek, ...input.trailing].map((x) => x.figures.day), ['2026-10-20', '2026-10-20', '2026-10-13', '2026-10-06', '2026-09-29']);
  assert.equal(input.lastWeek, input.trailing[0]);
  assert.ok(input.today.facts.returns && input.today.facts.returns.seen > 0);
  assert.equal(input.trailing[1].facts.returns, null);
  // each comparable day is computed in its own window: its bills are its own
  for (const x of input.trailing) assert.ok(x.figures.bills.closed >= 20 && x.figures.bills.closed <= 24, x.figures.day);
  assert.equal(input.today.figures.bills.closed, 30);
  const n = N2.closeNarrative(input);
  assert.equal(n.sentences[0].rule, 'evening'); assert.match(n.text, /^On Tuesday, 30 bills were closed/);
});

/* ---------------------------------------------------------- the model path */
function stub(answer, { status = 200, throws } = {}) {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); if (throws) throw throws; return { ok: status < 300, status, text: async () => JSON.stringify(answer) }; };
  return { fetch, calls };
}
const reply = (text, extra) => Object.assign({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] }, extra);
async function rulesOf(lang) {
  const N2 = await N();
  return N2.closeNarrative({ lang, day: DAY, today: day({ tipsCents: 11000, stillOpen: { count: 1, tables: ['12'] } }), lastWeek: base({}), trailing: [base({})] });
}
test('model path: off without CLOSE_NARRATIVE_MODEL_KEY; with it, a faithful rewrite is used and the request is the documented one', async () => {
  const Mm = await M(), n = await rulesOf('en');
  const off = stub(reply('x'));
  const a = await Mm.createNarrator({ env: {}, fetch: off.fetch })({ lang: 'en', day: DAY, today: day({ tipsCents: 11000, stillOpen: { count: 1, tables: ['12'] } }), lastWeek: base({}), trailing: [base({})] });
  assert.equal(off.calls.length, 0); assert.equal(a.source, 'rules'); assert.equal(a.text, n.text);
  const rewrite = 'Tuesday closed 20 bills and took $1,000.00 with tips, in line with last Tuesday ($1,000.00 from 20 bills). Tips rose to 11% of takings ($110.00), from 8% last Tuesday. One table, 1 bill still open at the close (table 12): check it was paid, then close it.';
  const on = stub(reply(rewrite));
  const b = await Mm.createNarrator({ env: { CLOSE_NARRATIVE_MODEL_KEY: 'test-key-not-real' }, fetch: on.fetch })({ lang: 'en', day: DAY, today: day({ tipsCents: 11000, stillOpen: { count: 1, tables: ['12'] } }), lastWeek: base({}), trailing: [base({})] });
  assert.equal(b.source, 'model'); assert.equal(b.text, rewrite);
  assert.equal(on.calls.length, 1);
  const c = on.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.opts.headers['x-api-key'], 'test-key-not-real');
  assert.equal(c.opts.headers['anthropic-version'], '2026-10-21');
  assert.equal(c.opts.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(c.body.model, 'claude-sonnet-5-5'); assert.equal(c.body.fallbacks, 'default'); assert.deepEqual(c.body.output_config, { effort: 'low' });
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) assert.ok(!(k in c.body), k);
  assert.match(c.body.system, /Keep every number exactly/); assert.match(c.body.system, /Add nothing/);
  assert.match(c.body.messages[0].content, /Language: English\./);
  assert.ok(c.body.messages[0].content.includes(n.text));
  assert.doesNotMatch(JSON.stringify(c.body), /Mayda|Kababji|@/);
  const other = stub(reply(rewrite));
  await Mm.createNarrator({ env: { CLOSE_NARRATIVE_MODEL_KEY: 'k', CLOSE_NARRATIVE_MODEL: 'claude-haiku-5-5', ANTHROPIC_BASE_URL: 'https://proxy.test/' }, fetch: other.fetch })({ lang: 'en', day: DAY, today: day({ tipsCents: 11000 }), lastWeek: base({}) });
  assert.equal(other.calls[0].url, 'https://proxy.test/v1/messages'); assert.equal(other.calls[0].body.model, 'claude-haiku-5-5');
});
test('model path: the rules\' text is the fallback whenever a number changes, and on every error', async () => {
  const Mm = await M();
  for (const lang of ['en', 'fr', 'ar']) {
    const n = await rulesOf(lang);
    const run = async (s) => Mm.rewriteNarrative({ narrative: n, input: {}, apiKey: 'k', fetch: s.fetch });
    const changed = n.text.replace(/11/, '12');
    assert.notEqual(changed, n.text);
    let r = await run(stub(reply(changed)));
    assert.equal(r.source, 'rules', lang); assert.equal(r.fallback, 'numbers changed'); assert.equal(r.text, n.text);
    r = await run(stub(reply(n.text.replace(/\.$/, ', 5% better.'))));
    assert.equal(r.fallback, 'numbers changed', lang);
    r = await run(stub(reply(n.text.replace(/ (\d+)%/, ' $1 percent').replace(/\(\$?\d[\d,.]*/, '('))));
    assert.equal(r.source, 'rules', lang);
    r = await run(stub(reply(n.text)));
    assert.equal(r.source, 'model', lang);
  }
  const ar = await rulesOf('ar');
  const indic = ar.text.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  assert.equal((await Mm.rewriteNarrative({ narrative: ar, input: {}, apiKey: 'k', fetch: stub(reply(indic)).fetch })).source, 'model');
  const n = await rulesOf('en'), go = (s) => Mm.rewriteNarrative({ narrative: n, input: {}, apiKey: 'k', fetch: s.fetch });
  const cases = [
    [stub(reply(n.text, { stop_reason: 'refusal', content: [] })), 'refusal'],
    [stub(reply(n.text, { stop_reason: 'max_tokens' })), 'cut off'],
    [stub({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 }), 'model API 529'],
    [stub({ type: 'error', error: { message: 'bad' } }, { status: 400 }), 'model API 400'],
    [stub(null, { throws: new TypeError('fetch failed') }), 'unreachable'],
    [stub(null, { throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) }), 'timeout'],
    [stub(reply('')), 'empty answer'],
    [stub(reply(n.text.replace('. ', ' \u2014 '))), 'em dash'],
    [stub(reply(n.text + ' See https://x.test')), 'link or address'],
    [stub(reply('- ' + n.text)), 'not plain prose'],
    [stub(reply(n.text + ' ' + n.text)), 'length changed'],
    [stub(reply(n.text.slice(0, 40))), 'length changed']
  ];
  for (const [s, why] of cases) {
    const r = await go(s);
    assert.equal(r.source, 'rules', why); assert.equal(r.text, n.text, why); assert.equal(r.fallback, why);
  }
  // a one-line narrative (the empty day) is never sent
  const N2 = await N(), e = N2.closeNarrative({ lang: 'en', day: DAY, today: { empty: true } }), s = stub(reply('x'));
  assert.equal((await Mm.rewriteNarrative({ narrative: e, input: {}, apiKey: 'k', fetch: s.fetch })).source, 'rules');
  assert.equal(s.calls.length, 0);
  // the narrator logs why and keeps the rules' sentences
  const logs = [];
  const bad = async (url, opts) => { const t = JSON.parse(opts.body).messages[0].content.split('Report to rewrite:\n')[1]; return { ok: true, status: 200, text: async () => JSON.stringify(reply(t.replace('11%', '12%'))) }; };
  const out = await Mm.createNarrator({ env: { CLOSE_NARRATIVE_MODEL_KEY: 'k' }, fetch: bad, log: (x) => logs.push(x) })({ lang: 'en', day: DAY, today: day({ tipsCents: 11000 }), lastWeek: base({}) });
  assert.equal(out.source, 'rules'); assert.equal(out.fallback, 'numbers changed'); assert.ok(out.sentences.length >= 3);
  assert.deepEqual(logs, ['close narrative: model not used (numbers changed)']);
});

/* ---------------------------------------------------------- the email */
function fakeDb(seed) {
  const db = Object.assign({ venue_profiles: [], staff_members: [], kv_docs: [], kv_rows: [], daily_close_log: [], webhook_endpoints: [], webhook_deliveries: [] }, seed);
  const RES = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']), isoLike = /^\d{4}-\d\d-\d\dT/;
  const cell = (row, col) => { const m = /^(\w+)->>(\w+)$/.exec(col); const v = m ? row[m[1]] && row[m[1]][m[2]] : row[col]; return v == null ? null : m ? String(v) : v; };
  const cmp = (a, b) => (isoLike.test(String(a)) && isoLike.test(String(b)) ? Date.parse(a) - Date.parse(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const ok = (op, c) => {
    if (op === 'is.null') return c === null;
    if (op === 'not.is.null') return c !== null;
    if (c === null) return false;
    if (op.startsWith('eq.')) return String(c) === op.slice(3);
    if (op.startsWith('gte.')) return cmp(c, op.slice(4)) >= 0;
    if (op.startsWith('lt.')) return cmp(c, op.slice(3)) < 0;
    if (op.startsWith('in.(')) return op.slice(4, -1).split(',').includes(String(c));
    throw new Error('fake: unsupported ' + op);
  };
  db.paths = [];
  db.rest = async (p, opts = {}) => {
    const i = p.indexOf('?'), table = i < 0 ? p : p.slice(0, i), params = new URLSearchParams(i < 0 ? '' : p.slice(i + 1)), method = opts.method || 'GET';
    db.paths.push(p);
    if (!Array.isArray(db[table])) throw new Error('database 404: {"code":"PGRST205","message":"Could not find the table public.' + table + ' in the schema cache"}');   // as PostgREST answers for a table that is not installed
    const match = () => db[table].filter((r) => [...params].every(([k, v]) => RES.has(k) || ok(v, cell(r, k))));
    if (method === 'GET') { const off = Number(params.get('offset') || 0), lim = params.has('limit') ? Number(params.get('limit')) : 1e9; return JSON.parse(JSON.stringify(match().slice(off, off + lim))); }
    if (method === 'POST') { const out = []; for (const it of JSON.parse(opts.body)) { if (db[table].some((r) => r.restaurant_id === it.restaurant_id && r.day === it.day)) continue; const row = Object.assign({ id: 'l' + db[table].length }, it); db[table].push(row); out.push(row); } return out; }
    if (method === 'PATCH') { const patch = JSON.parse(opts.body); match().forEach((r) => Object.assign(r, patch)); return null; }
    throw new Error('fake: ' + method);
  };
  return db;
}
async function closeWith({ scenario = 'bad', lang, narrate, dbPatch } = {}) {
  const m = await H(), Nn = await N();
  const set = demoRows({ day: DAY, scenario, windowFor: m.windowFor, addDays: m.addDays, lang });
  const db = fakeDb({ venue_profiles: [set.venue], staff_members: [{ restaurant_id: RID, email: 'owner@mayda.example', role: 'owner', revoked_at: null }],
    kv_docs: set.kv_docs, kv_rows: set.kv_rows, webhook_endpoints: set.webhook_endpoints, webhook_deliveries: set.webhook_deliveries });
  if (dbPatch) dbPatch(db);
  const sent = [];
  const narr = narrate === undefined ? async (i) => Nn.closeNarrative(i) : narrate;
  const handle = m.createHandler({ rest: db.rest, send: async (msg) => { sent.push(msg); return { id: 'em-' + sent.length }; }, now: () => m.windowFor(DAY).end + 3600000, env: { AALAYNA_CRON_SECRET: 's' }, ...(narr ? { narrate: narr } : {}) });
  const res = await handle(new Request('https://x.test/functions/v1/daily-close?venue=' + encodeURIComponent(RID) + '&date=' + DAY, { method: 'POST', headers: { 'X-Aalayna-Cron': 's' } }));
  return { res: await res.json(), sent, db, m };
}
test('the email: the narrative on top of the text and the HTML, in the venue\'s language; the CSV and the figures unchanged', async () => {
  const plain = await closeWith({ narrate: null });
  const told = await closeWith({});
  assert.equal(told.res.results[0].status, 'sent');
  const a = plain.sent[0], b = told.sent[0];
  assert.deepEqual(b.attachments, a.attachments);                      // the CSV is byte for byte the same
  assert.equal(b.subject, a.subject);
  const story = b.text.split('\n')[0];
  assert.match(story, /^On Tuesday, 6 bills were closed and \$\d[\d,]*\.\d\d was taken, tips included, down \d+% on last Tuesday/);
  assert.match(story, /1 bill update sent to the till was not delivered \(last answer: HTTP 502\)/);
  assert.match(story, /1 cash request \(\$24\.00, table 9\) was still waiting/);
  assert.equal(b.text.split('\n')[1], '');
  assert.equal(b.text.split('\n').slice(2).join('\n'), a.text);       // the figures below are the email as it was
  assert.ok(b.html.startsWith('<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:560px"><p dir="ltr" lang="en"'));
  assert.ok(b.html.endsWith(a.html.slice(a.html.indexOf('<p style="margin:0 0 4px">'))));
  assert.doesNotMatch(b.text + b.html, /[\u2014]|owner@mayda/);
  assert.doesNotMatch(b.text + b.html, /discount|promo|newsletter|unsubscribe|special offer|download the app/i);
  // with a narrator, the loads reach 28 days back and read the growth and POS rows
  assert.ok(told.db.paths.some((p) => /body->>customerId=not\.is\.null/.test(p)));
  assert.ok(told.db.paths.some((p) => p.startsWith('webhook_deliveries?')));
  assert.ok(told.db.paths.some((p) => p.includes('updated_at=gte.' + encodeURIComponent(new Date(told.m.windowFor('2026-09-29').start).toISOString()))));
  assert.ok(!plain.db.paths.some((p) => /customerId|webhook_/.test(p)));
  const ar = await closeWith({ lang: 'ar' });
  assert.match(ar.sent[0].html, /<p dir="rtl" lang="ar" style="margin:0 0 16px;line-height:1\.5;text-align:right">يوم الثلاثاء، تم إغلاق 6 فواتير/);
  assert.match(ar.sent[0].text, /^يوم الثلاثاء، /);
  const fr = await closeWith({ lang: 'fr', scenario: 'good' });
  assert.match(fr.sent[0].text, /^Mardi, 30 additions ont été clôturées/);
});
test('the email goes out without the narrative if the narrator fails, and without the growth or POS sentences if those reads fail', async () => {
  const broken = await closeWith({ narrate: async () => { throw new Error('boom'); } });
  assert.equal(broken.res.results[0].status, 'sent');
  assert.match(broken.sent[0].text, /^Mayda, Tuesday 27 October, 04:00 to 04:00 Beirut time\./);
  const soft = await closeWith({ scenario: 'good', dbPatch: (db) => { delete db.webhook_endpoints; const r = db.rest; db.rest = (p, o) => (/customerId=not/.test(p) ? Promise.reject(new Error('down')) : r(p, o)); } });
  assert.equal(soft.res.results[0].status, 'sent');
  assert.doesNotMatch(soft.sent[0].text.split('\n')[0], /recognised|bill update/);
  assert.match(soft.sent[0].text.split('\n')[0], /^On Tuesday, 30 bills/);
  // buildEmail escapes the narrative in the HTML and keeps it on one line in the text
  const m = await H(), f = m.computeClose({ window: m.windowFor(DAY), checks: [], settles: [], guests: [], events: [], docs: [] });
  const e = m.buildEmail({ venue: { name: 'V' }, figures: f, csvName: 'c.csv', narrative: { lang: 'en', text: 'A <b> & B\nC' } });
  assert.ok(e.text.startsWith('A <b> & B C\n\nV, '));
  assert.match(e.html, /A &lt;b&gt; &amp; B C/);
  assert.equal(m.buildEmail({ venue: { name: 'V' }, figures: f, csvName: 'c.csv' }).text.split('\n')[0], 'V, Tuesday 27 October, 04:00 to 04:00 Beirut time.');
});

/* ---------------------------------------------------------- preview, sql, wiring */
test('tools/close-preview.js renders a good, a bad and an empty night in three languages without sending', async () => {
  const { preview } = require('../tools/close-preview.js');
  for (const lang of ['en', 'fr', 'ar']) {
    for (const demo of ['good', 'bad', 'empty']) {
      const t = await preview({ demo, lang, date: DAY, flags: new Set() });
      assert.ok(t.length > 40, demo + lang); assert.doesNotMatch(t, DASH);
      if (demo === 'empty') assert.equal(t.split(/(?<=[.])\s/).length, 1);
    }
  }
  const mail = await preview({ demo: 'good', date: DAY, flags: new Set(['email']) });
  assert.match(mail, /^Subject: Mayda: Tuesday 27 October, on Aalayna\n\nOn Tuesday, 30 bills/);
  const json = JSON.parse(await preview({ demo: 'bad', date: DAY, flags: new Set(['json']) }));
  assert.ok(json.sentences.every((s) => s.rule && s.text));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-fixture-')), file = path.join(dir, 'rows.json'), m = await H();
  fs.writeFileSync(file, JSON.stringify(demoRows({ day: DAY, scenario: 'bad', windowFor: m.windowFor, addDays: m.addDays })));
  assert.equal(await preview({ fixture: file, date: DAY, flags: new Set() }), await preview({ demo: 'bad', date: DAY, flags: new Set() }));
  await assert.rejects(preview({ date: DAY, flags: new Set() }), /--demo/);
});
test('the migration adds lang and currency with their lists; index.ts wires the narrator; the rules have no dependency', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/close-narrative-2026-10-28.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.equal((code.match(/^begin;$/gm) || []).length, 1); assert.equal((code.match(/^commit;$/gm) || []).length, 1);
  assert.match(code, /add column if not exists lang text/); assert.match(code, /lang is null or lang in \('en', 'fr', 'ar'\)/);
  assert.match(code, /add column if not exists currency text/); assert.match(code, /currency is null or currency in \('USD', 'LBP'\)/);
  const idx = fs.readFileSync(path.join(root, 'supabase/functions/daily-close/index.ts'), 'utf8');
  assert.match(idx, /from '\.\.\/_shared\/close-narrative-model\.js'/); assert.match(idx, /narrate: createNarrator\(/);
  const rulesSrc = fs.readFileSync(path.join(root, 'supabase/functions/_shared/close-narrative.js'), 'utf8');
  assert.doesNotMatch(rulesSrc, /^import /m); assert.doesNotMatch(rulesSrc, /fetch\(|Date\.now|Deno\.env|process\.env/);
  assert.doesNotMatch(rulesSrc + fs.readFileSync(path.join(root, 'supabase/functions/_shared/close-narrative-model.js'), 'utf8'), /[\u2014]/);
  // every threshold is documented
  const doc = fs.readFileSync(path.join(root, 'docs/close-narrative.md'), 'utf8');
  return N().then((N2) => { for (const k of Object.keys(N2.THRESHOLDS)) assert.ok(k === 'maxSentences' ? /maxSentences/.test(doc) : doc.includes('`' + k + '`'), k); });
});
