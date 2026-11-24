/* Sample history for the no-key demo's Insights tab: six weeks of guest sessions at the fictional
   Mayda, generated deterministically from the venue, the menu and the day (the same browser shows
   the same figures all day). It is never stored and never sent: insights-panel.js passes it to
   A.venueInsights next to the device's own events, only in demo mode and only for Mayda, and the
   tab labels it as sample history. A real venue (a key, or another restaurant's walk-in link)
   never sees it.

   A.demoInsightEvents({items, tables, at, venueId, days}) returns the events: qr_scan, item_view,
   ui_action (language, currency, filter, option, dwell, split, tip, rail), order_placed with dish
   lines (some bills revised once), bill_requested and payment_completed. Built in so the tab has
   something to say: a premium grill dish opened often and rarely ordered (the "steak" case), a
   staple ordered without being opened, two dishes nobody opens, one long read, a barely scanned
   table (9), a slow-paying table (8), Friday and Saturday nights, Arabic and LBP sessions, splits. */
(function (global) {
  'use strict';
  var A = global.Aalayna, DAY = 86400000, HOUR = 3600000, MIN = 60000;
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function pickWeighted(r, list, weight) {
    var total = 0, i; for (i = 0; i < list.length; i++) total += weight(list[i]);
    var x = r() * total; for (i = 0; i < list.length; i++) { x -= weight(list[i]); if (x <= 0) return list[i]; }
    return list[list.length - 1];
  }
  var offsetFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  /* Beirut wall time (day index in UTC days, minutes after midnight) as an instant */
  function beirutInstant(day, minutes) {
    var guess = day * DAY + minutes * MIN - 2 * HOUR, o = {};
    offsetFmt.formatToParts(new Date(guess)).forEach(function (p) { if (p.type !== 'literal') o[p.type] = +p.value; });
    var shown = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute);
    return guess + (day * DAY + minutes * MIN - shown);
  }
  function beirutDay(t) { var o = {}; offsetFmt.formatToParts(new Date(t)).forEach(function (p) { if (p.type !== 'literal') o[p.type] = +p.value; }); return Date.UTC(o.year, o.month - 1, o.day) / DAY; }
  function find(items, re) { return items.filter(function (x) { return re.test(x.name); }); }
  var DRINK = /\b(?:coffee|espresso|tea|juice|lemonade|water|soft drinks?|jallab|ayran|latte|pellegrino)\b/i;
  var SWEET = /\b(?:ashta|atayef|maamoul|halawet|fondant|cake|mouhalabieh|tamrieh|ice cream)\b/i;

  /* the dishes' parts in the story, chosen from whatever menu the demo has */
  function roles(items) {
    var food = items.filter(function (x) { return !DRINK.test(x.name); });
    var byPrice = food.slice().sort(function (a, b) { return b.price - a.price; });
    var steak = find(food, /steak|filet|fillet|cutlet/i).filter(function (x) { return x.price >= 10; })[0] || find(food, /mixed grill/i)[0] || byPrice[Math.min(1, byPrice.length - 1)];
    var staple = find(food, /^hummus\b|hummus beiruti/i)[0] || food.slice().sort(function (a, b) { return a.price - b.price; })[0];
    var long = find(food, /nayyeh|atayef|fatteh|fattet/i).filter(function (x) { return x !== steak && x !== staple; })[0] || food[Math.floor(food.length / 2)];
    var rest = food.filter(function (x) { return x !== steak && x !== staple && x !== long; });
    var ignored = rest.slice(-2);   // the last dishes of the menu: nobody opens them
    return { steak: steak, staple: staple, long: long, ignored: ignored };
  }

  A.demoInsightEvents = function (input) {
    var items = (input.items || []).filter(function (x) { return !x.archivedAt && x.available !== false && x.price > 0; });
    if (items.length < 4) return [];
    var at = input.at == null ? Date.now() : input.at, days = input.days || 42, venueId = input.venueId || 'demo';
    var tables = (input.tables && input.tables.length ? input.tables : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16']).map(String);
    var role = roles(items), today = beirutDay(at), r = rng(hash(venueId + '|' + today + '|' + items.map(function (x) { return x.id; }).join(',')));
    var out = [], n = 0, devices = [];
    function id(kind) { n++; return 'demo-' + kind + '-' + today + '-' + n; }
    function ev(type, t, s, payload, extra) {
      out.push({ eventId: id('e'), deviceId: s.device, sessionId: s.id, restaurantId: venueId, tableId: s.table, customerId: null,
        eventType: type, payload: payload, createdAt: new Date(t).toISOString(), demo: true });
      return out[out.length - 1];
    }
    /* how often a dish is opened, and how likely an opened dish ends on the bill */
    function baseWeight(x) {
      if (role.ignored.indexOf(x) >= 0) return 0;
      if (DRINK.test(x.name)) return (x.opts || []).length ? 1.6 : 0.5;
      return 1 + (hash(x.id) % 7) / 3;
    }
    var others = items.reduce(function (a, x) { return a + (x === role.steak || x === role.staple || x === role.long ? 0 : baseWeight(x)); }, 0);
    /* the steak takes about 7% of all opens, the long read 4%, the staple under 1% */
    function viewWeight(x) {
      if (x === role.steak) return others * 0.075; if (x === role.long) return others * 0.04; if (x === role.staple) return others * 0.008;
      return baseWeight(x);
    }
    function orderChance(x) { if (x === role.steak) return 0.1; if (x === role.long) return 0.3; return 0.5 + (hash(x.id + 'o') % 30) / 100; }
    function dwellFor(x) { var base = x === role.long ? 26 : x === role.steak ? 14 : 6 + hash(x.id + 'd') % 6; return Math.max(2, Math.round(base * (0.6 + r() * 0.8))); }
    var PER_DAY = [7, 5, 7, 9, 14, 15, 10];   // Monday ... Sunday
    /* the filter the menu serves worst is the one 18% of tables ask for (the demand-against-offer case) */
    var FILTER_USE = ['veg', 'nonuts', 'nodairy', 'light', 'protein'].map(function (k) { return { key: k, fit: A.dietFits ? items.filter(function (x) { return A.dietFits(x, k); }).length : 0 }; })
      .sort(function (a, b) { return a.fit - b.fit || a.key.localeCompare(b.key); })
      .map(function (f, i) { return { key: f.key, p: [0.18, 0.1, 0.07, 0.05, 0.04][i] }; });
    for (var back = days; back >= 1; back--) {
      var day = today - back, weekday = (new Date(day * DAY).getUTCDay() + 6) % 7, count = Math.round(PER_DAY[weekday] * (0.75 + r() * 0.5));
      for (var k = 0; k < count; k++) {
        var lunch = r() < 0.3, minutes = lunch ? 12 * 60 + Math.floor(r() * 180) : (r() < 0.55 ? 20 * 60 + 30 + Math.floor(r() * 90) : 19 * 60 + Math.floor(r() * 240));
        var t = beirutInstant(day, Math.min(minutes, 23 * 60 + 20)), table = pickWeighted(r, tables, function (x) { return x === '9' ? 0.08 : x === '12' || x === '5' ? 1.6 : 1; });
        var returning = devices.length > 20 && r() < 0.22, device = returning ? devices[Math.floor(r() * devices.length)] : id('d');
        if (!returning) devices.push(device);
        var s = { id: id('s'), device: device, table: table };
        ev('qr_scan', t, s, { tableId: table, userAgent: 'demo' });
        var lang = r(), lbp = r() < 0.24;
        if (lang < 0.2) ev('ui_action', t + 4000, s, { action: 'language', value: 'ar' });
        else if (lang < 0.28) ev('ui_action', t + 4000, s, { action: 'language', value: 'fr' });
        if (lbp) ev('ui_action', t + 6000, s, { action: 'currency', value: 'lbp' });
        FILTER_USE.forEach(function (f, i) { if (r() < f.p) ev('ui_action', t + 9000 + i * 500, s, { action: 'filter', value: f.key + ':on' }); });
        /* browsing: 2 to 6 dishes opened, each with a reading time and sometimes an option */
        var cursor = t + 20000, viewed = [], opens = 1 + Math.floor(r() * 4);
        for (var v = 0; v < opens; v++) {
          var x = pickWeighted(r, items, viewWeight);
          if (!viewWeight(x)) continue;
          ev('item_view', cursor, s, { itemId: x.id, categoryId: x.sec });
          var dwell = dwellFor(x);
          (x.opts || []).forEach(function (g) {
            if (r() < 0.45 && g.choices.length > 1) { var c = g.type === 'one' ? g.choices[1 + Math.floor(r() * r() * (g.choices.length - 1))] : g.choices[Math.floor(r() * g.choices.length)]; ev('ui_action', cursor + 2000, s, { action: 'option', value: g.name + ':' + c.n }); }
          });
          ev('ui_action', cursor + dwell * 1000, s, { action: 'dwell', value: x.id, n: dwell });
          cursor += (dwell + 5 + Math.floor(r() * 30)) * 1000;
          if (viewed.indexOf(x) < 0) viewed.push(x);
        }
        if (r() < 0.1) continue;   // looked, left, no bill
        /* the bill staff enter: what was opened and ordered, the staple, drinks */
        var lines = [];
        function line(x, q) { var l = lines.filter(function (y) { return y.itemId === x.id; })[0]; if (l) l.qty += q; else lines.push({ itemId: x.id, qty: q, unitPrice: x.price, currency: 'USD' }); }
        viewed.forEach(function (x) { if (r() < orderChance(x)) line(x, 1 + (r() < 0.3 ? 1 : 0)); });
        if (r() < 0.62) line(role.staple, 1);
        var food = items.filter(function (x) { return !DRINK.test(x.name) && !SWEET.test(x.name) && role.ignored.indexOf(x) < 0 && x !== role.steak; });
        if (!lines.length || r() < 0.5) line(food[Math.floor(r() * food.length)], 1);
        var drinks = items.filter(function (x) { return DRINK.test(x.name); });
        if (drinks.length) line(drinks[Math.floor(r() * drinks.length)], 1 + Math.floor(r() * 3));
        var orderId = id('chk'), opened = cursor + 5 * MIN, total = lines.reduce(function (a, l) { return a + l.unitPrice * l.qty; }, 0);
        function order(at2, list, revision) { var sum = list.reduce(function (a, l) { return a + l.unitPrice * l.qty; }, 0); ev('order_placed', at2, s, { orderId: orderId, revision: revision, change: revision > 1 ? 'updated' : 'opened', source: 'staff', items: list, total: Math.round(sum * 100) / 100, currency: 'USD', amountUsd: Math.round(sum * 100) / 100 }); }
        if (lines.length > 2 && r() < 0.25) { order(opened, lines.slice(0, lines.length - 1), 1); order(opened + 25 * MIN, lines, 2); }
        else order(opened, lines, 1);
        /* asking for the bill, then paying: whole or split, cash, card, Whish or at the till */
        var asked = opened + (45 + Math.floor(r() * 50)) * MIN;
        ev('bill_requested', asked, s, {});
        var parts = r() < 0.6 ? 1 : 2 + Math.floor(r() * 3), mode = parts === 1 ? 'all' : (r() < 0.55 ? 'even' : r() < 0.6 ? 'item' : 'amt');
        if (parts > 1) ev('ui_action', asked + 15000, s, { action: 'split', value: mode });
        var wait = Math.round((90 + r() * r() * 600) * (table === '8' ? 3.2 : 1)) * 1000, paidAt = asked + wait;
        for (var p = 0; p < parts; p++) {
          var rail = pickWeighted(r, ['cash', 'card', 'whish', 'pos'], function (x2) { return { cash: 46, card: 30, whish: 17, pos: 7 }[x2]; });
          var share = Math.round(total / parts * 100) / 100, tipRate = rail === 'cash' ? (r() < 0.5 ? 0 : 0.05) : [0.05, 0.1, 0.1, 0.15][Math.floor(r() * 4)];
          var tip = Math.round(share * tipRate * 100) / 100, usd = Math.round((share + tip) * 100) / 100;
          if (p === 0 && rail !== 'pos') { ev('ui_action', paidAt - 20000, s, { action: 'rail', value: rail }); ev('ui_action', paidAt - 15000, s, { action: 'tip', value: tipRate ? Math.round(tipRate * 100) + '%' : '0%' }); }
          var inLbp = lbp && rail === 'cash' && r() < 0.5;
          ev('payment_completed', paidAt + p * 40000, s, { orderId: orderId, paymentId: id('pay'), amount: inLbp ? Math.round(usd * 89500) : usd, currency: inLbp ? 'LBP' : 'USD',
            fxRateUsed: inLbp ? 89500 : null, amountUsd: usd, rail: rail, tip: inLbp ? Math.round(tip * 89500) : tip });
        }
      }
    }
    return out;
  };
  A.demoInsightRoles = roles;
})(window);
