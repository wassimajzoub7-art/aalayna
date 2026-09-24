/* Operational rules for the static prototype. No network requests or provider claims.
   Customer statistics come only from linked, confirmed check payments. */
(function (global) {
  'use strict';
  var A = global.Aalayna, U = A.util, DAY = 86400000;
  function read(key) { return U.read(key, []); }
  function save(key, rows) { U.write(key, rows); }
  var uid = U.uid, now = U.now, cents = U.cents;
  function same(row) { return row.venueId === A.venueId(); }
  function getCustomer(id) { return read('aal.guests').filter(function(g){ return same(g) && g.id === id; })[0]; }
  function getCampaign(id) {
    var c = read('aal.campaigns').filter(function(x){ return same(x) && x.id === id; })[0];
    if (!c) throw new Error('Campaign not found for this restaurant.');
    return c;
  }
  function putCampaign(c) { var all = read('aal.campaigns'); var i = all.findIndex(function(x){ return x.id === c.id && same(x); }); if (i < 0) all.push(c); else all[i] = c; save('aal.campaigns', all); }
  A.normaliseContact = function (input) {
    var s = String(input || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254) return { contact:s.toLowerCase(), channel:'email' };
    s = s.replace(/[\s().-]/g, '').replace(/^00/, '+');
    if (!/^\+[1-9]\d{7,14}$/.test(s)) throw new Error('Use an email or a phone number with country code, for example +96170123456.');
    return { contact:s, channel:'whatsapp' };
  };
  A.serviceChecks = function () { return read('aal.checks').filter(same); };
  A.openCheckFor = function (table) {
    return A.serviceChecks().find(function(c){ return c.table === Number(table) && !c.closedAt; }) || null;
  };
  /* Check lines are {id, q, p, name}: q whole units, p the LINE total in dollars.
     Repeated item ids fold into one line, because payments claim units by id. */
  function checkLines(lines) {
    if (!Array.isArray(lines)) throw new Error('A bill needs a list of items.');
    var out = [], at = {};
    lines.forEach(function(l){
      var id = l && l.id != null ? String(l.id) : '', q = Number(l && l.q), p = cents(l && l.p);
      if (!id || !Number.isInteger(q) || q < 1 || q > 999 || !Number.isSafeInteger(p) || p < 0) throw new Error('Each bill item needs a dish, a whole quantity and a price.');
      if (at[id] == null) { at[id] = out.length; out.push({ id:id, q:0, pc:0, name:String(l.name || '').slice(0, 120) }); }
      out[at[id]].q += q; out[at[id]].pc += p;
    });
    return out.map(function(l){ return { id:l.id, q:l.q, p:l.pc / 100, name:l.name }; });
  }
  function linesTotal(lines) { return lines.reduce(function(n, l){ return n + cents(l.p); }, 0); }
  /* In this prototype the check IS the order (bills come from the waiter/POS,
     Aalayna takes no orders). Every open or change appends an event carrying the
     full line list; the latest revision per orderId is the current bill. */
  function orderEvent(c, change) {
    A.logEvent('order_placed', { orderId:c.id, revision:c.revision || 1, change:change, source:c.source,
                                 items:c.lines.map(function(l){ return { itemId:l.id, qty:l.q, unitPrice:Math.round(l.p / l.q * 100) / 100, currency:'USD' }; }),
                                 total:c.totalCents / 100, currency:'USD', fxRateUsed:c.fxRateUsed, amountUsd:c.totalCents / 100 },
               { sessionId:change === 'opened' ? c.sessionId : A.session(), deviceId:change === 'opened' ? c.deviceId : A.device(), tableId:c.table });
  }
  A.openServiceCheck = function (input) {
    var lines = input.lines == null ? [] : checkLines(input.lines);
    var total = input.total == null ? linesTotal(lines) : cents(input.total);
    if (!Number.isSafeInteger(total) || total <= 0 || !Number.isInteger(Number(input.table)) || Number(input.table) < 1) throw new Error('A check needs a table and a positive total.');
    var existing = A.openCheckFor(input.table);
    if (existing) return existing;
    var rate = A.rate();
    var c = { id:uid('check-'), venueId:A.venueId(), table:Number(input.table), totalCents:total, openedAt:now(), lines:lines, source:input.source === 'staff' ? 'staff' : 'prototype', revision:1,
              currency:'USD', fxRateUsed:rate, amountUsd:total / 100, sessionId:input.sessionId || A.session(), deviceId:input.deviceId || A.device() };
    var all = read('aal.checks'); all.push(c); save('aal.checks', all);
    orderEvent(c, 'opened');
    return c;
  };
  /* A waiter changes an open bill. Before any payment the lines may change
     freely. Once a payment exists (pending cash, a digital payment in progress, or
     confirmed), items can only be added: no line may disappear, shrink or change
     price, so a paid item never vanishes from the bill it was paid against.
     planCheckUpdate applies these rules without writing; the shared mode uses it
     to refuse early, and the server (aal_mutate update_check) applies the same
     rules again under its lock. */
  A.planCheckUpdate = function (id, lines) {
    var b = A.checkBalance(id), c = b.check;
    if (c.closedAt) throw new Error('This bill is closed. Open a new bill for the table instead.');
    var next = checkLines(lines), byId = {}, old = c.lines || [];
    next.forEach(function(l){ byId[l.id] = l; });
    function label(l) { var item = A.published().items.find(function(x){ return x.id === l.id; }); return item ? item.name : (l.name || 'This item'); }
    old.forEach(function(o){
      var claimed = b.items[o.id] || 0, n = byId[o.id];
      if (claimed && (!n || n.q < claimed)) throw new Error(label(o) + ' is covered by a payment and cannot be removed.');
    });
    if (b.confirmedCents || b.pendingCents) {
      old.forEach(function(o){
        var n = byId[o.id];
        if (!n || n.q < o.q) throw new Error('A payment is recorded on this bill. Items can be added, not removed or reduced.');
        if (cents(n.p) * o.q !== cents(o.p) * n.q) throw new Error('A payment is recorded on this bill. Prices of existing items cannot change.');
      });
    }
    var total = linesTotal(next);
    if (!Number.isSafeInteger(total) || total < b.confirmedCents + b.pendingCents) throw new Error('The new total is below what has already been paid.');
    return { check:c, lines:next, totalCents:total };
  };
  A.updateServiceCheck = function (id, lines) {
    var plan = A.planCheckUpdate(id, lines);
    var all = read('aal.checks'), row = all.find(function(x){ return x.id === id && same(x); });
    row.lines = plan.lines; row.totalCents = plan.totalCents; row.amountUsd = plan.totalCents / 100;
    row.revision = (row.revision || 1) + 1; row.updatedAt = now(); row.source = 'staff';
    save('aal.checks', all);
    orderEvent(row, 'updated');
    return row;
  };
  /* shared mode validates and folds lines before sending them to the server */
  A.checkLines = checkLines;
  A.checkBalance = function (id, excludePaymentId) {
    var c = A.serviceChecks().find(function(x){ return x.id === id; });
    if (!c) throw new Error('This bill is not available for this restaurant.');
    var confirmed = 0, pending = 0, tips = 0, methods = { cash:0, card:0, whish:0 }, items = {};
    A.settlements().filter(function(s){ return s.venueId === c.venueId && s.checkId === c.id && s.id !== excludePaymentId; }).forEach(function(s){
      var state = A.settlementStatus(s), net = cents(s.amount) - cents(s.tip || 0);
      if (state === 'confirmed') { confirmed += net; tips += cents(s.tip || 0); methods[s.rail] += net; }
      if (state === 'pending' || state === 'initiated') pending += net;
      if (state === 'pending' || state === 'initiated' || state === 'confirmed') Object.keys(s.items || {}).forEach(function(k){ items[k] = (items[k] || 0) + s.items[k]; });
    });
    return { check:c, confirmedCents:confirmed, pendingCents:pending, tipCents:tips, remainingCents:Math.max(0,c.totalCents-confirmed), availableCents:Math.max(0,c.totalCents-confirmed-pending), methods:methods, items:items };
  };
  A.validateCheckPayment = function (s, net, excludePaymentId) {
    var b = A.checkBalance(s.checkId, excludePaymentId);
    if (b.check.closedAt || Number(s.table) !== b.check.table) throw new Error('This bill is closed or belongs to a different table.');
    if (net > b.availableCents) throw new Error('The bill changed. Refresh your share; another payment or cash request already covers part of it.');
    var sum = 0;
    Object.keys(s.items || {}).forEach(function(id){
      var line = b.check.lines.find(function(x){ return x.id === id; }), q = s.items[id];
      if (!line || !Number.isInteger(q) || q <= 0 || q + (b.items[id] || 0) > line.q) throw new Error('One of these items is already covered by another payment.');
      sum += (line.p / line.q) * q;
    });
    if (Object.keys(s.items || {}).length && cents(sum) !== net) throw new Error('The selected items do not match the payment amount.');
  };
  A.closeServiceCheck = function (id) {
    var b = A.checkBalance(id);
    if (b.remainingCents || b.pendingCents) throw new Error('Collect the outstanding balance before closing this bill.');
    var all = read('aal.checks'); all.find(function(c){ return c.id === id && same(c); }).closedAt = now(); save('aal.checks', all);
  };
  A.optIn = function (input) {
    var contact = A.normaliseContact(input.contact), all = read('aal.guests');
    if (typeof input.receipt !== 'boolean' || typeof input.marketing !== 'boolean') throw new Error('Choose receipt and marketing permissions separately.');
    var payment = A.settlements().find(function(s){ return s.id === input.settlementId && same(s); });
    if (!payment || !A.isConfirmed(payment) || !payment.checkId) throw new Error('Link contact details to a confirmed payment first.');
    var g = all.find(function(x){ return same(x) && x.contact === contact.contact; });
    if (payment.customerId && (!g || payment.customerId !== g.id)) throw new Error('This payment is already linked to another contact.');
    if (!g) {
      g = { id:uid('guest-'), venueId:A.venueId(), venue:A.venue().name, contact:contact.contact, channel:contact.channel, deviceId:payment.deviceId || null, createdAt:now(), consentHistory:[] };
      all.push(g);
    }
    g.receipt = input.receipt; g.marketing = input.marketing;
    g.consentHistory.push({ at:now(), source:'receipt', receipt:g.receipt, marketing:g.marketing, version:'restaurant-offers-v1', settlementId:payment.id });
    /* Identity layer: the contact is a strong key. Linking attaches this device and
       backfills every earlier anonymous event from it. The venue profile keeps its
       own id (lists are never joined across venues); customerId is the global one. */
    var keys = [{ type:contact.channel === 'email' ? 'email' : 'phone', value:contact.contact }];
    if (payment.payerRef) keys.push({ type:'wallet_id', value:payment.payerRef });   // same transaction, two keys: one customer
    g.customerId = A.identity.link({ keys:keys, deviceId:payment.deviceId, source:'receipt' });
    var payments = read('aal.settle'), row = payments.find(function(s){ return s.id === payment.id && same(s); });
    row.customerId = g.id; row.identityId = g.customerId;
    // Both writes are local prototype state; a live backend must commit these atomically.
    save('aal.settle', payments); save('aal.guests', all);
    if (input.receipt) A.logEvent('receipt_requested', { channel:contact.channel, contactHash:A.contactHash(contact.contact), marketing:!!input.marketing },
                                  { deviceId:payment.deviceId, sessionId:payment.sessionId, tableId:payment.table, customerId:g.customerId });
    return g;
  };
  /* Post-payment prompt (spec §7): one tap to rate, optional comment. Low ratings
     surface on the owner dashboard. The contact box on the same screen goes
     through optIn, so it reaches the identity layer the same way. */
  A.submitReview = function (input) {
    var rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('Rate from 0 to 5.');
    var payment = A.settlements().find(function(s){ return s.id === input.settlementId && same(s); });
    var comment = String(input.comment || '').trim().slice(0, 1000);
    return A.logEvent('review_submitted', { rating:rating, comment:comment || null, destination:input.destination || null, paymentId:payment ? payment.id : null },
                      payment ? { deviceId:payment.deviceId, sessionId:payment.sessionId, tableId:payment.table, customerId:payment.identityId } : {});
  };
  A.lowRatings = function (since) {
    return A.events().filter(function(e){ return e.eventType === 'review_submitted' && e.payload.rating <= 2 && (!since || Date.parse(e.createdAt) >= since); });
  };
  A.withdrawMarketing = function (id) {
    var all = read('aal.guests'), g = all.find(function(x){ return same(x) && x.id === id; });
    if (!g) throw new Error('Customer not found.');
    g.marketing = false; g.consentHistory = g.consentHistory || [];
    g.consentHistory.push({ at:now(), source:'owner-recorded-opt-out', marketing:false, receipt:!!g.receipt, version:'restaurant-offers-v1' });
    save('aal.guests', all);
  };
  A.customerProfiles = function () {
    var payments = A.settlements().filter(function(s){ return same(s) && A.isConfirmed(s) && s.checkId; });
    return read('aal.guests').filter(same).map(function(g){
      var visits = {};
      payments.filter(function(s){ return s.customerId === g.id; }).forEach(function(s){
        var at = s.confirmedAt || s.ts;
        var v = visits[s.checkId] || { checkId:s.checkId, at:at, spendCents:0, rails:[] };
        if (at < v.at) v.at = at;
        v.spendCents += cents(s.amount) - cents(s.tip || 0);
        if (v.rails.indexOf(s.rail) < 0) v.rails.push(s.rail);
        visits[s.checkId] = v;
      });
      var history = Object.values(visits).sort(function(a,b){ return a.at.localeCompare(b.at); });
      return Object.assign({},g,{ history:history, visits:history.length, first:history.length ? history[0].at : null, last:history.length ? history[history.length-1].at : null, spendCents:history.reduce(function(n,v){ return n+v.spendCents; },0) });
    });
  };
  A.campaignAudience = function (segment, channel, at) {
    at = at || Date.now();
    return A.customerProfiles().filter(function(g){
      if (!g.marketing || !g.visits || g.channel !== channel) return false;
      var days = (at - Date.parse(g.last)) / DAY;
      if (segment === 'second_visit') return g.visits === 1 && days >= 7 && days < 30;
      if (segment === 'lapsed') return days >= 30;
      if (segment === 'regulars') return g.visits >= 3 && days < 30;
      return segment === 'all';
    });
  };
  A.prepareCampaign = function (input) {
    if (['all','second_visit','lapsed','regulars'].indexOf(input.audience) < 0 || ['email','whatsapp'].indexOf(input.channel) < 0) throw new Error('Choose a valid audience and channel.');
    var name = String(input.name || '').trim(), message = String(input.message || '').trim();
    if (!name || name.length > 100 || !message || message.length > 2000) throw new Error('Enter a campaign name and message (up to 2,000 characters).');
    var c = { id:uid('campaign-'), venueId:A.venueId(), venue:A.venue().name, name:name, message:message, audience:input.audience, channel:input.channel, useHoldout:!!input.useHoldout, status:'draft', ts:now(), recipients:[], holdout:[], deliveries:[], windowDays:30 };
    putCampaign(c); return c;
  };
  // Old callers cannot manufacture a sent count anymore.
  A.sendCampaign = function (input) { return A.prepareCampaign(Object.assign({channel:'whatsapp'},input)); };
  A.growthCampaigns = function () { return read('aal.campaigns').filter(same); };
  A.approveCampaign = function (id) {
    var c = getCampaign(id);
    if (c.status !== 'draft') throw new Error('This campaign is already approved.');
    var ids = A.campaignAudience(c.audience,c.channel).map(function(g){ return g.id; });
    if (!ids.length) throw new Error('No customers currently match this audience and permission.');
    if (c.useHoldout && ids.length < 5) throw new Error('At least five eligible contacts are needed to reserve a comparison group.');
    for (var i=ids.length-1;i>0;i--) { var j=Math.floor(Math.random()*(i+1)), t=ids[i];ids[i]=ids[j];ids[j]=t; }
    var count = c.useHoldout ? Math.max(1,Math.floor(ids.length*0.2)) : 0;
    c.holdout = ids.slice(0,count); c.recipients = ids.slice(count); c.approvedAt = now(); c.status = 'approved';
    putCampaign(c); return c;
  };
  A.exportCampaignAudience = function (id) {
    var c = getCampaign(id);
    if (c.status !== 'approved') throw new Error('Approve this campaign before exporting.');
    return c.recipients.map(getCustomer).filter(function(g){ return g && g.marketing && g.channel === c.channel; }).map(function(g){ return {campaignId:c.id,customerId:g.id,contact:g.contact,channel:g.channel,message:c.message}; });
  };
  A.recordCampaignDeliveries = function (id, events) {
    var c = getCampaign(id);
    if (c.status !== 'approved' || !Array.isArray(events) || events.length > 10000) throw new Error('Import a delivery report for an approved campaign.');
    // Validate the entire report before changing any state.
    var seen = Object.create(null);
    events.forEach(function(e){
      var stamp = Date.parse(e.deliveredAt), g = getCustomer(e.customerId);
      if (!g || c.recipients.indexOf(e.customerId) < 0 || !Number.isFinite(stamp) || stamp < Date.parse(c.approvedAt) || stamp > Date.now()) throw new Error('Delivery report includes an invalid recipient or timestamp.');
      var history = (g.consentHistory || []).filter(function(h){ return Date.parse(h.at) <= stamp; });
      if (!history.length || !history[history.length-1].marketing) throw new Error('A delivery predates permission or follows an opt-out.');
      var providerId = String(e.providerMessageId || '').trim();
      if (!providerId || providerId.length > 200) throw new Error('Every delivery needs its provider message ID (up to 200 characters).');
      var existing = c.deliveries.find(function(d){ return d.customerId === e.customerId; });
      if (existing && (existing.providerMessageId !== providerId || existing.deliveredAt !== new Date(stamp).toISOString())) throw new Error('This customer already has a different delivery record.');
      if ((seen[providerId] && seen[providerId] !== e.customerId) || c.deliveries.some(function(d){return d.providerMessageId===providerId && d.customerId!==e.customerId;})) throw new Error('A provider message ID cannot identify two recipients.');
      seen[providerId] = e.customerId;
    });
    events.forEach(function(e){
      if (!c.deliveries.some(function(d){ return d.customerId === e.customerId; })) c.deliveries.push({customerId:e.customerId, deliveredAt:new Date(e.deliveredAt).toISOString(), providerMessageId:String(e.providerMessageId).trim(), source:'owner-imported-report'});
    });
    putCampaign(c); return c;
  };
  A.campaignReport = function (id, at) {
    var c = getCampaign(id), profiles = A.customerProfiles(), end = Math.min(at || Date.now(), Date.parse(c.approvedAt) + c.windowDays*DAY);
    function group(ids, delivered) {
      var returners=0, visits=0, spend=0;
      ids.forEach(function(id){
        var g=profiles.find(function(x){return x.id===id;}), event=c.deliveries.find(function(d){return d.customerId===id;});
        var start=Date.parse(delivered && event ? event.deliveredAt : c.approvedAt);
        var matched=(g ? g.history : []).filter(function(v){return Date.parse(v.at)>start && Date.parse(v.at)<=end;});
        if (matched.length) returners++;
        visits+=matched.length; spend+=matched.reduce(function(n,v){return n+v.spendCents;},0);
      });
      return {size:ids.length,returners:returners,visits:visits,spendCents:spend,rate:ids.length?returners/ids.length:null};
    }
    return {campaign:c,delivered:group(c.deliveries.map(function(d){return d.customerId;}),true),assigned:group(c.recipients,false),comparison:group(c.holdout,false),windowComplete:!!c.approvedAt && (at || Date.now())>=Date.parse(c.approvedAt)+c.windowDays*DAY};
  };
  A.weeklySummary = function (at) {
    at=at || Date.now();var since=at-7*DAY, profiles=A.customerProfiles(), payments=A.settlements().filter(function(s){return same(s)&&A.isConfirmed(s)&&Date.parse(s.confirmedAt||s.ts)>=since&&Date.parse(s.confirmedAt||s.ts)<=at;});
    var checks={},identified={},spend=0,tips=0;
    payments.forEach(function(s){spend+=cents(s.amount)-cents(s.tip||0);tips+=cents(s.tip||0);if(s.checkId){checks[s.checkId]=true;if(s.customerId)identified[s.checkId]=true;}});
    return {netCents:spend,tipCents:tips,checks:Object.keys(checks).length,identifiedChecks:Object.keys(identified).length,customers:profiles.length,returningCustomers:profiles.filter(function(g){return g.visits>1;}).length};
  };
  A.recommendations = function (at) {
    at=at || Date.now();var result=[], pending=A.pendingCash().filter(function(s){return same(s)&&(at-Date.parse(s.ts))>=10*60000;});
    if(pending.length) result.push({kind:'cash',title:'Follow up on '+pending.length+' cash request'+(pending.length===1?'':'s'),detail:'These requests have waited at least 10 minutes. Confirm collection or cancel only after checking with the floor.',action:'Review cash requests'});
    ['second_visit','lapsed'].forEach(function(segment){
      var n=A.campaignAudience(segment,'whatsapp',at).length+A.campaignAudience(segment,'email',at).length;
      if(n) result.push({kind:segment,title:segment==='second_visit'?'Invite '+n+' first-time customer'+(n===1?'':'s')+' back':n+' opted-in customer'+(n===1?' has':'s have')+' not visited in 30 days',detail:'Based on linked confirmed visits. Choose a relevant message and review the audience before approving.',action:'Prepare a campaign'});
    });
    var w=A.weeklySummary(at);
    if(w.checks && w.identifiedChecks<w.checks) result.push({kind:'capture',title:'Contact details linked to '+w.identifiedChecks+' of '+w.checks+' bills this week',detail:'Offer an optional receipt and a separate restaurant-offers sign-up. Never require contact details to pay.',action:'Review customers'});
    if(!result.length) result.push({kind:'empty',title:'No action flagged from the available records',detail:'Recommendations appear as confirmed bills, customer permissions and return visits are recorded. No estimated results are substituted.',action:''});
    return result;
  };
})(window);
