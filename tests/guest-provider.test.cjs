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
     guest reads the server's sentence; the Pay button is usable again. */
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
function makeServer(){
 const server={calls:[],settle:[],rails:{card:'fake'},start:null,startError:null};
 const reply=(status,obj)=>({ok:status<300,status,text:async()=>obj==null?'':JSON.stringify(obj)});
 server.fetch=async(url,options)=>{
  options=options||{};const body=options.body?JSON.parse(options.body):null;server.calls.push({url,method:options.method||'GET',headers:options.headers||{},body});
  if(url===FN){
   if(options.headers['x-aalayna-key']!==KEY)return reply(400,{error:'Open a current bill link'});
   if((options.method||'GET')==='GET')return reply(200,{rails:server.rails});
   if(server.startError)return reply(server.startError.status,server.startError.body);
   server.start={body,token:options.headers['x-aalayna-payer']};
   return reply(200,{url:FN+'/fake/checkout?s=token-for-'+body.paymentId,provider:'fake',expiresAt:new Date(Date.now()+600000).toISOString()});
  }
  if(url.endsWith('/rpc/aal_snapshot')){
   if(options.headers['x-aalayna-key']!==KEY)return reply(400,{message:'Open a current bill link.'});
   return reply(200,{version:2,role:'guest',checkId:CHECK.id,rows:[{collection:'aal.checks',id:CHECK.id,body:CHECK}].concat(server.settle.map(s=>({collection:'aal.settle',id:s.id,body:s}))),docs:[{key:'aal.live',body:MENU}]});
  }
  if(url.endsWith('/rpc/aal_mutate')){
   if(body.p_op==='reserve'){
    const row=Object.assign({},body.p_body,{venueId:RID,status:body.p_body.rail==='cash'?'pending':'initiated',currency:'USD',expiresAt:body.p_body.rail==='cash'?null:new Date(Date.now()+600000).toISOString()});
    server.settle.push(row);server.tokens=server.tokens||{};server.tokens[row.id]=body.p_token;return reply(200,row);
   }
   if(body.p_op==='cancel'){const row=server.settle.find(s=>s.id===body.p_body.id);if(!row)return reply(400,{message:'Payment unavailable'});if(row.status==='initiated'||row.status==='pending'){row.status='cancelled';row.cancelled=new Date().toISOString();}return reply(200,row);}
   return reply(200,body.p_body);
  }
  return reply(201,null);
 };
 server.ops=op=>server.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')&&c.body.p_op===op);
 return server;
}
function boot({search,server,session=new Map(),local=new Map()}){
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
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,TypeError,RegExp,Set,Map};
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
 assert.deepEqual(p.assigned,[FN+'/fake/checkout?s=token-for-'+requestId]);
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
 assert.equal(p.run('Aalayna.availableCents?Aalayna.availableCents(CHECK.id):CHECK.totalCents'),1800);
 // the same for a reservation that ran out (a phone that holds the key but no cached copy of the payment)
 server.settle[0].status='expired';
 const q=boot({search:'?venue=Mayda&place=Hamra&live=1&pay='+requestId,server,local:new Map([...first.local].filter(([k])=>k.indexOf('aal.access:')===0))});await flush();
 assert.equal(q.alerts[0],'This payment was not completed. Nothing was charged. You can try again or pay another way.');
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
 assert.deepEqual(p.alerts,['No payment provider is connected for this rail']);
 assert.equal(p.$('paybtn').disabled,false);
 assert.equal(p.run('paymentBusy'),false);
 assert.equal(p.pending(),null);
 assert.notEqual(p.run('paymentRequestId'),requestId);
});
