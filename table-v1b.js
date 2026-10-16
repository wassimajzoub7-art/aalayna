/* Aalayna homepage, prototype V1 (style B, paper): two small jobs for the table; the page reads without either.

   1. The two travels. Where CSS scroll-driven animations run, the receipt travels from its tray into the split phone,
      and your share from the split phone into the payment. CSS cannot know how far apart they lie (the notes between
      them change height with the language and the window), so this measures it: for each traveller ([data-go], with
      the id of the box it lands in) it sets --dx, --dy and --s (how far, and how much it shrinks or grows), and on
      the page the scroll positions the travel runs between (--bill-a, --bill-b, --share-a, --share-b): from when the
      traveller is data-from of the way down the window to when its landing box is data-to of the way down, never
      shorter than data-min of a window. The shares only leave once all four have come up. Then it marks html.tv and
      table-v1b.css does the rest. It measures again when the window or the fonts change.
   2. The fallback. Without scroll-driven animations it marks each object on the table as it comes into view (class
      is-in), and the stylesheet sets it down in .7 s.
   With reduced motion, or without IntersectionObserver, nothing is hidden and nothing moves. */
(function () {
  'use strict';
  // iOS Safari shows :active (the buttons' press) only once the page listens for touches.
  document.addEventListener('touchstart', function () {}, { passive: true });
  var mm = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
  if (mm('(prefers-reduced-motion: reduce)')) return;
  var root = document.documentElement;

  if (window.CSS && CSS.supports && CSS.supports('animation-timeline: view()')) {
    // Where an element lies on the page, before any transform: offsets add up to the document.
    var box = function (el) {
      var x = 0, y = 0, w = el.offsetWidth, h = el.offsetHeight;
      for (var n = el; n; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
      return { w: w, h: h, cx: x + w / 2, cy: y + h / 2 };
    };
    var measure = function () {
      var vh = window.innerHeight, ends = {};
      Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (el) {
        var to = document.getElementById(el.getAttribute('data-go'));
        if (!to || !el.offsetWidth) return;
        var a = box(el), b = box(to), key = el.getAttribute('data-go') === 'land-bill' ? 'bill' : 'share';
        var s = key === 'bill' ? Math.min(b.w / a.w, b.h / a.h) : b.w / a.w;
        var s0 = a.cy - parseFloat(el.getAttribute('data-from')) * vh;
        var s1 = b.cy - parseFloat(el.getAttribute('data-to')) * vh;
        var min = parseFloat(el.getAttribute('data-min')) * vh;
        if (key === 'share' && ends.bill) s0 = Math.max(s0, ends.bill[1] + 0.42 * vh);
        if (s1 - s0 < min) { if (key === 'share') s1 = s0 + min; else s0 = s1 - min; }
        s0 = Math.max(0, s0);
        ends[key] = [s0, s1];
        el.style.setProperty('--dx', (b.cx - a.cx).toFixed(1) + 'px');
        el.style.setProperty('--dy', (b.cy - a.cy).toFixed(1) + 'px');
        el.style.setProperty('--s', s.toFixed(3));
        root.style.setProperty('--' + key + '-a', Math.round(s0) + 'px');
        root.style.setProperty('--' + key + '-b', Math.round(s1) + 'px');
      });
      if (ends.bill && ends.share) root.classList.add('tv');
    };
    var t;
    var again = function () { clearTimeout(t); t = setTimeout(measure, 120); };
    measure();
    window.addEventListener('resize', again);
    window.addEventListener('load', measure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    return;
  }
  if (!('IntersectionObserver' in window)) return;
  root.classList.add('io');
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      seen.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -10% 0px' });
  Array.prototype.forEach.call(document.querySelectorAll('.table .ob'), function (el) { seen.observe(el); });
})();
