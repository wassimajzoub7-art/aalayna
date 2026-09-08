/* Engineering spec: stable ids, events, device token, FX, identity, payment
   requests, permissions/edit log, health check, event metrics. */
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
function setup(){
  let time=Date.parse('2026-06-01T12:00:00Z');
  class Clock extends Date { constructor(...args){super(...(args.length?args:[time]));} static now(){return time;} }
  const map=new Map();
  const storage={getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};
  const window={location:{search:''},addEventListener(){},localStorage:storage};
  const ctx=vm.createContext({window,localStorage:storage,Date:Clock,URLSearchParams});
  for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),ctx);
  const a=window.Aalayna; a.setVenue({name:'Restaurant',place:'Beirut'});
  return {a,map,advance:ms=>{time+=ms;},now:()=>time};
}
const MIN=60000, DAY=86400000;

test('§1 renaming five times and archiving/restoring keeps one id; archived items stay resolvable', ()=>{
  const {a}=setup();
  const id='i07';   // a dish on the seeded check
  for(let i=1;i<=5;i++){ const d=a.draft(); d.items.find(x=>x.id===id).name='Name '+i; a.saveDraft(d); }
  a.archiveItem(id); a.publish();
  assert.ok(a.published().items.find(x=>x.id===id).archivedAt);
  assert.ok(!a.liveItems().some(x=>x.id===id));
  assert.equal(a.check().find(l=>l.id===id).name,'Name 5');   // history still resolves the row
  a.restoreItem(id); a.publish();
  assert.equal(a.liveItems().find(x=>x.id===id).name,'Name 5');
  assert.equal(a.published().items.filter(x=>x.name==='Name 5').length,1);
  const log=a.editLog().filter(r=>r.entityId===id);
  assert.equal(log.filter(r=>r.field==='name').length,5);
  assert.equal(JSON.stringify(log.filter(r=>r.field==='archivedAt').map(r=>r.tier)),'[3,3]');
});

test('§1 a draft that omits an item archives it instead of deleting; unpublished blanks can be discarded', ()=>{
  const {a}=setup();
  const d=a.draft(), gone=d.items[0].id; d.items=d.items.slice(1); a.saveDraft(d);
  const kept=a.draft().items.find(x=>x.id===gone);
  assert.ok(kept && kept.archivedAt);
  assert.equal(a.editLog().find(r=>r.entityId===gone&&r.field==='archivedAt').tier,3);
  const d2=a.draft(); d2.items.push({name:'Blank'}); a.saveDraft(d2);
  const blank=a.draft().items.find(x=>x.name==='Blank');
  assert.ok(blank.id.length>=8);
  assert.equal(a.discardDraftItem(blank.id),true);
  assert.equal(a.discardDraftItem(gone),false);   // published once: archive only
});

test('§2 events are append-only, typed, and stamped with device, session and restaurant', ()=>{
  const {a}=setup();
  const e=a.logEvent('qr_scan',{tableId:'12'},{tableId:12});
  assert.equal(e.deviceId,a.device()); assert.equal(e.sessionId,a.session()); assert.equal(e.restaurantId,a.venueId());
  assert.throws(()=>a.logEvent('order_deleted',{}),/Unknown event type/);
  assert.equal(a.events().length,1);
  assert.notEqual(a.newSession(),e.sessionId);
});

test('§4 every payment stores raw amount, currency, the rate used and the normalised figure', ()=>{
  const {a}=setup();
  a.setRate(90000,'owner');
  const c=a.openServiceCheck({table:12,total:100});
  assert.equal(c.fxRateUsed,90000); assert.equal(c.amountUsd,100);
  const p=a.settle({table:12,checkId:c.id,rail:'card',amount:20,tip:2});
  assert.equal(JSON.stringify([p.currency,p.fxRateUsed,p.amountUsd]),JSON.stringify(['USD',90000,20]));
  const ev=a.events().find(x=>x.eventType==='payment_completed');
  assert.equal(ev.payload.fxRateUsed,90000); assert.equal(ev.payload.rail,'card'); assert.equal(ev.payload.orderId,c.id);
  assert.equal(a.rateInfo().stale,false);
});

test('§5 a receipt links the device, backfills earlier anonymous events, and merges two customers', ()=>{
  const env=setup(), a=env.a;
  a.logEvent('qr_scan',{},{tableId:12}); a.logEvent('item_view',{itemId:'i01'});
  const c=a.openServiceCheck({table:12,total:40});
  const p=a.settle({table:12,checkId:c.id,rail:'card',amount:40});
  assert.equal(a.events().filter(e=>e.customerId).length,0);
  const g=a.optIn({settlementId:p.id,contact:'Guest@Example.com',receipt:true,marketing:false});
  assert.ok(g.customerId);
  assert.equal(a.events().filter(e=>e.customerId===g.customerId).length,a.events().length);   // retroactive attribution
  assert.equal(a.events().find(e=>e.eventType==='receipt_requested').payload.channel,'email');
  // a second identity from another device, then one transaction carrying both keys
  const other=a.identity.link({keys:[{type:'phone',value:'+96170123456'}],deviceId:'device-two',source:'receipt'});
  assert.notEqual(other,g.customerId);
  const survivor=a.identity.link({keys:[{type:'email',value:'guest@example.com'},{type:'phone',value:'+96170123456'}],deviceId:'device-three',source:'payment'});
  assert.equal(survivor,g.customerId);
  assert.equal(a.identity.count(),1);
  assert.equal(a.identity.merges().length,1);
  assert.equal(a.identity.keysFor(survivor).length,2);
  assert.equal(a.identity.customerForDevice('device-two'),survivor);
});

test('§6 digital payments are requested, then confirmed once by a provider reference', ()=>{
  const {a}=setup();
  const c=a.openServiceCheck({table:12,total:100});
  const r=a.requestPayment({table:12,checkId:c.id,rail:'whish',amount:30,requestId:'req-1'});
  assert.equal(a.settlementStatus(r),'initiated'); assert.equal(a.settledTotal(),0);
  assert.equal(a.checkBalance(c.id).availableCents,10000);   // an initiated request reserves nothing yet
  assert.throws(()=>a.confirmPayment('req-1',{}),/transaction reference/);
  const done=a.confirmPayment('req-1',{externalRef:'whish-abc',payerRef:'wallet-777'});
  assert.equal(a.settlementStatus(done),'confirmed'); assert.equal(a.settledTotal(),30);
  assert.ok(done.identityId);   // the wallet id is a strong key; customerId stays the venue profile
  assert.equal(a.confirmPayment('req-1',{externalRef:'whish-abc'}).id,done.id);   // duplicate callback is idempotent
  assert.equal(a.events().filter(e=>e.eventType==='payment_completed').length,1);
  assert.equal(a.webhookLog().length,2);   // rejected callbacks are not logged as confirmations
  a.requestPayment({table:12,checkId:c.id,rail:'card',amount:20,requestId:'req-2'});
  assert.throws(()=>a.confirmPayment('req-2',{externalRef:'whish-abc'}),/already confirmed another/);
  // a receipt after a wallet-confirmed payment links the same identity instead of failing
  const g=a.optIn({settlementId:done.id,contact:'+96171000000',receipt:true,marketing:false});
  assert.equal(g.customerId,done.identityId); assert.equal(a.identity.count(),1);
  a.failPayment('req-2','expired');
  assert.throws(()=>a.confirmPayment('req-2',{externalRef:'card-9'}),/expired/);
  assert.equal(a.checkBalance(c.id).remainingCents,7000);
});

test('§8 items without ingredients are incomplete and flagged; every edit is logged by tier', ()=>{
  const {a}=setup();
  const d=a.draft(); d.items.push({name:'Mystery plate',price:9,sec:'mez'}); a.saveDraft(d,'manager');
  const item=a.draft().items.find(x=>x.name==='Mystery plate');
  assert.equal(item.status,'incomplete');
  assert.equal(a.adminNotifications().filter(n=>n.kind==='incomplete_item').length,1);
  const d2=a.draft(); d2.items.find(x=>x.id===item.id).price=11; a.saveDraft(d2,'waiter');
  const row=a.editLog().find(r=>r.entityId===item.id&&r.field==='price');
  assert.equal(JSON.stringify([row.who,row.tier,row.oldValue,row.newValue]),JSON.stringify(['waiter',1,9,11]));
  const d3=a.draft(); d3.items.find(x=>x.id===item.id).ing=['lamb']; a.saveDraft(d3);
  assert.equal(a.draft().items.find(x=>x.id===item.id).status,'complete');
});

test('§7 a review is one event; low ratings are listed for the owner', ()=>{
  const {a}=setup();
  const c=a.openServiceCheck({table:12,total:40}); const p=a.settle({table:12,checkId:c.id,rail:'card',amount:40});
  a.submitReview({settlementId:p.id,rating:2,comment:'Slow',destination:'private'});
  a.submitReview({settlementId:p.id,rating:5});
  assert.throws(()=>a.submitReview({settlementId:p.id,rating:7}),/0 to 5/);
  assert.equal(a.lowRatings().length,1);
  assert.equal(a.lowRatings()[0].payload.comment,'Slow');
});

test('§9 the health report flags stale rates, incomplete items and orders on archived items', ()=>{
  const env=setup(), a=env.a;
  let h=a.healthReport();
  const get=k=>h.checks.find(c=>c.key===k);
  assert.equal(get('stale_rate').flag,true);            // never set
  a.setRate(89500); h=a.healthReport(); assert.equal(get('stale_rate').flag,false);
  env.advance(15*DAY); h=a.healthReport(); assert.equal(get('stale_rate').flag,true);
  assert.equal(get('incomplete_items').flag,false);
  const d=a.draft(); d.items.push({name:'No record',price:5,sec:'mez'}); a.saveDraft(d); a.publish();
  h=a.healthReport(); assert.equal(get('incomplete_items').value,1);
  const id=a.published().items[0].id; a.archiveItem(id); a.publish();
  a.openServiceCheck({table:3,total:20,lines:[{id:id,q:1,p:20}]});
  h=a.healthReport(); assert.equal(get('orders_on_archived').flag,true);
  const stored=a.recordHealth(); assert.equal(a.healthReports().length,1); assert.match(stored.week,/^\d{4}-W\d{2}$/);
  a.recordHealth(); assert.equal(a.healthReports().length,1);   // same week overwrites
});

test('§10 dashboard metrics come from the event stream', ()=>{
  const env=setup(), a=env.a;
  // session one: scan, view, bill, pay, identified
  a.logEvent('qr_scan',{},{tableId:12}); a.logEvent('item_view',{itemId:'i01'}); a.logEvent('item_view',{itemId:'i02'});
  env.advance(5*MIN); a.logEvent('bill_requested',{},{tableId:12});
  const c=a.openServiceCheck({table:12,total:40,lines:[{id:'i02',q:1,p:40}]});
  env.advance(4*MIN); const p=a.settle({table:12,checkId:c.id,rail:'card',amount:40});
  a.optIn({settlementId:p.id,contact:'a@b.co',receipt:true,marketing:true});
  // session two, same device, no payment
  env.advance(DAY); a.newSession(); a.logEvent('qr_scan',{},{tableId:5}); a.logEvent('item_view',{itemId:'i01'});
  const m=a.eventMetrics('7');
  assert.equal(m.scans,2); assert.equal(m.paidSessions,1); assert.equal(m.conversion,0.5);
  assert.equal(JSON.stringify(m.neverOrdered[0]),JSON.stringify({itemId:'i01',name:a.published().items.find(x=>x.id==='i01').name,views:2}));
  assert.equal(m.rails.card,4000); assert.equal(m.digitalShare,1);
  assert.equal(m.repeatSessions,1); assert.equal(m.repeatRate,0.5);
  assert.equal(m.medianBillToPaymentMs,4*MIN);
  assert.equal(m.captureRate,1);
});
