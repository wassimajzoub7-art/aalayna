/* Aalayna guest app: offline shell (README "Offline").
   Registered by guest.html with the scope guest.html, so it controls the guest page
   only; every request that page makes passes through here.
   - guest.html, its scripts and venues/*.json: network first. A deploy or a menu change
     is picked up whenever the phone is online; the cached copy answers when the network
     fails or takes more than six seconds. The page itself is revalidated with the server
     on every load (one small round trip on an ETag answer), so a copy the phone's HTTP
     cache took minutes before a deploy never outlives it. A versioned script
     (aalayna-store.js?v=N) is a new address at every deploy: when the network is slow it
     waits for the network rather than answer with an older version next to a new page;
     only a failed network falls back to the same file under any query.
   - Google Fonts and images: cache first.
   - The Supabase API, other hosts and every non-GET request: never cached, never touched.
   Bump VERSION when this file or SHELL changes; activate deletes the older caches. */
var VERSION = 'aal-guest-v2';
var SHELL = [
  'guest.html',
  'aalayna-store.js',
  'restaurant-growth.js',
  'aalayna-config.js',
  'aalayna-sync.js',
  'analytics-config.js',
  'analytics.js'
];
var TIMEOUT_MS = 6000;
var FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(VERSION).then(function (cache) {
    // one missing file must not stop the others from being kept
    return Promise.all(SHELL.map(function (url) {
      return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('aal-guest-') === 0 && k !== VERSION; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function keep(request, response) {
  // opaque (cross-origin, no-cors) images and font files are kept as they came
  if (response && (response.ok || response.type === 'opaque')) {
    var copy = response.clone();
    caches.open(VERSION).then(function (cache) { return cache.put(request, copy); }).catch(function () {});
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
  return caches.match(request).then(function (hit) {
    return hit || fetch(request).then(function (response) { return keep(request, response); });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf('/rest/') >= 0 || url.pathname.indexOf('/auth/') >= 0) return;
    if (request.destination === 'image') { event.respondWith(cacheFirst(request)); return; }
    var file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    var shell = request.mode === 'navigate' || SHELL.indexOf(file) >= 0;
    var menu = /\/venues\/[^/]+\.json$/.test(url.pathname);
    if (shell || menu) event.respondWith(networkFirst(request));
    return;
  }
  if (FONT_HOSTS.indexOf(url.hostname) >= 0 || request.destination === 'image') {
    event.respondWith(cacheFirst(request));
  }
  // anything else on another host (the Supabase API, analytics): straight to the network
});
