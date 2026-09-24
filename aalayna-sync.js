/* Shared mode uses scoped local caches, a durable outbox and server-authorised
   payment operations. No local demo history is ever imported into a restaurant. */
(function (global) {
  'use strict';
  var A=global.Aalayna, cfg=global.AalaynaConfig||{};
  var COLLECTIONS=['aal.checks','aal.settle','aal.events','aal.guests','aal.campaigns','aal.edit_log','aal.webhook_log','aal.admin_notifications','aal.health_reports','aal.identity_merges'];
  var DOCS=['aal.draft','aal.live','aal.rate','aal.rate_meta','aal.floor','aal.tips'];
  var CLIENT_EVENTS=['qr_scan','item_view','bill_requested','ui_action','review_submitted'];
  var OWNER_ROWS=['aal.guests','aal.campaigns','aal.edit_log','aal.admin_notifications','aal.health_reports','aal.identity_merges'];
  function rowId(c,r){return r&&typeof r==='object'?(r.id!=null?String(r.id):r.eventId!=null?String(r.eventId):c==='aal.health_reports'&&r.week?String(r.week):null):null;}
  function inVenue(row,rid){return !!row && (!row.venueId || row.venueId===rid) && (!row.restaurantId || row.restaurantId===rid) && (row.venueId===rid || row.restaurantId===rid);}
  function diffRows(c,local,snapshot,rid){return (local||[]).filter(function(r){return (!rid||inVenue(r,rid))&&rowId(c,r)&&snapshot[rowId(c,r)]!==JSON.stringify(r);}).map(function(r){return {id:rowId(c,r),body:r,json:JSON.stringify(r)};});}
  function mergeRows(c,local,remote){var by={},order=[];(local||[]).forEach(function(r){var id=rowId(c,r);if(id){if(!by[id])order.push(id);by[id]=r;}});(remote||[]).forEach(function(r){if(!by[r.id])order.push(r.id);by[r.id]=r.body;});return order.map(function(id){return by[id];});}
  var core={rowId:rowId,inVenue:inVenue,diffRows:diffRows,mergeRows:mergeRows,COLLECTIONS:COLLECTIONS,DOCS:DOCS};
  if(A)A.syncCore=core;else global.AalaynaSyncCore=core;
  /* ==== T4 staff sign-in (supabase/auth-2026-09-24.sql) ====
     Staff pages sign people in with a six-digit code sent to their email, through
     Supabase Auth's own endpoints (no SDK). The session (access and refresh token)
     is kept in localStorage under aal.session and refreshed before it expires. On
     the dashboard and editor a session replaces the owner key: requests carry
     Authorization: Bearer <access token>, apikey stays the anon key, and no
     x-aalayna-key is sent. Access itself comes from the staff_members row for the
     signed-in email, checked by aal_role() on the server. Guest pages never use it. */
  var Auth=(function(){
    if(!cfg.supabaseUrl||!cfg.anonKey||!global.localStorage)return null;
    var SESSION='aal.session',SKIP='aal.gate',EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,ROLE_LABEL={owner:'Owner',manager:'Manager',waiter:'Waiter'};
    var root=cfg.supabaseUrl.replace(/\/$/,''),listeners=[],refreshing=null,timer=null;
    function now(){return new Date().getTime();}
    function read(){try{var s=JSON.parse(global.localStorage.getItem(SESSION)||'null');return s&&s.access_token&&s.refresh_token?s:null;}catch(e){return null;}}
    function emit(){var s=read();listeners.forEach(function(f){try{f(s);}catch(e){}});}
    function hasTimers(){return typeof global.setTimeout==='function'&&typeof global.clearTimeout==='function';}
    function schedule(){
      if(!hasTimers())return;if(timer)global.clearTimeout(timer);timer=null;var s=read();if(!s)return;
      var wait=Math.min(Math.max(5000,s.expires_at*1000-now()-90000),2147483647);
      timer=global.setTimeout(function(){timer=null;refresh().then(null,function(){});},wait);
    }
    function store(res,previous){
      if(!res||!res.access_token||!res.refresh_token)throw new Error('The sign-in answer was incomplete. Try again.');
      var user=res.user||{},old=previous||{};
      var s={access_token:res.access_token,refresh_token:res.refresh_token,
        expires_at:Number(res.expires_at)||Math.floor(now()/1000)+(Number(res.expires_in)||3600),
        email:String(user.email||old.email||'').toLowerCase(),user_id:String(user.id||old.user_id||'')};
      global.localStorage.setItem(SESSION,JSON.stringify(s));schedule();emit();return s;
    }
    function post(path,body,token){
      var h={apikey:cfg.anonKey,'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;
      return fetch(root+path,{method:'POST',headers:h,body:JSON.stringify(body||{})}).then(function(r){return r.text().then(function(t){
        var j=null;try{j=t?JSON.parse(t):null;}catch(ignore){}
        if(!r.ok){var e=new Error((j&&(j.msg||j.error_description||j.message))||'The sign-in service answered '+r.status+'.');e.status=r.status;e.code=j&&(j.error_code||j.code);throw e;}
        return j;});},function(){throw new Error('Could not reach the sign-in service. Check the connection and try again.');});
    }
    /* The cached venue data this user's pages kept on this device (see start() below). */
    function scopeOf(s){return 'user:'+(s.user_id||s.email);}
    function forgetCache(s){
      if(!s)return;var mark=JSON.stringify(scopeOf(s)),drop=[],i,k;
      try{for(i=0;i<global.localStorage.length;i++){k=global.localStorage.key(i);if(k&&k.indexOf('aal.scope:')===0&&k.indexOf(mark)>0)drop.push(k);}}catch(e){}
      drop.forEach(function(k){try{global.localStorage.removeItem(k);}catch(e){}});
    }
    function clear(){try{global.localStorage.removeItem(SESSION);}catch(e){}if(timer&&hasTimers())global.clearTimeout(timer);timer=null;emit();}
    function sendCode(email){
      email=String(email||'').replace(/^\s+|\s+$/g,'').toLowerCase();
      if(!EMAIL.test(email))return Promise.reject(new Error('Enter the email address the restaurant invited.'));
      return post('/auth/v1/otp',{email:email,create_user:true}).then(function(){return email;});
    }
    function verify(email,code){
      email=String(email||'').replace(/^\s+|\s+$/g,'').toLowerCase();code=String(code||'').replace(/\s+/g,'');
      if(!/^[0-9]{6}$/.test(code))return Promise.reject(new Error('Enter the six-digit code from the email.'));
      return post('/auth/v1/verify',{type:'email',email:email,token:code}).then(function(res){return store(res,{email:email});},function(e){
        if(e.status>=400&&e.status<500&&e.status!==429)e.message='That code is wrong or has expired. Check the latest email, or send a new code.';throw e;});
    }
    /* One refresh at a time. A refused refresh token ends the session; a network
       failure keeps it for the next try. */
    function refresh(){
      if(refreshing)return refreshing;var s=read();if(!s)return Promise.resolve(null);
      refreshing=post('/auth/v1/token?grant_type=refresh_token',{refresh_token:s.refresh_token}).then(function(res){refreshing=null;return store(res,s);},function(e){
        refreshing=null;if(e.status>=400&&e.status<500&&e.status!==429){clear();return null;}throw e;});
      return refreshing;
    }
    function token(){var s=read();if(!s)return Promise.resolve(null);if(s.expires_at*1000-now()>60000)return Promise.resolve(s.access_token);return refresh().then(function(n){return n?n.access_token:null;});}
    function signOut(){
      var s=read();clear();forgetCache(s);try{global.sessionStorage.removeItem(SKIP);}catch(e){}
      if(!s)return Promise.resolve();
      return post('/auth/v1/logout?scope=local',{},s.access_token).then(function(){},function(){});
    }
    function rpc(fn,args){
      return token().then(function(t){
        if(!t){var e=new Error('Sign in again to continue.');e.signin=true;throw e;}
        return fetch(root+'/rest/v1/rpc/'+fn,{method:'POST',headers:{apikey:cfg.anonKey,Authorization:'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify(args||{})});
      }).then(function(r){return r.text().then(function(t){
        var j=null;try{j=t?JSON.parse(t):null;}catch(ignore){}
        if(!r.ok){var e=new Error(j&&j.code==='PGRST202'?'Staff sign-in is not installed on the shared store yet. Run supabase/auth-2026-09-24.sql.':(j&&j.message)||'The shared store answered '+r.status+'.');e.status=r.status;throw e;}
        return j;});});
    }
    function mine(){return rpc('aal_staff',{p_rid:null,p_body:{op:'mine'}});}

    /* The sign-in panel on a staff page. The page supplies the markup (ids below)
       in its own classes; this wires it. opts.roles: staff roles the page admits;
       opts.roleText: what a signed-in member with another role reads. */
    function gate(opts){
      opts=opts||{};var d=global.document,A=global.Aalayna,box=d&&d.getElementById('staff-gate');if(!box)return null;
      function $(id){return d.getElementById(id);}
      var s=read(),sync=A&&A.sync,rid=A?A.venueId():'',roles=opts.roles||['owner','manager','waiter'];
      var keyed=!!(sync&&sync.enabled&&!sync.signedIn),demo=!s&&!keyed,ownerLink=!s&&keyed&&/^own_/.test(sync.key()||'');
      var skip='';try{skip=global.sessionStorage.getItem(SKIP)||'';}catch(e){}
      var sent='',ctl={member:null,refused:false};
      function show(part){['staff-signin','staff-wait','staff-refusal'].forEach(function(id){var n=$(id);if(n)n.hidden=id!==part;});box.hidden=!part;ctl.part=part||null;}
      function say(text,kind){var n=$('staff-msg');if(n){n.textContent=text||'';n.setAttribute('data-kind',kind||'');}}
      function reload(){if(opts.reload)opts.reload();else global.location.reload();}
      function bar(who,action,fn){var b=$('staff-bar');if(!b)return;b.hidden=!who;$('staff-bar-who').textContent=who||'';var a=$('staff-bar-action');a.textContent=action||'';a.hidden=!action;a.onclick=function(e){if(e&&e.preventDefault)e.preventDefault();fn();};}
      function out(){var pending=sync&&sync.state?sync.state().pending:0;
        if(pending&&global.confirm&&!global.confirm(pending+(pending===1?' change is':' changes are')+' not saved to the restaurant yet. Sign out anyway?'))return;
        signOut().then(reload,reload);}
      function signin(){try{global.sessionStorage.removeItem(SKIP);}catch(e){}bar('');step(false);show('staff-signin');var e=$('staff-email');if(e&&e.focus)e.focus();}
      function step(code){$('staff-code-form').hidden=!code;$('staff-send').textContent=code?'Send a new code':'Send me a code';}
      function pass(mode){try{global.sessionStorage.setItem(SKIP,mode);}catch(e){}show(null);
        bar(mode==='demo'?'Demo, not signed in':'Owner link, not signed in','Sign in',signin);}
      function place(m){var p=m.place;if(p==null){try{p=JSON.parse(m.restaurant_id)[1];}catch(e){p='';}}return p||'';}
      function name(m){if(m.name)return m.name;try{return JSON.parse(m.restaurant_id)[0];}catch(e){return m.restaurant_id;}}
      function refuse(title,detail,list,retry){
        show('staff-refusal');$('staff-refusal-title').textContent=title;$('staff-refusal-text').textContent=detail;
        var ul=$('staff-venues');ul.replaceChildren();var page=(global.location.pathname||'').split('/').pop()||'dashboard.html';
        (list||[]).forEach(function(m){var li=d.createElement('li'),a=d.createElement('a');
          a.href=page+'?venue='+encodeURIComponent(name(m))+(place(m)?'&place='+encodeURIComponent(place(m)):'');
          a.textContent=name(m)+(place(m)?' · '+place(m):'')+' ('+(ROLE_LABEL[m.role]||m.role)+')';li.appendChild(a);ul.appendChild(li);});
        ul.hidden=!(list&&list.length);$('staff-retry').hidden=!retry;
      }
      function check(){
        show('staff-wait');
        return mine().then(function(list){
          list=Object.prototype.toString.call(list)==='[object Array]'?list:[];ctl.memberships=list;
          var m=list.filter(function(x){return x.restaurant_id===rid;})[0],who='Signed in as '+s.email;
          bar(who+(m?' · '+(ROLE_LABEL[m.role]||m.role):''),'Sign out',out);
          if(!m){ctl.refused=true;refuse("You are not on this restaurant's staff list",who+'. Ask the owner to invite this email address.'+(list.length?' Your restaurants:':''),list,false);return ctl;}
          if(roles.indexOf(m.role)<0){ctl.refused=true;refuse(opts.roleTitle||'This page is not part of your role',opts.roleText||'Ask the owner or a manager.',[],false);return ctl;}
          ctl.member=m;show(null);try{d.documentElement.setAttribute('data-staff-role',m.role);}catch(e){}
          if(opts.onMember)opts.onMember(m);return ctl;
        },function(e){
          if(e.signin){s=null;signin();say('Your sign-in has ended. Send a new code to continue.');return ctl;}
          bar('Signed in as '+s.email,'Sign out',out);refuse('Could not check your staff access',e.message,[],true);return ctl;
        });
      }
      $('staff-email-form').onsubmit=function(e){
        if(e&&e.preventDefault)e.preventDefault();var btn=$('staff-send');btn.disabled=true;say('Sending a code...');
        return sendCode($('staff-email').value).then(function(email){sent=email;btn.disabled=false;step(true);
          say('We sent a six-digit code to '+email+'. It can take a minute to arrive.','ok');var c=$('staff-code');c.value='';if(c.focus)c.focus();
        },function(err){btn.disabled=false;say(err.message,'err');});
      };
      $('staff-code-form').onsubmit=function(e){
        if(e&&e.preventDefault)e.preventDefault();var btn=$('staff-verify');btn.disabled=true;say('Checking the code...');
        return verify(sent||$('staff-email').value,$('staff-code').value).then(function(){say('Signed in.','ok');reload();},function(err){btn.disabled=false;say(err.message,'err');});
      };
      $('staff-demo').hidden=!demo;$('staff-demo').onclick=function(e){if(e&&e.preventDefault)e.preventDefault();pass('demo');};
      $('staff-key').hidden=!ownerLink;$('staff-key').onclick=function(e){if(e&&e.preventDefault)e.preventDefault();pass('key');};
      $('staff-refusal-out').onclick=function(e){if(e&&e.preventDefault)e.preventDefault();out();};
      $('staff-retry').onclick=function(e){if(e&&e.preventDefault)e.preventDefault();check();};
      step(false);
      // the session ended elsewhere (sign-out in another tab, refused refresh): back to the sign-in panel
      listeners.push(function(n){if(s&&!n){s=null;ctl.member=null;signin();say('Your sign-in has ended. Send a new code to continue.');}});
      if(s)ctl.ready=check();
      else if((demo&&skip==='demo')||(ownerLink&&skip==='key')){pass(skip);ctl.ready=Promise.resolve(ctl);}
      else{signin();ctl.ready=Promise.resolve(ctl);}
      return ctl;
    }
    if(read()&&!/guest(\.html)?$/.test((global.location&&global.location.pathname)||''))schedule();
    return {session:read,sendCode:sendCode,verify:verify,refresh:refresh,token:token,signOut:signOut,mine:mine,rpc:rpc,gate:gate,
      scope:function(){var s=read();return s?scopeOf(s):'';},onChange:function(f){listeners.push(f);},roleLabel:function(r){return ROLE_LABEL[r]||r;}};
  })();
  if(Auth)global.AalaynaAuth=Auth;
  /* ==== T4 staff sign-in end ==== */
  if(!A||!cfg.supabaseUrl||!cfg.anonKey||!global.localStorage)return;
  var rid=A.venueId(), q=new URLSearchParams(global.location.search), supplied=(q.get('k')||'').trim();
  var guestPage=/guest\.html$/.test(global.location.pathname||''), slot=guestPage?'guest':'owner';
  // T4: on the dashboard and editor a staff session is the credential and the owner key only a fallback.
  var staffPage=/(dashboard|editor)(\.html)?$/.test(global.location.pathname||''), session=staffPage&&Auth?Auth.session():null, signedIn=!!session;
  var key='', credentialKey='aal.access:'+rid+':'+slot;
  try{
    if(/^(own|chk|gst)_[0-9a-f]{12,64}$/.test(supplied)){
      key=supplied;
      // Owner credentials never become the default on a guest page.
      if(!guestPage||key.indexOf('own_')!==0)global.localStorage.setItem(credentialKey,key);
      if(global.history&&global.history.replaceState){q.delete('k');global.history.replaceState(null,'',global.location.pathname+(q.toString()?'?'+q.toString():''));}
    }else key=global.localStorage.getItem(credentialKey)||'';
  }catch(e){}
  // A signed-in member is 'staff' until the first snapshot names the role (owner or waiter): nothing is
  // queued as an owner write before the server has said so, so a waiter never gets a refused change.
  var state={status:key||signedIn?'starting':'no-key',role:signedIn?'staff':key.indexOf('own_')===0?'owner':key?'guest':null,checkId:null,lastPull:null,lastPush:null,pending:0,failed:0,errors:0,lastError:null,lastRefusal:null};
  var queue={},running=null,paused=false,ready=false,online=false,observers=[],docSnap={},rowSnap={};
  /* T8: refused outbox jobs. A job the server refuses with a definite answer (a 4xx with a
     message) can never succeed on a resend, so it leaves the outbox and is kept here, per
     credential scope, with the server's message. failed in state() counts the refusals
     nobody has seen yet; the status line shows the latest once, until dismissed. A refusal
     that its caller already received (a live mutate promise) or a client event is recorded
     as already shown. Only jobs that failed for network reasons stay queued and retried. */
  var refused={},errorFns=[],REFUSED_KEEP=20;
  var base=cfg.supabaseUrl.replace(/\/$/,'')+'/rest/v1/';
  var headers={apikey:cfg.anonKey,Authorization:'Bearer '+cfg.anonKey,'x-aalayna-key':key,'Content-Type':'application/json'};
  // T4: with a session the JWT is the credential; the anon key stays the apikey and no venue key is sent.
  if(signedIn){delete headers['x-aalayna-key'];headers.Authorization='Bearer '+session.access_token;}
  var STAFF_ROLES=['owner','waiter','staff'];
  function authorize(){
    if(!signedIn)return Promise.resolve();
    return Auth.token().then(function(t){if(!t){var e=new Error('Your sign-in has ended. Sign in again to keep saving.');throw e;}headers.Authorization='Bearer '+t;});
  }
  function view(){return JSON.parse(JSON.stringify(state));}
  /* The status line's words (T8: "1 change", never "1 changes"). */
  function changes(n){return n+(n===1?' change':' changes');}
  function statusText(s){
    if(s.status==='live')return 'Saved';
    if(s.status==='starting')return 'Connecting…';
    if(s.status==='no-key')return '';
    if(s.status==='offline')return 'Connection lost'+(s.pending?' · '+changes(s.pending)+' waiting':'');
    if(s.status==='error')return (s.failed===1?'Not saved: ':changes(s.failed)+' not saved. Latest: ')+s.lastRefusal;
    return 'Syncing '+changes(s.pending)+'…';
  }
  function unseen(){return Object.keys(refused).map(function(id){return refused[id];}).filter(function(r){return !r.shown;}).sort(function(a,b){return a.at<b.at?-1:a.at>b.at?1:0;});}
  function loadRefused(){try{refused=JSON.parse(global.localStorage.getItem(A.util.storageKey('aal.outbox.refused'))||'{}')||{};}catch(e){refused={};}}
  function saveRefused(){
    var ids=Object.keys(refused).sort(function(a,b){return refused[a].at<refused[b].at?-1:1;});
    ids.slice(0,Math.max(0,ids.length-REFUSED_KEEP)).forEach(function(id){delete refused[id];});
    try{global.localStorage.setItem(A.util.storageKey('aal.outbox.refused'),JSON.stringify(refused));}catch(e){}
  }
  function refuse(id,job,message,shown){
    var r={id:id,kind:job.kind,op:job.op||null,target:job.kind==='doc'?job.body.key:(job.collection||null),message:String(message||'The restaurant did not accept this change.'),at:new Date().toISOString(),shown:!!shown};
    refused[id]=r;saveRefused();
    errorFns.forEach(function(f){try{f(JSON.parse(JSON.stringify(r)));}catch(e){}});
    return r;
  }
  /* A definite refusal: the server answered 4xx with a message. Not 401 (the sign-in, not the
     change), 404 (a missing function or table: the SQL is not installed yet), 408 or 429. */
  function definitive(e){return !!e&&e.serverMessage===true&&e.status>=400&&e.status<500&&[401,404,408,429].indexOf(e.status)<0;}
  function httpError(status,text,fallback){
    var e=new Error(fallback);e.status=status;
    try{var j=JSON.parse(text);if(j&&j.message){e.message=/row-level security/.test(j.message)?'Your role cannot save this change for this restaurant.':String(j.message);e.serverMessage=true;e.code=j.code;}}catch(ignore){}
    return e;
  }
  function update(){
    var open=unseen();state.pending=Object.keys(queue).length;state.failed=open.length;state.lastRefusal=open.length?open[open.length-1].message:null;
    state.status=!key&&!signedIn?'no-key':!ready?(state.errors?'offline':'starting'):!online?'offline':state.failed?'error':state.pending?'syncing':'live';
    observers.forEach(function(f){f(view());});
  }
  function persist(){try{global.localStorage.setItem(A.util.storageKey('aal.outbox'),JSON.stringify(queue));}catch(e){state.lastError='Device storage is full. Keep this page open until changes are saved.';}update();}
  function fail(e){state.errors++;state.lastError=e.message||String(e);online=false;update();}
  function call(path,body,method){return authorize().then(function(){return fetch(base+path,{method:method||'POST',headers:headers,body:body==null?undefined:JSON.stringify(body)});}).then(function(r){return r.text().then(function(t){if(!r.ok)throw httpError(r.status,t,'The server could not save this change ('+r.status+').');return t?JSON.parse(t):null;});});}
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
    if(paused||(!key&&!signedIn)||!ready)return Promise.resolve();
    running=(async function(){
      var ids=Object.keys(queue);
      for(var i=0;i<ids.length;i++){
        var id=ids[i],job=queue[id];if(!job||job.blocked)continue;
        var sent=JSON.stringify(job);
        try{
          var result;
          if(job.kind==='doc'||job.kind==='row'){
            await authorize();
            var response=await fetch(base+(job.kind==='doc'?'kv_docs?on_conflict=restaurant_id,key':'kv_rows?on_conflict=restaurant_id,collection,id'),{method:'POST',headers:Object.assign({},headers,{Prefer:'resolution=merge-duplicates,return=minimal'}),body:JSON.stringify([job.body])});
            if(!response.ok)throw httpError(response.status,await response.text(),'Change was rejected ('+response.status+').');
          }else result=await transmit(job);
          if(JSON.stringify(queue[id])===sent)delete queue[id];
          applyResult(job,result);online=true;state.lastPush=new Date().toISOString();persist();
          if(job.waiter&&waiters[job.waiter]){waiters[job.waiter].resolve(result);delete waiters[job.waiter];}
        }catch(e){
          // T8: a definite refusal leaves the outbox and is recorded (see refuse above); a network
          // failure keeps the job queued and stops this run, so the order of changes is kept.
          var hard=definitive(e),live=!!(job.waiter&&waiters[job.waiter]);
          e.queued=!hard;
          if(hard){
            if(JSON.stringify(queue[id])===sent)delete queue[id];
            refuse(id,job,e.message,live||job.kind==='event');
            online=true;state.lastError=e.message;persist();
          }else{fail(e);persist();}
          if(live){waiters[job.waiter].reject(e);delete waiters[job.waiter];}
          if(!hard)break;
        }
      }
    })().finally(function(){running=null;update();});return running;
  }
  var waiters={};
  function enqueue(id,job){queue[id]=job;persist();if(ready)run();}
  async function mutate(op,body,token){
    if(!ready){try{await A.sync.ready;}catch(e){}}
    // Offline: a guest page opened without a connection, whose bill this device already
    // holds, queues the request; the outbox sends it after the first good read.
    var early=!ready&&state.role==='guest'&&!!A.sync.boundCheck();
    if(!ready&&!early)throw new Error('Connect to the restaurant before continuing.');
    var id='op:'+op+':'+(body.requestId||body.id||body.checkId||A.util.uid()), waiter=A.util.uid();
    var promise=new Promise(function(resolve,reject){waiters[waiter]={resolve:resolve,reject:reject};});
    enqueue(id,{kind:'op',op:op,body:body,token:token||'',waiter:waiter});
    if(early){delete waiters[waiter];var saved=new Error('Saved on this device. It is sent once the connection returns.');saved.queued=true;throw saved;}
    var result=await promise;
    // An acknowledged mutation stays successful even if the following refresh fails.
    // Its authoritative result is already applied; polling will refresh other records.
    try{await pull();}catch(e){fail(e);}
    return result;
  }
  A.sync={state:view,key:function(){return key;},enabled:!!key||signedIn,signedIn:signedIn,subscribe:function(f){observers.push(f);f(view());},pull:pull,retry:function(){return pull().then(function(){return run();}).catch(fail);},boundCheck:function(){return state.checkId?A.serviceChecks().find(function(c){return c.id===state.checkId;}):null;},mutate:mutate};
  /* Table QR (guest.html, supabase/sessions-2026-09-24.sql): a table whose bill is not
     entered yet opens without a key; once staff open the bill, aal_table_session mints
     a chk_ key and the page attaches it here, without a reload. The key is held exactly
     as a ?k= bill link on a guest page would hold it. docs are the menu/rate documents
     from the same response, landed at once so the new scope never shows the seed menu
     while the first snapshot is on its way. */
  /* T8 refusals: onError(fn) fires with {id, kind, op, target, message, at, shown} for every
     refused job; refusals() lists the ones not shown yet; dismiss(id) (or all, without id)
     marks them shown. Retry only resends jobs that are still queued, which are the ones
     that failed for network reasons. */
  A.sync.onError=function(f){errorFns.push(f);};
  A.sync.refusals=function(){return JSON.parse(JSON.stringify(unseen()));};
  A.sync.dismiss=function(id){(id?[refused[id]]:unseen()).forEach(function(r){if(r)r.shown=true;});saveRefused();update();};
  A.sync.statusText=statusText;
  A.sync.attach=function(k,docs){
    // T8: a key whose bill is closed (kept for the receipt) gives way to the table's next bill
    if(key&&!closedNow)throw new Error('This page already has a bill key.');
    if(!guestPage||!/^chk_[0-9a-f]{12,64}$/.test(k||''))throw new Error('Only a bill key can be attached on a guest page.');
    key=k;headers['x-aalayna-key']=k;state.role='guest';state.checkId=null;ready=false;A.sync.enabled=true;
    closedNow=false;closedFor=null;try{global.sessionStorage.removeItem(CLOSED);}catch(e){}
    try{global.localStorage.setItem(credentialKey,k);}catch(e){}
    start(docs);return A.sync.ready;
  };
  /* Offline (guest.html banner and receipt). A read is one aal_snapshot: readFailures
     counts failed reads in a row and a good read clears it. The bound check and the
     time of the last good read are kept in this scope's storage (per venue, role and
     key), so a page opened without a connection shows the last known bill and a cash
     request made there waits in the outbox. onState(fn) fires {online, lastReadAt,
     lastReadOk, readFailures, outboxPending, refused, closed} whenever one of them
     changes (refused: refusals not shown yet; closed: this page's bill closed, T8);
     job(id) says whether an outbox entry is 'pending', 'refused' (T8, with its message
     in refusals()) or gone (null). */
  var reads={ok:null,fails:0},stateFns=[],stateSent='',readOnce=pull;
  function lastRead(){try{return JSON.parse(global.localStorage.getItem(A.util.storageKey('aal.sync.read'))||'null')||{};}catch(e){return {};}}
  function netState(){return {online:!(global.navigator&&global.navigator.onLine===false),lastReadAt:key?lastRead().at||null:null,lastReadOk:reads.ok,readFailures:reads.fails,outboxPending:Object.keys(queue).length,refused:unseen().length,closed:closedNow};}
  function emitState(){var s=netState(),j=JSON.stringify(s);if(j===stateSent)return;stateSent=j;stateFns.forEach(function(f){try{f(s);}catch(e){}});}
  pull=function(){var held=key;return readOnce().then(function(res){
    reads.ok=true;reads.fails=0;
    try{global.localStorage.setItem(A.util.storageKey('aal.sync.read'),JSON.stringify({checkId:res.checkId||null,at:state.lastPull}));}catch(e){}
    if(!carried&&!guestPage){carried=true;carryOutbox();}
    emitState();
    // T8: a server without followups-2026-09-24.sql still answers for a closed bill
    if(held&&held===key&&boundClosed(res))markClosed(res.checkId);
    return res;
  },function(e){
    // T8: a bill key the server no longer accepts (its bill closed more than 24 hours ago)
    if(held&&held===key&&guestPage&&held.indexOf('chk_')===0&&e.status===400&&e.code==='P0001'){billEnded();throw e;}
    reads.ok=false;reads.fails++;emitState();throw e;});};
  A.sync.pull=pull;
  A.sync.boundCheck=function(){var id=state.checkId||(key&&state.role==='guest'?lastRead().checkId:null);return id?A.serviceChecks().find(function(c){return c.id===id;}):null;};
  A.sync.onState=function(f){stateFns.push(f);f(netState());};
  A.sync.job=function(id){return queue[id]?'pending':refused[id]?'refused':null;};
  observers.push(emitState);
  if(global.addEventListener){global.addEventListener('online',emitState);global.addEventListener('offline',emitState);}
  /* T4: fn runs once, after the first successful read, when the server has named this page's role, so an
     owner write made then is queued. Without a credential there is nothing to wait for: it runs at once. */
  var readyFns=[],readyDone=!key&&!signedIn;
  A.sync.onReady=function(fn){if(readyDone)fn();else readyFns.push(fn);};
  observers.push(function(s){if(readyDone||!s.lastPull)return;readyDone=true;readyFns.splice(0).forEach(function(fn){Promise.resolve().then(fn).then(null,function(e){if(global.console)global.console.error(e);});});});
  /* T8: bill keys and closed bills (supabase/followups-2026-09-24.sql). A bill key keeps
     working for 24 hours after its bill closes, for the receipt and cancel paths.
     - The check comes back closed: closed() turns true and onClosed(fn) fires once with the
       message the page shows. The key is KEPT, so the receipt box still works; attach()
       may then replace it with the table's next bill.
     - The server refuses the key (400: the grace period is over, or the key never
       existed): the key is dropped, unsent requests for that bill are recorded as refused,
       onClosed fires if it had not, and this tab remembers it so a reload stays on the
       message. The page stays live, never the demo.
     A new key (a new bill link, or attach()) clears both. */
  var CLOSED='aal.bill-closed:'+rid,CLOSED_MSG='This bill is closed. Scan the table code again for a new bill.',closedNow=false,closedFor=null,closedFns=[];
  function announceClosed(){closedFns.forEach(function(f){try{f(CLOSED_MSG);}catch(e){}});}
  function markClosed(cid){
    if(closedNow&&closedFor===cid)return;
    closedNow=true;closedFor=cid;update();announceClosed();
  }
  function boundClosed(res){
    if(!guestPage||!res||!res.checkId)return false;
    var c=(res.rows||[]).filter(function(r){return r.collection==='aal.checks'&&r.id===res.checkId;})[0];
    return !!(c&&c.body&&c.body.closedAt);
  }
  function billEnded(){
    if(!guestPage||key.indexOf('chk_')!==0)return;
    var dead=key,told=closedNow;closedNow=true;
    Object.keys(queue).forEach(function(id){refuse(id,queue[id],CLOSED_MSG,queue[id].kind==='event');});
    queue={};persist();
    key='';delete headers['x-aalayna-key'];state.role=null;state.checkId=null;ready=false;online=false;A.sync.enabled=false;
    reads.ok=null;reads.fails=0;
    try{if(global.localStorage.getItem(credentialKey)===dead)global.localStorage.removeItem(credentialKey);}catch(e){}
    try{global.localStorage.removeItem(A.util.storageKey('aal.sync.read'));}catch(e){}
    try{global.sessionStorage.setItem(CLOSED,'1');}catch(e){}
    A.demoMode=function(){return false;};
    update();
    if(!told)announceClosed();
  }
  A.sync.onClosed=function(f){closedFns.push(f);if(closedNow)f(CLOSED_MSG);};
  A.sync.closed=function(){return closedNow;};
  if(guestPage){
    if(key){try{global.sessionStorage.removeItem(CLOSED);}catch(e){}}
    else{var closedMark='';try{closedMark=global.sessionStorage.getItem(CLOSED)||'';}catch(e){}if(closedMark){closedNow=true;A.demoMode=function(){return false;};}}
  }
  /* T8: a staff device that changes credential for this venue (an owner link to a signed-in
     session, the reverse, or a replaced owner key) keeps its unsent changes. After the first
     read names this credential's role, the outbox of the venue's other staff credentials on
     this device moves into this one: everything for an owner; for a waiter, what a waiter may
     send (bill entry, bill links, cash, events, the floor plan), the rest stays where it was.
     A signed-in page takes over owner-link outboxes only, never another person's session. */
  var carried=false,WAITER_OPS=['open_check','update_check','issue_key','confirm_cash','cancel'];
  function sendable(j){
    if(state.role==='owner')return true;
    if(state.role!=='waiter'||!j)return false;
    return j.kind==='event'||(j.kind==='doc'&&j.body&&j.body.key==='aal.floor')||(j.kind==='op'&&WAITER_OPS.indexOf(j.op)>=0);
  }
  function carryOutbox(){
    if(guestPage)return 0;
    var here=A.util.storageKey('aal.outbox'),found=[],moved=0,i,k;
    try{for(i=0;i<global.localStorage.length;i++){k=global.localStorage.key(i);if(k&&k!==here&&k.indexOf('aal.scope:')===0&&k.slice(-11)===':aal.outbox')found.push(k);}}catch(e){return 0;}
    found.forEach(function(k){
      var scope,jobs,left={};
      try{scope=JSON.parse(k.slice(10,-11));}catch(e){return;}
      if(Object.prototype.toString.call(scope)!=='[object Array]'||scope[0]!==rid)return;
      if(!((scope[1]==='owner'&&/^own_/.test(scope[2]||''))||(scope[1]==='staff'&&!signedIn)))return;
      try{jobs=JSON.parse(global.localStorage.getItem(k)||'{}')||{};}catch(e){return;}
      Object.keys(jobs).forEach(function(id){
        var j=jobs[id];if(!j)return;
        if(!sendable(j)){left[id]=j;return;}
        if(queue[id])return;
        delete j.waiter;delete j.blocked;queue[id]=j;moved++;
      });
      try{if(Object.keys(left).length)global.localStorage.setItem(k,JSON.stringify(left));else global.localStorage.removeItem(k);}catch(e){}
    });
    if(moved)persist();
    return moved;
  }
  A.sync.carryOutbox=carryOutbox;
  if(!key&&!signedIn){A.sync.ready=Promise.resolve();return;}
  var started=false;
  start();
  function start(docs){
  A.util.activateScope(JSON.stringify(signedIn?[rid,'staff',Auth.scope()]:[rid,state.role,key]));
  (docs||[]).forEach(function(d){if(d&&['aal.live','aal.rate','aal.rate_meta'].indexOf(d.key)>=0&&d.body!=null)A.util.rawWrite(d.key,d.body);});
  try{queue=JSON.parse(global.localStorage.getItem(A.util.storageKey('aal.outbox'))||'{}')||{};}catch(e){queue={};}
  // T8: an older page kept refused jobs as blocked; each gets one more try under the rules above
  Object.keys(queue).forEach(function(id){if(queue[id]&&queue[id].blocked)delete queue[id].blocked;});
  loadRefused();
  // T8: attach() after a closed bill starts again here; hooks, timers and the status line are set once
  if(!started){started=true;once();}
  A.sync.ready=pull().then(function(){return run();}).catch(function(e){fail(e);throw e;});
  A.sync.ready.catch(function(){});
  }
  function once(){
  // Seed/local-only history is intentionally not queued on boot.
  A.util.hooks.afterWrite.push(function(k,v){
    if(paused||A.venueId()!==rid)return;
    // T8: a waiter's floor plan (table-to-server assignment) is sent too; docs_write admits it
    if(DOCS.indexOf(k)>=0&&(state.role==='owner'||(state.role==='waiter'&&k==='aal.floor'))){
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
    if(STAFF_ROLES.indexOf(state.role)<0){var c=A.sync.boundCheck();if(!c)throw new Error('This bill is not available. Ask your server for its current link.');return c;}
    var lines=input.lines&&input.lines.length?billLines(input.lines):[];
    var total=lines.length?lines.reduce(function(n,l){return n+A.util.cents(l.p);},0):A.util.cents(input.total);
    if(!Number.isSafeInteger(total)||total<=0||!Number.isInteger(Number(input.table))||Number(input.table)<1)throw new Error('A check needs a table and a positive total.');
    var rate=A.rate();return mutate('open_check',{id:A.util.uid(),table:Number(input.table),totalCents:total,lines:lines,currency:'USD',fxRateUsed:rate,amountUsd:total/100,sessionId:A.session(),deviceId:A.device()});
  };
  A.updateServiceCheck=function(id,lines){
    if(STAFF_ROLES.indexOf(state.role)<0)throw new Error('Only staff may change a bill.');
    var plan=A.planCheckUpdate(id,lines);
    return mutate('update_check',{checkId:id,requestId:A.util.uid(),baseRevision:plan.check.revision||1,lines:plan.lines,sessionId:A.session(),deviceId:A.device()});
  };
  A.sync.issueCheckKey=function(id){return mutate('issue_key',{checkId:id});};
  A.reset=function(){throw new Error('Shared restaurant records cannot be reset from a demo control.');};
  function tick(){if(paused||(!key&&!signedIn)||global.document.visibilityState==='hidden')return;pull().then(run).catch(fail);}
  setInterval(tick,4000);global.document.addEventListener('visibilitychange',function(){if(global.document.visibilityState==='visible')tick();});global.addEventListener('online',tick);
  // A compact status line; the receipt keeps its one-screen layout.
  function mount(){
    var node=global.document.createElement('div');node.id='aal-sync-status';node.setAttribute('role','status');node.setAttribute('aria-live','polite');
    node.style.cssText='position:fixed;right:8px;top:6px;z-index:9999;max-width:calc(100vw - 16px);font:11px system-ui;background:#fff8e9;color:#173e43;border:1px solid #ddd3c0;border-radius:6px;padding:5px 8px';
    var label=global.document.createElement('span'),retry=global.document.createElement('button'),dismiss=global.document.createElement('button');
    retry.textContent='Retry';retry.style.marginLeft='8px';retry.onclick=function(){A.sync.retry();};
    // T8: a refusal is shown once, until dismissed; Retry is only for changes waiting on the network
    dismiss.textContent='Dismiss';dismiss.style.marginLeft='8px';dismiss.onclick=function(){A.sync.dismiss();};
    node.append(label,retry,dismiss);global.document.body.appendChild(node);
    A.sync.subscribe(function(s){label.textContent=statusText(s);node.title=s.lastError||'';node.hidden=s.status==='no-key';retry.hidden=s.status!=='offline';dismiss.hidden=s.status!=='error';});
  }
  if(global.document.body)mount();else global.document.addEventListener('DOMContentLoaded',mount);
  }
})(window);
