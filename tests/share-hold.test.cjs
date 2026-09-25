/* T12: a share the guest has been shown and is paying stays fixed until that payment
   completes or is cancelled. The demo guest page (store, growth rules, table QR script
   and the page's own script, no shared-store config) runs against a minimal DOM, as in
   tests/offline.test.cjs, with timers the test runs by hand so the simulated provider
   confirmation happens when the test says. The sequence is the one found on the demo:
   the $152.50 sample bill, Evenly between 4 = $38.13, 10% tip = $41.94, Pay with
   Whish. Aalayna.requestPayment reserves the $38.13 on the check (availableCents drops
   to $114.37) and the store write repaints the page; before the fix calcShare then
   recomputed the share from the reduced balance ($114.37 / 4 = $28.59, $31.45 with
   the tip) behind the provider sheet, and the next payment charged that.
   Evenly with N (T12 round 2) is the bill divided by N, capped at what is left: four
   diners in turn pay 38.13, 38.13, 38.13 and the last 38.11 (the remaining cents),
   where dividing the remainder gave 38.13, 28.59, 21.45, 16.08 and left $48.25 unpaid. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const html=fs.readFileSync(path.join(root,'guest.html'),'utf8');
const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const TQ=inline.find(s=>s.indexOf('var AalaynaTableQR')>=0),PAGE=inline.find(s=>s.indexOf('function loadMenu')>=0);

function makeDom(){
 const byId=new Map();
 function el(id){
  const cls=new Set(),kids=[];
  return {id:id||'',style:{setProperty(){}},dataset:{},innerHTML:'',textContent:'',value:'',disabled:false,checked:false,hidden:false,children:kids,childNodes:kids,
   classList:{add:(...c)=>c.forEach(x=>cls.add(x)),remove:(...c)=>c.forEach(x=>cls.delete(x)),toggle:(c,f)=>{const on=f===undefined?!cls.has(c):!!f;on?cls.add(c):cls.delete(c);return on;},contains:c=>cls.has(c)},
   appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},prepend(...c){kids.unshift(...c);},insertBefore(c){kids.push(c);return c;},removeChild(c){return c;},remove(){},replaceChildren(){kids.length=0;},
   setAttribute(){},getAttribute(){return null;},removeAttribute(){},hasAttribute(){return false;},addEventListener(){},removeEventListener(){},
   querySelector:()=>el(),querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:0,height:0,right:0,bottom:0}),getClientRects:()=>[],
   focus(){},blur(){},click(){},scrollTo(){},scrollIntoView(){},closest:()=>null,matches:()=>false,contains:()=>false,
   offsetWidth:0,offsetHeight:0,offsetLeft:0,offsetTop:0,scrollTop:0,scrollHeight:0,clientHeight:0,clientWidth:0,parentNode:null,parentElement:null,firstChild:null,lastChild:null,nextSibling:null};
 }
 const views=['v-land','v-menu','v-bill','v-settle','v-pay','v-done'];
 const document={visibilityState:'visible',cookie:'',readyState:'complete',
  getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  querySelector:()=>el(),querySelectorAll:s=>s==='.view'?views.map(id=>document.getElementById(id)):[],createElement:()=>el(),createTextNode:()=>el(),addEventListener(){},removeEventListener(){},
  body:el('body'),head:el('head'),documentElement:el('html'),activeElement:null};
 return document;
}
function boot({local=new Map()}={}){
 const store=m=>({getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i],get length(){return m.size;}});
 const listeners={},timers=[],alerts=[],document=makeDom();
 const window={document,location:{pathname:'/guest.html',search:'?venue=Kababji',origin:'https://aalayna.com',href:'https://aalayna.com/guest.html?venue=Kababji',replace(){}},
  history:{replaceState(){}},localStorage:store(local),sessionStorage:store(new Map()),crypto:require('node:crypto').webcrypto,
  navigator:{userAgent:'test',clipboard:{writeText(){}},onLine:true},
  addEventListener(type,f){(listeners[type]=listeners[type]||[]).push(f);},removeEventListener(){},
  requestAnimationFrame(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),getComputedStyle:()=>({getPropertyValue:()=>''}),
  setInterval(){return 0;},clearInterval(){},setTimeout(f){timers.push(f);return timers.length;},clearTimeout(){},
  scrollTo(){},alert(m){alerts.push(m);},prompt(){},confirm:()=>true,innerHeight:844,innerWidth:390,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,TypeError,RegExp,Set,Map};
 window.window=window;window.self=window;
 const ctx=vm.createContext(window),run=(code,name)=>vm.runInContext(code,ctx,{filename:name||'probe'});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 run(TQ,'guest.html#table-qr');
 run(PAGE,'guest.html#page');
 const $=id=>document.getElementById(id);
 return {window,alerts,run,$,
  // everything a guest can see of the amount on the pay screen and the provider sheets
  shown:()=>({total:$('bigamt').textContent,share:$('pay-share').textContent,tip:$('pay-tip').textContent,button:$('paybtn').innerHTML.replace(/<[^>]*>/g,''),whish:$('wh-amt').textContent,card:$('card-btn').textContent}),
  // the provider confirmation is a setTimeout in the demo: run what is queued
  local,
  restnote:()=>$('restnote').textContent,
  timers:()=>{while(timers.length)timers.shift()();},
  // every way the page repaints on its own: a store write here or in another tab, focus, a return to the tab
  repaint:()=>{run('Aalayna.notify("aal.settle")');['focus','pageshow'].forEach(t=>(listeners[t]||[]).forEach(f=>f({type:t})));},
  available:()=>run('Aalayna.checkBalance(CHECK.id).availableCents'),
  payments:()=>JSON.parse(JSON.stringify(run('Aalayna.settlements().filter(function(s){return s.checkId===CHECK.id;}).map(function(s){return {rail:s.rail,amount:s.amount,tip:s.tip,status:Aalayna.settlementStatus(s)};})')))};
}
function toPay(p,rail){
 p.run("go('v-settle')");p.run("mode('even')");
 p.run("go('v-pay')");
 p.run("pick($('pm-"+rail+"'),'"+rail+"')");
}

test('the sample bill: Evenly between 4 with a 10% tip is $38.13 + $3.81 = $41.94',()=>{
 const p=boot();
 assert.equal(p.run('Aalayna.demoMode()'),true);
 assert.equal(p.run('TOTAL'),152.5);assert.equal(p.run('people'),4);
 toPay(p,'whish');
 const s=p.shown();
 assert.equal(s.share,'$38.13');assert.equal(s.tip,'$3.81');assert.equal(s.total,'$41.94');
 assert.equal(p.available(),15250);
});

test('Whish: the share shown stays $41.94 while the request is open, through repaints, and Whish charges $41.94',async()=>{
 const p=boot();
 toPay(p,'whish');
 const before=p.shown().total;
 assert.equal(before,'$41.94');
 p.run('settle()');await flush();
 assert.equal(p.shown().whish,'Pay $41.94');
 // the reservation is real: other guests now see $114.37 available ...
 assert.equal(p.available(),15250-3813);
 assert.deepEqual(p.payments(),[{rail:'whish',amount:41.94,tip:3.81,status:'initiated'}]);
 // ... but this guest's amount, behind the Whish sheet, does not move
 const during=p.shown();
 assert.equal(during.total,'$41.94');assert.equal(during.share,'$38.13');assert.equal(during.tip,'$3.81');assert.equal(during.button,'Pay $41.94');
 p.repaint();
 assert.equal(p.shown().total,'$41.94');assert.equal(p.shown().share,'$38.13');
 assert.equal(p.run('share'),38.13);assert.equal(p.run('tipAmt()'),3.81);
 p.run('whishConfirm()');p.timers();await flush();
 assert.deepEqual(p.payments(),[{rail:'whish',amount:41.94,tip:3.81,status:'confirmed'}]);
 assert.equal(p.$('rc-amt').textContent,before);                       // the receipt says what was shown
 assert.equal(p.run('payHold'),null);                                  // released once the payment completes
 assert.deepEqual(p.alerts,[]);
});

test('Whish cancelled, then card: the card charges exactly what was shown after the cancel',async()=>{
 const p=boot();
 toPay(p,'whish');
 p.run('settle()');await flush();
 p.repaint();
 assert.equal(p.shown().total,'$41.94');
 p.run("cancelProvider('ov-whish')");await flush();
 assert.equal(p.payments()[0].status,'expired');
 assert.equal(p.available(),15250);                                    // the reservation is released
 assert.equal(p.run('payHold'),null);
 p.run("pick($('pm-card'),'card')");
 const shown=p.shown();
 assert.equal(shown.total,'$41.94');                                   // recomputed from the full balance again
 p.run('settle()');await flush();
 assert.equal(p.shown().card,'Pay '+shown.total);
 p.repaint();
 assert.equal(p.shown().total,shown.total);
 p.run('cardConfirm()');p.timers();await flush();
 const card=p.payments().filter(x=>x.rail==='card');
 assert.deepEqual(card,[{rail:'card',amount:41.94,tip:3.81,status:'confirmed'}]);
 assert.equal('$'+card[0].amount.toFixed(2),shown.total);
 assert.deepEqual(p.alerts,[]);
});

test('the next guest after the Whish payment: Evenly with 4 is still a quarter of the bill, and the card charges what was shown',async()=>{
 const p=boot();
 toPay(p,'whish');
 p.run('settle()');await flush();
 p.run('whishConfirm()');p.timers();await flush();
 p.run('restart()');                                                    // a new scan on this phone
 toPay(p,'card');
 const shown=p.shown();
 assert.equal(shown.share,'$38.13');assert.equal(shown.total,'$41.94');   // not $28.59 / $31.45 from the remainder
 p.run('settle()');await flush();
 assert.equal(p.shown().card,'Pay '+shown.total);
 p.repaint();
 assert.equal(p.shown().total,shown.total);
 p.run('cardConfirm()');p.timers();await flush();
 const card=p.payments().filter(x=>x.rail==='card');
 assert.equal(card.length,1);assert.equal(card[0].status,'confirmed');
 assert.equal('$'+card[0].amount.toFixed(2),shown.total);
 assert.equal(p.$('rc-amt').textContent,shown.total);
});

test('My items: the picked items reserved by the request do not zero this guest\'s share mid-payment',async()=>{
 const p=boot();
 p.run("go('v-settle')");p.run("mode('item')");
 p.run('picked[0]=BILL[0].q;calcShare()');                             // the whole first line: once reserved, none of it is available
 p.run("go('v-pay')");p.run("pick($('pm-card'),'card')");
 const shown=p.shown();
 assert.equal(shown.share,'$'+p.run('BILL[0].p').toFixed(2));
 p.run('settle()');await flush();
 p.repaint();
 assert.equal(p.shown().share,shown.share);assert.equal(p.shown().total,shown.total);
 p.run('cardConfirm()');p.timers();await flush();
 const card=p.payments();
 assert.equal(card.length,1);assert.equal(card[0].status,'confirmed');
 assert.equal('$'+card[0].amount.toFixed(2),shown.total);
});

test('a provider confirmation the store refuses releases the hold and recomputes the share',async()=>{
 const p=boot();
 toPay(p,'whish');
 p.run('settle()');await flush();
 assert.ok(p.run('payHold'));
 // the reservation expires while the Whish sheet is open (10 minutes)
 p.run('(function(){var all=JSON.parse(localStorage.getItem("aal.settle"));all.forEach(function(s){s.expiresAt=new Date(Date.now()-1000).toISOString();});localStorage.setItem("aal.settle",JSON.stringify(all));})()');
 p.run('whishConfirm()');p.timers();await flush();
 assert.equal(p.alerts.length,1);
 assert.equal(p.run('payHold'),null);
 assert.equal(p.run('paymentBusy'),false);
 assert.equal(p.available(),15250);
 assert.equal(p.shown().total,'$41.94');
});

/* one phone per diner, all on the same bill (the demo store is shared between tabs) */
async function payEvenly(local,rail){
 const p=boot({local});
 toPay(p,rail);
 const shown=p.shown(),note=p.restnote();
 p.run('settle()');await flush();
 p.run(rail==='card'?'cardConfirm()':'whishConfirm()');p.timers();await flush();
 const last=p.payments().slice(-1)[0];
 return {p,shown,note,paid:last};
}

test('Evenly with 4: four diners in turn each pay a quarter of $152.50 and the fourth closes the bill',async()=>{
 const local=new Map(),series=[],notes=[];
 for(const rail of ['whish','card','card','whish']){
  const r=await payEvenly(local,rail);
  assert.equal(r.paid.status,'confirmed');
  assert.equal('$'+r.paid.amount.toFixed(2),r.shown.total);                       // charged what was shown
  assert.equal('$'+(r.paid.amount-r.paid.tip).toFixed(2),r.shown.share);
  series.push(r.shown.share);notes.push(r.note);
  var last=r.p;
 }
 // 152.50 / 4 = 38.125: each share rounds to $38.13 and the last takes the $38.11 left
 assert.deepEqual(series,['$38.13','$38.13','$38.13','$38.11']);
 // a two-cent rounding shortfall is not worth a warning: the fourth diner sees the ordinary covering line
 assert.doesNotMatch(notes[3],/^Only /);
 assert.match(notes[3],/covers the available balance/);
 assert.match(notes[0],/^\$114\.37 available for other guests/);
 const b=last.run('Aalayna.checkBalance(CHECK.id)');
 assert.equal(b.availableCents,0);assert.equal(b.remainingCents,0);assert.equal(b.pendingCents,0);
 assert.equal(b.confirmedCents,15250);
});

test('Evenly when less than an even share is left: the share is what is left and the page says so',async()=>{
 const local=new Map();
 // the first diner pays $130 of the bill as a custom amount
 const a=boot({local});
 a.run("go('v-settle')");a.run("mode('amt')");a.$('amt-in').value='130';a.run('calcShare()');
 a.run("go('v-pay')");a.run("pick($('pm-card'),'card')");
 assert.equal(a.shown().share,'$130.00');
 a.run('settle()');await flush();a.run('cardConfirm()');a.timers();await flush();
 assert.equal(a.available(),2250);
 // the next diner chooses Evenly with 4: a quarter would be $38.13, only $22.50 is left
 const r=await payEvenly(local,'card');
 assert.equal(r.shown.share,'$22.50');assert.equal(r.shown.tip,'$2.25');assert.equal(r.shown.total,'$24.75');
 assert.equal(r.note,'Only $22.50 is left on this bill.');
 assert.equal(r.paid.amount,24.75);assert.equal(r.paid.tip,2.25);
 assert.equal(r.p.available(),0);
 // with the bill paid, Evenly offers nothing
 const c=boot({local});
 c.run("go('v-settle')");c.run("mode('even')");
 assert.equal(c.run('share'),0);
 assert.equal(c.restnote(),'No balance is available for another payment. Check any pending cash request with your server.');
});
