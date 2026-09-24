/* Shared mode uses scoped local caches, a durable outbox and server-authorised
   payment operations. No local demo history is ever imported into a restaurant. */
(function (global) {
  'use strict';
  var A=global.Aalayna, cfg=global.AalaynaConfig||{};
  var COLLECTIONS=['aal.checks','aal.settle','aal.events','aal.guests','aal.campaigns','aal.edit_log','aal.webhook_log','aal.admin_notifications','aal.health_reports','aal.identity_merges'];
  var DOCS=['aal.draft','aal.live','aal.rate','aal.rate_meta','aal.floor','aal.tips'];
  var CLIENT_EVENTS=['qr_scan','item_view','bill_requested','ui_action','review_submitted'];
  var BILL_OPS=['open_check','update_check'];
  var OWNER_ROWS=['aal.guests','aal.campaigns','aal.edit_log','aal.admin_notifications','aal.health_reports','aal.identity_merges'];
  function rowId(c,r){return r&&typeof r==='object'?(r.id!=null?String(r.id):r.eventId!=null?String(r.eventId):c==='aal.health_reports'&&r.week?String(r.week):null):null;}
  function inVenue(row,rid){return !!row && (!row.venueId || row.venueId===rid) && (!row.restaurantId || row.restaurantId===rid) && (row.venueId===rid || row.restaurantId===rid);}
  function diffRows(c,local,snapshot,rid){return (local||[]).filter(function(r){return (!rid||inVenue(r,rid))&&rowId(c,r)&&snapshot[rowId(c,r)]!==JSON.stringify(r);}).map(function(r){return {id:rowId(c,r),body:r,json:JSON.stringify(r)};});}
  function mergeRows(c,local,remote){var by={},order=[];(local||[]).forEach(function(r){var id=rowId(c,r);if(id){if(!by[id])order.push(id);by[id]=r;}});(remote||[]).forEach(function(r){if(!by[r.id])order.push(r.id);by[r.id]=r.body;});return order.map(function(id){return by[id];});}
  var core={rowId:rowId,inVenue:inVenue,diffRows:diffRows,mergeRows:mergeRows,COLLECTIONS:COLLECTIONS,DOCS:DOCS};
  if(A)A.syncCore=core;else global.AalaynaSyncCore=core;
  if(!A||!cfg.supabaseUrl||!cfg.anonKey||!global.localStorage)return;
  var rid=A.venueId(), q=new URLSearchParams(global.location.search), supplied=(q.get('k')||'').trim();
  var guestPage=/guest\.html$/.test(global.location.pathname||''), slot=guestPage?'guest':'owner';
  var key='', credentialKey='aal.access:'+rid+':'+slot;
  try{
    if(/^(own|chk|gst)_[0-9a-f]{12,64}$/.test(supplied)){
      key=supplied;
      // Owner credentials never become the default on a guest page.
      if(!guestPage||key.indexOf('own_')!==0)global.localStorage.setItem(credentialKey,key);
      if(global.history&&global.history.replaceState){q.delete('k');global.history.replaceState(null,'',global.location.pathname+(q.toString()?'?'+q.toString():''));}
    }else key=global.localStorage.getItem(credentialKey)||'';
  }catch(e){}
  var state={status:key?'starting':'no-key',role:key.indexOf('own_')===0?'owner':key?'guest':null,checkId:null,lastPull:null,lastPush:null,pending:0,failed:0,errors:0,lastError:null};
  var queue={},running=null,paused=false,ready=false,online=false,observers=[],docSnap={},rowSnap={};
  var base=cfg.supabaseUrl.replace(/\/$/,'')+'/rest/v1/';
  var headers={apikey:cfg.anonKey,Authorization:'Bearer '+cfg.anonKey,'x-aalayna-key':key,'Content-Type':'application/json'};
  function view(){return JSON.parse(JSON.stringify(state));}
  function update(){
    var jobs=Object.values(queue);state.pending=jobs.filter(function(j){return !j.blocked;}).length;state.failed=jobs.filter(function(j){return j.blocked;}).length;
    state.status=!key?'no-key':!ready?(state.errors?'offline':'starting'):!online?'offline':state.failed?'error':state.pending?'syncing':'live';
    observers.forEach(function(f){f(view());});
  }
  function persist(){try{global.localStorage.setItem(A.util.storageKey('aal.outbox'),JSON.stringify(queue));}catch(e){state.lastError='Device storage is full. Keep this page open until changes are saved.';}update();}
  function fail(e){state.errors++;state.lastError=e.message||String(e);online=false;update();}
  function call(path,body,method){return fetch(base+path,{method:method||'POST',headers:headers,body:body==null?undefined:JSON.stringify(body)}).then(function(r){return r.text().then(function(t){if(!r.ok){var e=new Error('The server could not save this change ('+r.status+').');e.status=r.status;try{e.message=JSON.parse(t).message||e.message;}catch(ignore){}throw e;}return t?JSON.parse(t):null;});});}
  function rpc(op,body,token){return call('rpc/aal_mutate',{p_rid:rid,p_op:op,p_body:body,p_token:token||''});}
  function applyRow(c,row){if(!row||!rowId(c,row)||!inVenue(row,rid))return;var rows=A.util.read(c,[]).filter(function(r){return inVenue(r,rid);});A.util.rawWrite(c,mergeRows(c,rows,[{id:rowId(c,row),body:row}]));}
  function applyResult(job,result){if(job.kind!=='op')return;if(['reserve','confirm_cash','cancel','refund'].indexOf(job.op)>=0)applyRow('aal.settle',result);if(['open_check','update_check','close_check'].indexOf(job.op)>=0)applyRow('aal.checks',result);}
  function pull(){
    return call('rpc/aal_snapshot',{p_rid:rid}).then(function(res){
      if(!res||res.version!==2)throw new Error('The shared database needs the September 15 migration.');
      state.checkId=res.checkId;state.role=res.role;online=true;ready=true;
      var by={};COLLECTIONS.forEach(function(c){by[c]=[];});
      (res.rows||[]).forEach(function(r){if(by[r.collection]&&inVenue(r.body,rid))by[r.collection].push(r);});
      Object.keys(by).forEach(function(c){
        var remote=by[c].map(function(r){return r.body;});rowSnap[c]={};remote.forEach(function(r){rowSnap[c][rowId(c,r)]=JSON.stringify(r);});
        Object.values(queue).filter(function(j){return j.collection===c&&j.kind==='row';}).forEach(function(j){remote=mergeRows(c,remote,[{id:j.body.id,body:j.body.body}]);});
        if(JSON.stringify(remote)!==JSON.stringify(A.util.read(c,[])))A.util.rawWrite(c,remote);
      });
      (res.docs||[]).forEach(function(d){if(DOCS.indexOf(d.key)<0)return;docSnap[d.key]=JSON.stringify(d.body);if(!queue['doc:'+d.key]&&JSON.stringify(A.util.read(d.key,null))!==docSnap[d.key])A.util.rawWrite(d.key,d.body);});
      state.lastPull=new Date().toISOString();update();return res;
    });
  }
  function transmit(j){
    if(j.kind==='op')return rpc(j.op,j.body,j.token);
    if(j.kind==='event')return rpc('event',j.body);
    return call((j.kind==='doc'?'kv_docs?on_conflict=restaurant_id,key':'kv_rows?on_conflict=restaurant_id,collection,id'),[j.body]);
  }
  // PostgREST upsert is only for non-financial owner documents/records.
  function run(){
    if(running)return running;
    if(paused||!key||!ready)return Promise.resolve();
    running=(async function(){
      var ids=Object.keys(queue);
      for(var i=0;i<ids.length;i++){
        var id=ids[i],job=queue[id];if(!job||job.blocked)continue;
        var sent=JSON.stringify(job);
        try{
          var result;
          if(job.kind==='doc'||job.kind==='row'){
            var response=await fetch(base+(job.kind==='doc'?'kv_docs?on_conflict=restaurant_id,key':'kv_rows?on_conflict=restaurant_id,collection,id'),{method:'POST',headers:Object.assign({},headers,{Prefer:'resolution=merge-duplicates,return=minimal'}),body:JSON.stringify([job.body])});
            if(!response.ok){var t=await response.text();var error=new Error('Change was rejected ('+response.status+').');error.status=response.status;try{error.message=JSON.parse(t).message||error.message;}catch(ignore){}throw error;}
          }else result=await transmit(job);
          if(JSON.stringify(queue[id])===sent)delete queue[id];
          applyResult(job,result);online=true;state.lastPush=new Date().toISOString();persist();
          if(job.waiter&&waiters[job.waiter]){waiters[job.waiter].resolve(result);delete waiters[job.waiter];}
        }catch(e){
          var permanent=e.status>=400&&e.status<500&&e.status!==408&&e.status!==429;
          e.queued=!permanent;
          // A refused bill save was shown to the staff member who made it and their draft reloads;
          // it can never succeed on retry (the bill changed), so it does not stay blocked in the outbox.
          if(permanent&&queue[id]){if(job.kind==='op'&&BILL_OPS.indexOf(job.op)>=0&&job.waiter&&waiters[job.waiter])delete queue[id];else queue[id].blocked=e.message;}
          fail(e);persist();
          if(job.waiter&&waiters[job.waiter]){waiters[job.waiter].reject(e);delete waiters[job.waiter];}
          if(!permanent)break;
        }
      }
    })().finally(function(){running=null;update();});return running;
  }
  var waiters={};
  function enqueue(id,job){queue[id]=job;persist();if(ready)run();}
  async function mutate(op,body,token){
    if(!ready)await A.sync.ready;
    if(!ready)throw new Error('Connect to the restaurant before continuing.');
    var id='op:'+op+':'+(body.requestId||body.id||body.checkId||A.util.uid()), waiter=A.util.uid();
    var promise=new Promise(function(resolve,reject){waiters[waiter]={resolve:resolve,reject:reject};});
    enqueue(id,{kind:'op',op:op,body:body,token:token||'',waiter:waiter});
    var result=await promise;
    // An acknowledged mutation stays successful even if the following refresh fails.
    // Its authoritative result is already applied; polling will refresh other records.
    try{await pull();}catch(e){fail(e);}
    return result;
  }
  A.sync={state:view,key:function(){return key;},enabled:!!key,subscribe:function(f){observers.push(f);f(view());},pull:pull,retry:async function(){Object.values(queue).forEach(function(j){delete j.blocked;});persist();try{await pull();await run();}catch(e){fail(e);}},boundCheck:function(){return state.checkId?A.serviceChecks().find(function(c){return c.id===state.checkId;}):null;},mutate:mutate};
  if(!key){A.sync.ready=Promise.resolve();return;}
  A.util.activateScope(JSON.stringify([rid,state.role,key]));
  try{queue=JSON.parse(global.localStorage.getItem(A.util.storageKey('aal.outbox'))||'{}');}catch(e){queue={};}
  // Seed/local-only history is intentionally not queued on boot.
  A.util.hooks.afterWrite.push(function(k,v){
    if(paused||A.venueId()!==rid)return;
    if(DOCS.indexOf(k)>=0&&state.role==='owner'){
      if(v==null||v.at==='seed')return;
      if(JSON.stringify(v)!==docSnap[k])enqueue('doc:'+k,{kind:'doc',body:{restaurant_id:rid,key:k,body:v}});
    }else if(COLLECTIONS.indexOf(k)>=0){
      (v||[]).forEach(function(r){
        if(!inVenue(r,rid))return;var id=rowId(k,r);if(!id)return;
        if(k==='aal.events'){
          if(CLIENT_EVENTS.indexOf(r.eventType)>=0&&(!rowSnap[k]||rowSnap[k][id]!==JSON.stringify(r)))enqueue('event:'+id,{kind:'event',body:r});
        }else if(state.role==='owner'&&OWNER_ROWS.indexOf(k)>=0&&(!rowSnap[k]||rowSnap[k][id]!==JSON.stringify(r)))enqueue(k+':'+id,{kind:'row',collection:k,body:{restaurant_id:rid,collection:k,id:id,body:r}});
      });
    }
  });
  function payerToken(id){var k='aal.payer:'+id,t=A.util.read(k,null);if(!t){t=A.util.uid()+A.util.uid();A.util.rawWrite(k,t);}return t;}
  function remoteReserve(s){
    if(s.rail!=='cash')return Promise.reject(new Error('Digital payments are not connected yet. Please arrange payment with your server.'));
    var id=s.requestId||A.util.uid();return mutate('reserve',Object.assign({},s,{id:id,items:s.items||{},tip:s.tip||0}),payerToken(id));
  }
  A.settle=remoteReserve;A.requestPayment=remoteReserve;
  A.confirmPayment=function(){throw new Error('Only a verified provider callback can confirm a shared digital payment.');};
  A.confirmCash=function(id){return mutate('confirm_cash',{id:id}).then(function(){return true;});};
  A.cancelCash=function(id){return mutate('cancel',{id:id},payerToken(id));};
  A.refund=function(id){return mutate('refund',{id:id});};
  A.failPayment=function(requestId){var p=A.settlements().find(function(s){return s.requestId===requestId;});return p?mutate('cancel',{id:p.id},payerToken(p.id)):Promise.resolve();};
  A.optIn=function(input){var c=A.normaliseContact(input.contact);return mutate('receipt',Object.assign({},input,{id:input.settlementId,requestId:A.util.uid(),contact:c.contact,channel:c.channel}),payerToken(input.settlementId));};
  A.closeServiceCheck=function(id){return mutate('close_check',{checkId:id});};
  /* Bills. open_check takes either a POS total or itemised lines {id,q,p,name}
     (p the line total in dollars); with lines the server folds them by id and
     computes totalCents itself. update_check changes an open bill's lines under the
     same rules as the demo store (supabase/hardening-2026-09-24.sql). Both are
     checked here first for an immediate answer; the server decides. */
  function billLines(lines){if(!A.checkLines)throw new Error('Bill entry is not available on this page.');return A.checkLines(lines);}
  A.openServiceCheck=function(input){
    if(state.role!=='owner'){var c=A.sync.boundCheck();if(!c)throw new Error('This bill is not available. Ask your server for its current link.');return c;}
    var lines=input.lines&&input.lines.length?billLines(input.lines):[];
    var total=lines.length?lines.reduce(function(n,l){return n+A.util.cents(l.p);},0):A.util.cents(input.total);
    if(!Number.isSafeInteger(total)||total<=0||!Number.isInteger(Number(input.table))||Number(input.table)<1)throw new Error('A check needs a table and a positive total.');
    var rate=A.rate();return mutate('open_check',{id:A.util.uid(),table:Number(input.table),totalCents:total,lines:lines,currency:'USD',fxRateUsed:rate,amountUsd:total/100,sessionId:A.session(),deviceId:A.device()});
  };
  A.updateServiceCheck=function(id,lines){
    if(state.role!=='owner')throw new Error('Only staff may change a bill.');
    var plan=A.planCheckUpdate(id,lines);
    return mutate('update_check',{checkId:id,requestId:A.util.uid(),baseRevision:plan.check.revision||1,lines:plan.lines,sessionId:A.session(),deviceId:A.device()});
  };
  A.sync.issueCheckKey=function(id){return mutate('issue_key',{checkId:id});};
  A.reset=function(){throw new Error('Shared restaurant records cannot be reset from a demo control.');};
  A.sync.ready=pull().then(function(){return run();}).catch(function(e){fail(e);throw e;});
  A.sync.ready.catch(function(){});
  function tick(){if(paused||global.document.visibilityState==='hidden')return;pull().then(run).catch(fail);}
  setInterval(tick,4000);global.document.addEventListener('visibilitychange',function(){if(global.document.visibilityState==='visible')tick();});global.addEventListener('online',tick);
  // A compact status line; the receipt keeps its one-screen layout.
  function mount(){
    var node=global.document.createElement('div');node.id='aal-sync-status';node.setAttribute('role','status');node.setAttribute('aria-live','polite');
    node.style.cssText='position:fixed;right:8px;top:6px;z-index:9999;max-width:calc(100vw - 16px);font:11px system-ui;background:#fff8e9;color:#173e43;border:1px solid #ddd3c0;border-radius:6px;padding:5px 8px';
    var label=global.document.createElement('span'),retry=global.document.createElement('button');retry.textContent='Retry';retry.style.marginLeft='8px';retry.onclick=function(){A.sync.retry();};node.append(label,retry);global.document.body.appendChild(node);
    A.sync.subscribe(function(s){label.textContent=s.status==='live'?'Saved':s.status==='starting'?'Connecting…':s.status==='offline'?'Connection lost · '+s.pending+' changes waiting':s.status==='error'?s.failed+' changes need attention':'Syncing '+s.pending+' changes…';node.title=s.lastError||'';retry.hidden=s.status!=='offline'&&s.status!=='error';});
  }
  if(global.document.body)mount();else global.document.addEventListener('DOMContentLoaded',mount);
})(window);
