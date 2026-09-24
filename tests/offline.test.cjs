/* Offline tolerance for the guest app (README "Offline"). The real guest page (store,
   growth rules, table QR script, sync layer and the page's own script) runs against a
   mocked Supabase and a minimal DOM, as in tests/table-sessions.test.cjs, with a
   switchable connection: navigator.onLine, the online/offline events and a server
   that can stop answering. Proves that two failed reads in a row show the banner with
   the time of the last good read and a good read clears it; that a cash request made
   offline is queued in the sync outbox and its receipt says it is saved on this phone,
   then reads "Cash requested." once the outbox has sent it; that a page opened with no
   connection shows the last known bill and can still queue the request; that a
   request the restaurant refuses is never left as "saved"; and that the demo shows
   the banner and keeps working on the phone. sw.js itself needs a browser (see the
   README); this file covers the page and the sync layer. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const html=fs.readFileSync(path.join(root,'guest.html'),'utf8');
const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const TQ=inline.find(s=>s.indexOf('var AalaynaTableQR')>=0),PAGE=inline.find(s=>s.indexOf('function loadMenu')>=0);
const RID=JSON.stringify(['kababji','hamra']),KEY='chk_'+'ab'.repeat(24),LINK='?venue=Kababji&place=Hamra&k='+KEY;
const MENU={version:7,sections:[{id:'grl',name:'Grill',win:'all'}],items:[{id:'k1',sec:'grl',name:'Shish taouk',desc:'',price:9,status:'incomplete',available:true}],at:'2026-09-24T09:00:00.000Z'};
const CHECK={id:'bill-7',venueId:RID,table:7,source:'staff',openedAt:'2026-09-24T10:00:00.000Z',lines:[{id:'k1',q:2,p:18,name:'Shish taouk'}],totalCents:1800,amountUsd:18,revision:1};
const SAVED='Cash request saved on this phone. It reaches the restaurant as soon as you are back online.';
const SENT='Your server will collect the cash. You can close this screen; not marked paid until collection is confirmed.';
const BANNER=/^No connection\. Your bill is as of (\d\d:\d\d); we will send your payment when you are back online\.$/;
const two=n=>(n<10?'0':'')+n,clock=at=>{const d=new Date(at);return two(d.getHours())+':'+two(d.getMinutes());};

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
  // go() clears .on from every view, so the views are real here
  querySelector:()=>el(),querySelectorAll:s=>s==='.view'?views.map(id=>document.getElementById(id)):[],createElement:()=>el(),createTextNode:()=>el(),addEventListener(){},removeEventListener(){},
  body:el('body'),head:el('head'),documentElement:el('html'),activeElement:null};
 return document;
}
/* the mocked shared store: a check for the key, the settlements it has accepted */
function makeServer(){
 const server={down:false,refuse:false,calls:[],settle:[]};
 server.fetch=async(url,options)=>{
  if(server.down)throw new TypeError('Failed to fetch');
  const body=options&&options.body?JSON.parse(options.body):null;server.calls.push({url,body});
  const reply=(status,obj)=>({ok:status<300,status,text:async()=>JSON.stringify(obj)});
  if(url.endsWith('/rpc/aal_snapshot')){
   if(options.headers['x-aalayna-key']!==KEY)return reply(400,{message:'Open a current bill link.'});
   return reply(200,{version:2,role:'guest',checkId:CHECK.id,rows:[{collection:'aal.checks',id:CHECK.id,body:CHECK}].concat(server.settle.map(s=>({collection:'aal.settle',id:s.id,body:s}))),docs:[{key:'aal.live',body:MENU}]});
  }
  if(url.endsWith('/rpc/aal_mutate')){
   if(body.p_op!=='reserve')return reply(200,body.p_body);
   if(server.refuse)return reply(400,{message:'This bill is closed.'});
   const row=Object.assign({},body.p_body,{venueId:RID,status:'pending',requestedAt:new Date().toISOString()});
   server.settle.push(row);return reply(200,row);
  }
  return reply(201,'');
 };
 server.reserves=()=>server.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')&&c.body.p_op==='reserve');
 return server;
}
function boot({search,server,online=true,session=new Map(),local=new Map(),config=true}){
 const store=m=>({getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i],get length(){return m.size;}});
 const intervals=[],listeners={},alerts=[],document=makeDom(),net={onLine:online};
 const window={document,location:{pathname:'/guest.html',search,origin:'https://aalayna.com',href:'https://aalayna.com/guest.html'+search,replace(){}},
  history:{replaceState(s,t,url){window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},
  localStorage:store(local),sessionStorage:store(session),crypto:require('node:crypto').webcrypto,
  navigator:{userAgent:'test',clipboard:{writeText(){}},get onLine(){return net.onLine;}},
  addEventListener(type,f){(listeners[type]=listeners[type]||[]).push(f);},removeEventListener(){},
  requestAnimationFrame(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),getComputedStyle:()=>({getPropertyValue:()=>''}),
  setInterval(f,ms){intervals.push({f,ms});return intervals.length;},clearInterval(){},setTimeout(){return 0;},clearTimeout(){},
  scrollTo(){},alert(m){alerts.push(m);},prompt(){},confirm:()=>true,innerHeight:800,innerWidth:400,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,TypeError,RegExp,Set,Map};
 window.window=window;window.self=window;window.fetch=(u,o)=>server.fetch(u,o);
 const ctx=vm.createContext(window),run=(code,name)=>vm.runInContext(code,ctx,{filename:name});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 if(config)window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 run(TQ,'guest.html#table-qr');
 run(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),'aalayna-sync.js');
 run(PAGE,'guest.html#page');
 const $=id=>document.getElementById(id);
 return {window,document,local,session,alerts,run:c=>run(c,'probe'),$,
  // the phone loses or finds its connection: navigator.onLine flips and the event fires
  setOnline:async(on)=>{net.onLine=on;(listeners[on?'online':'offline']||[]).forEach(f=>f({type:on?'online':'offline'}));await flush();},
  tick:async()=>{intervals.filter(i=>i.ms===4000).forEach(i=>i.f());await flush();},
  banner:()=>({shown:!$('net-banner').hidden,text:$('net-banner').textContent,cls:document.documentElement.classList.contains('aal-offline')}),
  receipt:()=>({on:$('v-done').classList.contains('on'),title:$('result-title').textContent,status:$('payment-status').textContent,amount:$('rc-amt').textContent}),
  outbox:()=>JSON.parse(local.get(run("Aalayna.util.storageKey('aal.outbox')",'probe'))||'{}')};
}

test('two failed reads in a row show the banner with the time of the last good read; a good read clears it',async()=>{
 const server=makeServer(),p=boot({search:LINK,server});await flush();
 assert.equal(p.run('CHECK.id'),CHECK.id);
 assert.equal(p.banner().shown,false);
 const lastRead=p.run('NET.lastReadAt');assert.ok(lastRead,'the good read is timed');
 server.down=true;
 await p.tick();
 assert.equal(p.run('NET.readFailures'),1);
 assert.equal(p.banner().shown,false);                                   // one failed read is not "offline"
 await p.tick();
 assert.equal(p.run('NET.readFailures'),2);
 const b=p.banner();assert.equal(b.shown,true);assert.equal(b.cls,true);
 assert.equal(b.text.match(BANNER)[1],clock(lastRead));                  // as of the last good read
 assert.equal(p.run('Aalayna.sync.job("anything")'),null);
 server.down=false;
 await p.tick();
 assert.equal(p.banner().shown,false);assert.equal(p.banner().cls,false);
 assert.equal(p.run('NET.readFailures'),0);
});

test('a cash request made offline waits in the outbox, says it is saved on this phone, then reads "Cash requested." once sent',async()=>{
 const server=makeServer(),p=boot({search:LINK,server});await flush();
 server.down=true;await p.setOnline(false);
 assert.equal(p.banner().shown,true);                                    // navigator.onLine false is enough
 assert.match(p.banner().text,BANNER);
 p.run("go('v-pay')");
 assert.equal(p.$('paybtn').disabled,false);                             // cash stays payable offline
 const requestId=p.run('paymentRequestId');
 p.run('settle()');await flush();
 const r=p.receipt();
 assert.equal(r.on,true);assert.equal(r.title,'Saved on this phone.');assert.equal(r.status,SAVED);
 assert.equal(r.amount,'$'+(p.run('share')+p.run('tipAmt()')).toFixed(2));
 assert.ok(p.outbox()['op:reserve:'+requestId],'the request is in the outbox');
 assert.equal(p.run('Aalayna.sync.job("op:reserve:'+requestId+'")'),'pending');
 assert.equal(server.reserves().length,0);
 assert.deepEqual(p.alerts,[]);
 p.run('settle()');await flush();                                        // a second tap is not a second request
 assert.equal(Object.keys(p.outbox()).filter(k=>k.indexOf('op:reserve:')===0).length,1);
 // still offline on the next tick: nothing changes
 await p.tick();assert.equal(p.receipt().status,SAVED);
 // back online: the sync layer's online handler reads, then sends the outbox
 server.down=false;await p.setOnline(true);await flush();
 assert.equal(server.reserves().length,1);
 const sent=server.reserves()[0].body.p_body;
 assert.equal(sent.id,requestId);assert.equal(sent.rail,'cash');assert.equal(sent.checkId,CHECK.id);
 assert.equal(p.run('Aalayna.sync.job("op:reserve:'+requestId+'")'),null);
 const done=p.receipt();
 assert.equal(done.title,'Cash requested.');assert.equal(done.status,SENT);
 assert.equal(p.run('lastSettlementId'),requestId);
 assert.equal(p.banner().shown,false);
 assert.equal(p.session.get(p.run('pendingKey()')),undefined);           // nothing left waiting on this phone
});

test('opened with no connection: the last known bill from this phone, the banner, and a cash request that is sent later',async()=>{
 const server=makeServer(),first=boot({search:LINK,server});await flush();
 const lastRead=first.run('NET.lastReadAt');
 // later, a new tab with no connection: no k in the address, the key and the bill are on the phone
 server.down=true;
 const p=boot({search:'?venue=Kababji&place=Hamra',server,online:false,local:first.local});await flush();
 assert.equal(p.window.Aalayna.demoMode(),false);
 assert.equal(p.run('CHECK.id'),CHECK.id);assert.equal(p.run('TABLE'),7);assert.equal(p.run('TOTAL'),18);
 assert.equal(p.run('BILL[0].n'),'Shish taouk');
 assert.deepEqual(p.run('MENU.map(function(m){return m.n;})'),['Shish taouk']);   // the venue's menu, not the demo seed
 assert.equal(p.banner().shown,true);
 assert.equal(p.banner().text.match(BANNER)[1],clock(lastRead));
 assert.notEqual(p.$('payment-status').textContent,'Unable to connect to this bill. Please speak with your server.');
 const requestId=p.run('paymentRequestId');
 p.run('settle()');await flush();
 assert.equal(p.receipt().title,'Saved on this phone.');assert.equal(p.receipt().status,SAVED);
 assert.ok(p.outbox()['op:reserve:'+requestId]);
 // reloaded while still offline: the same receipt, not the pay screen
 const again=boot({search:'?venue=Kababji&place=Hamra',server,online:false,local:p.local,session:p.session});await flush();
 assert.equal(again.receipt().on,true);assert.equal(again.receipt().status,SAVED);
 assert.equal(again.run('paymentBusy'),true);
 server.down=false;await again.setOnline(true);await flush();
 assert.equal(server.reserves().length,1);assert.equal(server.reserves()[0].body.p_body.id,requestId);
 assert.equal(again.receipt().title,'Cash requested.');assert.equal(again.receipt().status,SENT);
 assert.equal(again.banner().shown,false);
});

test('a queued request the restaurant refuses is not left as saved: back to Pay with the reason',async()=>{
 const server=makeServer(),p=boot({search:LINK,server});await flush();
 server.down=true;await p.setOnline(false);
 p.run('settle()');await flush();
 assert.equal(p.receipt().status,SAVED);
 server.down=false;server.refuse=true;await p.setOnline(true);await flush();
 assert.equal(p.$('v-pay').classList.contains('on'),true);
 assert.deepEqual(p.alerts,['The restaurant did not accept this cash request. Please speak with your server.']);
 assert.equal(p.run('paymentBusy'),false);
 assert.equal(p.session.get(p.run('pendingKey()')),undefined);
});

test('demo mode: the banner shows offline and the demo keeps working on the phone',async()=>{
 const server=makeServer();server.down=true;
 const p=boot({search:'',server,online:false});await flush();
 assert.equal(p.window.Aalayna.demoMode(),true);
 assert.equal(p.banner().shown,true);assert.match(p.banner().text,BANNER);
 p.run("kind='cash'");p.run('settle()');await flush();
 assert.equal(p.receipt().title,'Cash requested.');assert.equal(p.receipt().status,SENT);
 assert.equal(server.calls.length,0);
 await p.setOnline(true);
 assert.equal(p.banner().shown,false);
 // and with no shared-store config at all (no sync layer), the same banner
 const q=boot({search:'',server,online:false,config:false});await flush();
 assert.equal(q.window.Aalayna.sync,undefined);
 assert.equal(q.banner().shown,true);
});
