/* Aalayna homepage, prototype V1, version E (the interactive version): the guest app on the table's phones, live.

   Built on style D (the photographic table). The three phones on the table no longer show screenshots: they show
   HTML replicas of the real guest app (guest.html with ?theme=balat, the Beirut cement-tile menu, as the film shows
   it), styled from its CSS, in English, French or Arabic, in dollars or lira. Three things can be tried, each only
   while its phone is held complete in the middle of the window, and each carries on down the table:
   - the menu: the language and the currency, and a dish tapped on or off the bill (the bill bar's total);
   - the split: how many of you, 2 to 6; the shares are the real app's (each share is the bill divided by the number
     of guests, rounded to the cent, and the last share takes the remainder, so they add up exactly to the bill);
   - the tip: none, 5, 10 or 15 percent of your share, rounded to the cent as the real app rounds it.
   One small state object (S, below) holds the choices; every amount on the page that depends on them is drawn from
   it: the receipt on the brass tray, the bill bar, the shares (and the ones that leave for the other guests), the
   payment, the Paid chip, the thank-you screen and the review card's Paid line. A reader who taps nothing sees the
   film's evening: the twelve dishes of the film's bill, $152.50, four guests, $38.13 each, a 10% tip, $41.94 paid.

   The data and the strings below are also read by tools/table-v1e-screens.js, which writes the screens' default HTML
   into table-v1e.html and ar/table-v1e.html, so the page reads complete without JavaScript (the controls are then
   visible and inert). */
(function (root, factory) {
  var APP = factory();
  if (typeof module === 'object' && module.exports) module.exports = APP; else root.AalaynaTableApp = APP;
})(this, function () {
  'use strict';
  var RATE = 89500;   // the rate the real app uses until the restaurant sets one (aalayna-store.js, Aalayna.rate)
  var TABLE = 12, SERVER = { en: 'Abou Karim', fr: 'Abou Karim', ar: 'أبو كريم' };

  /* The dishes, from the real menu pack (venues/mayda.json): section, the name in English, French and Arabic, the
     short name the printed receipt uses (English, Arabic), the price in dollars. */
  var D = {
    i07: ['grl', 'Shish Taouk', 'Chiche taouk', 'شيش طاووق', 'Shish taouk', 'شيش طاووق', 9],
    i03: ['brk', "Lahme Ba'ajine Lebanese", 'Lahm bi ajine libanais', 'لحم بعجين لبناني', "Lahm b'ajin", 'لحم بعجين', 1.5],
    i08: ['grl', 'Arayess Kafta', 'Arayes kafta', 'عرايس كفتة', 'Arayes kafta', 'عرايس كفتة', 16],
    i05: ['sal', 'Fattoush', 'Fattouche', 'فتوش', 'Fattoush', 'فتوش', 6.5],
    i06: ['app', 'Hummus', 'Houmous', 'حمص', 'Hummus', 'حمص', 5],
    i04: ['app', 'Batata w Kezbara', 'Pommes de terre à la coriandre', 'بطاطا بالكزبرة', 'Batata kezbara', 'بطاطا بالكزبرة', 7],
    i09: ['app', 'Warak Enab', 'Feuilles de vigne farcies', 'ورق عنب', 'Warak enab', 'ورق عنب', 6],
    i10: ['app', 'Moutabal Eggplant', 'Moutabal d’aubergine', 'متبل باذنجان', 'Moutabal', 'متبل', 5],
    i11: ['app', 'Mouhamara', 'Mouhammara', 'محمّرة', 'Mouhamara', 'محمّرة', 8.5],
    i14: ['bev', 'Laban Ayran', 'Laban ayran', 'لبن عيران', 'Ayran', 'عيران', 2.5],
    i15: ['bev', 'Fresh Lemonade', 'Citronnade fraîche', 'ليموناضة طازجة', 'Lemonade', 'ليموناضة', 3.5],
    i16: ['bev', 'Soft Drinks', 'Boissons gazeuses', 'مشروبات غازية', 'Soft drinks', 'مشروبات غازية', 2.5],
    k02: ['sal', 'Tabbouleh', 'Taboulé', 'تبولة', 'Tabbouleh', 'تبولة', 6],
    k03: ['sal', 'Raheb Salad', 'Salade raheb', 'سلطة الراهب', 'Raheb salad', 'سلطة الراهب', 7.5],
    k05: ['app', 'Hummus Meat and Almond', 'Houmous à la viande et aux amandes', 'حمص باللحمة واللوز', 'Hummus meat', 'حمص باللحمة', 11.5]
  };
  // The film's bill: the real app's sample check (aalayna-store.js, SEED_CHECK), twelve lines, $152.50.
  var SET = [['i07', 2], ['i03', 3], ['i08', 2], ['i05', 2], ['i06', 2], ['i04', 1], ['i09', 4], ['i10', 2], ['i11', 1], ['i14', 4], ['i15', 3], ['i16', 2]];
  // What the menu screen shows, as the real app lays it out: Salads, then Appetizers.
  var SECTIONS = [['sal', ['i05', 'k02', 'k03']], ['app', ['i06', 'k05']]];
  var CATS = { sal: ['Salads', 'Salades', 'سلطات'], app: ['Appetizers', 'Mezzés et entrées', 'مقبلات'],
    brk: ['All Day Breakfast', 'Petit-déjeuner toute la journée', 'ترويقة طوال النهار'],
    grl: ['Charcoal Grills', 'Grillades au charbon de bois', 'مشاوي على الفحم'], ong: ['On The Grill', 'Au gril', 'من الشوّاية'] };
  var CAT_ORDER = ['sal', 'app', 'brk', 'grl', 'ong'];
  var LI = { en: 0, fr: 1, ar: 2 };

  /* The app's own words. English and French are the real app's (guest.html); the Arabic is written for this page
     (docs/table-v1e-interactive.md lists it with back-translations). {x} is filled from the state. */
  var T = {
    en: { back: 'Back', table: 'Table 12', sub: 'Table 12 · Lebanese Grill', lang: 'Language', ccy: 'Currency', usd: 'USD $', lbp: 'LBP LL',
      filters: 'Dietary filters', openBill: 'Open the bill', splitTitle: 'How are we doing this?', splitSub: 'Nobody has to work out the maths',
      even: 'Evenly', mine: 'My items', custom: 'Custom amount', all: 'All of it', howMany: 'How many of you?', fewer: 'One fewer', more: 'One more',
      yourShare: 'YOUR SHARE', rest: '{rest} available for other guests. Pending cash is held until staff confirm or cancel it.',
      cont: 'Continue · {share}', powered: 'powered by', toPay: 'Total to pay · Table 12', billShare: 'Bill share', tip: 'Tip',
      tipFor: 'Something for {server}?', noTip: 'No tip', whishDesc: 'Opens with the amount filled in', card: 'Card', cash: 'Paying cash',
      cashDesc: 'Staff confirm after collection', cashMark: 'CASH', pay: 'Pay {pay}', thanks: 'Shukran.', paidVia: 'Paid via', tableL: 'Table',
      mailPh: 'WhatsApp (+code) or email', send: 'Send my receipt', offers: 'Send me offers from Mayda', rateQ: 'How was Mayda tonight?',
      paid: 'Paid {pay}', onBill: '{q} on the bill', offBill: 'not on the bill', tipOf: '{p} tip, {amt}' },
    fr: { back: 'Retour', table: 'Table 12', sub: 'Table 12 · Grillades libanaises', lang: 'Langue', ccy: 'Devise', usd: 'USD $', lbp: 'LBP LL',
      filters: 'Filtres alimentaires', openBill: 'Voir l’addition', splitTitle: 'On partage comment ?', splitSub: 'Personne n’a besoin de faire le calcul',
      even: 'À parts égales', mine: 'Mes plats', custom: 'Montant libre', all: 'Tout', howMany: 'Combien êtes-vous ?', fewer: 'Un de moins', more: 'Un de plus',
      yourShare: 'VOTRE PART', rest: '{rest} disponibles pour les autres convives. Les espèces en attente restent réservées jusqu’à ce que le personnel les confirme ou les annule.',
      cont: 'Continuer · {share}', powered: 'propulsé par', toPay: 'Total à payer · Table 12', billShare: 'Part de l’addition', tip: 'Pourboire',
      tipFor: 'Un pourboire pour {server} ?', noTip: 'Aucun', whishDesc: 'S’ouvre avec le montant déjà saisi', card: 'Carte', cash: 'Payer en espèces',
      cashDesc: 'Le personnel confirme à l’encaissement', cashMark: 'ESP.', pay: 'Payer {pay}', thanks: 'Merci.', paidVia: 'Payé par', tableL: 'Table',
      mailPh: 'WhatsApp (+indicatif) ou e-mail', send: 'Recevoir mon reçu', offers: 'Recevoir les offres de Mayda', rateQ: 'Comment était Mayda ce soir ?',
      paid: 'Payé {pay}', onBill: '{q} sur l’addition', offBill: 'pas sur l’addition', tipOf: 'Pourboire de {p}, {amt}' },
    ar: { back: 'رجوع', table: 'طاولة 12', sub: 'طاولة 12 · مشاوي لبنانية', lang: 'اللغة', ccy: 'العملة', usd: 'دولار $', lbp: 'ليرة ل.ل.',
      filters: 'فلاتر الحمية', openBill: 'افتح الفاتورة', splitTitle: 'كيف نتقاسم الفاتورة؟', splitSub: 'ولا أحد يحسب شيئاً',
      even: 'بالتساوي', mine: 'ما طلبتُه', custom: 'مبلغ آخر', all: 'كلّها عليّ', howMany: 'كم شخصاً على الطاولة؟', fewer: 'شخص أقل', more: 'شخص أكثر',
      yourShare: 'حصّتك', rest: 'يبقى {rest} لبقية الضيوف. الدفع النقدي المعلّق يبقى محجوزاً إلى أن يؤكّده الفريق أو يلغيه.',
      cont: 'متابعة · {share}', powered: 'بتقنية', toPay: 'المبلغ المستحق · طاولة 12', billShare: 'حصّتك من الفاتورة', tip: 'الإكرامية',
      tipFor: 'شي لـ{server}؟', noTip: 'بلا إكرامية', whishDesc: 'يفتح والمبلغ معبّأ', card: 'بطاقة', cash: 'الدفع نقداً',
      cashDesc: 'يؤكّده الفريق عند الاستلام', cashMark: 'نقد', pay: 'ادفع {pay}', thanks: 'شكراً.', paidVia: 'دُفعت عبر', tableL: 'الطاولة',
      mailPh: 'واتساب أو بريد إلكتروني', send: 'أرسلوا الإيصال', offers: 'أرسلوا لي عروض Mayda', rateQ: 'كيف كانت السهرة في Mayda؟',
      paid: 'مدفوع {pay}', onBill: '{q} على الفاتورة', offBill: 'ليس على الفاتورة', tipOf: 'إكرامية {p}، {amt}' }
  };
  // The printed receipt on the brass tray speaks the page's language (it is the restaurant's paper, not the app).
  var RC = {
    en: { head: 'Table 12 · {n} guests · 21:40', total: 'Total', foot: 'Shukran, see you soon' },
    ar: { head: 'طاولة 12 · {n} ضيوف · 21:40', total: 'المجموع', foot: 'شكراً، إلى اللقاء' }
  };

  /* ---------- Money, as the real app writes it (guest.html: fmtUSD, fmtLL, usd, ll, pct) ---------- */
  var LRI = '⁦', RLI = '⁧', PDI = '⁩';
  var fmtUSD = function (v, lang) { var s = '$' + v.toFixed(2); return lang === 'ar' ? LRI + s + PDI : s; };
  var group = function (n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  var fmtLL = function (n, lang) { var s = group(n); return lang === 'ar' ? s + ' ل.ل.' : 'LL ' + s; };
  var toLL = function (v) { return Math.round(v * RATE / 1000) * 1000; };   // lira to the nearest LL 1,000, as printed menus are
  var money = function (v, s) { return s.ccy === 'lbp' ? fmtLL(toLL(v), s.lang) : fmtUSD(v, s.lang); };
  var other = function (v, s) { return '≈ ' + (s.ccy === 'lbp' ? fmtUSD(v, s.lang) : fmtLL(Math.round(v * RATE), s.lang)); };
  var pct = function (n, lang) { return lang === 'fr' ? n + ' %' : n + '%'; };
  var fill = function (str, v) { return str.replace(/\{(\w+)\}/g, function (m, k) { return v[k] != null ? String(v[k]) : m; }); };

  /* ---------- The state, and everything that follows from it ---------- */
  var initial = function (page) {
    var q = {}; SET.forEach(function (l) { q[l[0]] = l[1]; });
    return { lang: page === 'ar' ? 'ar' : 'en', ccy: 'usd', q: q, people: 4, tip: 0.10 };
  };
  // The quantity a dish comes back with when it is tapped on again: the film's, or one.
  var usual = function (id) { for (var i = 0; i < SET.length; i++) if (SET[i][0] === id) return SET[i][1]; return 1; };
  var calc = function (s) {
    // The bill's lines, in the order the check was rung up (the film's twelve, then anything added).
    var order = SET.map(function (l) { return l[0]; });
    Object.keys(D).forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    var lines = [], cents = 0;
    order.forEach(function (id) {
      var q = s.q[id] || 0; if (!q) return;
      var c = Math.round(D[id][6] * 100) * q;
      lines.push({ id: id, q: q, cents: c }); cents += c;
    });
    // The real app's even split (guest.html, evenShareCents): each share is the bill over the guests, rounded to the
    // cent; the last share takes what is left, so the shares add up to the bill exactly.
    var n = s.people, even = n ? Math.round(cents / n) : 0, shares = [];
    for (var i = 0; i < n - 1; i++) shares.push(even);
    shares.push(cents - even * (n - 1));
    var share = even / 100, tipOf = function (r) { return Math.round(share * r * 100) / 100; };
    var tip = tipOf(s.tip), pay = share + tip;
    return { lines: lines, cents: cents, total: cents / 100, shares: shares, share: share, rest: (cents - even) / 100,
      others: shares.slice(1).map(function (c) { return c / 100; }), tip: tip, pay: pay, tipOf: tipOf };
  };
  // Every value a screen prints, formatted for the app's language and currency.
  var vars = function (s, c) {
    c = c || calc(s);
    var L = s.lang;
    return { total: money(c.total, s), share: money(c.share, s), shareLL: other(c.share, s),
      rest: money(c.rest, s), people: String(s.people), tip: money(c.tip, s), pay: money(c.pay, s), payLL: other(c.pay, s),
      t5: money(c.tipOf(0.05), s), t10: money(c.tipOf(0.10), s), t15: money(c.tipOf(0.15), s),
      p5: pct(5, L), p10: pct(10, L), p15: pct(15, L), server: SERVER[L],
      others: c.others.map(function (v) { return money(v, s); }), othersLL: c.others.map(function (v) { return other(v, s); }) };
  };
  var text = function (key, s, v) { return fill(T[s.lang][key], v || vars(s)); };
  var name = function (id, lang) { return D[id][1 + LI[lang]]; };
  // Balat's second line under a dish: its Arabic name, or, in Arabic, the name the menu was written with.
  var alt = function (id, lang) { return lang === 'ar' ? D[id][1] : D[id][3]; };
  var cat = function (id, lang) { return CATS[id][LI[lang]]; };
  var price = function (id, s) { return money(D[id][6], s); };

  /* The printed receipt (SVG, 200 units wide; its height follows its lines), in the page's language, in dollars. */
  var receipt = function (s, page) {
    var c = calc(s), ar = page === 'ar', R = RC[ar ? 'ar' : 'en'], esc = function (t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
    var y0 = 90, step = 21, n = c.lines.length, yr = y0 + (n - 1) * step + 11, H = yr + 80, out = [];
    var iso = function (t) { return ar ? RLI + t + PDI : t; };
    out.push('<text class="z-s w6 k caps" x="100" y="34" text-anchor="middle">Mayda</text>');
    var head = ar && s.people === 2 ? 'طاولة 12 · ضيفان · 21:40' : fill(R.head, { n: s.people });   // two guests: the Arabic dual
    out.push('<text class="z-s ' + (ar ? 'arb' : 'w5') + ' su" x="100" y="54" text-anchor="middle">' + esc(iso(head)) + '</text>');
    out.push('<path class="rule" d="M16 68h168"/>');
    c.lines.forEach(function (l, i) {
      var y = y0 + i * step, nm = D[l.id][ar ? 5 : 4], amt = fmtUSD(l.cents / 100, 'en');
      if (ar) out.push('<text class="z-s arb k" x="184" y="' + y + '" text-anchor="end">' + esc(RLI + RLI + nm + PDI + ' ×' + l.q + PDI) + '</text><text class="z-s tn k" x="16" y="' + y + '">' + amt + '</text>');
      else out.push('<text class="z-s w5 k" x="16" y="' + y + '">' + esc(l.q + '× ' + nm) + '</text><text class="z-s tn k" x="184" y="' + y + '" text-anchor="end">' + amt + '</text>');
    });
    out.push('<path class="rule" d="M16 ' + yr + 'h168"/>');
    var tot = fmtUSD(c.total, 'en');
    if (ar) out.push('<text class="z-b arb k" x="184" y="' + (yr + 24) + '" text-anchor="end">' + R.total + '</text><text class="z-b tn k" x="16" y="' + (yr + 24) + '">' + tot + '</text>');
    else out.push('<text class="z-b w6 k" x="16" y="' + (yr + 24) + '">' + R.total + '</text><text class="z-b w6 tn k" x="184" y="' + (yr + 24) + '" text-anchor="end">' + tot + '</text>');
    out.push('<text class="z-s ' + (ar ? 'arb' : 'w5') + ' su" x="100" y="' + (yr + 58) + '" text-anchor="middle">' + esc(iso(R.foot)) + '</text>');
    return { h: H, svg: out.join('') };
  };
  // The Paid chip's words (the app's language and currency), isolated so the amount keeps its side in Arabic.
  var paidLine = function (s) { var t = text('paid', s); return s.lang === 'ar' ? RLI + t + PDI : t; };

  return { RATE: RATE, TABLE: TABLE, D: D, SET: SET, SECTIONS: SECTIONS, CAT_ORDER: CAT_ORDER, T: T, initial: initial, usual: usual,
    calc: calc, vars: vars, text: text, name: name, alt: alt, cat: cat, price: price, receipt: receipt, paidLine: paidLine, fill: fill };
});

/* ---------- The state on the page: one object, S; every number the screens and the table print comes from it ---------- */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var APP = window.AalaynaTableApp, root = document.documentElement;
  var page = root.lang === 'ar' ? 'ar' : 'en';
  var S = APP.initial(page);
  var each = function (sel, fn, ctx) { Array.prototype.forEach.call((ctx || document).querySelectorAll(sel), fn); };
  var set = function (el, t) { if (el && el.textContent !== t) el.textContent = t; };
  var table = document.getElementById('table');
  if (!table) return;
  // The engine (below) sets the scroll ranges in which each phone is held, complete, in the middle of the window:
  // a control acts only inside its phone's range. Without the engine (reduced motion, no requestAnimationFrame), the
  // table is laid still and every control acts at any time.
  var UI = window.AalaynaTableUI = { S: S, ranges: {}, mids: {}, remeasure: null };
  var HERO = { menu: '.ob-menu', split: '.ob-split', pay: '.ob-pay' };
  var whose = function (el) {
    var f = el.closest('[data-for]'); if (f) return f.getAttribute('data-for');
    for (var k in HERO) if (el.closest(HERO[k])) return k;
    return null;
  };
  var inHold = function (k, y) { var r = UI.ranges[k]; return !r || (y >= r[0] && y <= r[1]); };
  UI.ok = function (el) { return !root.classList.contains('gate') || inHold(whose(el), window.scrollY || window.pageYOffset || 0); };
  // Called by the engine on every frame: the phone in its hold (and its caption's controls) take taps; the others do not.
  var liveNow = {};
  UI.gate = function (y) {
    for (var k in HERO) {
      var on = inHold(k, y);
      if (liveNow[k] === on) continue;
      liveNow[k] = on;
      each(HERO[k] + ', [data-for="' + k + '"]', function (el) { el.classList.toggle('live', on); }, table);
    }
  };
  // Under 1024 px (and on the phone stage) the screens' own pickers, stepper and tips are too small to tap: the
  // caption carries them at full size, so the screens' copies leave the tab order (the dishes stay: they are the
  // screen's own rows). Called again on every measure, so a resize moves the controls where they belong.
  UI.pin = function (on) {
    var small = on || !!(window.matchMedia && window.matchMedia('(max-width: 1023px)').matches);
    each('.screen [data-act]:not([data-act="dish"])', function (el) { if (small) el.setAttribute('tabindex', '-1'); else el.removeAttribute('tabindex'); }, table);
  };

  var rcLines = -1;
  var paint = function () {
    var c = APP.calc(S), v = APP.vars(S, c), L = S.lang, T = APP.T[L];
    v.langName = L.toUpperCase(); v.ccyName = T[S.ccy];
    for (var i = 0; i < 5; i++) { v['o' + i] = c.others[i] != null ? v.others[i] : ''; v['l' + i] = c.others[i] != null ? v.othersLL[i] : ''; }
    each('[data-app]', function (g) {
      if (g.getAttribute('lang') === L) return;
      g.setAttribute('lang', L); g.setAttribute('dir', L === 'ar' ? 'rtl' : 'ltr');
    }, table);
    each('.screen [data-t], .free [data-t]', function (el) { set(el, APP.fill(T[el.getAttribute('data-t')], v)); }, table);
    each('[data-f]', function (el) { set(el, APP.fill(el.getAttribute('data-f'), v)); }, table);
    each('[data-t-aria]', function (el) { el.setAttribute('aria-label', T[el.getAttribute('data-t-aria')]); }, table);
    each('[data-cat]', function (el) { set(el, APP.cat(el.getAttribute('data-cat'), L)); }, table);
    each('[data-dish]', function (b) {
      var id = b.getAttribute('data-dish'), q = S.q[id] || 0, nm = APP.name(id, L), pr = APP.price(id, S), a = b.querySelector('.g-mar');
      set(b.querySelector('.g-mn'), nm); set(a, APP.alt(id, L)); a.setAttribute('lang', L === 'ar' ? 'en' : 'ar');
      set(b.querySelector('.g-mp'), pr); set(b.querySelector('.g-qn'), '');
      b.classList.toggle('on', !!q); b.setAttribute('aria-pressed', q ? 'true' : 'false');
      b.setAttribute('aria-label', nm + ', ' + pr + ', ' + (q ? APP.fill(T.onBill, { q: q }) : T.offBill));
    }, table);
    each('select[data-act]', function (s) { var want = S[s.getAttribute('data-act')]; if (s.value !== want) s.value = want; }, table);
    each('[data-act="lang"][data-v], [data-act="ccy"][data-v]', function (b) { b.setAttribute('aria-pressed', S[b.getAttribute('data-act')] === b.getAttribute('data-v') ? 'true' : 'false'); }, table);
    each('[data-act="tip"]', function (b) { var on = +b.getAttribute('data-r') === S.tip; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }, table);
    each('[data-act="ppl"]', function (b) { var d = +b.getAttribute('data-d'), off = d < 0 ? S.people <= 2 : S.people >= 6; b.setAttribute('aria-disabled', off ? 'true' : 'false'); }, table);
    // The shares that leave for the other guests: one for each of them, each with its own amount.
    each('.share-o', function (el) { el.classList.toggle('off', +el.getAttribute('data-k') >= S.people - 1); }, table);
    // The receipt on the tray, in the page's language: its lines, its height, the guests at the table.
    var rc = table.querySelector('.rc-pz'), r = APP.receipt(S, page);
    if (rc) {
      var svg = rc.querySelector('svg');
      if (svg._k !== r.svg) { svg.innerHTML = r.svg; svg.setAttribute('viewBox', '0 0 200 ' + r.h); rc.style.setProperty('--ar', '200/' + r.h); svg._k = r.svg; }
    }
    // The Paid chip and the review card's Paid line say the same words: the chip lands there.
    var pl = APP.paidLine(S);
    each('.paid-line', function (t) { set(t, pl); t.setAttribute('x', L === 'ar' ? 132 : 162); }, table);
    each('.paid-tick', function (t) { t.setAttribute('d', L === 'ar' ? 'M190 20l6 6 12-12' : 'M96 20l6 6 12-12'); }, table);
    var grew = c.lines.length !== rcLines && rcLines >= 0;
    rcLines = c.lines.length;
    return grew;
  };
  var changed = function () { if (paint() && UI.remeasure) UI.remeasure(); };

  table.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!b || !UI.ok(b) || b.getAttribute('aria-disabled') === 'true') return;
    var a = b.getAttribute('data-act');
    if (a === 'dish') { var id = b.getAttribute('data-dish'); S.q[id] = S.q[id] ? 0 : APP.usual(id); }
    else if (a === 'lang' || a === 'ccy') S[a] = b.getAttribute('data-v');
    else if (a === 'ppl') S.people = Math.max(2, Math.min(6, S.people + (+b.getAttribute('data-d'))));
    else if (a === 'tip') S.tip = +b.getAttribute('data-r');
    changed();
  });
  table.addEventListener('change', function (e) {
    var s = e.target;
    if (!s.matches || !s.matches('select[data-act]')) return;
    if (UI.ok(s)) S[s.getAttribute('data-act')] = s.value;
    changed();
  });
  // Tabbing to a control brings its phone to the middle of the window first, where it takes keys.
  table.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!el.matches || !el.matches('[data-act]') || UI.ok(el)) return;
    var y = UI.mids[whose(el)];
    if (y != null) window.scrollTo({ top: y, behavior: 'instant' });
  });

  paint();
  UI.pin(false);
  each('[data-act][disabled]', function (el) { el.disabled = false; }, table);
  root.classList.add('ui');
})();

/* Aalayna homepage, prototype V1 (style D, photographic): the table's motion, written frame by frame from the scroll.

   One engine, the same in every browser. Once per frame it reads the scroll position, lets its own position follow it
   with a light smoothing (0.16 of the gap per frame, so wheel steps glide but never trail the finger), and for every
   track (a scroll range and a function of its progress, 0 to 1) writes a transform and an opacity to its layer.
   Nothing else is touched, so it all stays on the compositor. Ranges come from where things lie on the page (offsets,
   which transforms do not change), measured again when the window or the fonts change.

   What moves, and only where it serves the stretch's point (docs/table-v1c-storyboard.md):
   - Every object is set down as the reader reaches it: from 2.5rem away (the side of the chair it belongs to, the
     table's edge for the bill's tray), from scale .94, settling with the ease-out curve over 40% of its view range,
     staggered; its cast shadow catches up a beat later.
   - One chain carries the evening: the receipt lifts off its tray, travels down the table and becomes the bill on the
     split phone; ÷4 and the four shares come up; three shares leave for the other guests while yours lifts, travels
     and becomes the payment; the tip, the ways and the button come up; the button is pressed and becomes Paid; the
     paid chip lifts off the phone, travels and becomes the head of the review card; the five stars arrive one by one.
     Each travel has anticipation (a lift and a turn, its shadow falling away), an eased path with a slight arc, a
     landing that settles without bounce, and a follow-through (the shadow catching up, the screen taking it over).
   - The captions arrive line by line; beside the table they leave as their stretch goes. The figures count up once.
   With reduced motion nothing here runs and the table is simply laid. Without JavaScript nothing is hidden. Without
   requestAnimationFrame, an IntersectionObserver sets the objects down as they come into view (html.io). */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var UI = window.AalaynaTableUI || null;
  // iOS Safari shows :active (the buttons' press) only once the page listens for touches.
  document.addEventListener('touchstart', function () {}, { passive: true });
  var mm = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
  if (mm('(prefers-reduced-motion: reduce)')) return;
  var root = document.documentElement, each = function (sel, fn, ctx) { Array.prototype.forEach.call((ctx || document).querySelectorAll(sel), fn); };

  /* ---------- The figures count up once, to the value that was always in the page (as on the live site) ---------- */
  if ('IntersectionObserver' in window) {
    var count = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        count.unobserve(e.target);
        var el = e.target, text = el.textContent, m = text.match(/^([+-]?)(\d+)(.*)$/);
        if (!m || +m[2] < 5) return;
        var to = +m[2], t0 = null;
        el.setAttribute('aria-label', text);
        var tick = function (now) {
          if (t0 === null) t0 = now;
          var k = Math.min(1, (now - t0) / 900), v = Math.round(to * (1 - Math.pow(1 - k, 3)));
          el.textContent = m[1] + v + m[3];
          if (k < 1) requestAnimationFrame(tick); else { el.textContent = text; el.removeAttribute('aria-label'); }
        };
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.6 });
    each('[data-count]', function (el) { count.observe(el); });
  }

  if (!window.requestAnimationFrame) {
    if (!('IntersectionObserver' in window)) return;
    root.classList.add('io');
    var seen = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); seen.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -10% 0px' });
    each('.table .ob', function (el) { seen.observe(el); });
    return;
  }
  root.classList.add('js');
  if (UI) root.classList.add('gate');

  /* ---------- Curves and small helpers ---------- */
  // A cubic Bezier easing, solved for x by a few Newton steps: the site's two curves.
  var bez = function (x1, y1, x2, y2) {
    var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    return function (x) {
      if (x <= 0) return 0; if (x >= 1) return 1;
      var t = x;
      for (var i = 0; i < 6; i++) { var e = ((ax * t + bx) * t + cx) * t - x, d = (3 * ax * t + 2 * bx) * t + cx; if (Math.abs(e) < 1e-5 || !d) break; t -= e / d; }
      return ((ay * t + by) * t + cy) * t;
    };
  };
  var OUT = bez(.23, 1, .32, 1), INOUT = bez(.77, 0, .175, 1), MOVE = bez(.65, 0, .35, 1);
  var cl = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var seg = function (p, a, b) { return cl((p - a) / (b - a)); };
  var mix = function (a, b, t) { return a + (b - a) * t; };
  var dir = root.getAttribute('dir') === 'rtl' ? -1 : 1;
  var put = function (el, x, y, r, s, o) {
    var t = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0)' + (r ? ' rotate(' + r.toFixed(3) + 'deg)' : '') + (s !== 1 ? ' scale(' + s.toFixed(4) + ')' : '');
    if (el._t !== t) { el.style.transform = t; el._t = t; }
    var oo = o.toFixed(3);
    if (el._o !== oo) { el.style.opacity = oo; el._o = oo; }
  };
  // Where an element lies on the page, before any transform: offsets add up to the document.
  var box = function (el) {
    var x = 0, y = 0, w = el.offsetWidth, h = el.offsetHeight;
    for (var n = el; n; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    return { w: w, h: h, top: y, cx: x + w / 2, cy: y + h / 2 };
  };

  // A travel: anticipation (lift and turn, 0 to .14), the path (eased, with a slight arc, to .82), the landing (an
  // ease-out settle, to .94), the follow-through (the shadow catches up; the landing place takes over, .93 to 1).
  var travel = function (p, dx, dy, s, lift, arc, turn) {
    var x, y, r, k, h;
    if (p < .14) { var e = OUT(p / .14); x = 0; y = -lift * e; r = -turn * e; k = 1 + .03 * e; h = e; }
    else if (p < .82) { var t = MOVE((p - .14) / .68); x = dx * t + arc * Math.sin(Math.PI * t); y = mix(-lift, dy, t); r = mix(-turn, turn * .7, t); k = mix(1.03, s * 1.03, t); h = 1; }
    else { var q = OUT(seg(p, .82, .94)); x = dx; y = dy; r = turn * .7 * (1 - q); k = s * (1.03 - .03 * q); h = 1 - OUT(seg(p, .84, .97)); }
    return { x: x, y: y, r: r * dir, s: k, h: h, o: 1 - seg(p, .93, 1) };
  };
  var shadow = function (el, h, rem) { if (el) put(el, h * .5 * rem, h * 1.1 * rem, 0, 1 + .05 * h, 1 - .5 * h); };

  /* ---------- The tracks ---------- */
  var tracks = [], ranges = {};
  var add = function (a, b, fn) { tracks.push({ a: a, b: Math.max(b, a + 1), fn: fn, p: -1 }); };
  var shown = [];   // notes that have taken focus: shown whole at once

  var measure = function () {
    tracks = []; ranges = {};
    var vh = window.innerHeight, rem = parseFloat(getComputedStyle(root).fontSize) || 16, D = 2.5 * rem, wide = mm('(min-width: 768px)'), LIFT = wide ? .42 : .36;

    // On a phone the table is a pinned stage (html.pin): the boards lie on one strip that moves under it, each hero
    // held in the middle of the tabletop while its caption is read, and every hand-off plays inside the stage. The
    // scroll is a timeline of stretches: each hero holds for HOLD, then hands off to the next over HAND (about
    // 115vh a stretch in all). Every range below is taken from this timeline instead of from where things lie.
    var table = document.getElementById('table'), pin = table && table.querySelector('.pin');
    var PIN = !wide && !!pin;
    root.classList.toggle('pin', PIN);
    if (UI) UI.pin(PIN);
    // (On the stage the strip keeps its length while it is measured again: emptying it would clamp the scroll.)
    if (table && !PIN) table.style.height = '';
    each('.table .board', function (bd) { bd.style.transform = ''; bd._t = null; bd.style.removeProperty('--lp'); });
    each('.table .note', function (n) { n.style.transform = ''; n.style.opacity = ''; n._t = n._o = null; });
    var heroEls = Array.prototype.filter.call(document.querySelectorAll('.table .ob.hero'), function (el) { return el.offsetWidth; });
    var HOLD = .35 * vh, HAND = .85 * vh, STEP = HOLD + HAND, T0 = 0, pinH = 0;
    var holdAt = function (k) { return T0 + k * STEP; };
    var hand = function (k) { return [T0 + k * STEP + HOLD, T0 + (k + 1) * STEP]; };
    var heroOf = function (el) { var ob = el.closest('.ob'); if (!ob.classList.contains('hero')) ob = ob.closest('.board').querySelector('.ob.hero'); return heroEls.indexOf(ob); };
    // Where an element lies inside the pinned stage (the stage itself moves when stuck, so offsets stop there).
    var rel = function (el) { var y = 0, h = el.offsetHeight; for (var n = el; n && n !== pin; n = n.offsetParent) y += n.offsetTop; return { cy: y + h / 2, top: y }; };
    if (PIN) {
      var head0 = document.querySelector('.top');
      pinH = pin.offsetHeight;
      T0 = box(table).top - (head0 ? head0.offsetHeight : 0);
      table.style.height = Math.round((heroEls.length - 1) * STEP + .45 * vh + pinH) + 'px';
      var cap = (parseFloat(getComputedStyle(pin).getPropertyValue('--cap')) || 40) / 100, stageC = pinH * (cap + (1 - cap) / 2);
      var tys = heroEls.map(function (h) { return stageC - rel(h).cy; });
      var boards = Array.prototype.slice.call(pin.querySelectorAll('.board'));
      boards.forEach(function (bd) { bd.style.setProperty('--lp', (-rel(bd).top) + 'px'); });
      // Where the chain travels (the bill, your share, the Paid chip), the table moves under the traveller at the
      // traveller's pace, so it stays in the stage from lift to landing.
      var PAN = { 2: [.06, .62], 3: [.06, .62], 4: [.16, .62] };
      var last = heroEls.length - 1, endY = hand(last - 1)[1] + vh;
      add(T0 - vh, endY, function (p) {
        var y = T0 - vh + p * (endY - T0 + vh), ty = tys[0];
        for (var k = 0; k < last; k++) {
          var h = hand(k);
          if (y >= h[1]) ty = tys[k + 1];
          else if (y > h[0]) { var pw = PAN[k] || [.28, .84]; ty = mix(tys[k], tys[k + 1], MOVE(seg(y, h[0] + pw[0] * HAND, h[0] + pw[1] * HAND))); break; }
          else break;
        }
        for (var i = 0; i < boards.length; i++) put(boards[i], 0, ty, 0, 1, 1);
      });
    }

    // The timing rule (founder, 16 October): every hero is complete when it is centred. It arrives and every part of it
    // comes up while its centre climbs from the foot of the window to 50% (its shadow may follow through a moment
    // longer); from 50% to 32% nothing on it moves, so its caption is read beside a finished object; only then does the
    // next travel begin, and it lands early enough that the next hero is complete, in turn, when that one is centred.
    // On the phone stage the same rule runs on the timeline: a hero arrives and completes inside the hand-off that
    // brings it, holds complete for the whole hold, and leaves only once the hold is over.
    var NAMES = ['qr', 'menu', 'bill', 'split', 'pay', 'review', 'again', 'price', 'reserved'];
    var C = heroEls.map(function (h) { return box(h).cy; });
    var done = {};
    var mark = function (k, y) { var n = NAMES[k]; if (n) done[n] = Math.max(done[n] == null ? -1e9 : done[n], y); };
    // When hero k is set down.
    var arrive = function (k) {
      if (PIN) { if (!k) return [T0 - .8 * vh, T0 - .3 * vh]; var h = hand(k - 1); return [h[0] + .2 * HAND, h[0] + .58 * HAND]; }
      return [C[k] - .92 * vh, C[k] - .68 * vh];
    };
    // When the parts of hero k come up (from: the landing that starts them).
    var reveal = function (k, from) {
      var z = PIN ? (k ? hand(k - 1)[0] + .8 * HAND : T0 - .04 * vh) : C[k] - .51 * vh;
      var a = from != null ? from : (PIN ? (k ? hand(k - 1)[0] + .62 * HAND : T0 - .32 * vh) : C[k] - .76 * vh);
      return [a, z];
    };
    // Part j of n inside a window: an even stagger, each part over a share f of the window.
    var part = function (w, n, j, f) { var d = (w[1] - w[0]) * (f || .4), a = w[0] + (n > 1 ? j * (w[1] - w[0] - d) / (n - 1) : 0); return [a, a + d]; };
    // When hero k may start to leave (its hold is over), and when a travel into hero k must land, leaving R of the
    // window (vh) for the parts that the landing starts.
    var leave = function (k) { return PIN ? hand(k)[0] + .06 * HAND : C[k] - .32 * vh; };
    var land = function (k, R) { return PIN ? hand(k - 1)[0] + .62 * HAND : C[k] - .51 * vh - R * vh; };

    // Setting down: every object on the table, hero or quiet.
    each('.table .ob', function (ob) {
      if (!ob.offsetWidth) return;
      var pc = ob.querySelector('.pc'), sh = ob.querySelector(':scope > .osh'), k = heroOf(ob);
      var fx = (parseFloat(ob.getAttribute('data-fx')) || 0) * D * dir, fy = (parseFloat(ob.getAttribute('data-fy')) || 0) * D;
      if (!fx && !fy) fy = D;
      var i = parseFloat(ob.getAttribute('data-i')) || 0, w = arrive(k), a = w[0] + i * .08 * (w[1] - w[0]), z = w[1];
      mark(k, a + .75 * (z - a));   // the piece is in place; its shadow follows through to z
      add(a, z, function (p) {
        var e = OUT(p);
        put(pc, fx * (1 - e), fy * (1 - e), 0, .94 + .06 * e, cl(p / .22));   // a real object is opaque: it arrives, it does not materialise
        if (sh) { var q = OUT(seg(p, .18, 1)); put(sh, (fx + .5 * rem) * (1 - q), (fy + rem) * (1 - q), 0, 1, cl((p - .18) / .5)); }
      });
    });

    // Layers that come up in turn on a hero once it is down: the menu's slices, the regulars, the price's rows.
    each('.ob-menu, .ob-again, .ob-price', function (ob) {
      var k = heroOf(ob), w = reveal(k), els = ob.querySelectorAll('.scr-head, .dish, .reg-row, .pr-row');
      Array.prototype.forEach.call(els, function (el, j) {
        var r = part(w, els.length, j, .35); mark(k, r[1]);
        add(r[0], r[1], function (p) { var e = OUT(p); put(el, 0, .5 * rem * (1 - e), 0, 1, e); });
      });
    });
    // The QR card: one red line passes down its code as the card comes up to the middle.
    each('.ob-qr .scan i', function (el) {
      var w = reveal(0), hh = el.parentNode.offsetHeight; mark(0, w[1]);
      add(w[0], w[1], function (p) { put(el, 0, mix(-.03, 1, p) * hh, 0, 1, p <= 0 || p >= 1 ? 0 : 1 - seg(p, .85, 1) * 1); });
    });

    // The chain. A link starts once the hero it leaves has held (leave) and lands so that the hero it reaches can come
    // up whole before it is centred (land).
    var link = function (key, el, s0, R) {
      var goal = document.getElementById(el.getAttribute('data-go'));
      if (!goal || !el.offsetWidth) return null;
      var a = box(el), b = box(goal), k = heroOf(goal), s1 = land(k, R);
      if (s1 - s0 < .3 * vh) s1 = s0 + .3 * vh;   // never a snap; the stretch should be long enough for this not to happen
      ranges[key] = [Math.round(s0), Math.round(s1)];
      mark(k, s1);
      return { a: s0, b: s1, k: k, dx: b.cx - a.cx, dy: b.cy - a.cy, sw: b.w / a.w, sh: b.h / a.h };
    };

    // 1. The receipt becomes the bill on the split phone.
    var rc = document.querySelector('.rc-go'), split = document.querySelector('.ob-split');
    var L1 = rc && link('bill', rc, leave(heroOf(rc)), .22);
    if (L1) {
      var rsh = rc.querySelector('.rc-sh'), head = split.querySelector('.scr-head'), sc1 = Math.min(L1.sw, L1.sh);
      add(L1.a, L1.b, function (p) {
        var m = travel(p, L1.dx, L1.dy, sc1, .75 * rem, 2.5 * rem * dir, 2.4);
        put(rc, m.x, m.y, m.r, m.s, m.o); shadow(rsh, m.h, rem);
        var e = OUT(seg(p, .9, 1)); put(head, 0, .25 * rem * (1 - e), 0, 1, e);
      });
      // The split screen comes up in slices, the way the app draws it: the question, the ways to split, how many of
      // you, your share (and, under it, the three shares that are about to leave), the rest held for the others, the
      // button.
      var rows = [];
      each('.sp-row', function (el) { rows.push([el]); }, split);
      rows.splice(3, 0, Array.prototype.slice.call(split.querySelectorAll('.share > .sv')));
      var w1 = reveal(L1.k, L1.b);
      rows.forEach(function (els, j) {
        var r = part(w1, rows.length, j, .35); mark(L1.k, r[1]);
        els.forEach(function (el) { add(r[0], r[1], function (p) { var e = OUT(p); put(el, 0, .6 * rem * (1 - e), 0, .985 + .015 * e, e); }); });
      });

      // 2. Three shares leave for the other guests; yours becomes the payment.
      var mine = split.querySelector('.share-me'), pay = document.querySelector('.ob-pay');
      var L2 = mine && link('share', mine, leave(L1.k), .2);
      if (L2) {
        var w = mine.offsetWidth, amt = pay.querySelector('.pay-amt'), msh = mine.querySelector('.go-sh');
        // The other guests' shares (one to five of them, as many as the stepper says) slide out from under yours,
        // each toward its own guest's seat, turning, and fade as they go.
        var away = [[-1.2, -.35, -9], [1.25, -.55, 8], [-1.05, .7, -6], [1.15, .62, 7], [-.3, -1.05, -4]];
        each('.share-o', function (el) {
          var k = +el.getAttribute('data-k'), v = away[k];
          add(L2.a, L2.b, function (p) {
            var q = seg(p, .03 + k * .06, .5 + k * .06), e = INOUT(q);
            put(el, v[0] * w * e * dir, v[1] * w * e, v[2] * e * dir, 1 - .12 * e, 1 - seg(q, .35, 1));
          });
        }, split);
        add(L2.a, L2.b, function (p) {
          var m = travel(p, L2.dx, L2.dy, L2.sw, .4 * rem, -2 * rem * dir, 1.6);
          put(mine, m.x, m.y, m.r, m.s, m.o); if (msh) put(msh, 0, 0, 0, 1, m.h * m.o);
          var e = OUT(seg(p, .9, 1)); put(amt, 0, .2 * rem * (1 - e), 0, 1, e);
        });
        // The total, the tip, the ways to pay and the button come up in turn.
        var w2 = reveal(L2.k, L2.b), prs = pay.querySelectorAll('.pay-row');
        Array.prototype.forEach.call(prs, function (el) {
          var r = part(w2, prs.length, +el.getAttribute('data-k'), .35); mark(L2.k, r[1]);
          add(r[0], r[1], function (p) { var e = OUT(p); put(el, 0, .5 * rem * (1 - e), 0, 1, e); });
        });

        // 3. Once the payment has held, Pay is pressed and becomes Paid; the chip lifts off and becomes the head of
        // the review card.
        var chip = pay.querySelector('.paid-go'), btn = pay.querySelector('.pay-btn'), thanks = pay.querySelector('.pay-thanks'), review = document.querySelector('.ob-review');
        var pa = leave(L2.k), pz = pa + (PIN ? .1 * HAND : .1 * vh);
        var L3 = chip && link('paid', chip, pz, .22);
        if (L3) {
          var landed = review.querySelector('.rv-paid'), k3 = Math.min(L3.sw, L3.sh), csh = chip.querySelector('.go-sh');
          ranges.paid[0] = Math.round(pa);
          // The press: the button sinks a little and turns into the green Paid chip.
          add(pa, pz, function (p) {
            var dn = Math.sin(Math.PI * seg(p, 0, .6)) * .03;
            if (p < 1) { put(chip, 0, 0, 0, 1 - dn, OUT(seg(p, .35, .8))); }
            if (p > 0) put(btn, 0, 0, 0, 1 - dn, 1 - seg(p, .35, .8));   // at 0 the button is the reveal's
          });
          add(L3.a, L3.b, function (p) {
            // Until the lift, the press (above) holds the chip; the thanks and the card's head wait.
            if (p > 0) { var m = travel(p, L3.dx, L3.dy, k3, .6 * rem, 3 * rem * dir, 3); put(chip, m.x, m.y, m.r, m.s, m.o); if (csh) put(csh, 0, 0, 0, 1, m.h * m.o); }
            var f = OUT(seg(p, .14, .34)); put(thanks, 0, .5 * rem * (1 - f), 0, 1, f);
            var e = OUT(seg(p, .9, 1)); put(landed, 0, 0, 0, 1, e);
          });
          // 4. The five stars, one by one, all in before the card is centred.
          var w3 = reveal(L3.k, L3.b), sts = review.querySelectorAll('.star');
          Array.prototype.forEach.call(sts, function (el, j) {
            var r = part(w3, sts.length, j, .32); mark(L3.k, r[1]);
            add(r[0], r[1], function (p) { var e = OUT(p); put(el, 0, .3 * rem * (1 - e), 0, .55 + .45 * e, cl(p / .6)); });
          });
          ranges.stars = [Math.round(w3[0]), Math.round(w3[1])];
        }
      }
    }

    // On the pinned stage the caption of the stretch in view stands alone above the tabletop. It is there, still, for
    // the whole hold; as its hero's travel begins it steps back (dimmed to 55%, a little up) but stays, so the cream
    // band is never empty while the next hero arrives; it leaves upward only as the next caption lands from below,
    // once that hero is in place and complete (the two cross for a moment, the old one already going).
    var notes = PIN ? Array.prototype.slice.call(pin.querySelectorAll('.stretch > .note')) : [];
    notes.forEach(function (note, k) {
      var a = k ? hand(k - 1)[0] : T0 - vh, z = k < notes.length - 1 ? hand(k)[1] : T0 + 99 * vh, more = k < notes.length - 1;
      add(a, z, function (p) {
        var y = a + p * (z - a);
        var i = k ? OUT(seg(y, hand(k - 1)[0] + .84 * HAND, hand(k - 1)[0] + .94 * HAND)) : 1;
        var d = more ? INOUT(seg(y, hand(k)[0] + .28 * HAND, hand(k)[0] + .4 * HAND)) : 0;
        var o = more ? OUT(seg(y, hand(k)[0] + .86 * HAND, hand(k)[0] + .94 * HAND)) : 0;
        put(note, 0, .9 * rem * (1 - i) - .25 * rem * d - .65 * rem * o, 0, 1, i * (1 - .45 * d) * (1 - o));
        // Its controls take a tap only once it is in view (an arriving or leaving caption never catches one).
        var up = i > .6 && o < .4;
        if (note._up !== up) { note._up = up; note.classList.toggle('up', up); }
      });
    });
    // The captions beside the table: line by line as their note arrives; they leave as their stretch's hold ends.
    if (!PIN) each('.note', function (note) {
      var b = box(note), kids = note.children;
      Array.prototype.forEach.call(kids, function (el, j) {
        var a = b.top - .9 * vh + j * .035 * vh;
        add(a, a + .22 * vh, function (p) { if (note._shown) return put(el, 0, 0, 0, 1, 1); var e = OUT(p); el._in = e; put(el, 0, rem * (1 - e), 0, 1, e * (el._out == null ? 1 : el._out)); });
        if (wide) {
          var o = b.cy - .3 * vh + j * .02 * vh;
          add(o, o + .2 * vh, function (p) { if (note._shown) return; var e = 1 - p; el._out = e; put(el, 0, -rem * p, 0, 1, (el._in == null ? 1 : el._in) * e); });
        }
      });
    });

    // Every hand-off, chain or not, by the same rule, so the stills can be shot at the same points of each; the
    // chain's own ranges win. The moments each hero is complete (done) and centred (hold) are published for the shots.
    var hn = ['poster-qr', 'qr-menu', 'menu-bill', 'bill-split', 'split-pay', 'pay-review', 'review-again', 'again-price', 'price-close'];
    var chain = { 'bill-split': 'bill', 'split-pay': 'share', 'pay-review': 'paid' };
    var hold = {};
    hn.forEach(function (n, i) {
      if (!heroEls[i]) return;
      hold[NAMES[i]] = Math.round(PIN ? holdAt(i) + .2 * HOLD : C[i] - .5 * vh);
      if (chain[n] && ranges[chain[n]]) { ranges[n] = ranges[chain[n]]; return; }
      var a = i ? leave(i - 1) : (PIN ? T0 - vh : 0), z = PIN ? (i ? hand(i - 1)[1] : T0) : C[i] - .5 * vh;
      ranges[n] = [Math.round(Math.max(0, a)), Math.round(Math.max(a + 1, z))];
    });
    // The holds in which each interactive phone takes taps (version E), and where Tab brings it.
    if (UI) {
      var hk = { menu: 1, split: 3, pay: 4 };
      for (var nm in hk) {
        var hi = hk[nm]; if (!heroEls[hi]) continue;
        // On the stage a phone takes taps for as long as it is the current one: from the moment it is complete (its
        // reveal ends at .8 of the hand-off that brings it) until its own hand-off begins (the menu's table starts
        // to move at .28 of its hand-off; your share and the Pay press leave at .06). Beside the table, its hold.
        UI.ranges[nm] = PIN ? [hand(hi - 1)[0] + .8 * HAND, hand(hi)[0] + (nm === 'menu' ? .28 : .06) * HAND] : [C[hi] - .5 * vh, C[hi] - (nm === 'menu' ? .1 : .32) * vh];
        UI.mids[nm] = Math.round(PIN ? holdAt(hi) + .5 * HOLD : C[hi] - .41 * vh);
      }
      root.setAttribute('data-live', JSON.stringify(UI.ranges));
      UI.gate(window.scrollY || window.pageYOffset || 0);
    }
    for (var dn in done) done[dn] = Math.round(done[dn]);
    root.setAttribute('data-done', JSON.stringify(done));
    root.setAttribute('data-hold', JSON.stringify(hold));
    root.setAttribute('data-ranges', JSON.stringify(ranges));
    tracks.forEach(function (t) { t.p = -1; });
    apply(cur);
  };

  // Apply every track at a scroll position. Tracks are in page order, so a later one (the chain's handover) wins.
  var apply = function (y) {
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i], p = cl((y - t.a) / (t.b - t.a));
      if (p === t.p) continue;
      t.p = p; t.fn(p);
    }
  };

  /* ---------- The loop: follow the scroll, smoothly, only while it is moving ---------- */
  var cur = window.scrollY || window.pageYOffset || 0, running = false;
  var frame = function () {
    var target = window.scrollY || window.pageYOffset || 0, d = target - cur;
    if (UI) UI.gate(target);
    cur = Math.abs(d) < .5 ? target : cur + d * .16;
    apply(cur);
    if (cur !== target) requestAnimationFrame(frame); else running = false;
  };
  var go = function () { if (!running) { running = true; requestAnimationFrame(frame); } };
  window.addEventListener('scroll', go, { passive: true });
  var t;
  window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(measure, 120); });
  window.addEventListener('load', measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  if (UI) UI.remeasure = measure;
  // Tabbing into a note shows all of it at once: never focus something still on its way in.
  document.addEventListener('focusin', function (e) {
    var n = e.target.closest ? e.target.closest('.note') : null;
    if (n && !n._shown) { n._shown = true; Array.prototype.forEach.call(n.children, function (el) { put(el, 0, 0, 0, 1, 1); }); }
  });
  measure();
})();
