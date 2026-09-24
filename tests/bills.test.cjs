/* T1: waiter bill entry. A table's bill is the open check staff entered for it;
   the seeded sample only appears for a venue that never had a staff-entered check. */
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
function setup(options={}){
 let time=Date.parse('2026-06-01T12:00:00Z');
 class Clock extends Date { constructor(...args){super(...(args.length?args:[time]));}static now(){return time;} }
 const map=new Map();const storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 if(options.key)map.set('aal.key',options.key);
 const window={location:{search:options.search||''},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,Date:Clock,URLSearchParams});
 for(const file of ['aalayna-store.js','restaurant-growth.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
 const a=window.Aalayna;a.setVenue({name:'Restaurant',place:'Beirut'});
 return {a,map,ctx,advance:days=>{time+=days*86400000;},switchVenue:(place)=>a.setVenue({name:'Restaurant',place})};
}
const LINES=[{id:'i07',q:1,p:16,name:'Mixed Grill platter'},{id:'i06',q:2,p:10,name:'Hummus Beiruti'},{id:'i14',q:4,p:10,name:'Lebanese coffee'}];
const orders=a=>a.events().filter(e=>e.eventType==='order_placed');

test('a check opens from lines alone and computes its total in cents',()=>{
 const {a}=setup();
 const c=a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 assert.equal(c.totalCents,3600);assert.equal(c.amountUsd,36);assert.equal(c.source,'staff');assert.equal(c.revision,1);
 assert.deepEqual(JSON.parse(JSON.stringify(c.lines.map(l=>[l.id,l.q,l.p]))),[['i07',1,16],['i06',2,10],['i14',4,10]]);
 assert.equal(a.openCheckFor(5).id,c.id);assert.equal(a.openCheckFor(6),null);
 // a second open on the same table returns the open check instead of a duplicate
 assert.equal(a.openServiceCheck({table:5,lines:[{id:'i13',q:1,p:2}],source:'staff'}).id,c.id);
 // repeated dishes fold into one line; invalid lines are refused
 const d=a.openServiceCheck({table:6,lines:[{id:'i13',q:1,p:2},{id:'i13',q:2,p:4}],source:'staff'});
 assert.equal(d.lines.length,1);assert.equal(d.lines[0].q,3);assert.equal(d.totalCents,600);
 assert.throws(()=>a.openServiceCheck({table:7,lines:[{id:'i13',q:1.5,p:2}]}),/whole quantity/);
 assert.throws(()=>a.openServiceCheck({table:7,lines:[]}),/positive total/);
});

test('lines update freely before any payment and the total follows',()=>{
 const {a}=setup(),c=a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 const u=a.updateServiceCheck(c.id,[{id:'i07',q:2,p:32,name:'Mixed Grill platter'},{id:'i14',q:4,p:10}]);
 assert.equal(u.totalCents,4200);assert.equal(u.revision,2);assert.equal(u.lines.length,2);assert.ok(u.updatedAt);
 assert.equal(a.checkBalance(c.id).remainingCents,4200);
 assert.equal(a.serviceChecks().length,1);
 assert.throws(()=>a.updateServiceCheck('check-missing',LINES),/not available/);
});

test('a line with claimed units cannot be removed or reduced below the claim; adding still works',()=>{
 const {a}=setup(),c=a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 a.settle({table:5,checkId:c.id,rail:'card',amount:5,items:{i06:1}});
 assert.throws(()=>a.updateServiceCheck(c.id,[LINES[0],LINES[2]]),/Hummus Beiruti is covered by a payment/);
 // any payment freezes existing lines: no removal, no reduction, no price change
 assert.throws(()=>a.updateServiceCheck(c.id,[LINES[0],LINES[1]]),/added, not removed/);
 assert.throws(()=>a.updateServiceCheck(c.id,[LINES[0],LINES[1],{id:'i14',q:3,p:7.5}]),/added, not removed/);
 assert.throws(()=>a.updateServiceCheck(c.id,[{id:'i07',q:1,p:12},LINES[1],LINES[2]]),/Prices of existing items/);
 const u=a.updateServiceCheck(c.id,LINES.concat([{id:'i13',q:1,p:2,name:'Espresso'}]));
 assert.equal(u.totalCents,3800);assert.equal(a.checkBalance(c.id).remainingCents,3300);
 assert.equal(a.check(5).length,4);
 // more of an existing dish is an addition, not a change
 assert.equal(a.updateServiceCheck(c.id,[LINES[0],{id:'i06',q:3,p:15},LINES[2],{id:'i13',q:1,p:2}]).totalCents,4300);
});

test('a pending cash payment also freezes the existing lines',()=>{
 const {a}=setup(),c=a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 const cash=a.settle({table:5,checkId:c.id,rail:'cash',amount:10});
 assert.throws(()=>a.updateServiceCheck(c.id,[LINES[0]]),/added, not removed/);
 a.cancelCash(cash.id);
 assert.equal(a.updateServiceCheck(c.id,[LINES[0]]).totalCents,1600);
});

test('a closed check refuses changes',()=>{
 const {a}=setup(),c=a.openServiceCheck({table:5,lines:[{id:'i13',q:1,p:2}],source:'staff'});
 a.settle({table:5,checkId:c.id,rail:'card',amount:2});a.closeServiceCheck(c.id);
 assert.throws(()=>a.updateServiceCheck(c.id,[{id:'i13',q:2,p:4}]),/closed/);
 assert.equal(a.serviceChecks()[0].totalCents,200);
});

test('check(table) returns the open check, and the sample only for a venue without staff checks',()=>{
 const {a,switchVenue}=setup();
 // an empty venue shows the sample so demos keep working
 assert.equal(a.check(5).length,12);assert.equal(a.checkTotal(5),152.5);assert.equal(a.check().length,12);
 // a sample check opened by the guest app does not switch the venue off the sample
 const sample=a.openServiceCheck({table:12,lines:a.check(12)});
 assert.equal(sample.source,'prototype');assert.equal(sample.totalCents,15250);
 a.settle({table:12,checkId:sample.id,rail:'card',amount:152.5});a.closeServiceCheck(sample.id);
 assert.equal(a.check(12).length,12);
 // once staff entered a bill, only real checks show
 a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 const lines=a.check(5);
 assert.deepEqual(JSON.parse(JSON.stringify(lines)),[{id:'i07',q:1,p:16,name:'Mixed Grill platter'},{id:'i06',q:2,p:10,name:'Hummus Beiruti'},{id:'i14',q:4,p:10,name:'Lebanese coffee'}]);
 assert.equal(a.checkTotal(5),36);
 assert.deepEqual(JSON.parse(JSON.stringify(a.check(12))),[]);assert.equal(a.checkTotal(12),0);
 assert.deepEqual(JSON.parse(JSON.stringify(a.check())),[]);
 // lines resolve current menu names; checks are scoped to their venue
 const d=a.draft();d.items.find(x=>x.id==='i06').name='Hummus';a.saveDraft(d);a.publish();
 assert.equal(a.check(5)[1].name,'Hummus');
 switchVenue('Tripoli');assert.equal(a.check(5).length,12);
});

test('opening and every update append an order_placed event with the full line list',()=>{
 const {a}=setup(),c=a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 a.updateServiceCheck(c.id,LINES.concat([{id:'i13',q:1,p:2}]));
 const rows=orders(a);
 assert.equal(rows.length,2);
 assert.deepEqual(JSON.parse(JSON.stringify(rows.map(e=>[e.payload.orderId,e.payload.revision,e.payload.change,e.tableId]))),[[c.id,1,'opened','5'],[c.id,2,'updated','5']]);
 assert.deepEqual(JSON.parse(JSON.stringify(rows[1].payload.items)),[{itemId:'i07',qty:1,unitPrice:16,currency:'USD'},{itemId:'i06',qty:2,unitPrice:5,currency:'USD'},{itemId:'i14',qty:4,unitPrice:2.5,currency:'USD'},{itemId:'i13',qty:1,unitPrice:2,currency:'USD'}]);
 assert.equal(rows[0].payload.total,36);assert.equal(rows[1].payload.total,38);
 // refused updates log nothing
 a.settle({table:5,checkId:c.id,rail:'card',amount:10});
 assert.throws(()=>a.updateServiceCheck(c.id,[LINES[0]]));
 assert.equal(orders(a).length,2);
});

test('demo mode means no venue key: stored key or ?k= in the link turns it off',()=>{
 assert.equal(setup().a.demoMode(),true);
 assert.equal(setup({key:'gst_0123456789abcdef'}).a.demoMode(),false);
 assert.equal(setup({search:'?k=gst_0123456789abcdef'}).a.demoMode(),false);
});

test('with a venue key the sample bill never appears, whatever checks exist',()=>{
 for(const opts of [{key:'gst_0123456789abcdef'},{search:'?k=own_0123456789abcdef'}]){
  const {a}=setup(opts);
  // an empty live venue: no bill, not the sample
  assert.deepEqual(JSON.parse(JSON.stringify(a.check(12))),[]);assert.equal(a.checkTotal(12),0);
  assert.deepEqual(JSON.parse(JSON.stringify(a.check())),[]);
  // staff bills show; other tables stay empty
  a.openServiceCheck({table:5,lines:LINES,source:'staff'});
  assert.equal(a.check(5).length,3);assert.equal(a.checkTotal(5),36);assert.equal(a.check(7).length,0);
 }
});

test('with a venue key a leftover sample check is hidden from guests until staff replace it',()=>{
 const {a}=setup({key:'gst_0123456789abcdef'});
 // e.g. opened in demo mode on this device before the key was added
 const left=a.openServiceCheck({table:12,total:152.5,lines:[{id:'i07',q:2,p:32},{id:'i03',q:3,p:18}]});
 assert.equal(left.source,'prototype');
 assert.deepEqual(JSON.parse(JSON.stringify(a.check(12))),[]);assert.equal(a.checkTotal(12),0);
 // staff still find it and replace it with the real bill; it then reaches the guest
 assert.equal(a.openCheckFor(12).id,left.id);
 const real=a.updateServiceCheck(left.id,[{id:'i13',q:2,p:4,name:'Espresso'}]);
 assert.equal(real.source,'staff');assert.equal(real.totalCents,400);
 assert.deepEqual(JSON.parse(JSON.stringify(a.check(12))),[{id:'i13',q:2,p:4,name:'Espresso'}]);
});

test('demo mode also hides a leftover sample check once the venue has a staff bill',()=>{
 const {a}=setup();
 // the coordinator's repro: a guest opens first, then staff enter a bill elsewhere
 const left=a.openServiceCheck({table:12,lines:a.check(12)});
 assert.equal(a.sampleAllowed(),true);assert.equal(a.check(12).length,12);
 a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 assert.equal(a.sampleAllowed(),false);
 assert.deepEqual(JSON.parse(JSON.stringify(a.check(12))),[]);
 assert.equal(a.openCheckFor(12).id,left.id);   // staff still see it to clear it
});
