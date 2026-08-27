/* ============================================================================
   aalayna — shared data layer
   ----------------------------------------------------------------------------
   Stands in for the backend so the three apps are one system instead of three
   demos. Every rule here is the rule the real backend has to implement.

     editor    reads/writes DRAFT, calls publish()
     diner     reads PUBLISHED only, calls settle()
     dashboard reads SETTLEMENTS and TIPS

   Publishing creates an immutable version. Diners never see a draft.
   Settlement state only ever moves forward, and only on a provider confirmation
   or an operator action — never because a diner came back to a page.
   ========================================================================== */
(function (global) {
  'use strict';

  var K = { draft: 'aal.draft', live: 'aal.live', settle: 'aal.settle', tips: 'aal.tips',
            venue: 'aal.venue' };

  /* ---------- venue identity -------------------------------------------
     The walk-in trick: open any app with ?venue=Roadster's&place=Dbayeh and
     the whole system rebrands to that restaurant on this device. The QR card
     generator writes these params so an owner scans straight into "their" demo. */
  var DEFAULT_VENUE = { name: 'Hallab 1881', place: 'Kasr El Helou',
                        est: 'EST. 1881 · TRIPOLI', heritage: 1 };
  function venueFromURL() {
    try {
      var q = new URLSearchParams(global.location.search);
      var n = (q.get('venue') || '').trim();
      if (!n) return null;
      return { name: n.slice(0, 40), place: (q.get('place') || '').trim().slice(0, 40),
               est: '', heritage: 0 };
    } catch (e) { return null; }
  }

  /* ---------- canonical seed ---------------------------------------------
     One item shape for all three apps. The editor uses a subset, the diner app
     uses the lot. Sections carry the service window; items never do.          */
  var SEED_SECTIONS = [
    { id: 'brk', name: 'Breakfast',       win: 'brkf' },
    { id: 'mez', name: 'Mezze & Grill',   win: 'all'  },
    { id: 'swt', name: 'Knefeh & Sweets', win: 'all'  },
    { id: 'drk', name: 'Drinks',          win: 'all'  }
  ];

  function it(id, sec, name, desc, price, ing, al, kcal, pr, ft, cb, extra) {
    var o = { id: id, sec: sec, name: name, desc: desc, price: price,
              ing: ing, al: al, kcal: kcal, pr: pr, ft: ft, cb: cb,
              conf: 1, fr: 1, ar: 1, cust: 0, adds: [] };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  var SEED_ITEMS = [
    it('i01','brk',"Foul & Hummus plate","Fava beans, chickpeas, tahini, olive oil, cumin",5.50,
       ['fava beans','chickpeas','tahini','olive oil','cumin','lemon','bread'],['sesame','gluten'],430,15,19,52),
    it('i02','brk',"Egg Awarma","Baladi eggs, preserved lamb confit, ghee",7.00,
       ['eggs','lamb awarma','ghee','pepper'],['egg','dairy'],520,28,41,3),
    it('i03','brk',"Lahm b'Ajin · 4 pieces","Minced lamb, tomato, onion, pomegranate molasses, pine nuts",6.00,
       ['flour','minced lamb','tomato','onion','pomegranate molasses','pine nuts'],['gluten','nuts'],610,24,26,68),
    it('i04','brk',"Fatteh b'Laban","Chickpeas, garlic yogurt, fried bread, pine nuts",6.50,
       ['chickpeas','yogurt','garlic','fried bread','pine nuts','ghee'],['dairy','gluten','nuts'],560,19,28,57,{ar:0}),

    it('i05','mez',"Tabbouleh","Parsley, bulgur, tomato, onion, lemon, olive oil",6.00,
       ['parsley','bulgur','tomato','onion','lemon','olive oil'],['gluten'],190,4,11,21),
    it('i06','mez',"Hummus Beiruti","Chickpeas, tahini, garlic, lemon, hot pepper",5.00,
       ['chickpeas','tahini','garlic','lemon','hot pepper','olive oil'],['sesame'],310,11,20,24),
    it('i07','mez',"Mixed Grill platter","Kabab, shish taouk, lamb chops, fries",16.00,
       ['lamb','chicken','beef','garlic','potato','sunflower oil'],[],1140,78,72,44,
       { cust:1, adds:[{n:'Extra lamb chop',p:4.5},{n:'Garlic toum',p:.75},
                       {n:'Grilled tomato & onion',p:1.25},{n:'Swap fries for salad',p:0}] }),
    it('i08','mez',"Arayes","Grilled pita, spiced minced lamb, onion, parsley",7.50,
       ['pita bread','minced lamb','onion','parsley','spices'],['gluten'],640,31,34,52,{fr:0,ar:0}),

    it('i09','swt',"Knefeh b'Jebne + kaakeh","Akkawi cheese, semolina, ghee, sugar syrup, sesame kaakeh",4.50,
       ['akkawi cheese','semolina','ghee','sugar syrup','sesame kaakeh'],['dairy','gluten','sesame'],720,21,33,88,
       { cust:1, adds:[{n:'Extra ashta',p:1.5},{n:'Double kaakeh',p:1},
                       {n:'Hold the syrup',p:0},{n:'Pistachio crust',p:1.25}] }),
    it('i10','swt',"Halawet el Jeben","Sweet cheese dough, ashta cream, rose syrup, pistachio",4.00,
       ['sweet cheese dough','ashta cream','rose syrup','pistachio'],['dairy','gluten','nuts'],480,11,19,66),
    it('i11','swt',"Baklava assortment · 250g","Filo pastry, pistachio, cashew, ghee, sugar syrup",8.00,
       ['filo pastry','pistachio','cashew','ghee','sugar syrup'],['nuts','gluten','dairy'],1030,14,58,118),
    it('i12','swt',"Ashta ice cream","Milk, cream, mastic, sugar, pistachio crust",3.50,
       ['milk','cream','mastic','sugar','pistachio'],['dairy','nuts'],390,7,22,41),

    it('i13','drk',"Espresso","Single origin, pulled to order",2.00,['coffee'],[],5,0,0,1),
    it('i14','drk',"Lebanese coffee","Rakweh for two, orange blossom water",2.50,
       ['coffee','orange blossom water','sugar'],[],45,0,0,11,
       { cust:1, adds:[{n:'Ziyede — sweet',p:0},{n:'Wasat — medium',p:0},{n:'Murra — no sugar',p:0}] }),
    it('i15','drk',"Jallab","Date molasses, rose water, pine nuts, raisins",3.00,
       ['date molasses','grape molasses','rose water','pine nuts','raisins'],['nuts'],290,3,6,58),
    it('i16','drk',"Fresh lemonade w' mazaher","Lemon, sugar, orange blossom water, mint",3.00,
       ['lemon','sugar','orange blossom water','mint'],[],130,0,0,33,{fr:0,ar:0})
  ];

  /* the open check the diner sees — in production this comes from the POS */
  var SEED_CHECK = [
    { id:'i07', q:2, p:32.00 }, { id:'i03', q:3, p:18.00 }, { id:'i08', q:2, p:15.00 },
    { id:'i05', q:2, p:12.00 }, { id:'i06', q:2, p:10.00 }, { id:'i04', q:1, p:6.50 },
    { id:'i09', q:4, p:18.00 }, { id:'i10', q:2, p:8.00 },  { id:'i11', q:1, p:8.00 },
    { id:'i14', q:4, p:10.00 }, { id:'i15', q:3, p:9.00 },  { id:'i16', q:2, p:6.00 }
  ];

  /* ---------- plumbing ---------------------------------------------------- */
  function read(k, fallback) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    fire(k);
  }
  var subs = [];
  function fire(k) { subs.forEach(function (f) { try { f(k); } catch (e) {} }); }
  // storage events only fire in OTHER tabs, which is exactly the cross-app case
  global.addEventListener('storage', function (e) { if (e.key && e.key.indexOf('aal.') === 0) fire(e.key); });

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* Nothing downstream should ever receive a half-built item. A dish added in the
     editor used to reach the diner app with `ing` undefined, which crashed the
     dietary filters. Every write goes through here. */
  var ALLERGENS = ['nuts','dairy','gluten','sesame','egg','shellfish','soy'];
  function normalise(x) {
    return {
      id:   x.id   || 'i' + Date.now().toString(36),
      sec:  x.sec  || 'mez',
      name: x.name || '(untitled)',
      desc: x.desc || '',
      price: typeof x.price === 'number' ? x.price : 0,
      ing:  Array.isArray(x.ing) ? x.ing : [],
      al:   Array.isArray(x.al)  ? x.al.filter(function (a) { return ALLERGENS.indexOf(a) > -1; }) : [],
      kcal: x.kcal == null ? null : +x.kcal,
      pr:   x.pr   == null ? null : +x.pr,
      ft:   x.ft   == null ? null : +x.ft,
      cb:   x.cb   == null ? null : +x.cb,
      fr:   x.fr ? 1 : 0,
      ar:   x.ar ? 1 : 0,
      cust: x.cust ? 1 : 0,
      adds: Array.isArray(x.adds) ? x.adds : [],
      /* conf is a DECLARATION, not a side effect. It is only true when the kitchen
         has ingredients, macros, and has explicitly confirmed the allergen list. */
      conf: x.conf ? 1 : 0
    };
  }
  function complete(x) {
    return !!(x.ing && x.ing.length) && x.kcal != null && x.pr != null && x.ft != null && x.cb != null;
  }

  function seedIfEmpty() {
    if (!read(K.live, null)) {
      var m = { version: 1, sections: clone(SEED_SECTIONS), items: clone(SEED_ITEMS), at: 'seed' };
      write(K.live, m);
      write(K.draft, clone(m));
    }
    if (!read(K.draft, null)) write(K.draft, clone(read(K.live, null)));
    if (!read(K.settle, null)) write(K.settle, []);
    if (!read(K.tips, null)) write(K.tips, {});
  }

  /* ---------- API ---------------------------------------------------------- */
  var A = {
    SECTIONS_SEED: SEED_SECTIONS,

    /* ---- menu ---- */
    draft:     function () { seedIfEmpty(); return read(K.draft, null); },
    published: function () { seedIfEmpty(); return read(K.live, null); },
    saveDraft: function (d) {
      d.items = (d.items || []).map(normalise);
      write(K.draft, d);
    },
    ALLERGENS: ALLERGENS,
    /* what a dish still needs before it can be confirmed */
    missing: function (x) {
      var m = [];
      if (!x.ing || !x.ing.length) m.push('ingredients');
      if (x.kcal == null || x.pr == null || x.ft == null || x.cb == null) m.push('nutrition');
      return m;
    },
    canConfirm: function (x) { return complete(x); },

    /* A publish mints an immutable version and points live at it. The diner app
       caches by version id, so a version can never change under a diner's thumb. */
    publish: function () {
      var d = A.draft(), live = A.published();
      d.version = (live ? live.version : 0) + 1;
      d.at = new Date().toISOString();
      write(K.live, clone(d));
      write(K.draft, clone(d));
      return d.version;
    },
    isDirty: function () {
      var d = A.draft(), l = A.published();
      if (!d || !l) return false;
      return JSON.stringify({ s: d.sections, i: d.items }) !== JSON.stringify({ s: l.sections, i: l.items });
    },

    /* ---- the open check ---- */
    check: function () {
      var m = A.published();
      return SEED_CHECK.map(function (l) {
        var item = m.items.filter(function (x) { return x.id === l.id; })[0];
        return { id: l.id, q: l.q, p: l.p, name: item ? item.name : '(removed)' };
      });
    },
    checkTotal: function () {
      return A.check().reduce(function (a, b) { return a + b.p; }, 0);
    },

    /* ---- settlement ----
       Only ever called on a provider confirmation or an operator action.
       A diner returning to the page is NOT confirmation. */
    settle: function (s) {
      var all = read(K.settle, []);
      all.push({
        id: 'p' + Date.now() + Math.floor(Math.random() * 1000),
        table: s.table || 12, rail: s.rail, amount: +(s.amount || 0),
        tip: +(s.tip || 0), server: s.server || 'Abou Karim',
        note: s.note || 0, change: +(s.change || 0),
        ts: new Date().toISOString()
      });
      write(K.settle, all);
      return all[all.length - 1];
    },
    settlements: function () { seedIfEmpty(); return read(K.settle, []); },
    byRail: function () {
      var t = { whish: 0, card: 0, cash: 0 };
      A.settlements().forEach(function (s) { if (t[s.rail] !== undefined) t[s.rail] += s.amount; });
      return t;
    },
    settledTotal: function () {
      return A.settlements().reduce(function (a, b) { return a + b.amount; }, 0);
    },

    /* ---- tips ---- */
    tipsOwed: function () {
      var paid = read(K.tips, {}), by = {};
      A.settlements().forEach(function (s) {
        if (s.tip > 0) by[s.server] = (by[s.server] || 0) + s.tip;
      });
      return Object.keys(by).map(function (n) {
        return { server: n, amount: by[n], paid: !!paid[n] };
      });
    },
    payTip: function (server) {
      var paid = read(K.tips, {});
      paid[server] = new Date().toISOString();
      write(K.tips, paid);
    },

    /* ---- venue ---- */
    venue: function () {
      var u = venueFromURL();
      if (u) { write(K.venue, u); return u; }
      return read(K.venue, null) || DEFAULT_VENUE;
    },
    setVenue: function (v) { write(K.venue, v); },
    resetVenue: function () { try { localStorage.removeItem(K.venue); } catch (e) {} fire(K.venue); },

    /* ---- plumbing ---- */
    on: function (fn) { subs.push(fn); },
    reset: function () {
      [K.draft, K.live, K.settle, K.tips].forEach(function (k) {
        try { localStorage.removeItem(k); } catch (e) {}
      });
      seedIfEmpty();
      fire('reset');
    }
  };

  seedIfEmpty();
  global.Aalayna = A;
})(window);
