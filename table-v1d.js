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

    // Setting down: every object on the table, hero or quiet.
    each('.table .ob', function (ob) {
      if (!ob.offsetWidth) return;
      var b = box(ob), pc = ob.querySelector('.pc'), sh = ob.querySelector(':scope > .osh');
      var fx = (parseFloat(ob.getAttribute('data-fx')) || 0) * D * dir, fy = (parseFloat(ob.getAttribute('data-fy')) || 0) * D;
      if (!fx && !fy) fy = D;
      var range = vh + b.h, i = parseFloat(ob.getAttribute('data-i')) || 0;
      var a = b.top - vh + range * .04 + i * range * .06;
      add(a, a + range * .4, function (p) {
        var e = OUT(p);
        put(pc, fx * (1 - e), fy * (1 - e), 0, .94 + .06 * e, cl(p / .22));   // a real object is opaque: it arrives, it does not materialise
        if (sh) { var q = OUT(seg(p, .18, 1)); put(sh, (fx + .5 * rem) * (1 - q), (fy + rem) * (1 - q), 0, 1, cl((p - .18) / .5)); }
      });
    });

    // Layers that come up in turn on a hero once it is down: the menu's dishes, the regulars, the price's rows.
    each('.ob-menu, .ob-again, .ob-price', function (ob) {
      var b = box(ob);
      each('.scr-head, .dish, .reg-row, .pr-row', function (el, j) {
        var a = b.cy - .92 * vh + j * .035 * vh;
        add(a, a + .1 * vh, function (p) { var e = OUT(p); put(el, 0, .5 * rem * (1 - e), 0, 1, e); });
      }, ob);
    });
    // The QR card: one red line passes down its code as the card reaches the middle of the window.
    each('.ob-qr .scan i', function (el) {
      var b = box(el.parentNode.parentNode.parentNode), hh = el.parentNode.offsetHeight;
      add(b.cy - .66 * vh, b.cy - .44 * vh, function (p) { put(el, 0, mix(-.03, 1, p) * hh, 0, 1, p <= 0 || p >= 1 ? 0 : 1 - seg(p, .85, 1) * 1); });
    });

    // The chain. Each link starts once the hero it leaves has passed the middle of the window (its stretch has been
    // read) and lands while the hero it goes to is still in the lower part of the window, so that hero's own reveal
    // and a still moment both fit before the next link; never shorter than about half a window, and never before the
    // link before it has finished.
    var link = function (key, el, from, to, min, after) {
      var land = document.getElementById(el.getAttribute('data-go'));
      if (!land || !el.offsetWidth) return null;
      var a = box(el), b = box(land), s0 = box(el.closest('.ob')).cy - from * vh, s1 = box(land.closest('.ob')).cy - to * vh;
      if (after != null) s0 = Math.max(s0, after);
      if (s1 - s0 < min * vh) { if (after != null) s1 = s0 + min * vh; else s0 = s1 - min * vh; }
      s0 = Math.max(0, s0);
      ranges[key] = [Math.round(s0), Math.round(s1)];
      return { a: s0, b: s1, dx: b.cx - a.cx, dy: b.cy - a.cy, sw: b.w / a.w, sh: b.h / a.h };
    };
    var hide = function (el) { return function () { put(el, 0, 0, 0, 1, 0); }; };

    // 1. The receipt becomes the bill on the split phone.
    var rc = document.querySelector('.rc-go'), split = document.querySelector('.ob-split');
    var L1 = rc && link('bill', rc, LIFT, .72, .48, null);
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
      var t1 = L1.b, rows = [];
      each('.sp-row', function (el) { rows.push([el]); }, split);
      rows.splice(3, 0, Array.prototype.slice.call(split.querySelectorAll('.share > .sv')));
      rows.forEach(function (els, k) {
        var a = t1 + .02 * vh + k * .035 * vh;
        els.forEach(function (el) { add(a, a + .09 * vh, function (p) { var e = OUT(p); put(el, 0, .6 * rem * (1 - e), 0, .985 + .015 * e, e); }); });
      });
      var splitDone = t1 + .02 * vh + (rows.length - 1) * .035 * vh + .09 * vh;

      // 2. Three shares leave for the other guests; yours becomes the payment.
      var mine = split.querySelector('.share-3'), pay = document.querySelector('.ob-pay');
      var L2 = mine && link('share', mine, LIFT, .72, .48, splitDone);
      if (L2) {
        var w = mine.offsetWidth, amt = pay.querySelector('.pay-amt'), msh = mine.querySelector('.go-sh');
        // Three shares slide out from under yours, each toward its own guest's seat, turning, and fade as they go.
        var away = [[-1.2, -.35, -9], [1.25, -.55, 8], [-1.05, .7, -6]];
        each('.share-0, .share-1, .share-2', function (el, k) {
          var v = away[k];
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
        // The tip, the ways to pay and the button come up in turn.
        var t2 = L2.b;
        each('.pay-row', function (el) { var k = +el.getAttribute('data-k'), a = t2 + .01 * vh + k * .035 * vh; add(a, a + .1 * vh, function (p) { var e = OUT(p); put(el, 0, .5 * rem * (1 - e), 0, 1, e); }); }, pay);
        var payDone = t2 + .01 * vh + 4 * .035 * vh + .1 * vh;

        // 3. Pay is pressed and becomes Paid; the chip lifts off and becomes the head of the review card.
        var chip = pay.querySelector('.paid-go'), btn = pay.querySelector('.pay-btn'), thanks = pay.querySelector('.pay-thanks'), review = document.querySelector('.ob-review');
        var L3 = chip && link('paid', chip, LIFT, .72, .48, payDone);
        if (L3) {
          var landed = review.querySelector(".rv-paid"), k3 = Math.min(L3.sw, L3.sh), csh = chip.querySelector('.go-sh');
          // The press: the button sinks a little and turns olive (Paid) just before the travel's lift.
          var pa = L3.a - .12 * vh;
          add(pa, L3.a, function (p) {
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
          // 4. The five stars, one by one.
          var t3 = L3.b;
          each('.star', function (el, k) { var a = t3 + .03 * vh + k * .055 * vh; add(a, a + .1 * vh, function (p) { var e = OUT(p); put(el, 0, .3 * rem * (1 - e), 0, .55 + .45 * e, cl(p / .6)); }); }, review);
          ranges.stars = [Math.round(t3 + .03 * vh), Math.round(t3 + .03 * vh + 4 * .055 * vh + .1 * vh)];
        }
      }
    }

    // The captions: line by line as their note arrives; beside the table they leave as their stretch goes.
    each('.note', function (note) {
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

    // Every hand-off, chain or not, by the same rule (from the hero of one step passing LIFT of the window to the hero
    // of the next at 72%), so the stills can be shot at the same points of each; the chain's own ranges win.
    var heroes = Array.prototype.filter.call(document.querySelectorAll('.table .ob.hero'), function (el) { return el.offsetWidth; }).map(box);
    var names = ['poster-qr', 'qr-menu', 'menu-bill', 'bill-split', 'split-pay', 'pay-review', 'review-again', 'again-price', 'price-close'];
    var chain = { 'bill-split': 'bill', 'split-pay': 'share', 'pay-review': 'paid' };
    names.forEach(function (n, i) {
      if (chain[n] && ranges[chain[n]]) { ranges[n] = ranges[chain[n]]; return; }
      var to = heroes[i], from = heroes[i - 1];
      if (!to) return;
      var a = from ? from.cy - LIFT * vh : 0, z = to.cy - .72 * vh;
      if (!from) z = Math.max(z, to.cy - .5 * vh);
      ranges[n] = [Math.round(Math.max(0, a)), Math.round(Math.max(a + 1, z))];
    });
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
  // Tabbing into a note shows all of it at once: never focus something still on its way in.
  document.addEventListener('focusin', function (e) {
    var n = e.target.closest ? e.target.closest('.note') : null;
    if (n && !n._shown) { n._shown = true; Array.prototype.forEach.call(n.children, function (el) { put(el, 0, 0, 0, 1, 1); }); }
  });
  measure();
})();
