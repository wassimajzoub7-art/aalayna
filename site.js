/* Aalayna homepages (index.html, fr/, ar/): the four steps as a carousel, sections that rise in as they scroll into
   view, and the outcome figures counting up. Without JavaScript the page reads the same: the steps still scroll and
   snap (CSS), nothing is hidden, and the figures show their values. With reduced motion there is no animation at all,
   only the carousel's arrows and dots. */
(function () {
  'use strict';
  var mm = function (q) { return window.matchMedia ? window.matchMedia(q) : { matches: false, addListener: function () {} }; };
  var reduce = mm('(prefers-reduced-motion: reduce)').matches;
  var io = 'IntersectionObserver' in window;

  /* ---------- The four steps: a carousel at every width ---------- */
  // Computers see three cards and the edge of the fourth, phones one card with its neighbours peeking in. A card is
  // lit while it is fully in view, and so is its dot; the arrows move one card at a time.
  var steps = document.querySelector('#how .steps'), nav = document.querySelector('#how .steps-nav');
  if (steps && nav && io) {
    var cards = Array.prototype.slice.call(steps.children);
    var dots = Array.prototype.slice.call(nav.querySelectorAll('.steps-dots button'));
    var prev = nav.querySelector('[data-step="-1"]'), next = nav.querySelector('[data-step="1"]');
    var shown = cards.map(function () { return 0; }), cur = 0;
    var paint = function () {
      var lit = shown.map(function (r) { return r >= 0.9; });
      cur = lit.indexOf(true);
      if (cur < 0) { cur = 0; shown.forEach(function (r, k) { if (r > shown[cur]) cur = k; }); }
      cards.forEach(function (c, k) { c.classList.toggle('is-seen', lit[k]); });
      dots.forEach(function (d, k) { d.classList.toggle('is-seen', lit[k]); d.setAttribute('aria-current', k === cur ? 'true' : 'false'); });
      prev.disabled = lit[0]; next.disabled = lit[cards.length - 1];
    };
    // Bring card i into place by scrolling the row sideways only (the page stays put): its start edge on computers,
    // its centre on phones, as its scroll-snap-align says. Measured on screen, so it holds in Arabic too, where the
    // row runs the other way.
    var go = function (i) {
      i = Math.max(0, Math.min(cards.length - 1, i));
      var c = cards[i].getBoundingClientRect(), r = steps.getBoundingClientRect(), row = getComputedStyle(steps);
      var pad = parseFloat(row.scrollPaddingInlineStart) || 0, centre = getComputedStyle(cards[i]).scrollSnapAlign.indexOf('center') >= 0;
      var dx = centre ? c.left + c.width / 2 - (r.left + r.width / 2) : row.direction === 'rtl' ? c.right - (r.right - pad) : c.left - (r.left + pad);
      steps.scrollBy({ left: dx, behavior: reduce ? 'auto' : 'smooth' });
    };
    prev.addEventListener('click', function () { go(cur - 1); });
    next.addEventListener('click', function () { go(cur + 1); });
    dots.forEach(function (d, k) { d.addEventListener('click', function () { go(k); }); });
    // How much of each card is in view, however it got there (a swipe, a trackpad, an arrow, a dot).
    var seen = new IntersectionObserver(function (es) {
      es.forEach(function (e) { shown[cards.indexOf(e.target)] = e.isIntersecting ? e.intersectionRatio : 0; });
      steps.classList.add('is-live');
      paint();
    }, { root: steps, threshold: [0, 0.25, 0.5, 0.75, 0.9, 1] });
    cards.forEach(function (c) { seen.observe(c); });
    nav.hidden = false;
  }

  if (reduce || !io) return;

  /* ---------- Sections rise in as they arrive; items in a row follow one another ---------- */
  var groups = [
    '#how > .eyebrow, #how > h2', '#how .steps article',
    '#outcomes .wrap > .eyebrow, #outcomes h2', '.outcomes article', '.calc-link',
    '#pricing > .eyebrow, #pricing > h2', '.pricing-grid > *',
    '.faq-section > div:first-child', '.faq details', '.section-cta',
    '#contact .wrap > *'
  ];
  var rise = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); rise.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  groups.forEach(function (sel) {
    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el, i) {
      if (steps && steps.contains(el)) return;   // the carousel lights its own cards
      el.classList.add('js-reveal');
      el.style.transitionDelay = Math.min(i, 5) * 80 + 'ms';
      rise.observe(el);
    });
  });

  /* ---------- Outcome figures count up once, to the value that was always in the page ---------- */
  var count = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      count.unobserve(e.target);
      var el = e.target, text = el.textContent, m = text.match(/^([+\u2212-]?)(\d+)(.*)$/);   // 13 min, +62%, 140
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
  Array.prototype.forEach.call(document.querySelectorAll('.outcome-figure'), function (el) { count.observe(el); });
})();
