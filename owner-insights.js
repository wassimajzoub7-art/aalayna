/* Insights (owner dashboard): plain-language findings over a venue's recorded events.
   Deterministic, no model calls: every sentence comes from a rule below, with its numbers.

   A.computeInsights(input) is a pure function of its input:
     events   every recorded event of the venue (any date; the period is cut here)
     items    the published menu items (archived ones are skipped)
     sections [{id, name}]
     tables   optional table labels of the floor (a table with no scan only shows if listed)
     at       the time the report is for (ms); days: the period, 30 by default
     rateAgeDays optional, the age of the LBP rate setting
     firstEventAt, deviceFirstSeen  optional, from the server when the events cover only the period
                    (supabase/insights-2026-11-24.sql): the venue's first event of any date, and
                    each phone's first time at the venue, as ISO times
   It returns {insights, waiting, tables, ...}: the findings ranked by score, the rules still
   short of data (with what each needs and has), and the figures for the supporting tables.

   Rules (see MIN for every threshold; the tab prints each rule's minimum next to it):
   - "Ordered" means on a bill line: distinct bills containing the dish, the latest revision of
     each bill only (owner-metrics.js A.latestOrders / A.dishInterestFrom). Guests cannot order
     from the phone. A period whose bills carry no lines gets the view-side rules only, and
     orderNote says why.
   - Opens and bills are separate counts, not a conversion rate; sessions are not unique people,
     and a phone is not a person.
   - Until MIN.matureDays days of recorded activity exist, every finding is an early signal. */
(function (global) {
  'use strict';
  var A = global.Aalayna, DAY = 86400000;
  var MIN = {
    dishOpens: 20,       // a dish-level "looked at, rarely ordered" claim: that dish opened 20+ times
    dishBills: 10,       // "ordered a lot, rarely opened": that dish on 10+ bills
    menuOpens: 100,      // "nobody opens these": 100+ dish opens across the menu in the period
    dwellReads: 10,      // reading time of a dish: 10+ timed reads of it (and 3+ dishes to compare)
    optionPicks: 10,     // most-picked option: 10+ sessions picking in that option group
    sectionOpens: 30,    // a section claim: 30+ opens of its dishes
    filterSessions: 30,  // diet demand: 30+ menu sessions
    filterUses: 5,       // ... and 5+ sessions using that filter
    trafficSessions: 50, // busiest hours: 50+ sessions
    trafficDays: 14,     // busiest day of the week: 14+ days of activity in the period
    tableScans: 50,      // scans per table: 50+ scans across 3+ tables
    timedBills: 10,      // bill requested to paid: 10+ timed sessions
    slowTableBills: 5,   // a slow table: 5+ timed sessions at that table
    paidBills: 20,       // average bill, tips, splits: 20+ paid bills
    payments: 20,        // payment methods: 20+ payments
    uiSessions: 30,      // languages and currency: 30+ sessions
    repeatSessions: 50,  // returning phones: 50+ sessions
    repeatDays: 14,      // ... over 14+ days
    matureDays: 30       // the "early signal" label stays until 30 days are recorded
  };
  var FILTERS = [
    { key: 'veg', label: 'Vegetarian' }, { key: 'nonuts', label: 'No nuts' }, { key: 'nodairy', label: 'No dairy' },
    { key: 'light', label: 'Under 400 kcal' }, { key: 'protein', label: 'High protein' }
  ];
  var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var SHORT = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  var RAIL = { cash: 'Cash', card: 'Card', whish: 'Whish Money', pos: 'At the till', other: 'Other' };
  var SPLIT = { even: 'Equal shares', item: 'By item', amt: 'A chosen amount', all: 'The whole bill' };
  var LANG = { en: 'English', ar: 'Arabic', fr: 'French' };

  /* ---- the guest page's diet rules (guest.html filterable, effDiet, isVeg ... fitSwap), copied so
     the owner sees what a guest's filter shows. Keep in step with guest.html. ---- */
  var MEAT = /\b(?:meats?|lamb|mutton|beef|veal|chicken|poultry|turkey|duck|quail|pork|ham|bacon|sausages?|soujouk|sujuk|makanek|kafta|kofta|kabab|kebab|shawarma|awarma|liver|fish|salmon|tuna|sardines?|anchov(?:y|ies)|shrimps?|prawns?|calamari|squid|octopus|crab|lobster|mussels?|oysters?|clams?|seafood|gelatine?|lard)\b/i;
  function filterable(m) { return m.status === 'complete' && !!m.conf; }
  function effDiet(m, sel) {
    var al = (m.al || []).slice(), ing = (m.ing || []).slice();
    function add(c) {
      (c.al || []).forEach(function (a) { if (al.indexOf(a) < 0) al.push(a); });
      (c.ing || []).forEach(function (i) { if (ing.indexOf(i) < 0) ing.push(i); });
    }
    (m.opts || []).forEach(function (g, gi) {
      if (g.type === 'one') { var c = g.choices[(sel && sel[gi]) || 0]; if (c) add(c); }
    });
    return { al: al, ing: ing, kcal: m.kcal, pr: m.pr };
  }
  var PASS = {
    veg: function (e) { return !(e.ing || []).some(function (i) { return MEAT.test(i); }); },
    nonuts: function (e) { return (e.al || []).indexOf('nuts') < 0; },
    nodairy: function (e) { return (e.al || []).indexOf('dairy') < 0; },
    light: function (e) { return e.kcal != null && e.kcal <= 400; },
    protein: function (e) { return e.pr != null && e.pr >= 20; }
  };
  /* fits the filter as served, or with one pick-one swap (oat milk for cow milk), as the guest page offers */
  function fits(m, key) {
    if (!filterable(m)) return false;
    if (PASS[key](effDiet(m, null))) return true;
    var sel = {}, swapped = false;
    (m.opts || []).forEach(function (g, gi) {
      if (g.type !== 'one') return;
      g.choices.forEach(function (c, ci) { if (sel[gi] == null && PASS[key](effDiet(m, (function () { var s = {}; s[gi] = ci; return s; })()))) { sel[gi] = ci; if (ci) swapped = true; } });
    });
    return swapped && PASS[key](effDiet(m, sel));
  }

  /* ---- time, Beirut ---- */
  var fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' });
  function beirut(t) {
    var o = {};
    fmt.formatToParts(new Date(t)).forEach(function (p) { if (p.type !== 'literal') o[p.type] = p.value; });
    return { day: Date.UTC(+o.year, +o.month - 1, +o.day) / DAY, hour: +o.hour % 24, weekday: SHORT[o.weekday] };
  }
  function dateLabel(t) { return new Date(t).toLocaleDateString('en-GB', { timeZone: 'Asia/Beirut', day: 'numeric', month: 'short' }); }

  /* ---- small helpers ---- */
  function ts(e) { return Date.parse(e.createdAt); }
  function pct(n, d) { return d ? Math.round(100 * n / d) : 0; }
  function round1(x) { return Math.round(x * 10) / 10; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function listNames(names, max) {
    max = max || 4;
    var shown = names.slice(0, max), more = names.length - shown.length;
    if (more > 0) return shown.join(', ') + ' and ' + more + ' more';
    return shown.length > 1 ? shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1] : (shown[0] || '');
  }
  function median(list) { if (!list.length) return null; var a = list.slice().sort(function (x, y) { return x - y; }), m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function quantile(list, q) { if (!list.length) return null; var a = list.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; }
  function duration(ms) { var s = Math.round(ms / 1000), m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  function usd(x) { return '$' + (Math.round(x * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function tipUsd(p) {
    var tip = Number(p.tip) || 0, amount = Number(p.amount) || 0, inUsd = Number(p.amountUsd == null ? p.amount : p.amountUsd) || 0;
    return (p.currency && p.currency !== 'USD' && amount) ? tip * inUsd / amount : tip;
  }
  function paidUsd(p) { return Number(p.amountUsd == null ? p.amount : p.amountUsd) || 0; }
  var GUEST = { qr_scan: 1, item_view: 1, ui_action: 1, bill_requested: 1, review_submitted: 1 };

  A.INSIGHT_MIN = MIN;
  A.dietFits = fits;
  A.DIET_FILTERS = FILTERS;

  A.computeInsights = function (input) {
    input = input || {};
    var at = input.at == null ? Date.now() : input.at, days = input.days || 30;
    var start = at - days * DAY, w = { start: start, end: at + 1, days: days };
    var all = (input.events || []).filter(function (e) { var t = ts(e); return Number.isFinite(t) && t <= at; });
    var events = all.filter(function (e) { var t = ts(e); return t >= start; });
    var items = (input.items || []).filter(function (x) { return !x.archivedAt; });
    var secName = {}; (input.sections || []).forEach(function (s) { secName[s.id] = s.name; });
    var itemById = {}; items.forEach(function (x) { itemById[x.id] = x; });
    var insights = [], waiting = [];
    var early = false;
    function add(o) { o.early = early; insights.push(o); }
    function wait(id, family, label, need, have) { waiting.push({ id: id, family: family, label: label, need: need, have: have }); }

    /* how long this venue has been recording, in Beirut calendar days */
    var first = all.reduce(function (m, e) { var t = ts(e); return m == null || t < m ? t : m; }, null);
    var known = input.firstEventAt ? Date.parse(input.firstEventAt) : NaN;
    if (Number.isFinite(known) && known <= at && (first == null || known < first)) first = known;
    var daysCollected = first == null ? 0 : beirut(at).day - beirut(first).day + 1;
    early = daysCollected < MIN.matureDays;
    var activeFrom = first == null ? at : Math.max(first, start), periodDays = first == null ? 0 : beirut(at).day - beirut(activeFrom).day + 1;

    /* sessions: guest activity grouped by sessionId; the first event fixes its time, table and phone */
    var sess = {};
    events.forEach(function (e) {
      if (!GUEST[e.eventType] && e.eventType !== 'payment_completed') return;
      var id = e.sessionId; if (!id) return;
      var s = sess[id] || (sess[id] = { id: id, start: ts(e), table: null, device: e.deviceId, menu: false, ui: {} });
      var t = ts(e);
      if (t < s.start) { s.start = t; s.device = e.deviceId || s.device; }
      if (!s.table && e.tableId != null) s.table = String(e.tableId);
      if (e.eventType === 'qr_scan' || e.eventType === 'item_view') s.menu = true;
      if (e.eventType === 'ui_action') {
        var a = e.payload && e.payload.action, v = e.payload && e.payload.value;
        if (a === 'filter' || a === 'option') { var b = s.ui[a] || (s.ui[a] = {}); b[v] = 1; }
        else if (a) s.ui[a] = v;   // last choice wins
      }
    });
    var sessionList = Object.keys(sess).map(function (k) { return sess[k]; }).filter(function (s) { return s.menu || Object.keys(s.ui).length; });
    var menuSessions = sessionList.filter(function (s) { return s.menu; });

    /* ---------------- 1. dishes ---------------- */
    var orders = A.latestOrders(events);
    var lined = orders.filter(function (e) { return (e.payload.items || []).length > 0; });
    var hasLines = lined.length > 0, orderNote = null;
    if (!orders.length) orderNote = 'No bills were recorded in this period, so these insights cannot yet say which dishes were ordered. Bills reach Aalayna from your POS connection or when staff enter them on the Live floor; the dish-versus-bill insights appear once they do.';
    else if (!hasLines) orderNote = 'The ' + plural(orders.length, 'bill') + ' in this period arrived as totals only, without dish lines (the POS sends the amount, not the items). Without lines the tab cannot say which dishes were ordered, so the insights that compare dish views with bills are hidden. Bills with dish lines, from the POS or entered by staff, unlock them.';
    else if (lined.length < orders.length) orderNote = lined.length + ' of ' + plural(orders.length, 'bill') + ' in this period have dish lines; the dish-versus-bill figures count only those.';
    var dishes = A.dishInterestFrom(events, items);
    dishes.forEach(function (d) { d.sectionName = secName[d.section] || d.section; d.available = itemById[d.itemId].available !== false; });
    var opened = dishes.filter(function (d) { return d.opens > 0; });
    var totalOpens = opened.reduce(function (n, d) { return n + d.opens; }, 0);
    var totalOnBills = opened.reduce(function (n, d) { return n + d.onBills; }, 0);
    /* the typical pace: bills per open of the median dish among those opened 10+ times (a staple
       ordered without being opened would inflate a menu-wide ratio); the menu-wide ratio otherwise */
    var paced = opened.filter(function (d) { return d.opens >= 10; }).map(function (d) { return d.onBills / d.opens; });
    var R = paced.length >= 3 ? median(paced) : totalOpens ? totalOnBills / totalOpens : null;
    function pace(x) { return round1(x * 10) + ' bill' + (round1(x * 10) === 1 ? '' : 's') + ' for every 10 opens'; }
    var top = opened[0];

    if (!hasLines) wait('dish-low', 'dishes', 'Dishes guests look at but rarely order', 'bills with dish lines', orders.length ? 'bills without lines' : 'no bills');
    else if (!top || top.opens < MIN.dishOpens) wait('dish-low', 'dishes', 'Dishes guests look at but rarely order', 'a dish opened ' + MIN.dishOpens + ' times', top ? 'the most-opened dish has ' + top.opens : 'no dish opened yet');
    else {
      dishes.filter(function (d) { return d.opens >= MIN.dishOpens && R && d.onBills / d.opens <= R / 3; })
        .map(function (d) { d.missed = R * d.opens - d.onBills; return d; })
        .sort(function (a, b) { return b.missed - a.missed; }).slice(0, 2).forEach(function (d, i) {
          add({ id: 'dish-low:' + d.itemId, family: 'dishes', score: 70 + Math.min(25, d.missed) - i * 5,
            headline: d.name + ': looked at often, rarely ordered',
            text: d.name + ' was opened ' + plural(d.opens, 'time') + ' (in ' + plural(d.sessions, 'session') + ') but is on ' + (d.onBills ? 'only ' + plural(d.onBills, 'bill') : 'no bill') + '. A typical dish is on about ' + pace(R) + '; this one on ' + round1(d.onBills / d.opens * 10) + '.',
            action: 'Guests are curious but do not order it: check the photo, the description and the price, and ask staff what guests say about it.',
            rule: 'Shown for a dish opened at least ' + MIN.dishOpens + ' times that reaches bills at a third of the typical dish’s pace or less (bills per open).',
            numbers: { opens: d.opens, sessions: d.sessions, onBills: d.onBills } });
        });
    }
    if (hasLines) {
      var staples = dishes.filter(function (d) { return d.onBills >= MIN.dishBills && d.opens * 2 <= d.onBills && (!R || d.onBills / Math.max(1, d.opens) >= 2 * R); })
        .sort(function (a, b) { return b.onBills - a.onBills; });
      if (staples.length) {
        var s0 = staples[0];
        add({ id: 'dish-staple:' + s0.itemId, family: 'dishes', score: 45 + Math.min(20, s0.onBills / 3),
          headline: s0.name + ': ordered without being looked at',
          text: s0.name + ' is on ' + plural(s0.onBills, 'bill') + ' but was opened only ' + plural(s0.opens, 'time') + '. Guests order it without reading about it' + (staples.length > 1 ? ', as they do ' + listNames(staples.slice(1).map(function (d) { return d.name; }), 2) : '') + '.',
          action: 'A reliable seller: keep it easy to find and never out of stock. It is a good dish to suggest alongside something new.',
          rule: 'Shown for a dish on at least ' + MIN.dishBills + ' bills that is ordered at least twice for every time it is opened.',
          numbers: { opens: s0.opens, onBills: s0.onBills } });
      } else if (!dishes.some(function (d) { return d.onBills >= MIN.dishBills; })) wait('dish-staple', 'dishes', 'Dishes ordered without being opened', 'a dish on ' + MIN.dishBills + ' bills', 'the most-ordered dish is on ' + dishes.reduce(function (m, d) { return Math.max(m, d.onBills); }, 0));
    }
    if (totalOpens < MIN.menuOpens) wait('dish-unopened', 'dishes', 'Dishes nobody opens', MIN.menuOpens + ' dish opens across the menu', totalOpens + ' so far');
    else {
      var none = dishes.filter(function (d) { return d.opens === 0 && d.available; });
      var silent = hasLines ? none.filter(function (d) { return !d.onBills; }) : none;
      if (silent.length) add({ id: 'dish-unopened', family: 'dishes', score: 50 + Math.min(20, silent.length * 4),
        headline: plural(silent.length, 'dish', 'dishes') + ' nobody opened',
        text: listNames(silent.map(function (d) { return d.name; }), 5) + (silent.length === 1 ? ' was' : ' were') + ' not opened once in ' + days + ' days' + (hasLines ? (silent.length === 1 ? ', and is on no bill' : ', and none is on a bill') : '') + ', while guests opened dishes ' + plural(totalOpens, 'time') + '.',
        action: 'Check they are easy to find (place in the section, name, photo), or consider taking them off the menu.',
        rule: 'Shown once guests have opened dishes ' + MIN.menuOpens + ' times in the period.',
        numbers: { dishes: silent.length, totalOpens: totalOpens } });
    }
    var timed = dishes.filter(function (d) { return d.avgDwellS != null && d.dwellReads >= MIN.dwellReads; });
    if (timed.length < 3) wait('dish-dwell', 'dishes', 'Reading time per dish', '3 dishes with ' + MIN.dwellReads + ' timed reads each', plural(timed.length, 'dish', 'dishes'));
    else {
      var typical = median(timed.map(function (d) { return d.avgDwellS; }));
      var longest = timed.slice().sort(function (a, b) { return b.avgDwellS - a.avgDwellS; })[0];
      if (longest.avgDwellS >= 1.5 * typical && longest.avgDwellS >= 12) {
        var slowOrder = hasLines && R && longest.opens && longest.onBills / longest.opens < R;
        add({ id: 'dish-dwell:' + longest.itemId, family: 'dishes', score: slowOrder ? 42 : 30,
          headline: 'Guests read ' + longest.name + ' the longest',
          text: 'Guests spend ' + longest.avgDwellS + ' s on ' + longest.name + ' on average (' + plural(longest.dwellReads, 'timed read') + '), against ' + Math.round(typical) + ' s for a typical dish' + (slowOrder ? ', and it reaches fewer bills per open than most.' : '.'),
          action: slowOrder ? 'A long read with few orders can mean the description leaves questions: say the portion, the spice and what it comes with.' : 'Guests take their time over it: a clear photo and the portion size help them decide.',
          rule: 'Compares dishes with at least ' + MIN.dwellReads + ' timed reads each; shown when one is read 1.5 times longer than the typical dish.',
          numbers: { avgDwellS: longest.avgDwellS, typicalS: Math.round(typical) } });
      }
    }
    /* options: a click on a choice, attributed to the dish open in that session at that moment
       (the last item_view before it); one count per session and choice */
    var lastOpen = {}, picks = {};
    events.filter(function (e) { return e.eventType === 'item_view' || (e.eventType === 'ui_action' && e.payload && e.payload.action === 'option'); })
      .sort(function (a, b) { return ts(a) - ts(b); }).forEach(function (e) {
        if (e.eventType === 'item_view') { lastOpen[e.sessionId] = e.payload.itemId; return; }
        var v = String(e.payload.value || ''), i = v.indexOf(':'), x = itemById[lastOpen[e.sessionId]];
        var g = x && (x.opts || []).filter(function (o) { return o.name === v.slice(0, i); })[0];
        var ci = g ? g.choices.map(function (c) { return c.n; }).indexOf(v.slice(i + 1)) : -1;
        if (ci < 0 || (g.type === 'one' && ci === 0)) return;   // unknown, or back to the default choice
        var key = x.id + '|' + g.name + '|' + g.choices[ci].n, row = picks[key] || (picks[key] = { itemId: x.id, dish: x.name, group: g.name, choice: g.choices[ci].n, price: g.choices[ci].p, seen: {} });
        row.seen[e.sessionId] = 1;
      });
    var openSessions = {}; dishes.forEach(function (d) { openSessions[d.itemId] = d.sessions; });
    var optionRows = Object.keys(picks).map(function (k) { var r = picks[k]; return { itemId: r.itemId, dish: r.dish, group: r.group, choice: r.choice, price: r.price, sessions: Object.keys(r.seen).length, dishSessions: openSessions[r.itemId] || 0 }; })
      .sort(function (a, b) { return b.sessions - a.sessions || a.dish.localeCompare(b.dish); });
    var optionTop = optionRows.filter(function (r) { return r.sessions >= MIN.optionPicks; })[0];
    if (optionTop) add({ id: 'option:' + optionTop.itemId + ':' + optionTop.choice, family: 'dishes', score: 32 + Math.min(15, pct(optionTop.sessions, optionTop.dishSessions) / 4),
      headline: optionTop.choice + ' is the most-picked option',
      text: optionTop.choice + ' (' + optionTop.group + ', ' + optionTop.dish + ') is the most-picked option: ' + optionTop.sessions + ' of the ' + plural(optionTop.dishSessions, 'session') + ' that opened ' + optionTop.dish + ' chose it (' + pct(optionTop.sessions, optionTop.dishSessions) + '%).' + (optionTop.price ? ' It adds ' + usd(optionTop.price) + '.' : ''),
      action: 'Make sure it never runs out at peak hours, and mention it in the dish description' + (optionTop.price ? '; at ' + usd(optionTop.price) + ' it adds to the bill.' : '.'),
      rule: 'Shown for an option at least ' + MIN.optionPicks + ' sessions picked; a dish’s default choice does not count.',
      numbers: { sessions: optionTop.sessions, dishSessions: optionTop.dishSessions } });
    else wait('option', 'dishes', 'Most-picked options', 'an option picked in ' + MIN.optionPicks + ' sessions', optionRows.length ? 'the most-picked has ' + optionRows[0].sessions : 'no option picked yet');
    /* sections */
    var secRows = [], bySec = {};
    dishes.forEach(function (d) { var s = bySec[d.section] || (bySec[d.section] = { id: d.section, name: d.sectionName, dishes: 0, opens: 0, onBills: 0, unopened: 0 }); s.dishes++; s.opens += d.opens; s.onBills += d.onBills; if (!d.opens) s.unopened++; });
    (input.sections || []).forEach(function (s) { if (bySec[s.id]) secRows.push(bySec[s.id]); });
    Object.keys(bySec).forEach(function (k) { if (secRows.indexOf(bySec[k]) < 0) secRows.push(bySec[k]); });
    if (hasLines && R) {
      var weak = secRows.filter(function (s) { return s.opens >= MIN.sectionOpens && s.onBills / s.opens <= R / 2; }).sort(function (a, b) { return a.onBills / a.opens - b.onBills / b.opens; })[0];
      if (weak) add({ id: 'section:' + weak.id, family: 'dishes', score: 40,
        headline: weak.name + ': browsed more than ordered',
        text: 'Dishes in ' + weak.name + ' were opened ' + plural(weak.opens, 'time') + ' and are on ' + plural(weak.onBills, 'bill') + ': ' + pace(weak.onBills / weak.opens) + ', against ' + pace(R) + ' for a typical dish.',
        action: 'Guests browse this section without ordering from it: check its prices, and whether staff suggest it at the right moment.',
        rule: 'Shown for a section whose dishes were opened at least ' + MIN.sectionOpens + ' times and reach bills at half the typical dish’s pace or less.',
        numbers: { opens: weak.opens, onBills: weak.onBills } });
      else if (!secRows.some(function (s) { return s.opens >= MIN.sectionOpens; })) wait('section', 'dishes', 'Sections browsed but not ordered', 'a section opened ' + MIN.sectionOpens + ' times', 'the busiest section has ' + secRows.reduce(function (m, s) { return Math.max(m, s.opens); }, 0));
    }

    /* ---------------- 2. diet and allergen demand vs offer ---------------- */
    var available = items.filter(function (x) { return x.available !== false; });
    var unknown = available.filter(function (x) { return !filterable(x); }).length;
    var filterRows = FILTERS.map(function (f) {
      var uses = menuSessions.filter(function (s) { return s.ui.filter && s.ui.filter[f.key + ':on']; }).length;
      var fit = available.filter(function (x) { return fits(x, f.key); });
      return { key: f.key, label: f.label, uses: uses, share: menuSessions.length ? uses / menuSessions.length : null, fit: fit.length, fitNames: fit.map(function (x) { return x.name; }), live: available.length };
    });
    if (menuSessions.length < MIN.filterSessions) wait('diet', 'diet', 'Diet filters: demand against what the menu offers', MIN.filterSessions + ' menu sessions', menuSessions.length + ' so far');
    else {
      var used = filterRows.filter(function (r) { return r.uses >= MIN.filterUses; }).sort(function (a, b) { return b.uses - a.uses; });
      var gaps = used.filter(function (r) { return r.share >= 0.05 && r.fit <= Math.max(4, Math.round(0.1 * r.live)); });
      gaps.slice(0, 2).forEach(function (r) {
        add({ id: 'diet-gap:' + r.key, family: 'diet', score: 55 + Math.min(25, Math.round(r.share * 100)),
          headline: r.label + ': asked for more than offered',
          text: pct(r.uses, menuSessions.length) + '% of sessions (' + r.uses + ' of ' + menuSessions.length + ') turned on the ' + r.label + ' filter, and ' + (r.fit ? r.fit + ' of your ' + r.live + ' dishes fit it' + (r.fit <= 4 ? ': ' + listNames(r.fitNames, 4) : '') : 'none of your ' + r.live + ' dishes fits it') + '.' + (unknown ? ' ' + plural(unknown, 'dish has', 'dishes have') + ' no confirmed ingredient record, so the filter treats ' + (unknown === 1 ? 'it' : 'them') + ' as unknown.' : ''),
          action: 'The demand is there: consider adding a ' + r.label.toLowerCase() + ' dish, or a pick-one option that makes an existing dish fit' + (unknown ? ', and complete the missing ingredient records in the menu editor.' : '.'),
          rule: 'Shown when at least ' + MIN.filterUses + ' sessions (and 5% of ' + MIN.filterSessions + '+ menu sessions) use a filter that 4 dishes or fewer (or 10% of the menu) fit.',
          numbers: { uses: r.uses, sessions: menuSessions.length, fit: r.fit } });
      });
      var topUse = used.filter(function (r) { return gaps.indexOf(r) < 0; })[0];
      if (topUse) add({ id: 'diet-top:' + topUse.key, family: 'diet', score: 22,
        headline: topUse.label + ' is the most-used filter',
        text: pct(topUse.uses, menuSessions.length) + '% of sessions (' + topUse.uses + ' of ' + menuSessions.length + ') turned on ' + topUse.label + '; ' + topUse.fit + ' of your ' + topUse.live + ' dishes fit it.',
        action: 'Guests rely on these filters: keep the ingredient records of those dishes accurate when a recipe changes.',
        rule: 'Shown for the most-used filter once ' + MIN.filterUses + ' sessions have used it.',
        numbers: { uses: topUse.uses, sessions: menuSessions.length, fit: topUse.fit } });
      if (!used.length) wait('diet', 'diet', 'Diet filters: demand against what the menu offers', MIN.filterUses + ' sessions using one filter', 'the most-used filter has ' + filterRows.reduce(function (m, r) { return Math.max(m, r.uses); }, 0));
    }

    /* ---------------- 3. time and traffic ---------------- */
    var byHour = []; for (var h = 0; h < 24; h++) byHour.push(0);
    var byDay = [0, 0, 0, 0, 0, 0, 0], dayCount = [0, 0, 0, 0, 0, 0, 0];
    /* weekdays are averaged over whole days: today, still under way, is left out of them */
    var todayIx = beirut(at).day, fullDays = 0, fullSessions = 0;
    sessionList.forEach(function (s) { var b = beirut(s.start); byHour[b.hour]++; if (b.day < todayIx) { byDay[b.weekday]++; fullSessions++; } });
    if (first != null) { for (var d = beirut(activeFrom).day; d < todayIx; d++) { dayCount[(new Date(d * DAY).getUTCDay() + 6) % 7]++; fullDays++; } }
    var perDay = byDay.map(function (n, i) { return dayCount[i] ? n / dayCount[i] : null; });
    if (sessionList.length < MIN.trafficSessions) wait('traffic', 'traffic', 'Busiest days and hours', MIN.trafficSessions + ' sessions', sessionList.length + ' so far');
    else {
      var peak = 0; byHour.forEach(function (n, i) { if (n > byHour[peak]) peak = i; });
      var hourText = 'The busiest hour is ' + (peak < 10 ? '0' : '') + peak + ':00 to ' + (peak + 1 < 10 ? '0' : '') + ((peak + 1) % 24) + ':00 Beirut time, with ' + pct(byHour[peak], sessionList.length) + '% of sessions.';
      if (periodDays >= MIN.trafficDays) {
        var best = -1, worst = -1;
        perDay.forEach(function (v, i) { if (v == null) return; if (best < 0 || v > perDay[best]) best = i; if (worst < 0 || v < perDay[worst]) worst = i; });
        var avg = fullDays ? fullSessions / fullDays : 0;
        add({ id: 'traffic', family: 'traffic', score: 38,
          headline: WEEKDAYS[best] + 's are the busiest',
          text: 'An average ' + WEEKDAYS[best] + ' brings ' + round1(perDay[best]) + ' sessions, against ' + round1(avg) + ' on an average day; ' + WEEKDAYS[worst] + 's are the quietest, at ' + round1(perDay[worst]) + '. ' + hourText,
          action: 'Put your strongest team on ' + WEEKDAYS[best] + ' around ' + peak + ':00; a ' + WEEKDAYS[worst] + ' offer could fill the quiet day.',
          rule: 'Shown once ' + MIN.trafficSessions + ' sessions over ' + MIN.trafficDays + ' days are recorded; each weekday is averaged over the whole days of the period, Beirut time.',
          numbers: { best: WEEKDAYS[best], worst: WEEKDAYS[worst], peakHour: peak } });
      } else add({ id: 'traffic', family: 'traffic', score: 30, headline: 'The busiest hour is ' + peak + ':00', text: hourText + ' Busiest days need ' + MIN.trafficDays + ' days of activity; ' + periodDays + ' so far.',
        action: 'Plan the floor for ' + peak + ':00.', rule: 'Shown once ' + MIN.trafficSessions + ' sessions are recorded.', numbers: { peakHour: peak } });
    }
    /* scans per table */
    var scans = {}, scanTotal = 0;
    (input.tables || []).forEach(function (t) { scans[String(t)] = 0; });
    events.forEach(function (e) { if (e.eventType === 'qr_scan' && e.tableId != null) { scans[String(e.tableId)] = (scans[String(e.tableId)] || 0) + 1; scanTotal++; } });
    var tableIds = Object.keys(scans).sort(function (a, b) { return (Number(a) - Number(b)) || a.localeCompare(b); });
    if (scanTotal < MIN.tableScans || tableIds.length < 3) wait('tables', 'traffic', 'Scans per table', MIN.tableScans + ' scans across 3 tables', plural(scanTotal, 'scan') + ' at ' + plural(tableIds.length, 'table'));
    else {
      var typicalScans = median(tableIds.map(function (t) { return scans[t]; }));
      var low = tableIds.filter(function (t) { return typicalScans >= 8 && scans[t] <= typicalScans / 4; });
      if (low.length) add({ id: 'tables-low', family: 'traffic', score: 48,
        headline: (low.length === 1 ? 'Table ' + low[0] : plural(low.length, 'table')) + ' barely scanned',
        text: (low.length === 1 ? 'Table ' + low[0] + ' had ' + (scans[low[0]] ? plural(scans[low[0]], 'scan') : 'no scan') : 'Tables ' + listNames(low, 5) + ' had ' + low.map(function (t) { return scans[t]; }).join(', ') + ' scans') + ' in ' + days + ' days; a typical table had ' + Math.round(typicalScans) + '.',
        action: 'Check that the QR code at ' + (low.length === 1 ? 'that table' : 'those tables') + ' is there, visible and undamaged, and that the table is in use.',
        rule: 'Shown once ' + MIN.tableScans + ' scans are recorded, for a table with a quarter or less of a typical table’s scans.',
        numbers: { low: low, typical: typicalScans } });
    }
    /* bill requested to paid, per session; and per table */
    var billAt = {}, payAt = {};
    events.forEach(function (e) {
      var t = ts(e);
      if (e.eventType === 'bill_requested' && e.sessionId && (billAt[e.sessionId] == null || t < billAt[e.sessionId].t)) billAt[e.sessionId] = { t: t, table: e.tableId == null ? null : String(e.tableId) };
      if (e.eventType === 'payment_completed' && e.sessionId && (payAt[e.sessionId] == null || t < payAt[e.sessionId])) payAt[e.sessionId] = t;
    });
    var gaps2 = [], perTable = {};
    Object.keys(billAt).forEach(function (id) {
      if (payAt[id] == null || payAt[id] < billAt[id].t) return;
      var g = payAt[id] - billAt[id].t; gaps2.push(g);
      var tb = billAt[id].table || (sess[id] && sess[id].table); if (tb) (perTable[tb] = perTable[tb] || []).push(g);
    });
    var payMedian = median(gaps2), payP90 = quantile(gaps2, 0.9);
    var payRows = Object.keys(perTable).map(function (t) { return { table: t, timed: perTable[t].length, medianMs: median(perTable[t]) }; });
    if (gaps2.length < MIN.timedBills) wait('pay-time', 'traffic', 'Bill requested to paid', MIN.timedBills + ' timed sessions', gaps2.length + ' so far');
    else {
      var slowTail = payP90 >= 10 * 60000;
      add({ id: 'pay-time', family: 'traffic', score: slowTail ? 44 : 20,
        headline: 'Paying takes ' + duration(payMedian) + ' at the median',
        text: 'Half of the tables paid within ' + duration(payMedian) + ' (minutes:seconds) of asking for the bill; one in ten took longer than ' + duration(payP90) + '. Measured over ' + plural(gaps2.length, 'session') + '.',
        action: slowTail ? 'The slow tail is long: check that staff see cash requests quickly on the Live floor, under Needs attention.' : 'Paying is quick; nothing to fix here.',
        rule: 'Shown once ' + MIN.timedBills + ' sessions have both a bill request and a payment.',
        numbers: { medianMs: payMedian, p90Ms: payP90, timed: gaps2.length } });
      var slow = payRows.filter(function (r) { return r.timed >= MIN.slowTableBills && r.medianMs >= 1.5 * payMedian && r.medianMs - payMedian >= 60000; }).sort(function (a, b) { return b.medianMs - a.medianMs; })[0];
      if (slow) add({ id: 'pay-slow:' + slow.table, family: 'traffic', score: 46,
        headline: 'Table ' + slow.table + ' pays slowly',
        text: 'Table ' + slow.table + ' takes ' + duration(slow.medianMs) + ' from bill to paid (the median of ' + plural(slow.timed, 'session') + '), against ' + duration(payMedian) + ' across the room.',
        action: 'Look at how that table is served at the end of the meal: it may be out of the waiter’s sight, or its guests wait for change.',
        rule: 'Shown for a table with at least ' + MIN.slowTableBills + ' timed sessions whose median is 1.5 times the room’s and a minute longer.',
        numbers: { table: slow.table, medianMs: slow.medianMs } });
    }

    /* ---------------- 4. money and guests ---------------- */
    var payments = events.filter(function (e) { return e.eventType === 'payment_completed'; });
    var bills = {}, railAmt = { cash: 0, card: 0, whish: 0, pos: 0, other: 0 }, railTip = {}, railNet = {}, railCount = {};
    payments.forEach(function (e) {
      var p = e.payload || {}, id = p.orderId || p.paymentId || e.eventId, b = bills[id] || (bills[id] = { paid: 0, tip: 0, payments: 0 });
      var paid = paidUsd(p), tip = tipUsd(p), r = railAmt.hasOwnProperty(p.rail) ? p.rail : 'other';
      b.paid += paid; b.tip += tip; b.payments++;
      railAmt[r] += paid; railTip[r] = (railTip[r] || 0) + tip; railNet[r] = (railNet[r] || 0) + paid - tip; railCount[r] = (railCount[r] || 0) + 1;
    });
    var billList = Object.keys(bills).map(function (k) { return bills[k]; });
    var net = billList.reduce(function (n, b) { return n + b.paid - b.tip; }, 0), tips = billList.reduce(function (n, b) { return n + b.tip; }, 0);
    var splitBills = billList.filter(function (b) { return b.payments > 1; });
    var splitChoice = {}, splitChosen = 0;
    sessionList.forEach(function (s) { if (s.ui.split) { splitChoice[s.ui.split] = (splitChoice[s.ui.split] || 0) + 1; splitChosen++; } });
    var tipChoice = {}; sessionList.forEach(function (s) { if (s.ui.tip) tipChoice[s.ui.tip] = (tipChoice[s.ui.tip] || 0) + 1; });
    if (billList.length < MIN.paidBills) wait('money', 'money', 'Average bill, tips and splits', MIN.paidBills + ' paid bills', billList.length + ' so far');
    else {
      var cashTip = railNet.cash ? railTip.cash / railNet.cash : null, digNet = (railNet.card || 0) + (railNet.whish || 0), digTip = digNet ? ((railTip.card || 0) + (railTip.whish || 0)) / digNet : null;
      add({ id: 'money-bill', family: 'money', score: 34,
        headline: 'Average paid bill ' + usd(net / billList.length),
        text: 'The average bill paid through Aalayna was ' + usd(net / billList.length) + ' across ' + plural(billList.length, 'bill') + ', and tips added ' + pct(tips, net) + '% on top (' + usd(tips / billList.length) + ' a bill).' + (cashTip != null && digTip != null ? ' Guests tip ' + Math.round(digTip * 100) + '% by card and Whish, ' + Math.round(cashTip * 100) + '% in cash.' : ''),
        action: 'To lift the average bill, have staff suggest a dessert or a coffee before the bill is asked for.',
        rule: 'Shown once ' + MIN.paidBills + ' bills are paid in the period; amounts in US dollars, tips excluded from the bill.',
        numbers: { bills: billList.length, averageUsd: net / billList.length, tipShare: net ? tips / net : null } });
      var topSplit = Object.keys(splitChoice).filter(function (k) { return k !== 'all'; }).sort(function (a, b) { return splitChoice[b] - splitChoice[a]; })[0];
      add({ id: 'money-split', family: 'money', score: splitBills.length / billList.length >= 0.3 ? 33 : 18,
        headline: pct(splitBills.length, billList.length) + '% of bills are split',
        text: pct(splitBills.length, billList.length) + '% of paid bills (' + splitBills.length + ' of ' + billList.length + ') were paid in two or more payments' + (splitBills.length ? ', ' + round1(splitBills.reduce(function (n, b) { return n + b.payments; }, 0) / splitBills.length) + ' payments each on average' : '') + '.' + (topSplit ? ' The most-chosen way to split is ' + SPLIT[topSplit].toLowerCase() + ' (' + pct(splitChoice[topSplit], splitChosen) + '% of sessions that chose one).' : ''),
        action: splitBills.length / billList.length >= 0.3 ? 'Splitting is common here: have staff tell tables they can split on their phones.' : 'Most tables pay in one go; nothing to change.',
        rule: 'Shown once ' + MIN.paidBills + ' bills are paid in the period.',
        numbers: { split: splitBills.length, bills: billList.length } });
    }
    var railTotal = Object.keys(railAmt).reduce(function (n, k) { return n + railAmt[k]; }, 0);
    var railRows = Object.keys(railAmt).filter(function (k) { return railAmt[k] > 0; }).map(function (k) { return { rail: k, label: RAIL[k], amountUsd: railAmt[k], share: railTotal ? railAmt[k] / railTotal : 0, payments: railCount[k] || 0 }; }).sort(function (a, b) { return b.amountUsd - a.amountUsd; });
    if (payments.length < MIN.payments) wait('rails', 'money', 'Cash, card, Whish and the till', MIN.payments + ' payments', payments.length + ' so far');
    else {
      var cashShare = railAmt.cash / railTotal, whishShare = railAmt.whish / railTotal;
      add({ id: 'rails', family: 'money', score: cashShare >= 0.5 ? 36 : 26,
        headline: railRows[0].label + ' leads, at ' + pct(railRows[0].amountUsd, railTotal) + '%',
        text: 'Of the ' + usd(railTotal) + ' paid through Aalayna, ' + railRows.map(function (r) { return (r.rail === 'whish' ? r.label : r.label.toLowerCase()) + ' ' + pct(r.amountUsd, railTotal) + '%'; }).join(', ') + ' (' + plural(payments.length, 'payment') + ').',
        action: cashShare >= 0.5 ? 'Most money arrives as cash: keep change ready at peak hours and confirm cash promptly on the Live floor.' : whishShare >= 0.2 ? 'Whish is a real share of payments: keep the venue’s Whish account details current.' : 'No change needed; compare with your POS closing to see the share paid on phones.',
        rule: 'Shown once ' + MIN.payments + ' payments are recorded in the period; amounts in US dollars.',
        numbers: { total: railTotal } });
    }
    /* languages and currency: the last choice of each session; a session that never changed keeps the default */
    var langCount = { en: 0, ar: 0, fr: 0 }, lbp = 0;
    sessionList.forEach(function (s) { if (s.ui.language && langCount.hasOwnProperty(s.ui.language)) langCount[s.ui.language]++; if (s.ui.currency === 'lbp') lbp++; });
    var langRows = ['ar', 'fr', 'en'].map(function (k) { return { lang: k, label: LANG[k], sessions: langCount[k], share: sessionList.length ? langCount[k] / sessionList.length : null }; });
    if (sessionList.length < MIN.uiSessions) wait('lang', 'money', 'Languages and LBP prices', MIN.uiSessions + ' sessions', sessionList.length + ' so far');
    else {
      var noAr = available.filter(function (x) { return !x.ar; }), noFr = available.filter(function (x) { return !x.fr; });
      var arShare = langCount.ar / sessionList.length, frShare = langCount.fr / sessionList.length;
      var missing = (arShare >= 0.05 ? noAr.length : 0) + (frShare >= 0.05 ? noFr.length : 0);
      add({ id: 'languages', family: 'money', score: missing ? 40 : 24,
        headline: pct(langCount.ar, sessionList.length) + '% read in Arabic, ' + pct(langCount.fr, sessionList.length) + '% in French',
        text: pct(langCount.ar, sessionList.length) + '% of sessions switched the menu to Arabic and ' + pct(langCount.fr, sessionList.length) + '% to French; the others kept the default language.' + (arShare >= 0.05 && noAr.length ? ' ' + plural(noAr.length, 'dish has', 'dishes have') + ' no Arabic text (' + listNames(noAr.map(function (x) { return x.name; }), 3) + '), so ' + (noAr.length === 1 ? 'it shows' : 'they show') + ' in English.' : '') + (frShare >= 0.05 && noFr.length ? ' ' + plural(noFr.length, 'dish has', 'dishes have') + ' no French text.' : ''),
        action: missing ? 'Translate the missing dishes in the menu editor: those guests read them in English today.' : 'Your translations cover the menu; keep them in step when dishes change.',
        rule: 'Shown once ' + MIN.uiSessions + ' sessions are recorded; a session counts its last language choice.',
        numbers: { ar: langCount.ar, fr: langCount.fr, sessions: sessionList.length } });
      var age = input.rateAgeDays;
      add({ id: 'currency', family: 'money', score: lbp / sessionList.length >= 0.15 ? 30 : 16,
        headline: pct(lbp, sessionList.length) + '% view prices in LBP',
        text: pct(lbp, sessionList.length) + '% of sessions (' + lbp + ' of ' + sessionList.length + ') switched prices to Lebanese pounds; the rest saw US dollars.' + (age != null ? ' The LBP rate was last updated ' + plural(age, 'day') + ' ago.' : ''),
        action: lbp / sessionList.length >= 0.15 ? 'Guests compare in pounds: keep the LBP rate in step with the one at your till.' : 'Few guests use pounds; keep the rate current all the same.',
        rule: 'Shown once ' + MIN.uiSessions + ' sessions are recorded; a session counts its last currency choice.',
        numbers: { lbp: lbp, sessions: sessionList.length } });
    }
    /* returning phones: a session whose phone was seen before that session started (any date) */
    var firstSeen = {}, given = input.deviceFirstSeen || {};
    Object.keys(given).forEach(function (d) { var t = Date.parse(given[d]); if (Number.isFinite(t)) firstSeen[d] = t; });
    all.forEach(function (e) { if (!e.deviceId || !GUEST[e.eventType]) return; var t = ts(e); if (firstSeen[e.deviceId] == null || t < firstSeen[e.deviceId]) firstSeen[e.deviceId] = t; });
    var repeat = sessionList.filter(function (s) { return s.device && firstSeen[s.device] < s.start; }).length;
    if (sessionList.length < MIN.repeatSessions || daysCollected < MIN.repeatDays) wait('repeat', 'money', 'Returning phones', MIN.repeatSessions + ' sessions over ' + MIN.repeatDays + ' days', plural(sessionList.length, 'session') + ' over ' + plural(daysCollected, 'day'));
    else add({ id: 'repeat', family: 'money', score: 28,
      headline: pct(repeat, sessionList.length) + '% of sessions came back',
      text: pct(repeat, sessionList.length) + '% of sessions (' + repeat + ' of ' + sessionList.length + ') came from a phone that had opened your menu before. A phone is not a person: a shared phone counts once, a cleared browser counts as new.',
      action: 'Returning guests are worth knowing by name: a receipt by email or WhatsApp lets you invite them back.',
      rule: 'Shown once ' + MIN.repeatSessions + ' sessions over ' + MIN.repeatDays + ' days are recorded.',
      numbers: { repeat: repeat, sessions: sessionList.length } });

    insights.sort(function (a, b) { return b.score - a.score || a.id.localeCompare(b.id); });
    return {
      at: at, window: w, firstEventAt: first, firstLabel: first == null ? null : dateLabel(first), daysCollected: daysCollected, early: early,
      matureDays: MIN.matureDays, hasLines: hasLines, orderNote: orderNote,
      counts: { events: events.length, sessions: sessionList.length, menuSessions: menuSessions.length, opens: totalOpens, bills: orders.length, linedBills: lined.length, paidBills: billList.length, payments: payments.length, scans: scanTotal },
      insights: insights, waiting: waiting,
      tables: { dishes: dishes, sections: secRows, filters: filterRows, unknownDiet: unknown, options: optionRows.slice(0, 12),
        byHour: byHour, byWeekday: perDay.map(function (v) { return v == null ? null : round1(v); }), weekdays: WEEKDAYS,
        scans: tableIds.map(function (t) { var p = payRows.filter(function (r) { return r.table === t; })[0]; return { table: t, scans: scans[t], timed: p ? p.timed : 0, medianMs: p ? p.medianMs : null }; }),
        payMedianMs: payMedian, payP90Ms: payP90, rails: railRows, split: { bills: billList.length, split: splitBills.length, choices: splitChoice, chosen: splitChosen },
        tips: tipChoice, money: { bills: billList.length, netUsd: net, tipsUsd: tips }, languages: langRows, lbpSessions: lbp, repeatSessions: repeat }
    };
  };

  /* The shown venue's insights. Events: the server's answer for the period when given (opts.server,
     aal_insights_events, shared mode), else the events this device holds; extraEvents: the demo's
     sample history (insights-panel.js). */
  A.venueInsights = function (opts) {
    opts = opts || {};
    var m = A.published(), at = opts.at == null ? Date.now() : opts.at, rate = A.rateInfo ? A.rateInfo(at) : null, srv = opts.server;
    return A.computeInsights({ events: (opts.extraEvents || []).concat(srv ? srv.events || [] : A.events()), items: m.items, sections: m.sections, tables: opts.tables,
      at: at, days: opts.days || 30, rateAgeDays: rate && rate.updatedAt ? rate.ageDays : null,
      firstEventAt: srv ? srv.firstEventAt : null, deviceFirstSeen: srv ? srv.deviceFirstSeen : null });
  };
})(window);
