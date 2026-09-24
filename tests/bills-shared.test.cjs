/* Bill entry in shared mode (a venue key): the real store, growth rules and sync
   layer against a mocked Supabase. Proves that owner bill saves go through
   aal_mutate open_check / update_check with the right body, that the local store
   follows the returned row, and that a chk_ guest finds its one check. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=()=>new Promise(r=>setImmediate(r));
const LINES=[{id:'i07',q:1,p:16,name:'Mixed Grill platter'},{id:'i06',q:1,p:5,name:'Hummus Beiruti'},{id:'i06',q:1,p:5,name:'Hummus Beiruti'},{id:'i14',q:4,p:10,name:'Lebanese coffee'}];
const plain=x=>JSON.parse(JSON.stringify(x));
/* server: a minimal stand-in that stores what aal_mutate returns; the real rules are SQL */
async function boot({page='dashboard.html',key='own_aaaaaaaaaaaa',server}={}){
 server=server||{rows:{},checkId:null,calls:[]};
 const map=new Map(),storage={getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};
 const window={location:{pathname:'/'+page,search:'?k='+key},history:{replaceState(s,t,url){window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},addEventListener(){},localStorage:storage,crypto:require('node:crypto').webcrypto};
 const role=key.indexOf('own_')===0?'owner':'guest';
 const fetch=async(url,options)=>{
  const body=options.body?JSON.parse(options.body):null;
  if(url.endsWith('/rpc/aal_snapshot')){
   const rows=Object.values(server.rows).filter(r=>role==='owner'||(r.collection==='aal.checks'&&r.id===server.checkId));
   return {ok:true,status:200,text:async()=>JSON.stringify({version:2,role,checkId:role==='owner'?null:server.checkId,rows,docs:[]})};
  }
  if(url.endsWith('/rpc/aal_mutate')){
   server.calls.push(body);const rid=body.p_rid,b=body.p_body;let row;
   if(body.p_op==='open_check'){const {sessionId,deviceId,...rest}=b;row={...rest,venueId:rid,source:'staff',openedAt:'2026-09-24T10:00:00.000Z',revision:1};}
   else if(body.p_op==='update_check'){const old=server.rows['aal.checks:'+b.checkId].body;row={...old,lines:b.lines,totalCents:b.lines.reduce((n,l)=>n+Math.round(l.p*100),0),revision:old.revision+1,updatedAt:'2026-09-24T10:05:00.000Z',source:'staff',lastRequestId:b.requestId};row.amountUsd=row.totalCents/100;}
   else return {ok:false,status:400,text:async()=>JSON.stringify({message:'Unknown operation'})};
   server.rows['aal.checks:'+row.id]={collection:'aal.checks',id:row.id,body:row,updated_at:'now'};
   return {ok:true,status:200,text:async()=>JSON.stringify(row)};
  }
  return {ok:true,status:201,text:async()=>''};
 };
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,URL,fetch,setInterval(){},console});
 for(const f of ['aalayna-store.js','restaurant-growth.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx);
 window.document={visibilityState:'visible',cookie:'',body:{appendChild(){}},createElement:()=>({style:{},setAttribute(){},append(){}}),addEventListener(){}};
 window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 vm.runInContext(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),ctx);
 const a=window.Aalayna;await a.sync.ready;await flush();
 return {a,server,window};
}

test('an owner bill with lines opens through aal_mutate open_check and lands in the local store',async()=>{
 const {a,server,window}=await boot();
 assert.equal(window.location.search,'');                  // the key left the address
 assert.equal(a.demoMode(),false);                         // ...and the page is still live, not demo
 const c=await a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 const call=server.calls[0];
 assert.equal(call.p_op,'open_check');assert.equal(call.p_rid,a.venueId());
 assert.equal(call.p_body.table,5);assert.equal(call.p_body.totalCents,3600);assert.equal(call.p_body.amountUsd,36);
 assert.deepEqual(plain(call.p_body.lines),[{id:'i07',q:1,p:16,name:'Mixed Grill platter'},{id:'i06',q:2,p:10,name:'Hummus Beiruti'},{id:'i14',q:4,p:10,name:'Lebanese coffee'}]);
 assert.equal(c.source,'staff');assert.equal(a.openCheckFor(5).id,c.id);
 assert.equal(a.check(5).length,3);assert.equal(a.checkTotal(5),36);
 // no local order_placed: the server appends it, so it is never counted twice
 assert.equal(a.events().filter(e=>e.eventType==='order_placed').length,0);
 // a POS total without lines keeps upstream's path
 await a.openServiceCheck({table:6,total:12.5,lines:[]});
 assert.equal(server.calls[1].p_body.totalCents,1250);assert.deepEqual(plain(server.calls[1].p_body.lines),[]);
});

test('an owner bill edit goes through aal_mutate update_check with the base revision and the folded lines',async()=>{
 const {a,server}=await boot();
 const c=await a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 const u=await a.updateServiceCheck(c.id,LINES.concat([{id:'i13',q:1,p:2,name:'Espresso'}]));
 const call=server.calls[1];
 assert.equal(call.p_op,'update_check');assert.equal(call.p_body.checkId,c.id);assert.equal(call.p_body.baseRevision,1);
 assert.ok(call.p_body.requestId);assert.equal(call.p_body.lines.length,4);assert.equal(call.p_body.lines[1].q,2);
 assert.equal(u.revision,2);assert.equal(a.openCheckFor(5).totalCents,3800);assert.equal(a.check(5).length,4);
 // the demo rules refuse before anything is sent: a closed bill, an invalid line
 assert.throws(()=>a.updateServiceCheck(c.id,[{id:'i07',q:1.5,p:16}]),/whole quantity/);
 assert.equal(server.calls.length,2);
});

test('with a payment recorded, removing a line is refused locally and never reaches the server',async()=>{
 const {a,server,window}=await boot();
 const c=await a.openServiceCheck({table:5,lines:LINES,source:'staff'});
 // a confirmed card payment for one hummus, as the snapshot would deliver it
 const rows=JSON.parse(window.localStorage.getItem(a.util.storageKey('aal.settle'))||'[]');
 rows.push({id:'pay-1',venueId:a.venueId(),checkId:c.id,table:5,rail:'card',amount:5,tip:0,items:{i06:1},status:'confirmed',ts:'2026-09-24T10:01:00.000Z'});
 a.util.rawWrite('aal.settle',rows);
 assert.throws(()=>a.updateServiceCheck(c.id,[LINES[0],LINES[3]]),/Hummus Beiruti is covered by a payment/);
 assert.throws(()=>a.updateServiceCheck(c.id,[LINES[0],{id:'i06',q:2,p:10},{id:'i14',q:3,p:7.5}]),/added, not removed/);
 assert.equal(server.calls.length,1);
 await a.updateServiceCheck(c.id,[LINES[0],{id:'i06',q:2,p:10},LINES[3],{id:'i13',q:1,p:2}]);
 assert.equal(server.calls[1].p_op,'update_check');
});

test('a chk_ guest receives its one check through the snapshot; check(table) finds it and the table comes from the check',async()=>{
 const owner=await boot();
 const c=await owner.a.openServiceCheck({table:9,lines:LINES,source:'staff'});
 owner.server.checkId=c.id;
 const {a}=await boot({page:'guest.html',key:'chk_bbbbbbbbbbbbbbbb',server:owner.server});
 assert.equal(a.demoMode(),false);assert.equal(a.sampleAllowed(),false);
 const bound=a.sync.boundCheck();
 assert.equal(bound.id,c.id);assert.equal(bound.table,9);
 assert.deepEqual(plain(a.check(bound.table).map(l=>[l.id,l.q,l.p])),[['i07',1,16],['i06',2,10],['i14',4,10]]);
 assert.equal(a.checkTotal(bound.table),36);
 // every other table is empty: no sample bill with a key
 assert.deepEqual(plain(a.check(12)),[]);
 // a guest cannot open or change a bill
 assert.equal(a.openServiceCheck({table:12,lines:LINES}).id,c.id);
 assert.throws(()=>a.updateServiceCheck(c.id,LINES),/Only staff/);
});
