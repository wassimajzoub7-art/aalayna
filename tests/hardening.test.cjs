const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
function local(){let time=Date.parse('2026-09-15T12:00:00Z');class Clock extends Date{constructor(...a){super(...(a.length?a:[time]));}static now(){return time;}}const map=new Map(),storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)},window={location:{search:''},addEventListener(){},localStorage:storage};const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Date:Clock});for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx);return {a:window.Aalayna,map,advance:n=>time+=n};}
test('digital reservations prevent two payers covering the same amount, release on expiry and reject late confirmation',()=>{
 const {a,advance}=local(),c=a.openServiceCheck({table:1,total:100});
 a.requestPayment({requestId:'a',checkId:c.id,table:1,rail:'card',amount:100});
 assert.equal(a.checkBalance(c.id).availableCents,0);
 assert.throws(()=>a.requestPayment({requestId:'b',checkId:c.id,table:1,rail:'card',amount:100}),/already covers/);
 advance(11*60000);assert.equal(a.checkBalance(c.id).availableCents,10000);
 assert.throws(()=>a.confirmPayment('a',{externalRef:'late'}),/expired/);
 a.requestPayment({requestId:'b',checkId:c.id,table:1,rail:'card',amount:100});a.failPayment('b','failed');
 assert.equal(a.checkBalance(c.id).availableCents,10000);
});
test('item-level reservations include initiated digital payments and confirmation excludes its own reservation',()=>{
 const {a}=local(),c=a.openServiceCheck({table:1,total:40,lines:[{id:'dish',p:40,q:2}]});
 a.requestPayment({requestId:'a',checkId:c.id,table:1,rail:'card',amount:20,items:{dish:1}});
 assert.throws(()=>a.requestPayment({requestId:'b',checkId:c.id,table:1,rail:'card',amount:20,items:{dish:2}}),/already covered/);
 a.confirmPayment('a',{externalRef:'confirmed'});assert.equal(a.checkBalance(c.id).confirmedCents,2000);
});
test('shared caches never import the demo or another restaurant and owner cache is not the guest cache',()=>{
 const {a,map}=local();a.util.write('aal.guests',[{id:'private',venueId:a.venueId(),contact:'fictional@example.invalid'}]);
 a.util.activateScope('restaurant-A:owner');assert.equal(a.util.read('aal.guests',[]).length,0);
 a.util.write('aal.guests',[{id:'A',venueId:a.venueId()}]);
 a.util.activateScope('restaurant-B:owner');assert.equal(a.util.read('aal.guests',[]).length,0);
 a.util.activateScope('restaurant-A:guest');assert.equal(a.util.read('aal.guests',[]).length,0);
 a.util.activateScope('restaurant-A:owner');assert.equal(a.util.read('aal.guests',[])[0].id,'A');
 assert.ok(map.has('aal.guests'));assert.throws(()=>a.setVenue({name:'B'}),/separate restaurant/);
});
test('dish counts deduplicate bill events and never present unrelated orders as conversion',()=>{
 const {a}=local();a.logEvent('item_view',{itemId:'i01'});
 for(const id of ['bill-a','bill-a','bill-b'])a.logEvent('order_placed',{orderId:id,items:[{itemId:'i01',qty:1}]});
 const d=a.dishInterest('7').find(x=>x.itemId==='i01');assert.equal(d.onBills,2);assert.equal(d.units,2);assert.equal(d.billRate,null);
});
test('marketing scenario separates usage, deduplication and permission; zero consent or adoption yields no audience',()=>{
 const model=require('../numbers-model.js'),v={paid:100,adoption:50,capture:20,unique:50,permission:50,returnrate:10,check:40};
 const r=model.guests(v);assert.equal(r.week,10);assert.ok(Math.abs(r.unique-64.95)<1e-9);assert.ok(Math.abs(r.quarter-32.475)<1e-9);
 assert.equal(model.guests({...v,permission:0}).back,0);assert.equal(model.guests({...v,adoption:0}).value,0);
 assert.equal(model.clamp(-10,0,100,50),0);assert.equal(model.clamp(1000,0,100,50),100);
});
