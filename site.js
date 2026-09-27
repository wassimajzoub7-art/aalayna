/* Aalayna homepages (index.html, fr/, ar/): the three steps as a carousel on phones, sections that rise in as they
   scroll into view, and the outcome figures counting up. Without JavaScript the page reads the same: the steps still
   swipe (CSS scroll snap), nothing is hidden, and the figures show their values. With reduced motion there is no
   animation at all, only the carousel's arrows and dots. */
(function () {
  'use strict';
  var mm = function (q) { return window.matchMedia ? window.matchMedia(q) : { matches: false, addListener: function () {} }; };
  var reduce = mm('(prefers-reduced-motion: reduce)').matches;
  var io = 'IntersectionObserver' in window;

  /* ---------- The three steps: a carousel on phones ---------- */
  var steps = document.querySelector('#how .steps'), nav = document.querySelector('#how .steps-nav');
  if (steps && nav && io) {
    var cards = Array.prototype.slice.call(steps.children);
    var dots = Array.prototype.slice.call(nav.querySelectorAll('.steps-dots button'));
    var prev = nav.querySelector('[data-step="-1"]'), next = nav.querySelector('[data-step="1"]');
    var phone = mm('(max-width: 767px)'), cur = 0;
    var set = function (i) {
      cur = i;
      cards.forEach(function (c, k) { c.classList.toggle('is-active', k === i); });
      dots.forEach(function (d, k) { d.setAttribute('aria-current', k === i ? 'true' : 'false'); });
      prev.disabled = i === 0; next.disabled = i === cards.length - 1;
    };
    // Centre the card by scrolling the row sideways only (the page stays put). Measured on screen, so it holds in
    // Arabic too, where the row scrolls the other way.
    var go = function (i) {
      i = Math.max(0, Math.min(cards.length - 1, i));
      var c = cards[i].getBoundingClientRect(), r = steps.getBoundingClientRect();
      steps.scrollBy({ left: c.left + c.width / 2 - (r.left + r.width / 2), behavior: reduce ? 'auto' : 'smooth' });
      set(i);
    };
    prev.addEventListener('click', function () { go(cur - 1); });
    next.addEventListener('click', function () { go(cur + 1); });
    dots.forEach(function (d, k) { d.addEventListener('click', function () { go(k); }); });
    // The card most in view is the current one, however it got there (a swipe, an arrow, a dot).
    var seen = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting && e.intersectionRatio >= 0.6) set(cards.indexOf(e.target)); });
    }, { root: steps, threshold: [0.6] });
    cards.forEach(function (c) { seen.observe(c); });
    var mode = function () { nav.hidden = !phone.matches; steps.classList.toggle('is-live', phone.matches); };
    if (phone.addEventListener) phone.addEventListener('change', mode); else phone.addListener(mode);
    mode(); set(0);
  }

  if (reduce || !io) return;

  /* ---------- Sections rise in as they arrive; items in a row follow one another ---------- */
  var groups = [
    '#how > .eyebrow, #how > h2', '#how .steps article',
    '#outcomes .wrap > .eyebrow, #outcomes h2', '.outcomes article', '.calc-link, .outcomes-note',
    '#experience > .eyebrow, #experience > h2', '.experience-grid > *',
    '#pricing > .eyebrow, #pricing > h2, .section-intro', '.pricing-grid > *',
    '.retention-heading > *', '.retention-steps article', '.retention-status',
    '.faq-section > div:first-child', '.faq details',
    '#contact .wrap > *'
  ];
  var rise = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); rise.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  groups.forEach(function (sel) {
    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el, i) {
      if (steps && steps.contains(el) && mm('(max-width: 767px)').matches) return;   // the carousel animates on its own
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
      var el = e.target, text = el.textContent, m = text.match(/^(\d+)(.*)$/);
      if (!m || +m[1] < 5) return;
      var to = +m[1], t0 = null;
      el.setAttribute('aria-label', text);
      var tick = function (now) {
        if (t0 === null) t0 = now;
        var k = Math.min(1, (now - t0) / 900), v = Math.round(to * (1 - Math.pow(1 - k, 3)));
        el.textContent = v + m[2];
        if (k < 1) requestAnimationFrame(tick); else { el.textContent = text; el.removeAttribute('aria-label'); }
      };
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.6 });
  Array.prototype.forEach.call(document.querySelectorAll('.outcome-figure'), function (el) { count.observe(el); });
})();
