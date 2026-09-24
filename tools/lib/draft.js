'use strict';
/* Fold a menu pack into the venue's draft and publish it, with the editor's own code.
   aalayna-store.js runs in a vm sandbox (as the tests load it); the server's current
   aal.draft and aal.live are written into its scoped storage the way aalayna-sync.js
   lands a pull, then the pack goes in exactly as the ?menu=<slug> import does it
   (aalayna-store.js, "venue theme + menu pack"): d.sections = pack.sections,
   d.items = pack.items, saveDraft(d), publish(). So items are normalised, a dish that was
   in the old draft and is missing from the pack is kept as archived, version is the live
   version + 1 and at is the publish time. The result is the two documents the editor's
   outbox would send to kv_docs. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./supabase');

function sandbox() {
  const map = new Map();
  const storage = { getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
  const window = { location: { search: '' }, addEventListener() {}, localStorage: storage, crypto: require('crypto').webcrypto };
  const ctx = vm.createContext({ window, localStorage: storage, URLSearchParams, Date, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'aalayna-store.js'), 'utf8'), ctx, { filename: 'aalayna-store.js' });
  return window.Aalayna;
}

/* serverDraft / serverLive: the bodies from aal_snapshot, or null for a new venue. */
function publishPack(pack, serverDraft, serverLive) {
  const A = sandbox();
  // activateScope seeds and migrates the demo menu in the new scope first; the server's
  // documents then replace it, so nothing of the demo reaches this venue
  A.util.activateScope('onboard');
  const empty = { version: 0, sections: [], items: [], at: 'seed' };
  A.util.rawWrite('aal.live', serverLive || empty);
  A.util.rawWrite('aal.draft', serverDraft || serverLive || empty);
  const d = A.draft();
  d.sections = JSON.parse(JSON.stringify(pack.sections));
  d.items = JSON.parse(JSON.stringify(pack.items));
  A.saveDraft(d);
  A.publish();
  return { draft: A.util.read('aal.draft', null), live: A.util.read('aal.live', null) };
}

/* The checks the store's import does not make, so a broken pack never reaches guests. */
function checkPack(pack) {
  const errs = [];
  if (!pack || typeof pack !== 'object') return ['the file is not a JSON object'];
  if (!Array.isArray(pack.sections) || !pack.sections.length) errs.push('it has no sections');
  if (!Array.isArray(pack.items) || !pack.items.length) errs.push('it has no items');
  if (errs.length) return errs;
  const secs = {}, ids = {};
  pack.sections.forEach(function (s, i) {
    if (!s || !s.id || !s.name) errs.push('section ' + (i + 1) + ' needs an id and a name');
    else secs[s.id] = 1;
  });
  pack.items.forEach(function (x, i) {
    const label = 'item ' + (i + 1) + (x && x.name ? ' (' + x.name + ')' : '');
    if (!x || typeof x !== 'object') { errs.push(label + ' is not an object'); return; }
    if (!x.id) errs.push(label + ' has no id');
    else if (ids[x.id]) errs.push(label + ' repeats the id ' + x.id);
    else ids[x.id] = 1;
    if (!x.name) errs.push(label + ' has no name');
    // the importer writes null for a price it could not read; the store would show it as 0.00
    if (x.price === null || x.price === undefined) errs.push(label + ' has no price: write one in');
    else if (typeof x.price !== 'number' || !(x.price >= 0)) errs.push(label + ' has a price that is not a number');
    if (!secs[x.sec]) errs.push(label + ' is in a section that does not exist (' + x.sec + ')');
  });
  return errs.slice(0, 10);
}

function visibleCount(menu) {
  return ((menu && menu.items) || []).filter(function (x) { return !x.archivedAt; }).length;
}

module.exports = { publishPack, checkPack, visibleCount };
