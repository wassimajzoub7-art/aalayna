const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../aalayna-store.js'), 'utf8');
function setup(records) {
  const map = new Map(records ? [['aal.settle', JSON.stringify(records)]] : []);
  const window = { location: { search: '' }, addEventListener() {}, localStorage: { getItem: k => map.get(k) || null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) } };
  vm.runInNewContext(source, { window, localStorage: window.localStorage, URLSearchParams });
  return window.Aalayna;
}
test('cash requests never count as collected money or digital tips before confirmation', () => {
  const a = setup();
  const cash = a.settle({ rail: 'cash', amount: 42, tip: 2, note: 50, change: 8 });
  assert.equal(a.settledTotal(), 0);
  assert.equal(a.byRail().cash, 0);
  assert.equal(a.pendingCash().length, 1);
  assert.equal(a.tipsOwed().length, 0);
  a.refund(cash.id); // An uncollected claim cannot be refunded.
  assert.equal(a.pendingCash().length, 1);
  assert.equal(a.confirmCash(cash.id), true);
  assert.equal(a.confirmCash(cash.id), false); // Repeated operator action is harmless.
  assert.equal(a.settledTotal(), 42);
  assert.equal(a.pendingCash().length, 0);
  assert.equal(a.tipsOwed().length, 0); // Cash tips are not owed as digital payouts.
  a.cancelCash(cash.id);
  assert.equal(a.settledTotal(), 42); // Collected payments need a refund, not cancellation.
  a.refund(cash.id);
  assert.equal(a.settledTotal(), 0);
  assert.equal(a.confirmCash(cash.id), false);
  assert.equal(a.settlements().length, 1);
});
test('cancelled claims and old unverified cash records are never silently settled', () => {
  const a = setup([{ id: 'legacy', rail: 'cash', amount: 30, tip: 3 }]);
  assert.equal(a.settledTotal(), 0);
  assert.equal(a.pendingCash().length, 1);
  a.cancelCash('legacy');
  assert.equal(a.confirmCash('legacy'), false);
  assert.equal(a.pendingCash().length, 0);
  assert.equal(a.settlementStatus(a.settlements()[0]), 'cancelled');
});
test('mixed payment totals and tips exclude refunds and pending cash', () => {
  const a = setup();
  const card = a.settle({ rail: 'card', amount: 55, tip: 5, server: 'Sara' });
  a.settle({ rail: 'whish', amount: 22, tip: 2, server: 'Sara' });
  a.settle({ rail: 'cash', amount: 100, tip: 10 });
  assert.equal(a.settledTotal(), 77);
  assert.equal(a.tipsOwed()[0].amount, 7);
  a.refund(card.id);
  assert.equal(a.settledTotal(), 22);
  assert.equal(a.byRail().card, 0);
  assert.equal(a.tipsOwed()[0].amount, 2);
});
test('every rating opens one review panel with both destinations and restores focus on close', () => {
  const html = fs.readFileSync(path.join(__dirname, '../guest.html'), 'utf8');
  const code = html.slice(html.indexOf('function rate(n){'), html.indexOf('/* optional, after payment'));
  const stars = Array.from({length:5}, () => ({classList:{toggle(){}},setAttribute(){}}));
  const fields = Object.fromEntries(['review-title','review-destination','review-submit','review-status','review-text','v-done'].map(id=>[id,{textContent:'',value:'',disabled:false}]));
  const opened=[],recorded=[];let focused=false;
  const trigger={isConnected:true,focus(){focused=true;}};
  fields['ov-review']={classList:{remove(){}},querySelector(){return {focus(){}};}};
  const context={document:{activeElement:trigger,querySelectorAll:()=>stars},$:id=>fields[id],openOv:id=>opened.push(id),lastSettlementId:'p1',Aalayna:{submitReview:r=>recorded.push(r)}};
  vm.createContext(context);vm.runInContext(code,context);
  for(let n=1;n<=5;n++){
    context.rate(n);assert.equal(context.rating,n);assert.equal(opened.at(-1),'ov-review');assert.equal(fields['v-done'].inert,true);
    for(const destination of ['google','private']){
      fields['review-destination'].value=destination;context.paintReviewDestination();assert.equal(fields['review-submit'].disabled,false);
      context.submitReview();assert.equal(fields['review-submit'].disabled,true);assert.match(fields['review-status'].textContent,/not connected/);
    }
    context.closeReview();assert.equal(fields['v-done'].inert,false);assert.equal(focused,true);
  }
  assert.ok(!html.includes('id="ov-google"'));assert.ok(!html.includes('id="ov-priv"'));
  assert.equal(recorded.length,10);assert.equal(recorded[0].settlementId,'p1');assert.equal(recorded.at(-1).rating,5);
});
test('guest receipt stays pending until staff confirmation, and hides receipt and review actions', () => {
  const a = setup(), cash = a.settle({rail:'cash',amount:42,tip:2});
  const html = fs.readFileSync(path.join(__dirname,'../guest.html'),'utf8');
  const code = html.slice(html.indexOf('function paintSettlementResult(){'),html.indexOf('/* Every rating opens'));
  const nodes = Object.fromEntries(['rc-amt','rc-method','result-title','result-seal','method-label','payment-status','mailrc','consents','feedback-options'].map(id => [id,{textContent:'',style:{}}]));
  const ctx = { lastSettlementId:cash.id,lastSettlementStatus:null,Aalayna:a,$:id=>nodes[id],usd:n=>'$'+n.toFixed(2),RAIL_NAMES:{cash:'Cash'},window:{},rememberReceipt(){} };
  vm.createContext(ctx);vm.runInContext(code,ctx);
  ctx.paintSettlementResult();
  assert.match(nodes['payment-status'].textContent,/not marked paid/);
  assert.equal(nodes.mailrc.style.display,'none');
  assert.equal(nodes['feedback-options'].style.display,'none');
  a.confirmCash(cash.id);ctx.paintSettlementResult();
  assert.match(nodes['payment-status'].textContent,/confirmed/);
  assert.equal(nodes.mailrc.style.display,'');
  assert.equal(nodes['feedback-options'].style.display,'');
});
function guestSession(a, storage = new Map()) {
  const html = fs.readFileSync(path.join(__dirname,'../guest.html'),'utf8');
  const nodes = Object.fromEntries(['rc-amt','rc-method','result-title','result-seal','method-label','payment-status','mailrc','consents','feedback-options'].map(id=>[id,{textContent:'',style:{}}]));
  const events = {}, tracked = [], views = [];
  a.venueId = a.venueId || (()=>a.venue().name);
  const analytics = {track:(...args)=>tracked.push(args)};
  const context = {Aalayna:a,TABLE:12,MENU_V:1,$:id=>nodes[id],usd:n=>'$'+n.toFixed(2),RAIL_NAMES:{cash:'Cash',card:'Card'},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    window:{addEventListener:(name,fn)=>events[name]=fn,AalaynaAnalytics:analytics},AalaynaAnalytics:analytics,
    document:{visibilityState:'visible',addEventListener:(name,fn)=>events[name]=fn},go:id=>views.push(id),
    loadMenu(){},buildCats(){},buildMenu(){},renderMenu(){},buildBill(){},buildPick(){},calcShare(){}};
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('var paymentBusy ='),html.indexOf('function settle(){'))+
    html.slice(html.indexOf('function paintSettlementResult(){'),html.indexOf('/* Every rating opens')),context);
  return {context,nodes,events,tracked,views,storage};
}
test('returning to the guest tab catches confirmation without a storage event and counts it once',()=>{
  for(const event of ['focus','pageshow','visibilitychange']){
    const a=setup(),cash=a.settle({rail:'cash',amount:42,tip:2});
    const g=guestSession(a);g.context.lastSettlementId=cash.id;g.context.paintSettlementResult();
    // The store callback is deliberately disconnected to model a missed notification.
    a.on=()=>{};g.context.watchGuestChanges();
    g.events[event]();assert.equal(g.nodes['method-label'].textContent,'Requested via');
    a.confirmCash(cash.id);assert.equal(g.nodes['method-label'].textContent,'Requested via');
    g.events[event]();assert.equal(g.nodes['method-label'].textContent,'Paid via');
    g.events[event]();assert.equal(g.tracked.length,1);
    assert.deepEqual(g.tracked[0],['demo_complete','cash_confirmed']);
  }
});
test('reload restores this tab’s exact receipt, including confirmation received while away',()=>{
  const a=setup(),cash=a.settle({rail:'cash',amount:42,tip:2,note:50});
  const g=guestSession(a);g.context.lastSettlementId=cash.id;g.context.paintSettlementResult();
  a.settle({rail:'card',amount:90}); // A different guest must never replace the saved receipt.
  let reload=guestSession(a,g.storage);reload.context.restoreReceipt();
  assert.equal(reload.context.lastSettlementId,cash.id);assert.equal(reload.nodes['result-title'].textContent,'Cash requested.');
  a.confirmCash(cash.id);
  reload=guestSession(a,g.storage);reload.context.restoreReceipt();
  assert.equal(reload.nodes['rc-amt'].textContent,'$42.00');assert.equal(reload.nodes['rc-method'].textContent,'Cash · $8.00 change');
  assert.equal(reload.nodes['method-label'].textContent,'Paid via');assert.deepEqual(reload.views,['v-done']);
  const fresh=guestSession(a);fresh.context.restoreReceipt();assert.equal(fresh.context.lastSettlementId,null);
  const otherTable=guestSession(a,g.storage);otherTable.context.TABLE=13;otherTable.context.restoreReceipt();assert.equal(otherTable.context.lastSettlementId,null);
  a.setVenue({name:'Other restaurant',place:'Beirut'});
  const otherVenue=guestSession(a,g.storage);otherVenue.context.restoreReceipt();assert.equal(otherVenue.context.lastSettlementId,null);
});
test('one explicit staff action confirms cash and stale actions show feedback',()=>{
  const a=setup(),cash=a.settle({rail:'cash',amount:42});
  const html=fs.readFileSync(path.join(__dirname,'../dashboard.html'),'utf8');
  const code=html.slice(html.indexOf('function confirmCashReceived(id){'),html.indexOf('/* Refunds retain'));
  const messages=[];let refreshed=0;
  const ctx={Aalayna:a,toast:message=>messages.push(message),paintRows:()=>refreshed++};
  vm.createContext(ctx);vm.runInContext(code,ctx);ctx.confirmCashReceived(cash.id);
  assert.equal(a.pendingCash().length,0);assert.equal(a.settledTotal(),42);assert.match(messages[0],/recorded/);
  ctx.confirmCashReceived(cash.id);assert.equal(a.settledTotal(),42);assert.equal(refreshed,1);assert.match(messages[1],/Request changed/);
});
test('payment breakdown updates with tips and keeps cash coverage validation', () => {
  const html=fs.readFileSync(path.join(__dirname,'../guest.html'),'utf8');
  const code=html.slice(html.indexOf('function paintPay(){'),html.indexOf('/* ---------------- success'));
  const nodes=Object.fromEntries(['bigamt','bigll','pay-share','pay-tip','tv5','tv10','tv15','paybtn'].map(id=>[id,{}]));
  let tip=3.81,changeDue;
  const context={share:38.13,kind:'whish',note:0,tipAmt:()=>tip,$:id=>nodes[id],usd:x=>'$'+x.toFixed(2),ll:x=>'LL '+Math.round(x*89500),paintChange:x=>changeDue=x};
  vm.createContext(context);vm.runInContext(code,context);context.paintPay();
  assert.equal(nodes['pay-share'].textContent,'$38.13');assert.equal(nodes['pay-tip'].textContent,'$3.81');assert.equal(nodes.bigamt.textContent,'$41.94');
  tip=0;context.paintPay();assert.equal(nodes.bigamt.textContent,'$38.13');assert.equal(nodes['pay-tip'].textContent,'$0.00');
  context.kind='cash';context.note=20;context.paintPay();assert.equal(nodes.paybtn.disabled,true);assert.equal(changeDue,38.13);
  context.note=50;context.paintPay();assert.equal(nodes.paybtn.disabled,false);
});
test('optional dish photos survive publication and reject non-HTTPS image sources',()=>{
  const a=setup(),d=a.draft();d.items[0].imageUrl='https://restaurant.example/dish.jpg';a.saveDraft(d);a.publish();
  assert.equal(a.published().items[0].imageUrl,'https://restaurant.example/dish.jpg');
  for(const url of ['javascript:alert(1)','data:image/svg+xml,test','http://restaurant.example/dish.jpg']){
    const next=a.draft();next.items[0].imageUrl=url;a.saveDraft(next);assert.equal(a.draft().items[0].imageUrl,'');
  }
  assert.equal(a.published().items[0].imageUrl,'https://restaurant.example/dish.jpg');
});
