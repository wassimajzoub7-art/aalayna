const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const DAY=86400000;
function setup(){
 let time=Date.parse('2026-06-01T12:00:00Z');
 class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
 const map=new Map(),storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const window={location:{search:''},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Date:Clock});
 for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),ctx);
 const a=window.Aalayna;a.setVenue({name:'Restaurant',place:'Beirut'});
 return {a,advance:days=>time+=days*DAY,at:()=>time,map};
}
function bill(e,{amount=40,tip=0,contact,marketing=false,rail='card',close=true}={}){
 const a=e.a,c=a.openServiceCheck({table:12,total:amount});
 const p=a.settle({table:12,checkId:c.id,rail,amount:amount+tip,tip});
 if(rail!=='cash'&&contact)a.optIn({settlementId:p.id,contact,receipt:true,marketing});
 if(rail!=='cash'&&close)a.closeServiceCheck(c.id);
 return {c,p};
}
test('empty reports have no invented rates or averages, and today begins at Beirut midnight',()=>{
 const e=setup(),a=e.a,m=a.ownerReport('7').current;
 for(const key of ['captureRate','optInRate','returnRate','averageBillCents'])assert.equal(m[key],null);
 const summer=a.ownerWindow('today',Date.parse('2026-06-01T22:00:00Z'));
 assert.equal(new Date(summer.start).toISOString(),'2026-06-01T21:00:00.000Z');
 const winter=a.ownerWindow('today',Date.parse('2026-01-01T23:00:00Z'));
 assert.equal(new Date(winter.start).toISOString(),'2026-01-01T22:00:00.000Z');
 const spring=a.ownerWindow('today',Date.parse('2026-03-29T12:00:00Z'));
 assert.equal(new Date(spring.start).toISOString(),'2026-03-28T22:00:00.000Z');
 const autumn=a.ownerWindow('today',Date.parse('2026-10-25T12:00:00Z'));
 assert.equal(new Date(autumn.start).toISOString(),'2026-10-24T22:00:00.000Z');
});
test('periods separate previous payments, retain confirmed cash by collection time, and exclude refunds',()=>{
 const e=setup(),a=e.a;bill(e,{amount:80});e.advance(8);
 const cash=bill(e,{amount:40,rail:'cash',close:false});e.advance(8);
 assert.equal(a.ownerReport('7').current.netCents,0);
 a.confirmCash(cash.p.id);
 const r=a.ownerReport('7');assert.equal(r.current.netCents,4000);assert.equal(r.current.rails.cash,4000);
 assert.equal(a.ownerPaymentHistory('7').length,1);assert.equal(a.ownerReport('30').current.netCents,12000);
 a.refund(cash.p.id);assert.equal(a.ownerReport('7').current.netCents,0);
 assert.equal(a.ownerPaymentHistory('7').length,1); // Refund remains visible in history.
});
test('average completed bill distinguishes parties at the same table and excludes tips and partial bills',()=>{
 const e=setup(),a=e.a;bill(e,{amount:40,tip:4});bill(e,{amount:60,tip:6});
 const c=a.openServiceCheck({table:12,total:100});a.settle({table:12,checkId:c.id,rail:'card',amount:20});
 const m=a.ownerReport('7').current;
 assert.equal(m.completedBills,2);assert.equal(m.averageBillCents,5000);assert.equal(m.bills,3);assert.equal(m.netCents,12000);assert.equal(m.tipCents,1000);
});
test('capture is per bill, while receipt sign-ups deduplicate contacts and use the latest choice in period',()=>{
 const e=setup(),a=e.a,x=bill(e,{contact:'a@example.com',marketing:true});
 bill(e,{contact:'a@example.com',marketing:true});bill(e,{});
 a.optIn({settlementId:x.p.id,contact:'a@example.com',receipt:true,marketing:false});
 const m=a.ownerReport('7').current;
 assert.equal(m.bills,3);assert.equal(m.identifiedBills,2);assert.equal(m.captureRate,2/3);
 assert.equal(m.receiptContacts,1);assert.equal(m.marketingContacts,0);assert.equal(m.optInRate,0);assert.equal(m.withdrawals,1);
});
test('return rate uses a mature first-observed cohort and excludes recent guests and late returns',()=>{
 const e=setup(),a=e.a;
 bill(e,{contact:'returned@example.com'});bill(e,{contact:'late@example.com'});bill(e,{contact:'no@example.com'});
 e.advance(5);bill(e,{contact:'returned@example.com'});
 e.advance(26);bill(e,{contact:'late@example.com'});bill(e,{contact:'new@example.com'});
 e.advance(1);bill(e,{contact:'new@example.com'});
 e.advance(1);
 const m=a.ownerReport('7').current;
 assert.equal(m.eligibleReturners,3);assert.equal(m.returners,1);assert.equal(m.returnRate,1/3);
});
test('previous period comparisons use distinct intervals and respect restaurant scope',()=>{
 const e=setup(),a=e.a;bill(e,{amount:25,contact:'past@example.com'});e.advance(8);bill(e,{amount:50,contact:'now@example.com'});
 let r=a.ownerReport('7');assert.equal(r.previous.netCents,2500);assert.equal(r.current.netCents,5000);assert.equal(r.previousWindow.end,r.window.start);
 a.setVenue({name:'Restaurant',place:'Tripoli'});r=a.ownerReport('7');assert.equal(r.current.netCents,0);assert.equal(r.current.receiptContacts,0);assert.equal(a.ownerPaymentHistory('30').length,0);
});
test('a refunded completed bill is removed from averages and receipt cohorts',()=>{
 const e=setup(),x=bill(e,{contact:'refund@example.com',marketing:true});e.a.refund(x.p.id);
 const m=e.a.ownerReport('7').current;assert.equal(m.completedBills,0);assert.equal(m.averageBillCents,null);assert.equal(m.receiptContacts,0);
});
