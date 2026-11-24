/* Owner groups in the no-key demo (T2 "One floor for three places"): one owner, several venues.
   The localStorage shape mirrors supabase/groups-2026-10-28.sql (see schema/README.md):

     aal.group = { id, name,
                   venues: [{ name, place, placeTr, brand, bg, font, theme, ... }],   owner_group_venues
                   staff:  [{ email, name, role, venueId, revokedAt }] }

   A staff row with venueId null is group staff (owner_group_staff: owner or manager, never a
   waiter); a row with a venueId is that venue's staff (staff_members: owner, manager or waiter).
   Who sees what follows aal_role: a group owner or manager runs every venue of the group as an
   owner, a venue's own staff see only that venue, a waiter only the Live floor of it.

   The demo group applies only in the demo (no key, no session) and only when this device's own
   venue is one of its venues. Records stay per venue (venueId): a group view reads each venue in
   turn (util.withVenue) and adds the figures up (owner-metrics.js A.groupReport, A.groupLive).
   Guest lists are never joined.

   Shared mode (a signed-in owner or an owner link): the page is still one venue's credential scope,
   and A.loadSharedVenues asks the server which venues this credential runs as an owner
   (aalayna-sync.js A.sync.pullVenues, supabase/all-venues-2026-11-24.sql). With two or more, they
   are the group: this page's venue reads its own live records, the others are lent to the store
   read only and in memory (util.lendVenues), so the same A.groupReport adds up the same per-venue
   figures. Opening another venue opens its own page (A.sharedVenueHref). A waiter never asks, and
   a venue the server does not list is never shown. */
(function (global) {
  'use strict';
  var A = global.Aalayna, U = A.util, KEY = 'aal.group', RANK = { waiter: 1, manager: 2, owner: 3 };
  function idOf(v) { return U.venueKey(v); }
  function higher(a, b) { return (RANK[b] || 0) > (RANK[a] || 0) ? b : a; }
  function clean(email) { return String(email || '').trim().toLowerCase(); }

  var shared = null;   // shared mode: { id, name, venues, staff, shared: true, readAt } from the server
  A.group = function () {
    var g = U.read(KEY, null);
    return g && Array.isArray(g.venues) && g.venues.length ? g : null;
  };
  A.setGroup = function (g) { U.write(KEY, g); };
  /* the group this device's own venue belongs to, in the demo only */
  A.groupActive = function () {
    if (shared) return !A.demoMode() && shared.venues.length > 1 ? shared : null;
    var g = A.group();
    if (!g || !A.demoMode()) return null;
    var own = idOf(A.ownVenue());
    return g.venues.some(function (v) { return idOf(v) === own; }) ? g : null;
  };
  /* the venues the floor covers: the group's, or this venue alone */
  A.groupVenues = function () {
    var g = A.groupActive();
    return g ? g.venues.map(function (v) { return U.clone(v); }) : [A.ownVenue()];
  };
  A.groupVenueId = idOf;

  /* ---- shared mode: the venues the server lists for this credential ---- */
  function ridParts(rid) { try { var a = JSON.parse(rid); if (Array.isArray(a)) return a; } catch (e) {} return [String(rid || ''), '']; }
  /* the venue object for a listed venue: its own name and place when they give back its id, else the id's */
  function sharedVenueOf(m) {
    var p = ridParts(m.restaurantId), v = { name: m.name || p[0], place: m.place == null ? p[1] || '' : m.place };
    if (idOf(v) !== m.restaurantId) v = { name: p[0], place: p[1] || '' };
    v.slug = m.slug || '';
    return v;
  }
  function staffRows(list, groupIds) {
    var rows = [];
    (list || []).forEach(function (g) {
      if (!g || groupIds.indexOf(g.group_id) < 0) return;
      (g.staff || []).forEach(function (s) { rows.push({ email: s.email, name: '', role: s.role, venueId: null, revokedAt: s.revoked_at || null }); });
      (g.venue_staff || []).forEach(function (vs) {
        (vs && vs.staff || []).forEach(function (s) { rows.push({ email: s.email, name: '', role: s.role, venueId: vs.restaurant_id, revokedAt: s.revoked_at || null }); });
      });
    });
    return rows;
  }
  /* Ask the server (owner pages only). Resolves with the group, or null when this credential runs
     one venue, the page's own venue is not among the listed ones, or the server cannot answer
     (then the page stays on its venue, as before). */
  A.loadSharedVenues = function () {
    var sync = A.sync;
    if (A.demoMode() || !sync || !sync.pullVenues) return Promise.resolve(null);
    return sync.pullVenues().then(function (list) {
      var own = idOf(A.ownVenue());
      if (!list || !list.some(function (m) { return m.restaurantId === own; })) { shared = null; U.lendVenues({}); A.notify('group'); return null; }
      var lend = {}, venues = list.map(function (m) {
        if (m.restaurantId === own) return A.ownVenue();
        var v = sharedVenueOf(m); lend[m.restaurantId] = { venue: v, data: m.data }; return v;
      });
      U.lendVenues(lend);
      var groups = list.map(function (m) { return m.groupId; }).filter(function (g, i, all) { return g && all.indexOf(g) === i; });
      var one = groups.length === 1 && list.every(function (m) { return m.groupId === groups[0]; });
      var prev = shared;
      shared = { id: one ? groups[0] : 'mine', name: one ? list[0].groupName || 'Your venues' : 'Your venues', venues: venues,
                 staff: prev ? prev.staff : [], shared: true, readAt: new Date().toISOString() };
      A.notify('group');
      if (!sync.groupStaff || !groups.length) return A.groupActive();
      return Promise.all(groups.map(function (g) { return sync.groupStaff(g); })).then(function (answers) {
        if (shared) { shared.staff = staffRows(answers, groups); A.notify('group'); }
        return A.groupActive();
      });
    }, function () { return A.groupActive(); });
  };
  A.groupShared = function () { return !!A.groupActive() && !!shared; };
  /* the address of another listed venue's own dashboard, for the drill-down in shared mode */
  A.sharedVenueHref = function (v, page) {
    var id = idOf(v);
    if (!shared || !A.sync || !A.sync.openVenue || !A.sync.openVenue(id)) return null;
    var p = ridParts(id), name = v.name || p[0], place = v.place == null ? p[1] : v.place;
    return (page || 'dashboard.html') + '?venue=' + encodeURIComponent(name) + (place ? '&place=' + encodeURIComponent(place) : '');
  };

  /* What a person may open, per venue id: 'owner' (owner or manager rights) or 'waiter'.
     A group role covers every venue of the group; a venue role only that venue; the higher wins. */
  A.groupAccess = function (email, group) {
    group = group || A.group(); email = clean(email);
    var out = {}; if (!group || !email) return out;
    var live = (group.staff || []).filter(function (s) { return clean(s.email) === email && !s.revokedAt; });
    var groupRole = null;
    live.forEach(function (s) { if (!s.venueId && (s.role === 'owner' || s.role === 'manager')) groupRole = higher(groupRole, s.role); });
    group.venues.forEach(function (v) {
      var id = idOf(v), role = groupRole;
      live.forEach(function (s) { if (s.venueId === id) role = higher(role, s.role); });
      if (role === 'owner' || role === 'manager') out[id] = 'owner';
      else if (role === 'waiter') out[id] = 'waiter';
    });
    return out;
  };
  /* The team of one venue: the group's own staff (they see every venue) and the venue's staff. */
  A.groupTeam = function (venueId, group) {
    group = group || A.group();
    var staff = (group && group.staff || []).filter(function (s) { return !s.revokedAt; });
    return {
      group: staff.filter(function (s) { return !s.venueId && (s.role === 'owner' || s.role === 'manager'); }),
      venue: staff.filter(function (s) { return s.venueId === venueId; })
    };
  };

  /* ---- demo data: Mayda and two more branches under one owner ---- */
  var BRANCHES = [
    { place: 'Achrafieh', placeTr: { fr: 'Achrafieh', ar: 'الأشرفية' }, servers: ['Nadine', 'Elie'],
      tables: { 1: 'Nadine', 2: 'Nadine', 3: 'Nadine', 5: 'Elie', 6: 'Elie', 7: 'Elie' },
      bills: [{ table: 3, items: [[0, 2], [1, 1], [4, 2]], pay: 'card', tip: 3, contact: 'rana@example.com', marketing: true, rating: 5 },
              { table: 5, items: [[2, 1], [5, 2]], pay: 'cash', tip: 1, rating: 3, comment: 'The grill took a while tonight.' },
              { table: 6, items: [[3, 2], [6, 1]], pay: 'cash-pending', tip: 0 },
              { table: 7, items: [[1, 3], [7, 2]] }] },
    { place: 'Batroun', placeTr: { fr: 'Batroun', ar: 'البترون' }, servers: ['Joe', 'Rita', 'Karim'],
      tables: { 1: 'Joe', 2: 'Joe', 4: 'Rita', 8: 'Rita', 10: 'Karim', 11: 'Karim' },
      bills: [{ table: 1, items: [[0, 1], [2, 2]], pay: 'whish', tip: 2, contact: 'hadi@example.com', marketing: false, rating: 4 },
              { table: 4, items: [[4, 3], [5, 1]], pay: 'card', tip: 2.5 },
              { table: 8, items: [[6, 2]], pay: 'cash-pending', tip: 1 },
              { table: 10, items: [[3, 1], [7, 1]] },
              { table: 11, items: [[1, 2]] }] }
  ];
  var DEMO_ID = 'grp_demo_mayda';
  function seedVenue(v, plan) {
    U.withVenue(v, function () {
      A.setFloor({ servers: plan.servers.slice(), tables: U.clone(plan.tables), pooled: false });
      var items = A.liveItems().filter(function (x) { return x.available !== false && x.price > 0; });
      if (!items.length) return;
      plan.bills.forEach(function (b) {
        var lines = b.items.map(function (p) { var x = items[p[0] % items.length]; return { id: x.id, q: p[1], p: Math.round(x.price * p[1] * 100) / 100, name: x.name }; });
        var c = A.openServiceCheck({ table: b.table, lines: lines, source: 'staff' }), total = c.totalCents / 100;
        if (!b.pay) return;   // an open bill, nothing paid yet
        var rail = b.pay === 'cash-pending' ? 'cash' : b.pay;
        var p = A.settle({ table: b.table, checkId: c.id, rail: rail, amount: Math.round((total + b.tip) * 100) / 100, tip: b.tip, server: A.serverFor(b.table) });
        if (b.pay === 'cash') A.confirmCash(p.id);
        if (b.contact) A.optIn({ settlementId: p.id, contact: b.contact, receipt: true, marketing: !!b.marketing });
        if (b.rating != null) A.submitReview({ settlementId: p.id, rating: b.rating, comment: b.comment || '', destination: b.rating >= 4 ? 'google' : 'private' });
        if (b.pay !== 'cash-pending') A.closeServiceCheck(c.id);
      });
    });
  }
  /* Only for the fictional Mayda demo, only without a key, only once per device. A walk-in link for
     another restaurant (?venue=...) gets no invented branches. Activity is stamped now: it is today's. */
  A.seedDemoGroup = function () {
    if (!A.demoMode() || A.group()) return A.groupActive();
    var own = A.ownVenue();
    if (idOf(own) !== idOf({ name: 'Mayda', place: 'Lebanese Grill' })) return null;
    var style = { brand: own.brand || '', bg: own.bg || '', font: own.font || '', theme: own.theme || '', est: '', heritage: 0, gplace: '' };
    var venues = [own].concat(BRANCHES.map(function (b) { return Object.assign({}, style, { name: own.name, place: b.place, placeTr: U.clone(b.placeTr) }); }));
    var ids = venues.map(idOf);
    A.setGroup({ id: DEMO_ID, name: 'Mayda Group', venues: venues, staff: [
      { email: 'karim@mayda.example', name: 'Karim Haddad', role: 'owner', venueId: null },
      { email: 'lea@mayda.example', name: 'Lea Saab', role: 'manager', venueId: null },
      { email: 'sara@mayda.example', name: 'Sara', role: 'waiter', venueId: ids[0] },
      { email: 'nadine@mayda.example', name: 'Nadine', role: 'manager', venueId: ids[1] },
      { email: 'elie@mayda.example', name: 'Elie', role: 'waiter', venueId: ids[1] },
      { email: 'joe@mayda.example', name: 'Joe', role: 'waiter', venueId: ids[2] },
      { email: 'rita@mayda.example', name: 'Rita', role: 'waiter', venueId: ids[2] }
    ] });
    BRANCHES.forEach(function (b, i) { try { seedVenue(venues[i + 1], b); } catch (e) {} });
    return A.groupActive();
  };
})(window);
