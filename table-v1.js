/* Aalayna homepage, prototype V1: the fallback for browsers without CSS scroll-driven animations.
   Where animation-timeline: view() works, table-v1.css moves the table by itself and this script does nothing.
   Elsewhere it marks each object on the table as it comes into view (class is-in), and the stylesheet lets it
   arrive in .6 s. With reduced motion, or without IntersectionObserver, nothing is hidden and nothing moves;
   without JavaScript the table is simply laid. */
(function () {
  'use strict';
  // iOS Safari shows :active (the buttons' press) only once the page listens for touches.
  document.addEventListener('touchstart', function () {}, { passive: true });
  var mm = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
  if (mm('(prefers-reduced-motion: reduce)')) return;
  if (window.CSS && CSS.supports && CSS.supports('animation-timeline: view()')) return;
  if (!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('io');
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      seen.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -10% 0px' });
  Array.prototype.forEach.call(document.querySelectorAll('.table .ob'), function (el) { seen.observe(el); });
})();
