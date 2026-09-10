/* ============================================================================
   Aalayna sync: one venue, many phones.
   ----------------------------------------------------------------------------
   The store keeps working on localStorage exactly as before; this layer mirrors
   it to Supabase (supabase/migration.sql) so a guest's payment reaches the
   owner's dashboard. Collections become one row per record, documents one row
   per key. Remote is the source of truth on first load; afterwards every local
   write is pushed and remote changes are polled in.

   Access key: ?k=<key> in the link (kept in localStorage). Guest keys ride in
   the QR link; the owner key is typed once into the dashboard or editor. Row
   level security in Postgres decides what each key may do; this file just sends.
   Without a key or without config, nothing here runs and the apps stay local.
   ========================================================================== */
(function (global) {
  'use strict';
  var A = global.Aalayna, cfg = global.AalaynaConfig || {};
  var COLLECTIONS = ['aal.checks', 'aal.settle', 'aal.events', 'aal.guests', 'aal.campaigns',
                     'aal.edit_log', 'aal.webhook_log', 'aal.admin_notifications', 'aal.health_reports', 'aal.identity_merges'];
  var GUEST_COLLECTIONS = ['aal.checks', 'aal.settle', 'aal.events', 'aal.guests'];
  var DOCS = ['aal.draft', 'aal.live', 'aal.rate', 'aal.rate_meta', 'aal.floor', 'aal.tips'];

  /* ---- pure helpers (also unit-tested in node) ---- */
  function rowId(collection, row) {
    if (!row || typeof row !== 'object') return null;
    if (row.id != null) return String(row.id);
    if (row.eventId != null) return String(row.eventId);
    if (collection === 'aal.health_reports' && row.week) return String(row.week);
    return null;
  }
  /* rows whose JSON differs from the last pushed/pulled snapshot */
  function diffRows(collection, local, snapshot) {
    var out = [];
    (local || []).forEach(function (row) {
      var id = rowId(collection, row);
      if (!id) return;
      var json = JSON.stringify(row);
      if (snapshot[id] !== json) out.push({ id: id, body: row, json: json });
    });
    return out;
  }
  /* remote rows replace local rows with the same id; unknown local rows survive (they are pushed next) */
  function mergeRows(collection, local, remote) {
    var byId = {}, order = [];
    (local || []).forEach(function (row) { var id = rowId(collection, row); if (id) { byId[id] = row; order.push(id); } });
    (remote || []).forEach(function (r) {
      if (!byId[r.id]) order.push(r.id);
      byId[r.id] = r.body;
    });
    return order.map(function (id) { return byId[id]; });
  }
  var core = { rowId: rowId, diffRows: diffRows, mergeRows: mergeRows, COLLECTIONS: COLLECTIONS, DOCS: DOCS };
  if (A) A.syncCore = core; else global.AalaynaSyncCore = core;

  if (!A || !cfg.supabaseUrl || !cfg.anonKey || !global.localStorage) return;

  /* ---- key + venue ---- */
  var key = '';
  try {
    var q = new URLSearchParams(global.location.search), k = (q.get('k') || '').trim();
    if (/^(own|gst)_[0-9a-f]{12,64}$/.test(k)) localStorage.setItem('aal.key', k);
    key = localStorage.getItem('aal.key') || '';
  } catch (e) {}
  var state = { status: key ? 'starting' : 'no-key', role: key.indexOf('own_') === 0 ? 'owner' : key ? 'guest' : null,
                lastPull: null, lastPush: null, pushed: 0, pulled: 0, errors: 0, lastError: null };
  A.sync = { state: function () { return JSON.parse(JSON.stringify(state)); }, pull: function () { return pull(); }, key: function () { return key; } };
  if (!key) return;
  var rid = A.venueId();
  var base = cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/';
  var headers = { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey, 'x-aalayna-key': key, 'x-aalayna-device': A.device(), 'Content-Type': 'application/json' };

  function call(path, opts) {
    opts = opts || {};
    return fetch(base + path, { method: opts.method || 'GET', headers: Object.assign({}, headers, opts.headers || {}),
                                body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) {
        return res.text().then(function (t) {
          if (!res.ok) throw new Error(res.status + ' ' + t.slice(0, 160));
          return t ? JSON.parse(t) : null;      // 201/204 with return=minimal have no body
        });
      });
  }
  function fail(e) { state.errors++; state.lastError = String(e && e.message || e); state.status = 'error'; }
  var enc = encodeURIComponent;

  /* ---- snapshots: what remote is known to hold ---- */
  var snap = {};           // collection -> { id: json }
  var docSnap = {};        // key -> json
  var ready = false, paused = false, timers = {}, sinceRows = null, sinceDocs = null;
  COLLECTIONS.forEach(function (c) { snap[c] = {}; });

  function apply(rowsByCollection, docs) {
    var changed = [];
    Object.keys(rowsByCollection).forEach(function (c) {
      var local = A.util.read(c, []), merged = mergeRows(c, local, rowsByCollection[c]);
      rowsByCollection[c].forEach(function (r) { snap[c][r.id] = JSON.stringify(r.body); });
      if (JSON.stringify(merged) !== JSON.stringify(local)) { A.util.rawWrite(c, merged); changed.push(c); }
    });
    (docs || []).forEach(function (d) {
      var json = JSON.stringify(d.body);
      docSnap[d.key] = json;
      if (JSON.stringify(A.util.read(d.key, null)) !== json) { A.util.rawWrite(d.key, d.body); changed.push(d.key); }
    });
    return changed;
  }

  function pull(full) {
    var rowsQ = 'kv_rows?restaurant_id=eq.' + enc(rid) + '&select=collection,id,body,updated_at&order=updated_at.asc' + (!full && sinceRows ? '&updated_at=gt.' + enc(sinceRows) : '');
    var docsQ = 'kv_docs?restaurant_id=eq.' + enc(rid) + '&select=key,body,updated_at&order=updated_at.asc' + (!full && sinceDocs ? '&updated_at=gt.' + enc(sinceDocs) : '');
    return Promise.all([call(rowsQ), call(docsQ)]).then(function (res) {
      var byC = {};
      (res[0] || []).forEach(function (r) { if (COLLECTIONS.indexOf(r.collection) < 0) return; (byC[r.collection] = byC[r.collection] || []).push(r); sinceRows = r.updated_at; });
      (res[1] || []).forEach(function (d) { sinceDocs = d.updated_at; });
      var docs = (res[1] || []).filter(function (d) { return DOCS.indexOf(d.key) > -1; });
      state.pulled += (res[0] || []).length + docs.length;
      state.lastPull = new Date().toISOString();
      state.status = 'live';
      return apply(byC, docs);
    });
  }

  function pushCollection(c) {
    var rows = diffRows(c, A.util.read(c, []), snap[c]);
    if (!rows.length) return Promise.resolve();
    if (state.role === 'guest' && GUEST_COLLECTIONS.indexOf(c) < 0) return Promise.resolve();
    var body = rows.map(function (r) { return { restaurant_id: rid, collection: c, id: r.id, body: r.body }; });
    /* events are append-only: a retry must never turn into an update */
    var resolution = c === 'aal.events' ? 'ignore-duplicates' : 'merge-duplicates';
    return call('kv_rows?on_conflict=restaurant_id,collection,id', { method: 'POST', headers: { Prefer: 'resolution=' + resolution + ',return=minimal' }, body: body })
      .then(function () { rows.forEach(function (r) { snap[c][r.id] = r.json; }); state.pushed += rows.length; state.lastPush = new Date().toISOString(); });
  }
  function pushDoc(k) {
    var v = A.util.read(k, null);
    if (v == null) return Promise.resolve();
    var json = JSON.stringify(v);
    if (docSnap[k] === json) return Promise.resolve();
    if (state.role !== 'owner') return Promise.resolve();                 // guests never write documents
    if ((k === 'aal.draft' || k === 'aal.live') && v && v.at === 'seed') return Promise.resolve();   // a fresh device's seed never overwrites a venue's menu
    return call('kv_docs?on_conflict=restaurant_id,key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                body: [{ restaurant_id: rid, key: k, body: v }] })
      .then(function () { docSnap[k] = json; state.pushed++; state.lastPush = new Date().toISOString(); });
  }
  function schedulePush(k) {
    clearTimeout(timers[k]);
    timers[k] = setTimeout(function () {
      var p = COLLECTIONS.indexOf(k) > -1 ? pushCollection(k) : DOCS.indexOf(k) > -1 ? pushDoc(k) : Promise.resolve();
      p.catch(fail);
    }, 150);
  }

  A.util.hooks.afterWrite.push(function (k) {
    if (!ready || paused) return;
    if (COLLECTIONS.indexOf(k) > -1 || DOCS.indexOf(k) > -1) schedulePush(k);
  });

  /* reset() is a demo control: it wipes this device, never the venue */
  var originalReset = A.reset;
  A.reset = function () {
    paused = true;
    try { originalReset.apply(A, arguments); } finally {}
    COLLECTIONS.forEach(function (c) { snap[c] = {}; }); docSnap = {}; sinceRows = null; sinceDocs = null;
    pull(true).catch(fail).then(function () { paused = false; });
  };

  /* boot: remote first, then push whatever this device holds that remote lacks */
  pull(true).then(function () {
    ready = true;
    var work = COLLECTIONS.map(pushCollection).concat(DOCS.map(pushDoc));
    return Promise.all(work.map(function (p) { return p.catch(fail); }));
  }).catch(function (e) { fail(e); ready = true; });

  function tick() {
    if (!ready || paused || global.document.visibilityState === 'hidden') return;
    pull(false).catch(fail);   // rawWrite already notifies subscribers for every key that changed
  }
  setInterval(tick, 4000);
  global.document.addEventListener('visibilitychange', function () { if (global.document.visibilityState === 'visible') tick(); });
})(window);
