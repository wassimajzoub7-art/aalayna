/* Hosted payment pages on the guest page (T15). The real guest page (store, growth rules,
   table QR script, sync layer and the page's own script) runs against a mocked Supabase and
   a minimal DOM, as in tests/offline.test.cjs, with the payment-start function mocked at
   /functions/v1/payment-start. Proves that:
   - with a bill key the page asks payment-start which rails the bill may pay: a rail with a
     provider is offered (the fake one says "Demo provider · no money moves" under it) and the
     chosen rail moves to it; with no provider the page offers cash only, as before;
   - paying by card reserves the payment on the server (aal_mutate reserve, rail card), then
     asks payment-start for the provider page with the bill key and the payer token and this
     page's address without any credential, keeps a pending note with the rail, and sends the
     browser to the page it names; nothing on the page marks anything paid;
   - back from the provider with pay=<id>: the receipt says "Confirming…" while the snapshot
     still says initiated, the pay parameter leaves the address, and once the server says
     confirmed (the webhook's work) the receipt says Shukran, confirmed by the demo provider;
   - a payment the provider declined sends the guest back to the pay screen, told that
     nothing was charged, with the balance free again;
   - when no page can be opened the reservation is cancelled with the payer token and the
     guest reads a plain sentence for the function's answer; the Pay button is usable again;
   - "Confirming…" is never a dead end (review fix 2): Cancel this payment, the page's own
     timer, and a payment the snapshot never shows; the server's clock decides expiry (fix 4);
     a card reserve whose answer is lost is never queued nor labelled cash (fix 3); a double tap
     opens one provider session (fix 5); the rails come back after a failed read (fix 8); a
     row marked demo: true reads as the demo provider (fix 7); payment errors in French. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=async(n=40)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const html=fs.readFileSync(path.join(root,'guest.html'),'utf8');
const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const TQ=inline.find(s=>s.indexOf('var AalaynaTableQR')>=0),PAGE=inline.find(s=>s.indexOf('function loadMenu')>=0);
const RID=JSON.stringify(['mayda','hamra']),KEY='chk_'+'ab'.repeat(24),LINK='?venue=Mayda&place=Hamra&k='+KEY;
const BASE='https://mock.invalid',FN=BASE+'/functions/v1/payment-start';
const MENU={version:7,sections:[{id:'grl',name:'Grill',win:'all'}],items:[{id:'k1',sec:'grl',name:'Shish taouk',desc:'',price:9,status:'incomplete',available:true}],at:'2026-09-24T09:00:00.000Z'};
const CHECK={id:'bill-7',venueId:RID,table:7,source:'staff',openedAt:'2026-09-24T10:00:00.000Z',lines:[{id:'k1',q:2,p:18,name:'Shish taouk'}],totalCents:1800,amountUsd:18,revision:1};
const CONFIRMING='Waiting for the payment provider to confirm. This usually takes a few seconds; keep this page open.';
const FAKE_OK='Confirmed by the demo provider · no money moved.';
const NOT_DONE='This payment was not completed here. If the payment provider shows a charge, tell your server. You can try again or pay another way.';
const DIGITAL_ONLINE='Paying by card or Whish needs the connection. Try again once you are back online.';

function makeDom(){
 const byId=new Map();
 function el(id){
  const cls=new Set(),kids=[];
  return {id:id||'',style:{setProperty(){}},dataset:{},innerHTML:'',textContent:'',value:'',disabled:false,checked:false,hidden:false,children:kids,childNodes:kids,
   classList:{add:(...c)=>c.forEach(x=>cls.add(x)),remove:(...c)=>c.forEach(x=>cls.delete(x)),toggle:(c,f)=>{const on=f===undefined?!cls.has(c):!!f;on?cls.add(c):cls.delete(c);return on;},contains:c=>cls.has(c)},
   appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},prepend(...c){kids.unshift(...c);},insertBefore(c){kids.push(c);return c;},removeChild(c){return c;},remove(){},replaceChildren(){kids.length=0;},
   setAttribute(k,v){this['@'+k]=v;},getAttribute(k){return this['@'+k]==null?null:this['@'+k];},removeAttribute(){},hasAttribute(){return false;},addEventListener(){},removeEventListener(){},
   // the rail's description line is the one child the test reads
   querySelector:(s)=>{if(s==='.pd'){if(!this_pd.has(id))this_pd.set(id,el(id+'.pd'));return this_pd.get(id);}return el();},querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:0,height:0,right:0,bottom:0}),getClientRects:()=>[],
   focus(){},blur(){},click(){},scrollTo(){},scrollIntoView(){},closest:()=>null,matches:()=>false,contains:()=>false,
   offsetWidth:0,offsetHeight:0,offsetLeft:0,offsetTop:0,scrollTop:0,scrollHeight:0,clientHeight:0,clientWidth:0,parentNode:null,parentElement:null,firstChild:null,lastChild:null,nextSibling:null};
 }
 const this_pd=new Map();
 const views=['v-land','v-menu','v-bill','v-settle','v-pay','v-done'];
 const document={visibilityState:'visible',cookie:'',readyState:'complete',
  getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  querySelector:()=>el(),querySelectorAll:s=>s==='.view'?views.map(id=>document.getElementById(id)):s==='.pm'?['pm-whish','pm-card','pm-cash'].map(id=>document.getElementById(id)):[],createElement:()=>el(),createTextNode:()=>el(),addEventListener(){},removeEventListener(){},
  body:el('body'),head:el('head'),documentElement:el('html'),activeElement:null};
 return document;
}
/* the mocked shared store and the mocked payment-start function */
/* the clock: the server's runs at real time plus shift; a phone's at that plus its skew (a
   phone running fast). Advancing shift moves both, as time passing does. */
function makeClock(skew=0){
 const c={shift:0,skew};
 class D extends Date{constructor(...a){if(a.length)super(...a);else super(Date.now()+c.shift+c.skew);}static now(){return Date.now()+c.shift+c.skew;}}
 c.Date=D;c.server=()=>Date.now()+c.shift;
 return c;
}
function makeServer(){
 const server={calls:[],settle:[],rails:{card:'fake'},start:null,startError:null,clock:null,noClock:false,down:false,railsDown:0,startDown:false,reserveLost:false,cancelRefuse:null};
 const reply=(status,obj)=>({ok:status<300,status,text:async()=>obj==null?'':JSON.stringify(obj)});
 server.fetch=async(url,options)=>{
  options=options||{};const body=options.body?JSON.parse(options.body):null;server.calls.push({url,method:options.method||'GET',headers:options.headers||{},body});
  if(server.down)throw new TypeError('Failed to fetch');
  if(url.endsWith('/rpc/aal_now')){
   if(server.noClock)return reply(404,{code:'PGRST202',message:'Could not find the function public.aal_now'});
   return reply(200,new Date(server.clock?server.clock.server():Date.now()).toISOString());
  }
  if(url===FN){
   if(options.headers['x-aalayna-key']!==KEY)return reply(400,{error:'Open a current bill link'});
   if((options.method||'GET')==='GET'){if(server.railsDown>0){server.railsDown--;throw new TypeError('Failed to fetch');}return reply(200,{rails:server.rails});}
   if(server.startDown)throw new TypeError('Failed to fetch');
   if(server.startError)return reply(server.startError.status,server.startError.body);
   server.start={body,token:options.headers['x-aalayna-payer']};
   return reply(200,{url:'https://aalayna.com/pay-demo.html?s=token-for-'+body.paymentId,provider:'fake',expiresAt:new Date(Date.now()+600000).toISOString()});
  }
  if(url.endsWith('/rpc/aal_snapshot')){
   if(options.headers['x-aalayna-key']!==KEY)return reply(400,{message:'Open a current bill link.'});
   return reply(200,{version:2,role:'guest',checkId:CHECK.id,rows:[{collection:'aal.checks',id:CHECK.id,body:CHECK}].concat(server.settle.map(s=>({collection:'aal.settle',id:s.id,body:s}))),docs:[{key:'aal.live',body:MENU}]});
  }
  if(url.endsWith('/rpc/aal_mutate')){
   if(body.p_op==='reserve'){
    const row=Object.assign({},body.p_body,{venueId:RID,status:body.p_body.rail==='cash'?'pending':'initiated',currency:'USD',expiresAt:body.p_body.rail==='cash'?null:new Date(Date.now()+600000).toISOString()});
    server.settle.push(row);server.tokens=server.tokens||{};server.tokens[row.id]=body.p_token;
    // the reserve lands, its answer does not (the connection dropped on the way back)
    if(server.reserveLost){server.reserveLost=false;throw new TypeError('Failed to fetch');}
    return reply(200,row);
   }
   if(body.p_op==='cancel'){const row=server.settle.find(s=>s.id===body.p_body.id);if(!row)return reply(400,{message:'Payment unavailable'});
    if(server.tokens[row.id]!==body.p_token)return reply(400,{message:'Wrong payer token'});
    if(server.cancelRefuse&&row.status==='confirmed')return reply(400,{message:server.cancelRefuse});if(row.status==='initiated'||row.status==='pending'){row.status='cancelled';row.cancelled=new Date().toISOString();}return reply(200,row);}
   return reply(200,body.p_body);
  }
  return reply(201,null);
 };
 server.ops=op=>server.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')&&c.body.p_op===op);
 return server;
}
function boot({search,server,session=new Map(),local=new Map(),clock=null}){
 const store=m=>({getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i],get length(){return m.size;}});
 const intervals=[],listeners={},alerts=[],assigned=[],replaced=[],document=makeDom();
 const window={document,location:{pathname:'/guest.html',search,origin:'https://aalayna.com',href:'https://aalayna.com/guest.html'+search,replace(){},assign(u){assigned.push(u);}},
  history:{replaceState(s,t,url){replaced.push(url);window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},
  localStorage:store(local),sessionStorage:store(session),crypto:require('node:crypto').webcrypto,
  navigator:{userAgent:'test',clipboard:{writeText(){}},onLine:true},
  addEventListener(type,f){(listeners[type]=listeners[type]||[]).push(f);},removeEventListener(){},
  requestAnimationFrame(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),getComputedStyle:()=>({getPropertyValue:()=>''}),
  setInterval(f,ms){intervals.push({f,ms});return intervals.length;},clearInterval(){},setTimeout(){return 0;},clearTimeout(){},
  scrollTo(){},alert(m){alerts.push(m);},prompt(){},confirm:()=>true,innerHeight:800,innerWidth:400,
  URLSearchParams,URL,Intl,Date:clock?clock.Date:Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,TypeError,RegExp,Set,Map};
 window.window=window;window.self=window;window.fetch=(u,o)=>server.fetch(u,o);
 const ctx=vm.createContext(window),run=(code,name)=>vm.runInContext(code,ctx,{filename:name});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 window.AalaynaConfig={supabaseUrl:BASE,anonKey:'public-anon'};
 run(TQ,'guest.html#table-qr');
 run(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),'aalayna-sync.js');
 run(PAGE,'guest.html#page');
 const $=id=>document.getElementById(id);
 return {window,document,local,session,alerts,assigned,replaced,run:c=>run(c,'probe'),$,
  tick:async()=>{intervals.filter(i=>i.ms===4000).forEach(i=>i.f());await flush();},
  // the guest page's own timer (the confirming state re-reads itself), without any page event
  watch:async()=>{intervals.filter(i=>i.ms===2000).forEach(i=>i.f());await flush();},
  fire:async type=>{(listeners[type]||[]).forEach(f=>f({type}));await flush();},
  intervals,
  rails:()=>({whish:!$('pm-whish').hidden,card:!$('pm-card').hidden,note:!$('rails-note').hidden,cardDesc:$('pm-card').querySelector('.pd').textContent,kind:run('kind','probe')}),
  receipt:()=>({on:$('v-done').classList.contains('on'),pay:$('v-pay').classList.contains('on'),title:$('result-title').textContent,status:$('payment-status').textContent,amount:$('rc-amt').textContent,method:$('rc-method').textContent}),
  pending:()=>{const raw=session.get(run('pendingKey()','probe'));return raw?JSON.parse(raw):null;}};
}

test('with a provider for card the page offers card (as the demo provider) and moves the chosen rail to it; with none, cash only',async()=>{
 const server=makeServer(),p=boot({search:LINK,server});await flush();
 assert.equal(p.run('CHECK.id'),CHECK.id);
 const r=p.rails();
 assert.deepEqual([r.card,r.whish,r.note],[true,false,false]);
 assert.equal(r.cardDesc,'Demo provider · no money moves');
 assert.equal(r.kind,'card');                                            // whish, the default, is not offered
 const ask=server.calls.find(c=>c.url===FN);
 assert.equal(ask.method,'GET');assert.equal(ask.headers['x-aalayna-key'],KEY);assert.equal(ask.headers['x-aalayna-payer'],undefined);
 const none=makeServer();none.rails={};
 const q=boot({search:LINK,server:none});await flush();
 assert.deepEqual([q.rails().card,q.rails().whish,q.rails().note,q.rails().kind],[false,false,true,'cash']);
 const both=makeServer();both.rails={card:'fake',whish:'whish'};
 const b=boot({search:LINK,server:both});await flush();
 assert.deepEqual([b.rails().card,b.rails().whish,b.rails().kind],[true,true,'whish']);
 assert.equal(b.$('pm-whish').querySelector('.pd').textContent,'Opens with the amount filled in');
});

test('paying by card reserves on the server, asks payment-start for the page with the key, the payer token and a clean return address, and goes there',async()=>{
 const server=makeServer(),p=boot({search:LINK,server});await flush();
 p.run("go('v-pay')");
 const requestId=p.run('paymentRequestId'),shown=p.run('share')+p.run('tipAmt()');
 p.run('settle()');await flush();
 assert.equal(server.ops('reserve').length,1);
 const sent=server.ops('reserve')[0].body;
 assert.deepEqual([sent.p_body.id,sent.p_body.rail,sent.p_body.checkId,sent.p_body.amount],[requestId,'card',CHECK.id,shown]);
 assert.ok(server.start,'payment-start was asked');
 assert.deepEqual(server.start.body,{paymentId:requestId,returnUrl:'https://aalayna.com/guest.html?venue=Mayda&place=Hamra&live=1'});
 assert.equal(server.start.token,sent.p_token);                          // the same payer token as the reserve
 assert.ok(server.start.token.length>=32);
 assert.deepEqual(p.assigned,['https://aalayna.com/pay-demo.html?s=token-for-'+requestId]);
 const pend=p.pending();
 assert.deepEqual([pend.requestId,pend.rail,pend.amount],[requestId,'card',shown]);
 assert.equal(p.run('paymentBusy'),true);
 assert.equal(p.receipt().on,false);                                     // nothing is shown as paid
 assert.deepEqual(p.alerts,[]);
 assert.equal(server.ops('cancel').length,0);
});

test('back from the provider with pay=<id>: Confirming… while initiated, the parameter leaves the address, Shukran once the server says confirmed',async()=>{
 const server=makeServer(),first=boot({search:LINK,server});await flush();
 first.run("go('v-pay')");const requestId=first.run('paymentRequestId');first.run('settle()');await flush();
 assert.equal(server.settle[0].status,'initiated');
 // the provider brings the browser back; this tab's sessionStorage may be gone (a wallet app, another tab)
 const p=boot({search:'?venue=Mayda&place=Hamra&live=1&pay='+requestId,server,local:first.local});await flush();
 assert.ok(p.replaced.length&&p.replaced[p.replaced.length-1].indexOf('pay=')<0,'pay= is dropped from the address');
 assert.equal(p.window.location.search,'?venue=Mayda&place=Hamra&live=1');
 let r=p.receipt();
 assert.equal(r.on,true);assert.equal(r.title,'Confirming…');assert.equal(r.status,CONFIRMING);
 assert.equal(r.amount,'$'+server.settle[0].amount.toFixed(2));assert.equal(r.method,'Card');
 assert.equal(p.run('lastSettlementId'),requestId);
 assert.equal(p.run('paymentBusy'),true);
 // the webhook confirmed it meanwhile: the next read says so
 Object.assign(server.settle[0],{status:'confirmed',confirmedAt:new Date().toISOString(),externalRef:'fake-'+requestId+'-0123456789abcdef'});
 await p.tick();
 r=p.receipt();
 assert.equal(r.title,'Shukran.');assert.equal(r.status,FAKE_OK);
 assert.equal(p.pending(),null);
 assert.deepEqual(p.alerts,[]);
 // a real provider's reference reads as confirmed by the provider
 const q=boot({search:'?venue=Mayda&place=Hamra&live=1&pay='+requestId,server,local:first.local});await flush();
 server.settle[0].externalRef='WHISH-99';await q.tick();
 assert.equal(q.receipt().status,'Confirmed by the payment provider.');
});

test('a declined payment sends the guest back to the pay screen with the balance free and nothing charged',async()=>{
 const server=makeServer(),first=boot({search:LINK,server});await flush();
 first.run("go('v-pay')");const requestId=first.run('paymentRequestId');first.run('settle()');await flush();
 server.settle[0].status='failed';
 const p=boot({search:'?venue=Mayda&place=Hamra&live=1&pay='+requestId,server,local:first.local,session:first.session});await flush();
 assert.equal(p.receipt().pay,true);assert.equal(p.receipt().on,false);
 assert.deepEqual(p.alerts,['This payment was declined. Nothing was charged. You can try again or pay another way.']);
 assert.equal(p.pending(),null);
 assert.equal(p.run('paymentBusy'),false);
 assert.notEqual(p.run('paymentRequestId'),requestId);                  // the next tap is a fresh request
 assert.equal(p.run("Aalayna.checkBalance('"+CHECK.id+"').availableCents"),1800);
 // the same for a reservation that ran out (a phone that holds the key but no cached copy of the payment)
 server.settle[0].status='expired';
 const q=boot({search:'?venue=Mayda&place=Hamra&live=1&pay='+requestId,server,local:new Map([...first.local].filter(([k])=>k.indexOf('aal.access:')===0))});await flush();
 assert.equal(q.alerts[0],NOT_DONE);                                    // the page cannot know what the provider did
});

test('when no page can be opened the reservation is cancelled with the payer token and the guest reads why',async()=>{
 const server=makeServer(),p=boot({search:LINK,server});await flush();
 server.startError={status:409,body:{error:'No payment provider is connected for this rail',status:'no_provider'}};
 p.run("go('v-pay')");const requestId=p.run('paymentRequestId');p.run('settle()');await flush();
 assert.equal(server.ops('reserve').length,1);
 assert.deepEqual(p.assigned,[]);
 assert.equal(server.ops('cancel').length,1);
 assert.deepEqual([server.ops('cancel')[0].body.p_body.id,server.ops('cancel')[0].body.p_token],[requestId,server.ops('reserve')[0].body.p_token]);
 assert.equal(server.settle[0].status,'cancelled');
 assert.deepEqual(p.alerts,['Card and Whish are not available for this bill right now. Pay another way, or ask your server.']);   // never the function's own sentence
 assert.equal(p.$('paybtn').disabled,false);
 assert.equal(p.run('paymentBusy'),false);
 assert.equal(p.pending(),null);
 assert.notEqual(p.run('paymentRequestId'),requestId);
});

/* ---- review fixes ---- */
const BACK_TO=id=>'?venue=Mayda&place=Hamra&live=1&pay='+id;
const free=p=>p.run("Aalayna.checkBalance('"+CHECK.id+"').availableCents");
/* tap Pay by card on one page, then come back from the provider on a second (same phone) */
async function payThenReturn({server=makeServer(),clock=null,keepSession=true}={}){
 if(clock)server.clock=clock;
 const first=boot({search:LINK,server,clock});await flush();
 first.run("go('v-pay')");const requestId=first.run('paymentRequestId');first.run('settle()');await flush();
 assert.equal(first.assigned.length,1);
 const p=boot({search:BACK_TO(requestId),server,clock,local:first.local,session:keepSession?first.session:new Map()});await flush();
 return {server,first,p,requestId};
}

test('Back from the provider without paying: Confirming… offers Cancel this payment, which cancels with the payer token and frees the balance',async()=>{
 const {server,p,requestId}=await payThenReturn();
 assert.equal(p.receipt().title,'Confirming…');
 assert.equal(p.$('confirm-cancel').hidden,false);
 assert.equal(p.$('confirm-cancel').textContent,'Cancel this payment');
 assert.ok(free(p)<1800,'held while initiated');
 p.run('cancelConfirming()');await flush();
 const cancel=server.ops('cancel');
 assert.equal(cancel.length,1);
 assert.deepEqual([cancel[0].body.p_body.id,cancel[0].body.p_token],[requestId,server.tokens[requestId]]);
 assert.equal(server.settle[0].status,'cancelled');
 assert.equal(p.receipt().pay,true);assert.equal(p.receipt().on,false);
 assert.deepEqual(p.alerts,[NOT_DONE]);
 assert.equal(free(p),1800);
 assert.equal(p.pending(),null);assert.equal(p.run('paymentBusy'),false);
 assert.notEqual(p.run('paymentRequestId'),requestId);
 // the same from a browser whose sessionStorage did not survive the provider (only pay= is known)
 const again=await payThenReturn({keepSession:false});
 assert.equal(again.p.receipt().title,'Confirming…');assert.equal(again.p.$('confirm-cancel').hidden,false);
 again.p.run('cancelConfirming()');await flush();
 assert.equal(again.server.settle[0].status,'cancelled');assert.equal(again.p.receipt().pay,true);
});

test('a cancel that reaches the server after the provider confirmed loses: the guest sees the confirmed receipt',async()=>{
 for(const refuse of [null,'Payment already confirmed']){
  const {server,p}=await payThenReturn();
  server.cancelRefuse=refuse;
  Object.assign(server.settle[0],{status:'confirmed',confirmedAt:new Date().toISOString(),demo:true});   // the callback landed; this page has not read it yet
  assert.equal(p.receipt().title,'Confirming…');
  p.run('cancelConfirming()');await flush();
  assert.equal(server.settle[0].status,'confirmed',String(refuse));
  const r=p.receipt();
  assert.equal(r.on,true);assert.equal(r.title,'Shukran.');assert.equal(r.status,FAKE_OK);
  assert.equal(p.$('confirm-cancel').hidden,true);
  assert.deepEqual(p.alerts,[],String(refuse));
 }
});

test('ten minutes later the confirming state re-reads itself on its timer and returns to Pay by the server clock, with no focus or page event',async()=>{
 const clock=makeClock(0);
 const {server,p}=await payThenReturn({clock});
 assert.equal(typeof p.run('Aalayna.sync.clockOffset()'),'number');
 assert.ok(p.intervals.some(i=>i.ms===2000),'the page has its own timer');
 await p.tick();await p.watch();
 assert.equal(p.receipt().title,'Confirming…');
 // eleven minutes pass; the server expires the payment without writing (the row is unchanged)
 clock.shift=11*60000;
 const before=JSON.stringify(server.settle[0]);
 await p.tick();                                                         // the poll reads the same snapshot: no store write
 assert.equal(JSON.stringify(server.settle[0]),before);
 assert.equal(p.receipt().on,true,'nothing changed without the timer');
 await p.watch();
 assert.equal(p.receipt().pay,true);assert.equal(p.receipt().on,false);
 assert.deepEqual(p.alerts,[NOT_DONE]);
 assert.equal(free(p),1800);assert.equal(p.pending(),null);
});

test('a pay= for a payment the snapshot does not hold: given up after two good reads, and a reload does not bring it back',async()=>{
 const server=makeServer(),first=boot({search:LINK,server});await flush();
 const p=boot({search:BACK_TO('request-nobody-made'),server,local:first.local,session:first.session});await flush();
 assert.equal(p.receipt().title,'Confirming…');
 assert.equal(p.$('confirm-cancel').hidden,false);
 await p.tick();await p.watch();
 assert.equal(p.receipt().pay,true);assert.equal(p.receipt().on,false);
 assert.deepEqual(p.alerts,[NOT_DONE]);
 assert.equal(p.pending(),null);
 assert.equal(p.session.get(p.run('returnKey()')),undefined);
 const again=boot({search:'?venue=Mayda&place=Hamra&live=1',server,local:first.local,session:p.session});await flush();
 assert.equal(again.receipt().on,false);
 assert.equal(server.ops('cancel').length,0);
});

test('C10: a card reserve whose answer is lost on the way is never queued, never labelled cash, and its reservation is released',async()=>{
 const server=makeServer(),p=boot({search:LINK,server});await flush();
 server.reserveLost=true;
 p.run("go('v-pay')");const requestId=p.run('paymentRequestId');p.run('settle()');await flush();
 assert.equal(server.ops('reserve').length,1);
 assert.deepEqual(p.alerts,[DIGITAL_ONLINE]);
 assert.equal(p.run('Aalayna.sync.state().pending'),0,'nothing in the outbox');
 assert.equal(p.run("Aalayna.sync.job('op:reserve:"+requestId+"')"),null);
 assert.equal(p.pending(),null,'no pending note, so no "cash request saved" receipt');
 assert.equal(server.calls.filter(c=>c.url===FN&&c.method==='POST').length,0);
 assert.deepEqual(p.assigned,[]);
 assert.equal(server.ops('cancel').length,1);assert.equal(server.ops('cancel')[0].body.p_token,server.tokens[requestId]);
 assert.equal(server.settle[0].status,'cancelled');
 assert.equal(p.run('paymentBusy'),false);assert.equal(p.receipt().pay,true);
 // the connection comes back: nothing is sent again; a reload shows no cash receipt
 await p.tick();await p.tick();
 assert.equal(server.ops('reserve').length,1);
 const q=boot({search:'?venue=Mayda&place=Hamra&live=1',server,local:p.local,session:p.session});await flush();
 assert.equal(q.receipt().on,false);assert.notEqual(q.receipt().method,'Cash');
});

test('C9: a phone fifteen minutes fast is not told its payment expired, with a server offset and without one',async()=>{
 // with aal_now: the offset is measured and expiry is judged by server time
 const clock=makeClock(15*60000);
 const {server,p}=await payThenReturn({clock});
 const off=p.run('Aalayna.sync.clockOffset()');
 assert.ok(Math.abs(off+15*60000)<2000,'offset about -15 min: '+off);
 assert.equal(p.receipt().title,'Confirming…');assert.deepEqual(p.alerts,[]);
 await p.watch();assert.equal(p.receipt().title,'Confirming…');
 assert.equal(p.run('Aalayna.settlementStatus(Aalayna.settlements()[0])'),'initiated');
 assert.equal(p.run("Aalayna.settlementStatus({status:'initiated',rail:'card',expiresAt:new Date(Date.now()-1000).toISOString()})"),'initiated');   // the fast phone's past is the server's future
 server.settle[0].status='confirmed';server.settle[0].demo=true;await p.tick();
 assert.equal(p.receipt().title,'Shukran.');
 // no aal_now on the server: with no offset known, an initiated payment is not called expired
 const blind=makeServer();blind.noClock=true;
 const b=await payThenReturn({server:blind,clock:makeClock(15*60000)});
 assert.equal(b.p.run('Aalayna.sync.clockOffset()'),null);
 assert.equal(b.p.receipt().title,'Confirming…');assert.deepEqual(b.p.alerts,[]);
 await b.p.watch();assert.equal(b.p.receipt().title,'Confirming…');
 assert.equal(b.p.$('confirm-cancel').hidden,false);                     // the way out stays
 assert.ok(blind.calls.filter(c=>c.url.endsWith('/rpc/aal_now')).length<=2,'a missing aal_now is not hammered');
 // local demo mode has no server: the device clock decides, as before
 const demo=boot({search:'?venue=Mayda&place=Hamra',server:makeServer()});await flush();
 assert.equal(demo.run('!!(Aalayna.sync&&Aalayna.sync.enabled)'),false);
 assert.equal(demo.run("Aalayna.settlementStatus({status:'initiated',rail:'card',expiresAt:new Date(Date.now()-1000).toISOString()})"),'expired');
});

test('a double tap on Pay makes one reserve, one payment-start call and one trip to the provider',async()=>{
 const server=makeServer(),p=boot({search:LINK,server});await flush();
 p.run("go('v-pay')");p.run('settle();settle();');await flush();
 assert.equal(server.ops('reserve').length,1);
 assert.equal(server.calls.filter(c=>c.url===FN&&c.method==='POST').length,1);
 assert.equal(p.assigned.length,1);
});

test('card comes back after a failed rails read: when the connection returns, and after a page opened offline reads again',async()=>{
 const server=makeServer();server.railsDown=1;
 const p=boot({search:LINK,server});await flush();
 assert.deepEqual([p.rails().card,p.rails().note,p.rails().kind],[false,true,'cash']);
 await p.fire('online');
 assert.deepEqual([p.rails().card,p.rails().note,p.rails().kind],[true,false,'card']);
 const gets=()=>server.calls.filter(c=>c.url===FN&&c.method==='GET').length;
 assert.equal(gets(),2);
 await p.fire('online');assert.equal(gets(),2,'no new request once the rails are known');
 // opened with a dead connection: nothing loads; the first good read brings the rails
 const dead=makeServer();dead.down=true;
 const q=boot({search:LINK,server:dead});await flush();
 assert.equal(q.rails().card,false);
 await q.tick();assert.equal(q.rails().card,false);
 dead.down=false;await q.tick();await flush();
 assert.equal(q.rails().card,true);
});

test('a confirmed row marked demo: true, without externalRef, reads as the demo provider; without the mark, as the provider',async()=>{
 const {server,p,first,requestId}=await payThenReturn();
 Object.assign(server.settle[0],{status:'confirmed',confirmedAt:new Date().toISOString(),demo:true});
 delete server.settle[0].externalRef;
 await p.tick();
 assert.equal(p.receipt().title,'Shukran.');assert.equal(p.receipt().status,FAKE_OK);
 assert.equal(p.$('confirm-cancel').hidden,true);
 server.settle[0].demo=false;
 const q=boot({search:BACK_TO(requestId),server,local:first.local});await flush();await q.tick();
 assert.equal(q.receipt().status,'Confirmed by the payment provider.');
});

test('payment errors read in French: no provider, a provider down, no answer, and card needing the connection; English never shows Failed to fetch',async()=>{
 const server=makeServer(),p=boot({search:LINK+'&lang=fr',server});await flush();
 assert.equal(p.run('LANG'),'fr');
 const tryPay=async()=>{p.run("go('v-pay')");p.run('settle()');await flush();return p.alerts[p.alerts.length-1];};
 server.startError={status:409,body:{error:'No payment provider is connected for this rail',status:'no_provider'}};
 assert.equal(await tryPay(),'La carte et Whish ne sont pas disponibles pour cette addition pour le moment. Payez autrement, ou demandez à votre serveur.');
 server.startError={status:502,body:{error:'The payment provider could not be reached; try again'}};
 assert.equal(await tryPay(),'La page de paiement ne peut pas s’ouvrir pour le moment. Réessayez dans un instant, ou payez autrement.');
 server.startError={status:501,body:{error:'whish: createPayment is not implemented yet (see INTEGRATIONS.md)'}};
 assert.equal(await tryPay(),'La carte et Whish ne sont pas disponibles pour cette addition pour le moment. Payez autrement, ou demandez à votre serveur.');
 server.startError=null;server.startDown=true;
 assert.equal(await tryPay(),'La page de paiement n’a pas pu s’ouvrir. Vérifiez votre connexion et réessayez.');
 server.startDown=false;p.window.navigator.onLine=false;
 assert.equal(await tryPay(),'Le paiement par carte ou Whish demande une connexion. Réessayez une fois de retour en ligne.');
 assert.equal(server.ops('cancel').length,4);                            // every reservation that opened no page was released
 const en=boot({search:LINK,server:Object.assign(makeServer(),{startDown:true})});await flush();
 en.run("go('v-pay')");en.run('settle()');await flush();
 assert.deepEqual(en.alerts,['The payment page could not be opened. Check your connection and try again.']);
 // the French and Arabic tables carry every new string
 for(const k of ['providerNotDone','cancelPayment','cancelling','errDigitalOnline','errProviderNet','errProviderDown','errNoProvider','errProviderStart'])
  for(const l of ['en','fr','ar'])assert.equal(typeof p.run('STR.'+l+'.'+k),'string',l+'.'+k);
});
