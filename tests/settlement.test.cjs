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
test('all guest ratings keep feedback channel choice unchanged', () => {
  const html = fs.readFileSync(path.join(__dirname, '../3alyna_full_flow.html'), 'utf8');
  const rate = html.slice(html.indexOf('function rate(n){'), html.indexOf('/* optional, after payment'));
  const nodes = Array.from({ length: 5 }, () => ({ classList: { toggle() {} }, setAttribute() {} }));
  const context = { document: { querySelectorAll: () => nodes }, openOv: () => { throw Error('Rating must not route feedback'); }, setTimeout: fn => fn() };
  vm.createContext(context); vm.runInContext(rate, context);
  for (let n=1;n<=5;n++) { context.rate(n); assert.equal(context.rating,n); }
});
test('guest receipt stays pending until staff confirmation, and hides receipt and review actions', () => {
  const a = setup(), cash = a.settle({rail:'cash',amount:42,tip:2});
  const html = fs.readFileSync(path.join(__dirname,'../3alyna_full_flow.html'),'utf8');
  const code = html.slice(html.indexOf('function paintSettlementResult(){'),html.indexOf('/* Rating never changes'));
  const nodes = Object.fromEntries(['result-title','result-seal','method-label','payment-status','mailrc','consents','feedback-options'].map(id => [id,{textContent:'',style:{}}]));
  const ctx = { lastSettlementId:cash.id,Aalayna:a,$:id=>nodes[id] };
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
