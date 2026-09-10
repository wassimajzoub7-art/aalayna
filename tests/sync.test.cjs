const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
function core(){ const window={}; vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../aalayna-sync.js'),'utf8'),{window}); return window.AalaynaSyncCore; }
test('rows are identified by id, eventId or ISO week', ()=>{
  const c=core();
  assert.equal(c.rowId('aal.settle',{id:'p1'}),'p1');
  assert.equal(c.rowId('aal.events',{eventId:'e1'}),'e1');
  assert.equal(c.rowId('aal.health_reports',{week:'2026-W37'}),'2026-W37');
  assert.equal(c.rowId('aal.settle',{amount:3}),null);
});
test('only rows that changed since the snapshot are pushed', ()=>{
  const c=core(), local=[{id:'a',v:1},{id:'b',v:2},{v:9}];
  const snap={a:JSON.stringify({id:'a',v:1})};
  const out=c.diffRows('aal.settle',local,snap);
  assert.equal(JSON.stringify(out.map(r=>r.id)),'["b"]');
});
test('remote rows replace local rows by id; unknown local rows survive for the next push', ()=>{
  const c=core();
  const merged=c.mergeRows('aal.settle',[{id:'a',status:'pending'},{id:'local-only',status:'pending'}],[{id:'a',body:{id:'a',status:'confirmed'}},{id:'c',body:{id:'c',status:'confirmed'}}]);
  assert.equal(JSON.stringify(merged.map(r=>r.id+':'+r.status)),'["a:confirmed","local-only:pending","c:confirmed"]');
});
test('the sync layer stays inert without config or key', ()=>{
  const window={Aalayna:{venueId:()=>'x',util:{hooks:{afterWrite:[]}}},localStorage:{getItem:()=>null,setItem(){}},location:{search:''},document:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../aalayna-sync.js'),'utf8'),{window,URLSearchParams,fetch(){throw new Error('must not call');},setInterval(){}});
  assert.equal(window.Aalayna.sync,undefined);
  assert.equal(window.Aalayna.util.hooks.afterWrite.length,0);
});
