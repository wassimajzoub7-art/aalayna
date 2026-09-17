const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const flush=()=>new Promise(r=>setImmediate(r));
async function boot({map=new Map(),bad=false,role='owner',key='own_aaaaaaaaaaaa',rid='A',remote=[]}={}){
 let fail=bad,failReads=false,tick;const posts=[];const listeners=[];
 const storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const node=()=>({style:{},setAttribute(){},append(){}});
 const doc={visibilityState:'visible',body:{appendChild(){}},createElement:node,addEventListener(){}};
 let scope='';
 const A={venueId:()=>rid,device:()=> 'device',util:{hooks:{afterWrite:[]},activateScope:s=>{scope=s;},storageKey:k=>scope+':'+k,read:(k,f)=>{const v=storage.getItem(scope+':'+k);return v?JSON.parse(v):f;},rawWrite:(k,v)=>storage.setItem(scope+':'+k,JSON.stringify(v)),uid:()=>Math.random().toString(36).repeat(4)},serviceChecks:()=>[],settlements:()=>[]};
 const window={Aalayna:A,AalaynaConfig:{supabaseUrl:'https://mock.invalid',anonKey:'fake'},localStorage:storage,location:{pathname:role==='guest'?'/guest.html':'/dashboard.html',search:'?k='+key},document:doc,addEventListener(){}};
 const snapshot={version:2,role,checkId:null,rows:remote,docs:[]};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../aalayna-sync.js'),'utf8'),{window,URLSearchParams,fetch:async(url,options)=>{
  if(url.endsWith('/aal_snapshot'))return {ok:!failReads,status:503,text:async()=>failReads?'unavailable':JSON.stringify(snapshot)};
  posts.push({url,body:JSON.parse(options.body)});return {ok:!fail,status:503,text:async()=>fail?'unavailable':url.endsWith('/aal_mutate')?JSON.stringify(JSON.parse(options.body).p_body):''};
 },setInterval:f=>{tick=f;}});
 await A.sync.ready;await flush();
 return {A,map,posts,tick,setReadFail:v=>{failReads=v;},setFail:v=>{fail=v;},write:(k,v)=>{A.util.rawWrite(k,v);A.util.hooks.afterWrite.forEach(f=>f(k,v));}};
}
test('an acknowledged mutation is not reported as failed when its refresh loses connection',async()=>{
 const b=await boot();b.setReadFail(true);
 const result=await b.A.sync.mutate('issue_key',{checkId:'check-one'});
 assert.equal(result.checkId,'check-one');assert.equal(b.posts.length,1);
 assert.equal(b.A.sync.state().pending,0);assert.notEqual(b.A.sync.state().status,'live');
});
test('failed writes remain pending despite successful reads, retry on polling and survive reload',async()=>{
 const b=await boot({bad:true});b.write('aal.campaigns',[{id:'campaign',venueId:'A',name:'draft'}]);await flush();await flush();
 assert.equal(b.A.sync.state().pending,1);await b.A.sync.pull();assert.notEqual(b.A.sync.state().status,'live');
 const reloaded=await boot({map:b.map});assert.equal(reloaded.posts.length,1);assert.equal(reloaded.posts[0].body[0].body.name,'draft');assert.equal(reloaded.A.sync.state().pending,0);
 b.setFail(false);b.tick();await flush();await flush();assert.equal(b.A.sync.state().pending,0);
});
test('a foreign record is never queued under the active restaurant',async()=>{
 const b=await boot();b.write('aal.guests',[{id:'foreign',venueId:'B',contact:'fictional@example.invalid'}]);await flush();assert.equal(b.posts.length,0);
});
test('guest cannot queue raw payment or contact writes or manufacture payment-completed events',async()=>{
 const b=await boot({role:'guest',key:'chk_bbbbbbbbbbbb'});
 b.write('aal.settle',[{id:'fake',venueId:'A',status:'confirmed'}]);b.write('aal.guests',[{id:'fake',venueId:'A'}]);b.write('aal.events',[{eventId:'fake',restaurantId:'A',eventType:'payment_completed'}]);await flush();assert.equal(b.posts.length,0);
 await assert.rejects(b.A.requestPayment({rail:'card'}),/not connected/);assert.throws(()=>b.A.confirmPayment('fake',{}),/verified provider/);
});
