/* Aalayna offline shell (README "Offline", docs/resilience.md).
   One file, two registrations, each with its own scope, cache and precache list:
   - guest.html registers sw.js with the scope guest.html (GUEST_SHELL, cache aal-guest-*);
   - dashboard.html registers sw.js?shell=staff with the scope dashboard.html (STAFF_SHELL,
     cache aal-staff-*). A guest phone never downloads the dashboard.
   Every request the controlled page makes passes through here.
   - The page, its scripts and venues/*.json: network first. A deploy or a menu change
     is picked up whenever the device is online; the cached copy answers when the network
     fails or takes more than six seconds. The page itself is revalidated with the server
     on every load (one small round trip on an ETag answer), so a copy the phone's HTTP
     cache took minutes before a deploy never outlives it. A versioned script
     (aalayna-store.js?v=N) is a new address at every deploy: when the network is slow it
     waits for the network rather than answer with an older version next to a new page;
     only a failed network falls back to the same file under any query.
   - Any other same-origin script, style, font, JSON or SVG: network first too, kept once
     fetched (T1), so a file a page starts using is there offline after one visit.
   - Google Fonts and images: cache first. The guest page also asks this worker to keep
     its menu photos (a 'warm' message, at most WARM_MAX), which load lazily otherwise.
   - The Supabase API, other hosts and every non-GET request: never cached, never touched.
     Data offline is the store's last good read (aalayna-sync.js), never an old HTTP answer.
   Bump VERSION (guest) or STAFF_VERSION (staff) when this file or that shell list changes;
   activate deletes the older caches of its own kind only. */
var VERSION = 'aal-guest-v3';
var STAFF_VERSION = 'aal-staff-v2';
var GUEST_SHELL = [
  'guest.html',
  'aalayna-store.js',
  'restaurant-growth.js',
  'aalayna-config.js',
  'aalayna-sync.js',
  'analytics-config.js',
  'analytics.js'
];
var STAFF_SHELL = [
  'dashboard.html',
  'aalayna-store.js',
  'restaurant-growth.js',
  'owner-metrics.js',
  'aalayna-config.js',
  'aalayna-sync.js',
  'restaurant-ops.css',
  'restaurant-ops.js',
  'owner-group.js'
];
var TIMEOUT_MS = 6000;
var WARM_MAX = 60;
var FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
var STATIC = /\.(js|css|json|svg|woff2?|ttf|otf)$/;
var STAFF = /[?&]shell=staff(&|$)/.test((self.location && self.location.search) || '');
var CACHE = STAFF ? STAFF_VERSION : VERSION;
var PREFIX = STAFF ? 'aal-staff-' : 'aal-guest-';
var SHELL = STAFF ? STAFF_SHELL : GUEST_SHELL;

/* Which strategy a GET request gets: 'network' (network first), 'cache' (cache first) or
   null (not touched). Pure, so tests/resilience.test.cjs can check it. */
function route(url, mode, destination, origin) {
  if (url.origin === origin) {
    if (url.pathname.indexOf('/rest/') >= 0 || url.pathname.indexOf('/auth/') >= 0 || url.pathname.indexOf('/functions/') >= 0) return null;
    if (destination === 'image') return 'cache';
    var file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    if (mode === 'navigate' || SHELL.indexOf(file) >= 0) return 'network';
    if (/\/venues\/[^/]+\.json$/.test(url.pathname)) return 'network';
    if (STATIC.test(url.pathname)) return 'network';
    return null;
  }
  if (FONT_HOSTS.indexOf(url.hostname) >= 0 || destination === 'image') return 'cache';
  // anything else on another host (the Supabase API, analytics): straight to the network
  return null;
}

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    // one missing file must not stop the others from being kept
    return Promise.all(SHELL.map(function (url) {
      return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function keep(request, response) {
  // opaque (cross-origin, no-cors) images and font files are kept as they came
  if (response && (response.ok || response.type === 'opaque')) {
    var copy = response.clone();
    caches.open(CACHE).then(function (cache) { return cache.put(request, copy); }).catch(function () {});
  }
  return response;
}

function cached(request, loose) {
  // the page is opened with different queries (?menu=, ?table=, ?v= on scripts):
  // an exact match first, then, when loose, the same file under any query
  return caches.match(request).then(function (hit) {
    return hit || (loose ? caches.match(request, { ignoreSearch: true }) : null);
  });
}

function networkFirst(request) {
  var navigate = request.mode === 'navigate';
  return new Promise(function (resolve, reject) {
    var settled = false;
    function fallback(error, loose) {
      cached(request, loose).then(function (hit) {
        if (settled) return;
        if (hit) { settled = true; resolve(hit); }
        else if (error) { settled = true; reject(error); }
      });
    }
    // slow: the page under any query answers; a versioned script only in its exact version
    var timer = setTimeout(function () { fallback(null, navigate); }, TIMEOUT_MS);
    // the page is revalidated with the server; a request with mode 'navigate' cannot be rebuilt, so its URL is fetched
    var fetching = navigate ? fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(request);
    fetching.then(function (response) {
      clearTimeout(timer);
      if (settled) { keep(request, response); return; }
      settled = true;
      resolve(keep(request, response));
    }, function (error) {
      clearTimeout(timer);
      fallback(error || new Error('offline'), true);   // no network: anything kept for this file
    });
  });
}

function cacheFirst(request) {
  // an opaque photo kept by 'warm' carries no headers to vary on
  return caches.match(request, { ignoreVary: true }).then(function (hit) {
    return hit || fetch(request).then(function (response) { return keep(request, response); });
  });
}

/* The guest page names its menu photos once the menu is painted: kept now, so the menu
   keeps its pictures offline even for the dishes nobody scrolled to. https only. */
function warm(urls) {
  var list = (urls || []).filter(function (u) { return typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u); }).slice(0, WARM_MAX);
  return caches.open(CACHE).then(function (cache) {
    return Promise.all(list.map(function (u) {
      var request = new Request(u, { mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      return cache.match(request, { ignoreVary: true }).then(function (hit) {
        if (hit) return;
        return fetch(request).then(function (response) {
          if (response && (response.ok || response.type === 'opaque')) return cache.put(request, response);
        });
      }).catch(function () {});
    }));
  });
}

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'warm' && event.waitUntil) event.waitUntil(warm(data.urls));
  else if (data.type === 'warm') warm(data.urls);
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var how = route(new URL(request.url), request.mode, request.destination, self.location.origin);
  if (how === 'network') event.respondWith(networkFirst(request));
  else if (how === 'cache') event.respondWith(cacheFirst(request));
});
