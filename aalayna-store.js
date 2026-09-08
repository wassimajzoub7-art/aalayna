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
            venue: 'aal.venue', rate: 'aal.rate', rateMeta: 'aal.rate_meta', floor: 'aal.floor',
            guests: 'aal.guests', campaigns: 'aal.campaigns',
            /* data layer (engineering spec): one localStorage key per Postgres table */
            events: 'aal.events', device: 'aal.device', devices: 'aal.devices',
            identities: 'aal.identities', identityKeys: 'aal.identity_keys',
            deviceLinks: 'aal.device_links', merges: 'aal.identity_merges',
            editLog: 'aal.edit_log', webhooks: 'aal.webhook_log', admin: 'aal.admin_notifications' };

  /* ---------- venue identity -------------------------------------------
     The walk-in trick: open any app with ?venue=Roadster's&place=Dbayeh and
     the whole system rebrands to that restaurant on this device. The QR card
     generator writes these params so an owner scans straight into "their" demo. */
  var DEFAULT_VENUE = { name: 'Hallab 1881', place: 'Kasr El Helou',
                        est: 'EST. 1881 · TRIPOLI', heritage: 1, gplace: '',
                        brand: '', bg: '', font: '' };
  function venueFromURL() {
    try {
      var q = new URLSearchParams(global.location.search);
      var n = (q.get('venue') || '').trim();
      if (!n) return null;
      var hex = function (v) {
        v = (v || '').trim().replace(/^#/, '');
        return /^[0-9A-Fa-f]{6}$/.test(v) ? '#' + v : '';
      };
      var font = (q.get('font') || '').trim().slice(0, 40);
      if (!/^[A-Za-z0-9 +]*$/.test(font)) font = '';
      return { name: n.slice(0, 40), place: (q.get('place') || '').trim().slice(0, 40),
               est: '', heritage: 0, gplace: (q.get('gplace') || '').trim().slice(0, 60),
               brand: hex(q.get('brand')), bg: hex(q.get('bg')), font: font };
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
              conf: 1, fr: 1, ar: 1, opts: [] };
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
       { opts:[{name:'Extras',type:'many',choices:[
           {n:'Extra lamb chop',p:4.5,ing:['lamb']},{n:'Garlic toum',p:.75},
           {n:'Grilled tomato & onion',p:1.25},{n:'Swap fries for salad',p:0}]}] }),
    it('i08','mez',"Arayes","Grilled pita, spiced minced lamb, onion, parsley",7.50,
       ['pita bread','minced lamb','onion','parsley','spices'],['gluten'],640,31,34,52,{fr:0,ar:0}),

    it('i09','swt',"Knefeh b'Jebne + kaakeh","Akkawi cheese, semolina, ghee, sugar syrup, sesame kaakeh",4.50,
       ['akkawi cheese','semolina','ghee','sugar syrup','sesame kaakeh'],['dairy','gluten','sesame'],720,21,33,88,
       { opts:[{name:'Extras',type:'many',choices:[
           {n:'Extra ashta',p:1.5,ing:['ashta'],al:['dairy']},{n:'Double kaakeh',p:1},
           {n:'Hold the syrup',p:0},{n:'Pistachio crust',p:1.25}]}] }),
    it('i10','swt',"Halawet el Jeben","Sweet cheese dough, ashta cream, rose syrup, pistachio",4.00,
       ['sweet cheese dough','ashta cream','rose syrup','pistachio'],['dairy','gluten','nuts'],480,11,19,66),
    it('i11','swt',"Baklava assortment · 250g","Filo pastry, pistachio, cashew, ghee, sugar syrup",8.00,
       ['filo pastry','pistachio','cashew','ghee','sugar syrup'],['nuts','gluten','dairy'],1030,14,58,118),
    it('i12','swt',"Ashta ice cream","Milk, cream, mastic, sugar, pistachio crust",3.50,
       ['milk','cream','mastic','sugar','pistachio'],['dairy','nuts'],390,7,22,41),

    it('i13','drk',"Espresso","Single origin, pulled to order",2.00,['coffee'],[],5,0,0,1),
    it('i14','drk',"Lebanese coffee","Rakweh for two, orange blossom water",2.50,
       ['coffee','orange blossom water','sugar'],[],45,0,0,11,
       { opts:[{name:'Sugar',type:'one',choices:[
           {n:'Ziyede — sweet',p:0},{n:'Wasat — medium',p:0},{n:'Murra — no sugar',p:0}]}] }),
    it('i15','drk',"Jallab","Date molasses, rose water, pine nuts, raisins",3.00,
       ['date molasses','grape molasses','rose water','pine nuts','raisins'],['nuts'],290,3,6,58),
    it('i16','drk',"Fresh lemonade w' mazaher","Lemon, sugar, orange blossom water, mint",3.00,
       ['lemon','sugar','orange blossom water','mint'],[],130,0,0,33,{fr:0,ar:0}),
    it('i17','drk',"Latte","Espresso, steamed milk",3.50,
       ['coffee'],[],180,9,9,14,
       { opts:[
         {name:'Milk',type:'one',choices:[
           {n:'Fresh cow milk',p:0,ing:['milk'],al:['dairy']},
           {n:'Oat milk',p:0.75,ing:['oat milk']},
           {n:'Almond milk',p:0.75,ing:['almond'],al:['nuts']}]},
         {name:'Extras',type:'many',choices:[
           {n:'Extra shot',p:0.75,ing:['coffee']},{n:'Vanilla syrup',p:0.5}]}
       ] })
  ];

  /* ---------- seed translations -----------------------------------------
     Per-item FR/AR name and description. These live ON the item so the editor
     can edit them; the diner app reads them with English as the fallback. */
  var SEED_TR = {
    i01:{fr:{n:"Assiette de foul et houmous",d:"Fèves, pois chiches, tahini, huile d'olive, cumin"},ar:{n:"صحن فول وحمص",d:"فول، حمص، طحينة، زيت زيتون، كمون"}},
    i02:{fr:{n:"Œufs à l'awarma",d:"Œufs baladi, confit d'agneau, ghee"},ar:{n:"بيض بالقاورما",d:"بيض بلدي، قاورما، سمنة"}},
    i03:{fr:{n:"Lahm b'ajin · 4 pièces",d:"Agneau haché, tomate, oignon, mélasse de grenade, pignons"},ar:{n:"لحم بعجين · ٤ قطع",d:"لحمة مفرومة، بندورة، بصل، دبس رمان، صنوبر"}},
    i04:{fr:{n:"Fatteh au yaourt",d:"Pois chiches, yaourt à l'ail, pain frit, pignons"},ar:{n:"فتة باللبن",d:"حمص، لبن بالثوم، خبز مقلي، صنوبر"}},
    i05:{fr:{n:"Taboulé",d:"Persil, boulgour, tomate, oignon, citron, huile d'olive"},ar:{n:"تبولة",d:"بقدونس، برغل، بندورة، بصل، حامض، زيت زيتون"}},
    i06:{fr:{n:"Houmous beyrouthin",d:"Pois chiches, tahini, ail, citron, piment"},ar:{n:"حمص بيروتي",d:"حمص، طحينة، ثوم، حامض، فليفلة حارة"}},
    i07:{fr:{n:"Assiette de grillades",d:"Kebab, chiche taouk, côtelettes d'agneau, frites"},ar:{n:"مشاوي مشكلة",d:"كباب، شيش طاووق، ريش غنم، بطاطا"}},
    i08:{fr:{n:"Arayes",d:"Pain pita grillé, agneau haché épicé, oignon, persil"},ar:{n:"عرايس",d:"خبز مشوي، لحمة مفرومة، بصل، بقدونس"}},
    i09:{fr:{n:"Knefeh au fromage + kaake",d:"Fromage akkawi, semoule, ghee, sirop, kaake au sésame"},ar:{n:"كنافة بالجبنة + كعكة",d:"جبنة عكاوي، سميد، سمنة، قطر، كعكة بالسمسم"}},
    i10:{fr:{n:"Halawet el jeben",d:"Pâte de fromage sucrée, crème ashta, sirop de rose, pistache"},ar:{n:"حلاوة الجبن",d:"عجينة جبن حلوة، قشطة، ماء ورد، فستق"}},
    i11:{fr:{n:"Assortiment de baklava · 250g",d:"Pâte filo, pistache, noix de cajou, ghee, sirop"},ar:{n:"بقلاوة مشكلة · ٢٥٠ غ",d:"عجين رقيق، فستق، كاجو، سمنة، قطر"}},
    i12:{fr:{n:"Glace ashta",d:"Lait, crème, mastic, sucre, croûte de pistache"},ar:{n:"بوظة قشطة",d:"حليب، قشطة، مستكة، سكر، فستق"}},
    i13:{fr:{n:"Espresso",d:"Origine unique, préparé à la commande"},ar:{n:"إسبريسو",d:"بن مختار، يُحضّر عند الطلب"}},
    i14:{fr:{n:"Café libanais",d:"Rakweh pour deux, eau de fleur d'oranger"},ar:{n:"قهوة عربية",d:"ركوة لشخصين، ماء زهر"}},
    i15:{fr:{n:"Jallab",d:"Mélasse de dattes, eau de rose, pignons, raisins secs"},ar:{n:"جلاب",d:"دبس تمر، ماء ورد، صنوبر، زبيب"}},
    i16:{fr:{n:"Limonade à la fleur d'oranger",d:"Citron, sucre, eau de fleur d'oranger, menthe"},ar:{n:"ليموناضة بماء الزهر",d:"حامض، سكر، ماء زهر، نعناع"}},
    i17:{fr:{n:"Latte",d:"Espresso, lait vapeur"},ar:{n:"لاتيه",d:"إسبريسو مع حليب مبخّر"}}
  };

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

  function centsEqual(value, amount) { return Math.round(Number(value) * 100) === amount; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  /* Shared primitives for the sibling modules (growth, metrics). One definition,
     one behaviour: ids are UUIDs, money is integer cents, time is ISO. */
  function uid(prefix) {
    var c = global.crypto;
    var id = c && c.randomUUID ? c.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    return (prefix || '') + id;
  }
  function now() { return new Date().toISOString(); }
  function cents(n) { return Math.round(Number(n) * 100); }

  /* Nothing downstream should ever receive a half-built item. A dish added in the
     editor used to reach the diner app with `ing` undefined, which crashed the
     dietary filters. Every write goes through here. */
  var ALLERGENS = ['nuts','dairy','gluten','sesame','egg','shellfish','soy'];
  function normalise(x) {
    var ing = Array.isArray(x.ing) ? x.ing : [];
    return {
      /* Immutable once minted. Renames touch `name`, deletes set `archivedAt`;
         the id is what every event, check line and report points at. */
      id:   x.id   || uid(),
      archivedAt: typeof x.archivedAt === 'string' ? x.archivedAt : null,
      available: x.available === false ? false : true,   // the 86 toggle
      /* No ingredient record = no dietary claim. The dish stays on the menu but
         every filter and allergen line treats it as unknown. */
      status: ing.length ? 'complete' : 'incomplete',
      sec:  x.sec  || 'mez',
      name: x.name || '(untitled)',
      desc: x.desc || '',
      imageUrl: typeof x.imageUrl === 'string' && /^https:\/\/[^\s]+$/i.test(x.imageUrl) ? x.imageUrl : '',
      price: typeof x.price === 'number' ? x.price : 0,
      ing:  ing,
      al:   Array.isArray(x.al)  ? x.al.filter(function (a) { return ALLERGENS.indexOf(a) > -1; }) : [],
      kcal: x.kcal == null ? null : +x.kcal,
      pr:   x.pr   == null ? null : +x.pr,
      ft:   x.ft   == null ? null : +x.ft,
      cb:   x.cb   == null ? null : +x.cb,
      tr: {
        fr: { n: (x.tr && x.tr.fr && x.tr.fr.n) || '', d: (x.tr && x.tr.fr && x.tr.fr.d) || '' },
        ar: { n: (x.tr && x.tr.ar && x.tr.ar.n) || '', d: (x.tr && x.tr.ar && x.tr.ar.d) || '' }
      },
      fr: (x.tr && x.tr.fr && (x.tr.fr.n || x.tr.fr.d)) ? 1 : 0,
      ar: (x.tr && x.tr.ar && (x.tr.ar.n || x.tr.ar.d)) ? 1 : 0,
      /* option groups: 'one' = guest picks exactly one (milk, sweetness),
         'many' = independent add-ons. Legacy flat `adds` folds into an Extras group. */
      opts: (Array.isArray(x.opts) ? x.opts
             : (Array.isArray(x.adds) && x.adds.length
                ? [{ name: 'Extras', type: 'many', choices: x.adds }] : [])
            ).map(function (g) {
              return {
                name: g.name || 'Options',
                type: g.type === 'one' ? 'one' : 'many',
                choices: (Array.isArray(g.choices) ? g.choices : [])
                  .map(function (c) {
                    return { n: c.n || '', p: typeof c.p === 'number' ? c.p : (+c.p || 0),
                             /* what THIS choice adds to the dish — the dish's own al/ing stay the unavoidable base */
                             ing: Array.isArray(c.ing) ? c.ing : [],
                             al: Array.isArray(c.al) ? c.al.filter(function (a) { return ALLERGENS.indexOf(a) > -1; }) : [] };
                  })
                  .filter(function (c) { return c.n; })
              };
            }).filter(function (g) { return g.choices.length; }),
      /* conf is a DECLARATION, not a side effect. It is only true when the kitchen
         has ingredients, macros, and has explicitly confirmed the allergen list. */
      conf: x.conf ? 1 : 0
    };
  }
  function complete(x) {
    return !!(x.ing && x.ing.length) && x.kcal != null && x.pr != null && x.ft != null && x.cb != null;
  }

  /* ---------- migration ---------------------------------------------------
     A device that scanned the QR last week holds last week's data shape in
     localStorage. New fields (like per-item translations) must be merged in
     silently — a field demo can never depend on someone finding "Reset". */
  var SCHEMA = 5;   // v5: archivedAt / available / status on every item
  function migrate() {
    var meta = read('aal.schema', 0);
    if (meta >= SCHEMA) return;
    [K.live, K.draft].forEach(function (key) {
      var m = read(key, null);
      if (!m || !m.items) return;
      m.items = m.items.map(function (x) {
        // attach seed translations to seed items that predate the tr field
        if ((!x.tr || (!x.tr.fr && !x.tr.ar)) && SEED_TR[x.id]) {
          var tr = clone(SEED_TR[x.id]);
          if (x.fr === 0) tr.fr = { n: '', d: '' };
          if (x.ar === 0) tr.ar = { n: '', d: '' };
          x.tr = tr;
        }
        return normalise(x);
      });
      // v3: the latte (option-group demo dish) joins menus seeded before it existed
      // v4: its dairy moved from the dish base into the cow-milk choice — refresh it
      var latteSeed = clone(SEED_ITEMS.filter(function (x) { return x.id === 'i17'; })[0]);
      latteSeed.tr = clone(SEED_TR.i17);
      var have = m.items.filter(function (x) { return x.id === 'i17'; })[0];
      if (!have) m.items.push(normalise(latteSeed));
      else { have.al = latteSeed.al; have.ing = latteSeed.ing; have.opts = latteSeed.opts;
             m.items[m.items.indexOf(have)] = normalise(have); }
      write(key, m);
    });
    try { localStorage.setItem('aal.schema', JSON.stringify(SCHEMA)); } catch (e) {}
  }

  function seedIfEmpty() {
    if (!read(K.live, null)) {
      var seeded = clone(SEED_ITEMS).map(function (x) {
        var tr = SEED_TR[x.id] ? clone(SEED_TR[x.id]) : null;
        if (tr) {
          // items seeded with fr:0 / ar:0 model a venue that hasn't translated them yet
          if (x.fr === 0) tr.fr = { n: '', d: '' };
          if (x.ar === 0) tr.ar = { n: '', d: '' };
          x.tr = tr;
        }
        return x;
      });
      var m = { version: 1, sections: clone(SEED_SECTIONS), items: seeded.map(normalise), at: 'seed' };
      write(K.live, m);
      write(K.draft, clone(m));
    }
    if (!read(K.draft, null)) write(K.draft, clone(read(K.live, null)));
    if (!read(K.settle, null)) write(K.settle, []);
    if (!read(K.tips, null)) write(K.tips, {});
  }

  /* ---------- edit log --------------------------------------------------
     Every mutation from any tier lands here, field by field. `who` is a label
     in the prototype; a backend stamps the authenticated staff account. */
  var TIER = { price: 1, available: 1, desc: 1, name: 2, sec: 2, created: 2, imageUrl: 2,
               ing: 2, al: 2, kcal: 2, pr: 2, ft: 2, cb: 2, opts: 2, tr: 2, conf: 2,
               archivedAt: 3, id: 3 };
  function fieldEq(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
  function logEdits(prev, next, who) {
    var rows = read(K.editLog, []), at = now(), rid = A.venueId();
    function row(type, id, field, o, n) {
      rows.push({ id: uid('e'), who: who || 'owner', restaurantId: rid, entityType: type, entityId: id,
                  field: field, oldValue: o === undefined ? null : o, newValue: n === undefined ? null : n,
                  tier: TIER[field] || 2, at: at });
    }
    var before = {}, after = {};
    (prev && prev.items || []).forEach(function (x) { before[x.id] = x; });
    (next.items || []).forEach(function (x) { after[x.id] = x; });
    Object.keys(after).forEach(function (id) {
      var o = before[id], n = after[id];
      if (!o) { row('item', id, 'created', null, n.name); if (n.status === 'incomplete') adminNotify('incomplete_item', { itemId: id, name: n.name }); return; }
      Object.keys(TIER).forEach(function (f) {
        if (f === 'created' || f === 'id') return;
        if (!fieldEq(o[f], n[f])) {
          row('item', id, f, o[f], n[f]);
          if (f === 'ing' && n.status === 'incomplete' && o.status !== 'incomplete') adminNotify('incomplete_item', { itemId: id, name: n.name });
        }
      });
    });
    Object.keys(before).forEach(function (id) { if (!after[id]) row('item', id, 'hard_delete_blocked', before[id].name, null); });
    var bs = {}, as = {};
    (prev && prev.sections || []).forEach(function (x) { bs[x.id] = x; });
    (next.sections || []).forEach(function (x) { as[x.id] = x; });
    Object.keys(as).forEach(function (id) {
      if (!bs[id]) { row('section', id, 'created', null, as[id].name); return; }
      ['name', 'win'].forEach(function (f) { if (!fieldEq(bs[id][f], as[id][f])) row('section', id, f, bs[id][f], as[id][f]); });
    });
    Object.keys(bs).forEach(function (id) { if (!as[id]) row('section', id, 'removed', bs[id].name, null); });
    if (rows.length > 5000) rows = rows.slice(-5000);
    write(K.editLog, rows);
  }
  function adminNotify(kind, detail) {
    var rows = read(K.admin, []);
    rows.push({ id: uid('n'), kind: kind, restaurantId: A.venueId(), detail: detail || {}, at: now(), seen: false });
    write(K.admin, rows.slice(-500));
  }

  /* ---------- device + session ------------------------------------------
     device_id is a weak signal (Safari ITP, in-app browsers), kept in
     localStorage with a first-party cookie as the backup copy. session_id is
     minted per QR scan and travels on every event. */
  function cookieGet(name) {
    try {
      var m = global.document && global.document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  function cookieSet(name, value) {
    try { if (global.document) global.document.cookie = name + '=' + encodeURIComponent(value) + '; Max-Age=31536000; Path=/; SameSite=Lax'; } catch (e) {}
  }
  var UUIDish = /^[A-Za-z0-9-]{8,64}$/;
  function deviceId() {
    var ls = '', ck = cookieGet('device_id');
    try { ls = localStorage.getItem(K.device) || ''; } catch (e) {}
    if (!UUIDish.test(ls)) ls = '';
    if (!UUIDish.test(ck)) ck = '';
    var id = ls || ck || uid();
    if (id !== ls) { try { localStorage.setItem(K.device, id); } catch (e) {} }
    if (id !== ck) cookieSet('device_id', id);
    var devices = read(K.devices, {});
    if (!devices[id]) devices[id] = { firstSeen: now() };
    devices[id].lastSeen = now();
    try { localStorage.setItem(K.devices, JSON.stringify(devices)); } catch (e) {}
    return id;
  }
  var memSession = null;
  function sessionId(fresh) {
    var ss = null;
    try { ss = global.sessionStorage; } catch (e) {}
    var cur = null;
    try { cur = ss ? ss.getItem('aal.session') : memSession; } catch (e) {}
    if (!fresh && cur && UUIDish.test(cur)) return cur;
    var id = uid();
    try { if (ss) ss.setItem('aal.session', id); } catch (e) {}
    memSession = id;
    return id;
  }

  /* ---------- events: append-only ----------------------------------------
     Never updated, never deleted (customer_id backfill is the one sanctioned
     exception, and it is done by the identity layer). */
  var EVENT_TYPES = ['qr_scan', 'item_view', 'bill_requested', 'order_placed', 'payment_completed',
                     'payment_refunded', 'payment_cancelled', 'receipt_requested', 'review_submitted'];
  function logEvent(type, payload, extra) {
    if (EVENT_TYPES.indexOf(type) < 0) throw new Error('Unknown event type: ' + type);
    extra = extra || {};
    var did = extra.deviceId || deviceId();
    var rows = read(K.events, []);
    var e = { eventId: uid(), deviceId: did, sessionId: extra.sessionId || sessionId(),
              restaurantId: A.venueId(), tableId: extra.tableId == null ? null : String(extra.tableId),
              customerId: extra.customerId || customerForDevice(did) || null,
              eventType: type, payload: payload || {}, createdAt: now() };
    rows.push(e);
    if (rows.length > 5000) rows = rows.slice(-5000);
    write(K.events, rows);
    return e;
  }

  /* ---------- identity ---------------------------------------------------
     identities / identity_keys / device_links / identity_merges. Keys are
     normalised (E.164, lower-case email); a backend hashes them at rest. */
  function keyId(type, value) { return type + ':' + value; }
  function customerForDevice(did) {
    var links = read(K.deviceLinks, []), best = null;
    links.forEach(function (l) { if (l.deviceId === did && (!best || l.linkedAt > best.linkedAt)) best = l; });
    return best ? best.customerId : null;
  }
  function repoint(from, to) {
    var keys = read(K.identityKeys, {});
    Object.keys(keys).forEach(function (k) { if (keys[k].customerId === from) keys[k].customerId = to; });
    write(K.identityKeys, keys);
    var links = read(K.deviceLinks, []);
    links.forEach(function (l) { if (l.customerId === from) l.customerId = to; });
    write(K.deviceLinks, links);
    var events = read(K.events, []);
    events.forEach(function (e) { if (e.customerId === from) e.customerId = to; });
    write(K.events, events);
    var settle = read(K.settle, []);
    settle.forEach(function (x) { if (x.customerId === from) x.customerId = to; });
    write(K.settle, settle);
    var guests = read(K.guests, []);
    guests.forEach(function (g) { if (g.customerId === from) g.customerId = to; });
    write(K.guests, guests);
    var merges = read(K.merges, []);
    merges.push({ id: uid('m'), from: from, into: to, at: now() });
    write(K.merges, merges);
  }
  function linkIdentity(input) {
    var keys = read(K.identityKeys, {}), ids = read(K.identities, {});
    var found = [], fresh = [];
    (input.keys || []).forEach(function (k) {
      if (!k || !k.type || !k.value) return;
      var kid = keyId(k.type, k.value), hit = keys[kid];
      if (hit) { if (found.indexOf(hit.customerId) < 0) found.push(hit.customerId); }
      else fresh.push(kid);
    });
    var survivor = found[0] || null;
    if (!survivor) {
      survivor = uid();
      ids[survivor] = { customerId: survivor, createdAt: now() };
      write(K.identities, ids);
    }
    fresh.forEach(function (kid) { keys[kid] = { customerId: survivor, createdAt: now() }; });
    write(K.identityKeys, keys);
    // two keys, two customers: union-find style merge into the survivor
    found.slice(1).forEach(function (other) { repoint(other, survivor); delete ids[other]; });
    if (found.length > 1) write(K.identities, ids);
    var did = input.deviceId || deviceId();
    var links = read(K.deviceLinks, []);
    if (!links.some(function (l) { return l.deviceId === did && l.customerId === survivor; })) {
      links.push({ deviceId: did, customerId: survivor, linkedAt: now(), source: input.source || 'receipt' });
      write(K.deviceLinks, links);
    }
    // retroactive attribution: everything this device did before we knew who it was
    var events = read(K.events, []), touched = false;
    events.forEach(function (e) { if (e.deviceId === did && !e.customerId) { e.customerId = survivor; touched = true; } });
    if (touched) write(K.events, events);
    return survivor;
  }
  /* the one event the whole reporting layer hangs off */
  function paymentEvent(row) {
    logEvent('payment_completed',
      { orderId: row.checkId, paymentId: row.id, requestId: row.requestId, amount: row.amount, currency: row.currency || 'USD',
        fxRateUsed: row.fxRateUsed || null, amountUsd: row.amountUsd == null ? row.amount : row.amountUsd,
        rail: row.rail, payerRef: row.payerRef || null, tip: row.tip || 0, externalRef: row.externalRef || null },
      { deviceId: row.deviceId, sessionId: row.sessionId, tableId: row.table, customerId: row.customerId });
  }
  /* stable hash for event payloads: identifies a contact without carrying it */
  function contactHash(str) {
    var h = 5381, i;
    for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(16);
  }

  /* ---------- API ---------------------------------------------------------- */
  var A = {
    SECTIONS_SEED: SEED_SECTIONS,

    /* ---- menu ---- */
    draft:     function () { seedIfEmpty(); return read(K.draft, null); },
    published: function () { seedIfEmpty(); return read(K.live, null); },
    saveDraft: function (d, who) {
      var prev = read(K.draft, null);
      d.items = (d.items || []).map(normalise);
      /* A row referenced by history never disappears: an item missing from the
         incoming draft is kept as archived rather than dropped. */
      if (prev && prev.items) {
        var have = {};
        d.items.forEach(function (x) { have[x.id] = 1; });
        prev.items.forEach(function (x) {
          if (!have[x.id]) { var keep = clone(x); keep.archivedAt = keep.archivedAt || now(); d.items.push(normalise(keep)); }
        });
      }
      logEdits(prev, d, who);
      write(K.draft, d);
    },
    /* Tier 3: archive semantics. Soft delete only; re-adding mints a new id. */
    archiveItem: function (id, who) {
      var d = A.draft(), hit = d.items.filter(function (x) { return x.id === id; })[0];
      if (!hit) throw new Error('Item not found.');
      hit.archivedAt = hit.archivedAt || now();
      A.saveDraft(d, who);
    },
    restoreItem: function (id, who) {
      var d = A.draft(), hit = d.items.filter(function (x) { return x.id === id; })[0];
      if (!hit) throw new Error('Item not found.');
      hit.archivedAt = null;
      A.saveDraft(d, who);
    },
    /* The one hard delete: a draft row that was never published and that nothing
       references (a blank dish the editor opened and abandoned). */
    discardDraftItem: function (id) {
      if (A.published().items.some(function (x) { return x.id === id; })) return false;
      var d = A.draft(), before = d.items.length;
      d.items = d.items.filter(function (x) { return x.id !== id; });
      if (d.items.length === before) return false;
      write(K.draft, d);   // not through saveDraft: nothing to log, nothing to keep
      return true;
    },
    /* what a guest can see: published, not archived */
    liveItems: function () {
      return A.published().items.filter(function (x) { return !x.archivedAt; });
    },
    editLog: function () { return read(K.editLog, []).filter(function (r) { return r.restaurantId === A.venueId(); }); },
    adminNotifications: function () { return read(K.admin, []); },
    markNotificationsSeen: function () { var rows = read(K.admin, []); rows.forEach(function (r) { r.seen = true; }); write(K.admin, rows); },
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
      var amount = Math.round(Number(s.amount) * 100), tip = Math.round(Number(s.tip || 0) * 100);
      if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(tip) || tip < 0 || tip >= amount || ['cash','card','whish'].indexOf(s.rail) < 0) throw new Error('Enter a valid payment and tip.');
      var scope = A.venueId();
      var previous = s.requestId && all.filter(function(x){ return x.requestId === s.requestId && x.venueId === scope; })[0];
      if (previous) {
        if (centsEqual(previous.amount, amount) && centsEqual(previous.tip || 0, tip) && previous.rail === s.rail && previous.checkId === (s.checkId || null) && Number(previous.table) === Number(s.table || 12) && JSON.stringify(previous.items || {}) === JSON.stringify(s.items || {})) return previous;
        throw new Error('This payment reference was already used for a different request.');
      }
      var cashNote = Math.round(Number(s.note || 0) * 100);
      if (s.rail === 'cash' && (!Number.isSafeInteger(cashNote) || cashNote < 0 || (cashNote > 0 && cashNote < amount))) throw new Error('Choose enough cash to cover your share and tip.');
      if (s.checkId && A.validateCheckPayment) A.validateCheckPayment(s, amount - tip);
      var rate = A.rate(), status = s.rail === 'cash' ? 'pending' : (s.initiate ? 'initiated' : 'confirmed');
      var row = {
        id: uid('p'),
        venueId: scope, venue: A.venue().name, checkId: s.checkId || null,
        requestId: s.requestId || null, items: s.items || {},
        deviceId: s.deviceId || deviceId(), sessionId: s.sessionId || sessionId(),
        table: s.table || 12, rail: s.rail, amount: amount / 100,
        tip: tip / 100, server: s.server || 'Abou Karim',
        /* raw amount + the rate it was taken at + the normalised figure: all
           three, always. A converted number on its own is meaningless later. */
        currency: 'USD', fxRateUsed: rate, amountUsd: amount / 100,
        note: s.rail === 'cash' ? cashNote / 100 : 0, change: s.rail === 'cash' && cashNote > 0 ? (cashNote - amount) / 100 : 0,
        status: status,
        ts: new Date().toISOString()
      };
      if (status === 'confirmed') { row.confirmedAt = row.ts; }
      all.push(row);
      write(K.settle, all);
      if (status === 'confirmed') paymentEvent(row);
      return row;
    },
    /* Two-step digital path (spec §6): the guest app creates the request when it
       hands over to the provider; the provider's callback confirms it. Anything
       else (a redirect, a returning tab) is not a confirmation. */
    requestPayment: function (s) {
      if (s.rail === 'cash') return A.settle(s);
      return A.settle(Object.assign({}, s, { initiate: true }));
    },
    confirmPayment: function (requestId, cb) {
      cb = cb || {};
      var all = read(K.settle, []), log = read(K.webhooks, []);
      var ref = String(cb.externalRef || '').trim();
      if (!ref) throw new Error('A provider confirmation needs its transaction reference.');
      log.push({ id: uid('w'), requestId: requestId, externalRef: ref, payerRef: cb.payerRef || null, body: cb.raw || null, at: now() });
      write(K.webhooks, log.slice(-2000));
      var row = all.filter(function (x) { return x.requestId === requestId && x.venueId === A.venueId(); })[0];
      if (!row) throw new Error('Unknown payment request.');
      if (row.externalRef === ref && A.settlementStatus(row) === 'confirmed') return row;   // duplicate callback
      if (A.settlementStatus(row) !== 'initiated') throw new Error('This request is ' + A.settlementStatus(row) + ' and cannot be confirmed.');
      if (all.some(function (x) { return x.externalRef === ref && x.id !== row.id; })) throw new Error('This provider reference already confirmed another request.');
      row.status = 'confirmed'; row.confirmedAt = now(); row.externalRef = ref;
      if (cb.payerRef) row.payerRef = contactHash(String(cb.payerRef));
      write(K.settle, all);
      if (cb.payerRef) {
        var cid = linkIdentity({ keys: [{ type: 'wallet_id', value: row.payerRef }], deviceId: row.deviceId, source: 'payment' });
        row.customerId = row.customerId || cid; write(K.settle, all);
      }
      paymentEvent(row);
      return row;
    },
    failPayment: function (requestId, reason) {
      var all = read(K.settle, []);
      var row = all.filter(function (x) { return x.requestId === requestId && x.venueId === A.venueId(); })[0];
      if (row && A.settlementStatus(row) === 'initiated') { row.status = reason === 'expired' ? 'expired' : 'failed'; row.failedAt = now(); write(K.settle, all); }
    },
    settlements: function () {
      seedIfEmpty(); var scope = A.venueId();
      return read(K.settle, []).filter(function(s){ return !s.venueId || s.venueId === scope; });
    },
    settlementStatus: function (s) {
      if (s.refunded) return 'refunded';
      if (s.cancelled) return 'cancelled';
      return s.status || (s.rail === 'cash' ? 'pending' : 'confirmed');
    },
    isConfirmed: function (s) { return A.settlementStatus(s) === 'confirmed'; },
    pendingCash: function () {
      return A.settlements().filter(function (s) { return s.rail === 'cash' && A.settlementStatus(s) === 'pending'; });
    },
    confirmCash: function (id) {
      var all = read(K.settle, []), changed = false;
      var allowed = A.settlements().some(function(s){ return s.id === id; });
      var hit = null;
      all.forEach(function (s) {
        if (allowed && s.id === id && s.rail === 'cash' && A.settlementStatus(s) === 'pending') {
          s.status = 'confirmed'; s.confirmedAt = new Date().toISOString(); changed = true; hit = s;
        }
      });
      if (changed) { write(K.settle, all); paymentEvent(hit); }
      return changed;
    },
    cancelCash: function (id) {
      var all = read(K.settle, []);
      var allowed = A.settlements().some(function(s){ return s.id === id; });
      all.forEach(function (s) {
        if (allowed && s.id === id && s.rail === 'cash' && A.settlementStatus(s) === 'pending') {
          s.cancelled = new Date().toISOString();
          logEvent('payment_cancelled', { paymentId: s.id, orderId: s.checkId, rail: s.rail }, { deviceId: s.deviceId, sessionId: s.sessionId, tableId: s.table, customerId: s.customerId });
        }
      });
      write(K.settle, all);
    },
    /* refunds MARK, they never delete — the ledger stays append-only and the
       refunded row stays visible, it just leaves every total. Operator action,
       same rule as the rest of settlement state. */
    refund: function (id) {
      var all = read(K.settle, []);
      all.forEach(function (s) {
        if (s.id === id && A.settlements().some(function(x){ return x.id === id; }) && A.isConfirmed(s)) {
          s.refunded = new Date().toISOString();
          logEvent('payment_refunded', { paymentId: s.id, orderId: s.checkId, amount: s.amount, currency: s.currency || 'USD', fxRateUsed: s.fxRateUsed || null, amountUsd: s.amountUsd == null ? s.amount : s.amountUsd, rail: s.rail },
                   { deviceId: s.deviceId, sessionId: s.sessionId, tableId: s.table, customerId: s.customerId });
        }
      });
      write(K.settle, all);
    },
    byRail: function () {
      var t = { whish: 0, card: 0, cash: 0 };
      A.settlements().forEach(function (s) {
        if (A.isConfirmed(s) && t[s.rail] !== undefined) t[s.rail] += s.amount;
      });
      return t;
    },
    settledTotal: function () {
      return A.settlements().reduce(function (a, b) { return a + (A.isConfirmed(b) ? b.amount : 0); }, 0);
    },

    /* ---- tips ---- */
    tipsOwed: function () {
      var paid = read(K.tips, {}), by = {};
      A.settlements().forEach(function (s) {
        if (s.tip > 0 && A.isConfirmed(s) && s.rail !== 'cash') by[s.server] = (by[s.server] || 0) + s.tip;
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
    /* Every operational record is scoped to this key. It is data organisation,
       not a tenant boundary: a real backend scopes by restaurant_id server-side. */
    venueId: function () {
      var v = A.venue();
      return JSON.stringify([v.name.trim().toLowerCase(), (v.place || '').trim().toLowerCase()]);
    },
    venue: function () {
      var u = venueFromURL();
      if (u) { if (JSON.stringify(read(K.venue, null)) !== JSON.stringify(u)) write(K.venue, u); return u; }
      return read(K.venue, null) || DEFAULT_VENUE;
    },
    setVenue: function (v) { write(K.venue, v); },
    /* ---- guests: the venue's own list, built at the receipt moment ----
       Two separate consents, both explicit. Lists are per venue and are never
       joined across venues. Marketing sends require an active marketing consent. */
    guests: function () { return read(K.guests, []); },
    /* ---- floor: which server has which table tonight ----
       Set by the manager at service start (sections, not per-order); replaced by
       the POS employee-on-check field once integration exists. Pooled mode is for
       venues that pool tips — assignment goes dormant, one house pool. */
    floor: function () {
      var f = read(K.floor, null);
      if (!f || !Array.isArray(f.servers) || !f.servers.length) {
        f = { servers: ['Abou Karim', 'Sara', 'Jad'], tables: {}, pooled: false };
      }
      f.tables = f.tables || {};
      return f;
    },
    setFloor: function (f) { write(K.floor, f); },
    serverFor: function (table) {
      var f = A.floor();
      if (f.pooled) return 'Team pool';
      return f.tables[String(table)] || f.servers[0];
    },
    /* USD→LBP. The lira has been stable near 89,500 for years, so this is a
       venue setting with a sane default, not a live feed. Every LL figure on
       every guest phone follows it the moment it changes. */
    rate: function () {
      var r = read(K.rate, 0);
      return (r >= 1000 && r <= 10000000) ? r : 89500;
    },
    setRate: function (v, by) {
      v = Math.round(+v || 0);
      if (v >= 1000 && v <= 10000000) {
        write(K.rateMeta, { updatedAt: now(), updatedBy: by || 'owner', restaurantId: A.venueId() });
        write(K.rate, v);
      }
    },
    /* the rate with its provenance: mirrors the house/POS rate, never a market feed */
    rateInfo: function (at) {
      var meta = read(K.rateMeta, null) || {};
      var age = meta.updatedAt ? ((at || Date.now()) - Date.parse(meta.updatedAt)) / 86400000 : null;
      return { rate: A.rate(), updatedAt: meta.updatedAt || null, updatedBy: meta.updatedBy || null,
               ageDays: age == null ? null : Math.floor(age), stale: age == null ? true : age >= 14 };
    },
    /* The one integration that needs no partner: with a Place ID this opens the
       venue's actual Google review box; without one it opens their real Maps
       listing (review is one tap from there). Works for any walk-in demo venue. */
    reviewURL: function () {
      var v = A.venue();
      if (v.gplace) return 'https://search.google.com/local/writereview?placeid=' +
        encodeURIComponent(v.gplace);
      return 'https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent(v.name + (v.place ? ' ' + v.place : '') + ' Lebanon');
    },
    resetVenue: function () { try { localStorage.removeItem(K.venue); } catch (e) {} fire(K.venue); },

    /* ---- data layer: device, session, events, identity ---- */
    device: function () { return deviceId(); },
    session: function () { return sessionId(false); },
    newSession: function () { return sessionId(true); },
    events: function () { return read(K.events, []).filter(function (e) { return e.restaurantId === A.venueId(); }); },
    logEvent: logEvent,
    EVENT_TYPES: EVENT_TYPES,
    contactHash: contactHash,
    identity: {
      link: linkIdentity,
      customerForDevice: customerForDevice,
      keysFor: function (customerId) {
        var keys = read(K.identityKeys, {});
        return Object.keys(keys).filter(function (k) { return keys[k].customerId === customerId; })
          .map(function (k) { return { type: k.slice(0, k.indexOf(':')), value: k.slice(k.indexOf(':') + 1) }; });
      },
      merges: function () { return read(K.merges, []); },
      count: function () { return Object.keys(read(K.identities, {})).length; }
    },
    webhookLog: function () { return read(K.webhooks, []); },
    actor: function () { return 'owner'; },   // a backend replaces this with the authenticated staff user

    /* ---- plumbing ---- */
    on: function (fn) { subs.push(fn); },
    notify: function (key) { fire(key); },
    util: { read: read, write: write, uid: uid, now: now, cents: cents, clone: clone },
    reset: function () {
      try { localStorage.removeItem('aal.pack'); } catch (e) {}
      try { localStorage.removeItem(K.guests); localStorage.removeItem(K.campaigns); } catch (e) {}
      [K.draft, K.live, K.settle, K.tips, 'aal.checks', K.events, K.identities, K.identityKeys, K.deviceLinks,
       K.merges, K.editLog, K.webhooks, K.admin, K.rateMeta].forEach(function (k) {
        try { localStorage.removeItem(k); } catch (e) {}
      });
      seedIfEmpty();
      fire('reset');
    }
  };

  seedIfEmpty();
  migrate();
  global.Aalayna = A;

  /* ---------- venue theme + menu pack, applied on every page ----------
     One link re-skins and re-menus the whole system: guest, editor, dashboard.
     ?venue=&brand=&bg=&font= theme the app; ?menu=<slug> imports venues/<slug>.json
     into the store once (marker-guarded) and reloads. */
  (function () {
    if (!global.document) return;
    function mix(hex, t) {
      var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
      var f = function (c) { return Math.round(c + (255 - c) * t); };
      return '#' + ((1 << 24) + (f(r) << 16) + (f(g) << 8) + f(b)).toString(16).slice(1);
    }
    function shade(hex, t) {
      var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
      var f = function (c) { return Math.max(0, Math.round(c * (1 - t))); };
      return '#' + ((1 << 24) + (f(r) << 16) + (f(g) << 8) + f(b)).toString(16).slice(1);
    }
    try {
      var v = A.venue(), r = global.document.documentElement.style;
      if (v.brand) {
        var brand = v.brand, n = parseInt(brand.slice(1), 16);
        var lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
        if (lum > 0.62) brand = shade(brand, 0.35);
        r.setProperty('--green', brand);
        r.setProperty('--green-bg', mix(brand, 0.92));
        r.setProperty('--green-line', mix(brand, 0.78));
        r.setProperty('--gold', shade(brand, 0.25));
        r.setProperty('--gold-lt', mix(brand, 0.72));
        r.setProperty('--side', shade(brand, 0.55));
      }
      if (v.bg) r.setProperty('--bg', v.bg);
      if (v.font && !global.document.getElementById('venue-font')) {
        var link = global.document.createElement('link');
        link.id = 'venue-font'; link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=' +
          encodeURIComponent(v.font).replace(/%20/g, '+') + ':wght@400;500;600;700;800&display=swap';
        global.document.head.appendChild(link);
        var st = global.document.createElement('style');
        st.textContent = "body,button,input,textarea{font-family:'" + v.font +
          "','IBM Plex Sans Arabic',system-ui,sans-serif !important}";
        global.document.head.appendChild(st);
      }
      var q = new URLSearchParams(global.location.search);
      var pack = (q.get('menu') || '').replace(/[^a-z0-9-]/g, '');
      if (pack && localStorage.getItem('aal.pack') !== pack) {
        fetch('venues/' + pack + '.json').then(function (res) {
          if (!res.ok) throw 0;
          return res.json();
        }).then(function (m) {
          var d = A.draft();
          d.sections = m.sections; d.items = m.items;
          A.saveDraft(d);
          A.publish();
          localStorage.setItem('aal.pack', pack);
          global.location.reload();
        }).catch(function () {});
      }
    } catch (e) {}
  })();
})(window);
