/* Owner groups in the no-key demo (T2 "One floor for three places"): one owner, several venues.
   The localStorage shape mirrors supabase/groups-2026-10-28.sql (see schema/README.md):

     aal.group = { id, name,
                   venues: [{ name, place, placeTr, brand, bg, font, theme, ... }],   owner_group_venues
                   staff:  [{ email, name, role, venueId, revokedAt }] }

   A staff row with venueId null is group staff (owner_group_staff: owner or manager, never a
   waiter); a row with a venueId is that venue's staff (staff_members: owner, manager or waiter).
   Who sees what follows aal_role: a group owner or manager runs every venue of the group as an
   owner, a venue's own staff see only that venue, a waiter only the Live floor of it.

   The group applies only in the demo (no key, no session) and only when this device's own venue
   is one of its venues. Shared mode keeps one venue per page; the server model is the SQL file.
   Records stay per venue (venueId): a group view reads each venue in turn (util.withVenue) and
   adds the figures up (owner-metrics.js A.groupReport, A.groupLive). Guest lists are never joined. */
(function (global) {
  'use strict';
  var A = global.Aalayna, U = A.util, KEY = 'aal.group', RANK = { waiter: 1, manager: 2, owner: 3 };
  function idOf(v) { return U.venueKey(v); }
  function higher(a, b) { return (RANK[b] || 0) > (RANK[a] || 0) ? b : a; }
  function clean(email) { return String(email || '').trim().toLowerCase(); }

  A.group = function () {
    var g = U.read(KEY, null);
    return g && Array.isArray(g.venues) && g.venues.length ? g : null;
  };
  A.setGroup = function (g) { U.write(KEY, g); };
  /* the group this device's own venue belongs to, in the demo only */
  A.groupActive = function () {
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
