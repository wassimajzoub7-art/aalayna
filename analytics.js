(function (global) {
  'use strict';
  var KEY = 'aal.marketing.events';
  var allowed = ['demo_start', 'demo_open', 'demo_complete', 'demo_cash_requested', 'whatsapp_click', 'booking_click', 'booking_page_view', 'booking_calendar_click'];
  var privacyOptOut = global.navigator.doNotTrack === '1' || global.navigator.globalPrivacyControl === true;
  function events() {
    try { var data = JSON.parse(global.localStorage.getItem(KEY) || '[]'); return Array.isArray(data) ? data : []; }
    catch (e) { return []; }
  }
  function track(name, placement) {
    if (privacyOptOut || allowed.indexOf(name) === -1) return;
    // Only fixed event names, short placement tokens, and a path. Never contacts,
    // bill contents, payment amounts, query strings, or marketing consent data.
    var event = { name: name, placement: /^[a-z_]{1,40}$/.test(placement || '') ? placement : 'unspecified', path: global.location.pathname, at: new Date().toISOString() };
    try { global.localStorage.setItem(KEY, JSON.stringify(events().concat([event]).slice(-300))); } catch (e) {}
    global.dispatchEvent(new CustomEvent('aalayna:analytics', { detail: event }));
    var endpoint = (global.AalaynaAnalyticsConfig || {}).endpoint;
    if (!endpoint || !/^https:\/\//.test(endpoint)) return;
    var payload = JSON.stringify(event);
    try {
      if (global.navigator.sendBeacon && global.navigator.sendBeacon(endpoint, new Blob([payload], { type: 'text/plain;charset=UTF-8' }))) return;
      global.fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: payload, keepalive: true, credentials: 'omit' }).catch(function () {});
    } catch (e) { /* Measurement must never interfere with navigation. */ }
  }
  global.AalaynaAnalytics = { track: track, events: events, clear: function () { try { global.localStorage.removeItem(KEY); } catch (e) {} } };
  global.document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('[data-track]');
    if (link) track(link.dataset.track, link.dataset.placement);
  });
  var file = global.location.pathname.split('/').pop();
  if (file === '3alyna_full_flow.html') track('demo_open', 'guest_demo');
  if (file === 'book.html') track('booking_page_view', 'booking');
})(window);
