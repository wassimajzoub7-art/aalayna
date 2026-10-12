/* Aalayna homepages (index.html, fr/, ar/): the four steps as one stage on a computer, sections that rise in as
   they scroll into view, and the outcome figures counting up. Without JavaScript the page reads the same: each step
   keeps its own screen beside it, nothing is hidden, and the figures show their values. With reduced motion nothing
   rises or counts; the stage still changes screen, as a plain fade. */
(function () {
  'use strict';
  var mm = function (q) { return window.matchMedia ? window.matchMedia(q) : { matches: false, addListener: function () {} }; };
  var reduce = mm('(prefers-reduced-motion: reduce)').matches;
  var io = 'IntersectionObserver' in window;
  // iOS Safari shows :active (the buttons' press) only once the page listens for touches.
  document.addEventListener('touchstart', function () {}, { passive: true });

  /* ---------- The four steps: one phone that changes screen as each step passes ---------- */
  // On a computer (website.css's stage: 1024 px wide and 600 px tall at least) the steps scroll by beside one phone.
  // The step whose text crosses the band just above the middle of the window is lit, and the phone shows its
  // screen. However the page got there (a wheel, a trackpad, the keyboard, a link), the step in view is the one lit.
  var steps = document.querySelector('#how .steps');
  if (steps && io) {
    var arts = Array.prototype.slice.call(steps.children);
    var stage = mm('(min-width: 1024px) and (min-height: 600px)');
    var light = function (i) { arts.forEach(function (a, k) { a.classList.toggle('is-active', k === i); }); };
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) light(arts.indexOf(e.target.parentNode)); });
    }, { rootMargin: '-44% 0px -54% 0px' });
    arts.forEach(function (a) { var t = a.querySelector('.step-text'); if (t) spy.observe(t); });
    light(0);
    var mode = function () { steps.classList.toggle('is-live', stage.matches); };
    if (stage.addEventListener) stage.addEventListener('change', mode); else stage.addListener(mode);
    mode();
  }

  if (reduce || !io) return;

  /* ---------- Sections rise in as they arrive; items in a row follow one another ---------- */
  var groups = [
    '#how > .eyebrow, #how > h2', '#how .steps article', '#how .section-cta',
    '#outcomes .wrap > .eyebrow, #outcomes h2', '.outcomes article', '#outcomes .section-cta',
    '#pricing > .eyebrow, #pricing > h2', '.pilot > .pill, .pilot > h3, .pilot-steps li', '.price-card',
    '.faq-section > div:first-child', '.faq details', '.faq .section-cta',
    '#contact .wrap > *'
  ];
  // Items that arrive together follow one another, 60 ms apart; an item that arrives alone does not wait.
  var rise = new IntersectionObserver(function (es) {
    var k = 0;
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.style.transitionDelay = Math.min(k++, 5) * 60 + 'ms';
      e.target.classList.add('is-in');
      rise.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  groups.forEach(function (sel) {
    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) { el.classList.add('js-reveal'); rise.observe(el); });
  });
  // Tabbing into a section that has not risen yet shows it at once: never focus on something still invisible.
  document.addEventListener('focusin', function (e) {
    var el = e.target.closest ? e.target.closest('.js-reveal:not(.is-in)') : null;
    while (el) {
      el.style.transition = 'none'; el.classList.add('is-in'); rise.unobserve(el);
      el = el.parentElement ? el.parentElement.closest('.js-reveal:not(.is-in)') : null;
    }
  });

  /* ---------- Outcome figures count up once, to the value that was always in the page ---------- */
  var count = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      count.unobserve(e.target);
      var el = e.target, text = el.textContent, m = text.match(/^([+−-]?)(\d+)(.*)$/);   // 10 min, 22%, 83%, 50%
      if (!m || +m[2] < 5) return;
      var to = +m[2], t0 = null;
      el.setAttribute('aria-label', text);
      var tick = function (now) {
        if (t0 === null) t0 = now;
        var k = Math.min(1, (now - t0) / 800), v = Math.round(to * (1 - Math.pow(1 - k, 3)));
        el.textContent = m[1] + v + m[3];
        if (k < 1) requestAnimationFrame(tick); else { el.textContent = text; el.removeAttribute('aria-label'); }
      };
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.6 });
  Array.prototype.forEach.call(document.querySelectorAll('.outcome-figure'), function (el) { count.observe(el); });
})();
