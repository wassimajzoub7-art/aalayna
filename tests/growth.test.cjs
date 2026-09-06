const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
function setup(){
 let time=Date.parse('2026-06-01T12:00:00Z');
 class Clock extends Date { constructor(...args){super(...(args.length?args:[time]));}static now(){return time;} }
 const map=new Map();const storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const window={location:{search:''},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,Date:Clock,URLSearchParams});
 for(const file of ['aalayna-store.js','restaurant-growth.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
 const a=window.Aalayna;a.setVenue({name:'Restaurant',place:'Beirut'});
 return {a,map,ctx,advance:days=>{time+=days*86400000;},stamp:()=>new Clock().toISOString(),switchVenue:(place)=>a.setVenue({name:'Restaurant',place})};
}
function visit(env,contact,options={}){
 const a=env.a,check=a.openServiceCheck({table:options.table||12,total:options.amount||40});
 const payment=a.settle({table:check.table,checkId:check.id,rail:options.rail||'card',amount:options.amount||40});
 if(payment.rail==='cash')a.confirmCash(payment.id);
 const customer=a.optIn({settlementId:payment.id,contact,receipt:true,marketing:options.marketing!==false});
 a.closeServiceCheck(check.id);return {customer,payment,check};
}
test('receipt resubmission normalises identity without manufacturing visits; latest consent wins',()=>{
 const e=setup(),x=visit(e,' Guest@Example.com ');
 e.a.optIn({settlementId:x.payment.id,contact:'guest@example.com',receipt:true,marketing:false});
 const ps=e.a.customerProfiles();assert.equal(ps.length,1);assert.equal(ps[0].visits,1);assert.equal(ps[0].spendCents,4000);assert.equal(ps[0].marketing,false);assert.equal(ps[0].consentHistory.length,2);
 assert.equal(e.a.campaignAudience('all','email').length,0);
});
test('same bill counts once across partial payments and does not imply party spending',()=>{
 const e=setup(),a=e.a,c=a.openServiceCheck({table:12,total:100});
 const p=a.settle({table:12,checkId:c.id,rail:'card',amount:20,tip:2});
 const g=a.optIn({settlementId:p.id,contact:'+96170123456',receipt:true,marketing:true});
 const p2=a.settle({table:12,checkId:c.id,rail:'whish',amount:30});
 a.optIn({settlementId:p2.id,contact:'00961 70 123 456',receipt:true,marketing:true});
 assert.equal(a.customerProfiles()[0].visits,1);assert.equal(a.customerProfiles()[0].spendCents,4800);
 assert.throws(()=>a.optIn({settlementId:p.id,contact:'different@example.com',receipt:true,marketing:true}),/another contact/);
 assert.equal(g.channel,'whatsapp');
});
test('cash visits require collection and refunds remove their spend and visit',()=>{
 const e=setup(),a=e.a,c=a.openServiceCheck({table:12,total:40});
 const p=a.settle({table:12,checkId:c.id,rail:'cash',amount:44,tip:4,note:50});
 assert.throws(()=>a.optIn({settlementId:p.id,contact:'cash@example.com',receipt:true,marketing:true}),/confirmed/);
 a.confirmCash(p.id);a.optIn({settlementId:p.id,contact:'cash@example.com',receipt:true,marketing:true});
 assert.equal(a.customerProfiles()[0].spendCents,4000);a.refund(p.id);assert.equal(a.customerProfiles()[0].visits,0);assert.equal(a.customerProfiles()[0].spendCents,0);
});
test('mixed methods reserve pending cash, reject excess, and reopen balances after refunds',()=>{
 const e=setup(),a=e.a,c=a.openServiceCheck({table:12,total:100});
 const cash=a.settle({table:12,checkId:c.id,rail:'cash',amount:55,tip:5,note:60,requestId:'cash-one'});
 assert.equal(a.settle({table:12,checkId:c.id,rail:'cash',amount:55,tip:5,note:60,requestId:'cash-one'}).id,cash.id);
 const card=a.settle({table:12,checkId:c.id,rail:'card',amount:22,tip:2});
 assert.equal(a.checkBalance(c.id).availableCents,3000);assert.equal(a.checkBalance(c.id).remainingCents,8000);
 assert.throws(()=>a.settle({table:12,checkId:c.id,rail:'whish',amount:31}),/bill changed/);
 assert.throws(()=>a.closeServiceCheck(c.id),/outstanding/);
 a.cancelCash(cash.id);assert.equal(a.checkBalance(c.id).availableCents,8000);
 a.settle({table:12,checkId:c.id,rail:'whish',amount:80});a.closeServiceCheck(c.id);a.refund(card.id);
 assert.equal(a.checkBalance(c.id).remainingCents,2000);
});
test('item reservations reject duplicate units and cancellation frees them',()=>{
 const e=setup(),a=e.a,c=a.openServiceCheck({table:12,total:100,lines:[{id:'meal',q:2,p:60},{id:'other',q:1,p:40}]});
 const p=a.settle({table:12,checkId:c.id,rail:'cash',amount:30,items:{meal:1}});
 assert.throws(()=>a.settle({table:12,checkId:c.id,rail:'card',amount:60,items:{meal:2}}),/already covered/);
 a.cancelCash(p.id);a.settle({table:12,checkId:c.id,rail:'card',amount:60,items:{meal:2}});
 assert.equal(a.checkBalance(c.id).availableCents,4000);
});
test('customers, settlements, checks and campaign mutations remain branch scoped',()=>{
 const e=setup(),x=visit(e,'guest@example.com');
 const campaign=e.a.prepareCampaign({name:'Invite',message:'Come back. Reply STOP to opt out.',audience:'all',channel:'email'});
 const c=e.a.openServiceCheck({table:12,total:20}),pending=e.a.settle({table:12,checkId:c.id,rail:'cash',amount:20});
 e.switchVenue('Tripoli');assert.equal(e.a.customerProfiles().length,0);assert.equal(e.a.settlements().length,0);assert.equal(e.a.serviceChecks().length,0);
 assert.throws(()=>e.a.approveCampaign(campaign.id),/not found/);assert.equal(e.a.confirmCash(pending.id),false);e.a.refund(x.payment.id);
 e.switchVenue('Beirut');assert.equal(e.a.customerProfiles()[0].visits,1);assert.equal(e.a.pendingCash().length,1);
});
test('audiences use confirmed recency, frequency, consent and the correct channel',()=>{
 const e=setup();visit(e,'first@example.com');visit(e,'+96170123456');visit(e,'no@example.com',{marketing:false});
 visit(e,'regular@example.com');visit(e,'regular@example.com');visit(e,'regular@example.com');
 e.advance(8);
 assert.equal(e.a.campaignAudience('second_visit','email').length,1);assert.equal(e.a.campaignAudience('second_visit','whatsapp').length,1);assert.equal(e.a.campaignAudience('regulars','email').length,1);
 e.advance(23);assert.equal(e.a.campaignAudience('lapsed','email').length,2);assert.equal(e.a.campaignAudience('second_visit','email').length,0);
});
test('draft approval freezes comparison assignment without inventing deliveries; export rechecks opt-outs',()=>{
 const e=setup();for(let i=0;i<10;i++)visit(e,'g'+i+'@example.com');
 const draft=e.a.prepareCampaign({name:'Welcome back',message:'Visit again. Reply STOP.',audience:'all',channel:'email',useHoldout:true});
 assert.equal(draft.status,'draft');assert.throws(()=>e.a.exportCampaignAudience(draft.id),/Approve/);
 const c=e.a.approveCampaign(draft.id);assert.equal(c.holdout.length,2);assert.equal(c.recipients.length,8);assert.equal(c.deliveries.length,0);
 assert.equal(new Set([...c.holdout,...c.recipients]).size,10);
 assert.throws(()=>e.a.approveCampaign(c.id),/already approved/);
 e.a.withdrawMarketing(c.recipients[0]);assert.equal(e.a.exportCampaignAudience(c.id).length,7);assert.equal(e.a.campaignReport(c.id).assigned.size,8);
});
test('delivery reports validate atomically, exclude holdout and deduplicate retries',()=>{
 const e=setup();for(let i=0;i<5;i++)visit(e,'g'+i+'@example.com');
 const d=e.a.prepareCampaign({name:'Invite',message:'Welcome back.',audience:'all',channel:'email',useHoldout:true}),c=e.a.approveCampaign(d.id);
 e.advance(1);const valid={customerId:c.recipients[0],deliveredAt:e.stamp(),providerMessageId:'provider-1'};
 assert.throws(()=>e.a.recordCampaignDeliveries(c.id,[valid,{...valid,customerId:c.holdout[0]}]),/invalid/);assert.equal(e.a.campaignReport(c.id).delivered.size,0);
 e.a.recordCampaignDeliveries(c.id,[valid]);e.a.recordCampaignDeliveries(c.id,[valid]);assert.equal(e.a.campaignReport(c.id).delivered.size,1);
 e.advance(1);e.a.withdrawMarketing(c.recipients[1]);e.advance(1);
 assert.throws(()=>e.a.recordCampaignDeliveries(c.id,[{customerId:c.recipients[1],deliveredAt:e.stamp(),providerMessageId:'provider-2'}]),/opt-out/);
});
test('campaign returns require a later confirmed visit, respect the window, and exclude refunds',()=>{
 const e=setup();const first=visit(e,'guest@example.com');
 const c=e.a.approveCampaign(e.a.prepareCampaign({name:'Invite',message:'Hello',audience:'all',channel:'email'}).id);
 e.advance(1);e.a.recordCampaignDeliveries(c.id,[{customerId:first.customer.id,deliveredAt:e.stamp(),providerMessageId:'m1'}]);
 assert.equal(e.a.campaignReport(c.id).delivered.returners,0);
 e.advance(1);const repeat=visit(e,'guest@example.com',{rail:'cash',amount:25});
 let r=e.a.campaignReport(c.id);assert.equal(r.delivered.returners,1);assert.equal(r.delivered.spendCents,2500);assert.equal(r.windowComplete,false);
 e.a.refund(repeat.payment.id);assert.equal(e.a.campaignReport(c.id).delivered.returners,0);
 e.advance(31);visit(e,'guest@example.com');r=e.a.campaignReport(c.id);assert.equal(r.delivered.returners,0);assert.equal(r.windowComplete,true);
});
test('weekly metrics and recommendations use scoped confirmed records and explain empty state',()=>{
 const e=setup();assert.equal(e.a.recommendations()[0].kind,'empty');
 visit(e,'customer@example.com',{amount:40});e.advance(8);
 const c=e.a.openServiceCheck({table:12,total:30});e.a.settle({table:12,checkId:c.id,rail:'cash',amount:30});e.advance(1);
 assert.equal(e.a.weeklySummary().netCents,0);assert.ok(e.a.recommendations().some(r=>r.kind==='cash'));assert.ok(e.a.recommendations().some(r=>r.kind==='second_visit'));
});
test('legacy contacts without check evidence cannot become marketing audiences or return visits',()=>{
 const e=setup();e.map.set('aal.guests',JSON.stringify([{id:'old',venue:'Restaurant',contact:'old@example.com',marketing:true,visits:100,last:e.stamp()}]));
 assert.equal(e.a.customerProfiles().length,0);assert.equal(e.a.campaignAudience('all','email').length,0);
});
test('venue URL reads do not recursively emit write events',()=>{
 const e=setup();e.ctx.window.location.search='?venue=Restaurant&place=Beirut';let count=0;e.a.on(()=>{count++;e.a.venue();});e.a.venue();assert.ok(count<=1);
});
test('payment retries cannot change the amount, and cash change is derived from the actual note',()=>{
 const e=setup(),a=e.a,c=a.openServiceCheck({table:12,total:100});
 const p=a.settle({table:12,checkId:c.id,rail:'cash',amount:40,note:50,change:999,requestId:'stable'});assert.equal(p.change,10);
 assert.throws(()=>a.settle({table:12,checkId:c.id,rail:'cash',amount:41,note:50,requestId:'stable'}),/different request/);
 assert.throws(()=>a.settle({table:12,checkId:c.id,rail:'cash',amount:30,note:20}),/enough cash/);
});
test('one provider delivery ID cannot manufacture delivery to several people',()=>{
 const e=setup();visit(e,'one@example.com');visit(e,'two@example.com');const c=e.a.approveCampaign(e.a.prepareCampaign({name:'Invite',message:'Hello',audience:'all',channel:'email'}).id);e.advance(1);
 assert.throws(()=>e.a.recordCampaignDeliveries(c.id,c.recipients.map(customerId=>({customerId,deliveredAt:e.stamp(),providerMessageId:'same-id'}))),/two recipients/);
 assert.equal(e.a.campaignReport(c.id).delivered.size,0);
});
