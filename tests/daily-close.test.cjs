/* Daily close email (T15). supabase/functions/daily-close/handler.js runs against a fake
   PostgREST (a small interpreter of exactly the filters the handler sends: eq, gte, lt, is.null,
   in, the body->>field paths, limit/offset, and insert-ignore-duplicates on the log's unique
   key) and a fake Resend. Proves:
   - the window is Beirut 04:00 to 04:00 in summer (UTC+3), winter (UTC+2) and across both
     clock changes (a 23 hour and a 25 hour day), start inclusive and end exclusive;
   - the figures on a small fixture: bills opened/closed/still open, cash, digital by rail, tips,
     pending cash (including older than the window), cancelled/expired, refunds, receipts and
     marketing opt-ins, ratings, top five dishes, the LBP line, and statuses as of 04:00;
   - the CSV, the email, the recipients (owners and managers, not waiters, not revoked),
     one message per recipient with the CSV attached in base64;
   - the log: a rerun says "already sent" and sends nothing, ?force=1 sends again, a failure is
     retried by the next plain call, a fresh "in progress" row is left alone;
   - 401 without the secret; the cron call closes the latest finished day that has no sent row, so
     of the 01:00 / 02:00 UTC pair the one that is 04:00 in Beirut sends and the other is the retry
     (summer, winter, and a failed send picked up by the next call);
   - a window with no bills and no payment records is skipped as 'no activity', unless forced;
   - supabase/daily-close-2026-09-30.sql keeps the rules it states (static checks).
   ../_shared/supabase.js and ../_shared/resend.js belong to T14 and are not imported: the handler
   receives rest and send, and the tests pass fakes. Node imports a copy of handler.js as .mjs so the
   test does not depend on the Node version's ES module detection. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
let loaded;
const mod=()=>loaded||(loaded=(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'daily-close-')),file=path.join(dir,'handler.mjs');
 fs.copyFileSync(path.join(root,'supabase/functions/daily-close/handler.js'),file);return import(pathToFileURL(file).href);})());
const iso=ms=>new Date(ms).toISOString(),at=s=>Date.parse(s);
const SECRET='test-cron-secret-not-real';
const RID='["kababji","hamra"]',RID2='["mayda","hamra"]',RID3='["quiet","gemmayzeh"]';
const T=(t)=>'2026-09-30T'+t+'Z';   // inside business day 2026-09-30: 2026-09-30T01:00Z to 2026-10-01T01:00Z
const CRON_NOW=at('2026-10-01T01:00:00Z');   // 04:00 in Beirut

/* ---------------------------------------------------------------- fakes */
function fakeDb(seed){
 const db=Object.assign({venue_profiles:[],staff_members:[],kv_docs:[],kv_rows:[],daily_close_log:[]},seed),calls=[];
 const RESERVED=new Set(['select','order','limit','offset','on_conflict']),isoLike=/^\d{4}-\d\d-\d\dT/;
 const cell=(row,col)=>{const m=/^(\w+)->>(\w+)$/.exec(col);if(m){const v=row[m[1]]&&row[m[1]][m[2]];return v==null?null:String(v);}return row[col]==null?null:row[col];};
 const cmp=(a,b)=>isoLike.test(String(a))&&isoLike.test(String(b))?Date.parse(a)-Date.parse(b):String(a)<String(b)?-1:String(a)>String(b)?1:0;
 const test1=(op,val,c)=>{
  if(op==='is.null')return c===null;
  if(c===null)return false;
  if(op.startsWith('eq.'))return String(c)===op.slice(3);
  if(op.startsWith('gte.'))return cmp(c,op.slice(4))>=0;
  if(op.startsWith('lt.'))return cmp(c,op.slice(3))<0;
  if(op.startsWith('in.(')&&op.endsWith(')'))return op.slice(4,-1).split(',').includes(String(c));
  throw new Error('fake PostgREST: unsupported filter '+op);
 };
 const match=(table,params)=>db[table].filter(row=>{for(const [k,v] of params)if(!RESERVED.has(k)&&!test1(v,null,cell(row,k)))return false;return true;});
 db.calls=calls;db.fail=null;
 db.rest=async(p,opts={})=>{
  const i=p.indexOf('?'),table=i<0?p:p.slice(0,i),params=new URLSearchParams(i<0?'':p.slice(i+1)),method=opts.method||'GET';
  calls.push({table,method,path:p});
  if(!db[table]||Array.isArray(db[table])===false)throw new Error('fake PostgREST: no table '+table);
  if(db.fail&&db.fail(table,method))throw new Error('database down');
  if(method==='GET'){
   let rows=match(table,params);
   if((params.get('order')||'').startsWith('id'))rows=rows.slice().sort((a,b)=>String(a.id).localeCompare(String(b.id)));
   const off=Number(params.get('offset')||0),lim=params.has('limit')?Number(params.get('limit')):rows.length;
   return JSON.parse(JSON.stringify(rows.slice(off,off+lim)));
  }
  if(method==='POST'){
   const body=JSON.parse(opts.body),prefer=(opts.headers||{}).Prefer||'',out=[];
   for(const item of body){
    if(table==='daily_close_log'&&db[table].some(r=>r.restaurant_id===item.restaurant_id&&r.day===item.day)){
     if(prefer.includes('ignore-duplicates'))continue;throw new Error('409 duplicate key');
    }
    const row=Object.assign({id:'log-'+(db[table].length+1)},item);db[table].push(row);out.push(row);
   }
   return prefer.includes('return=representation')?JSON.parse(JSON.stringify(out)):null;
  }
  if(method==='PATCH'){const patch=JSON.parse(opts.body);match(table,params).forEach(r=>Object.assign(r,patch));return null;}
  throw new Error('fake PostgREST: method '+method);
 };
 return db;
}
function fakeResend(){
 const r={sent:[],failFor:new Set(),n:0};
 r.send=async(m)=>{if(r.failFor.has(m.to))throw new Error('resend rejected '+m.to);r.sent.push(m);return {id:'em-'+(++r.n)};};
 return r;
}
const kv=(rid,collection,id,body,updated)=>({restaurant_id:rid,collection,id,body,updated_at:updated||body.updatedAt||body.closedAt||body.openedAt||body.createdAt});
/* a settlement row: updated_at is the last change, as the touch trigger would leave it */
const settle=(rid,id,body)=>{const b=Object.assign({id,venueId:rid,currency:'USD',tip:0},body);
 const last=[b.ts,b.confirmedAt,b.cancelled,b.refunded,b.failedAt].filter(Boolean).sort().pop();return kv(rid,'aal.settle',id,b,last);};
const check=(rid,id,body)=>kv(rid,'aal.checks',id,Object.assign({id,venueId:rid},body),[body.openedAt,body.closedAt].filter(Boolean).sort().pop());

function fixture(){
 const rows=[
  // bills
  check(RID,'c1',{table:4,openedAt:T('10:00:00.000'),closedAt:T('12:00:00.000'),totalCents:3200,lines:[{id:'d1',q:3,p:36,name:'Hummus'},{id:'d2',q:2,p:40,name:'Kebab'}]}),
  check(RID,'c2',{table:7,openedAt:T('18:00:00.000'),closedAt:T('19:00:00.000'),totalCents:9000,lines:[{id:'d1',q:2,p:24,name:'Hummus'},{id:'d3',q:5,p:50,name:'Fattoush'},{id:'d4',q:1,p:3,name:'Tea'},{id:'d5',q:1,p:4},{id:'d6',q:1,p:9,name:'Cake'},{id:'d7',q:1,p:1}]}),
  check(RID,'c3',{table:9,openedAt:T('20:00:00.000'),totalCents:5000,lines:[{id:'d1',q:10,p:120,name:'Hummus'}]}),
  check(RID,'c4',{table:2,openedAt:T('00:00:00.000'),closedAt:T('01:30:00.000'),totalCents:1000,lines:[{id:'d1',q:1,p:12,name:'Hummus'}]}),   // opened 03:00 Beirut, before the window
  check(RID,'c5',{table:12,openedAt:'2026-09-29T15:00:00.000Z',totalCents:900,lines:[]}),                                                 // open since the day before; untouched since
  // payments
  settle(RID,'p1',{checkId:'c1',table:4,rail:'cash',amount:32,tip:2,amountUsd:32,status:'confirmed',ts:T('11:00:00.000'),confirmedAt:T('11:05:00.000')}),
  settle(RID,'p2',{checkId:'c2',table:7,rail:'card',amount:55,tip:5,amountUsd:55,status:'confirmed',ts:T('18:40:00.000'),confirmedAt:T('18:50:00.000'),externalRef:'ref-1'}),
  settle(RID,'p3',{checkId:'c2',table:7,rail:'whish',amount:20,tip:1,amountUsd:20,status:'confirmed',ts:T('18:41:00.000'),confirmedAt:T('18:52:00.000'),externalRef:'=2+5'}),
  settle(RID,'p4',{checkId:'c4',table:2,rail:'cash',amount:10,amountUsd:10,status:'confirmed',ts:T('01:10:00.000'),confirmedAt:T('01:20:00.000')}),
  settle(RID,'p5',{checkId:'c3',table:9,rail:'cash',amount:15,amountUsd:15,status:'pending',ts:T('21:00:00.000')}),
  settle(RID,'p6',{checkId:'c5',table:12,rail:'cash',amount:8,amountUsd:8,status:'pending',ts:'2026-09-28T10:00:00.000Z'}),   // older, still pending
  settle(RID,'p7',{checkId:'c3',table:9,rail:'card',amount:9,amountUsd:9,status:'cancelled',cancelled:T('13:05:00.000'),ts:T('13:00:00.000')}),
  settle(RID,'p8',{checkId:'c3',table:9,rail:'whish',amount:9,amountUsd:9,status:'initiated',expiresAt:T('14:10:00.000'),ts:T('14:00:00.000')}),
  settle(RID,'p9',{checkId:'c3',table:5,rail:'cash',amount:12,amountUsd:12,status:'confirmed',ts:T('14:55:00.000'),confirmedAt:T('15:00:00.000'),refunded:T('16:00:00.000')}),
  settle(RID,'p10',{checkId:'x',table:6,rail:'cash',amount:6,amountUsd:6,status:'confirmed',ts:'2026-09-29T11:55:00.000Z',confirmedAt:'2026-09-29T12:00:00.000Z',refunded:T('09:00:00.000')}),
  settle(RID,'p11',{checkId:'c3',table:9,rail:'cash',amount:4,amountUsd:4,status:'confirmed',ts:T('22:00:00.000'),confirmedAt:T('22:01:00.000'),refunded:'2026-10-01T05:00:00.000Z'}),   // refunded after the close
  settle(RID,'p12',{checkId:'c3',table:9,rail:'card',amount:9,amountUsd:9,status:'failed',ts:T('23:00:00.000'),failedAt:T('23:02:00.000')}),
  settle(RID,'p13',{checkId:'c3',table:6,rail:'cash',amount:5,amountUsd:5,status:'confirmed',ts:'2026-10-01T00:40:00.000Z',confirmedAt:'2026-10-01T03:00:00.000Z'}),   // confirmed after the close
  settle(RID,'p14',{checkId:'c2',table:7,rail:'card',amount:895000,tip:89500,currency:'LBP',amountUsd:10,status:'confirmed',ts:T('19:10:00.000'),confirmedAt:T('19:11:00.000')}),
  settle(RID,'p15',{checkId:'old',table:3,rail:'cash',amount:100,amountUsd:100,status:'confirmed',ts:'2026-09-29T12:00:00.000Z',confirmedAt:'2026-09-29T12:05:00.000Z'}),   // the day before: in no figure, not in the CSV
  // guests: receipts and offers
  kv(RID,'aal.guests','g1',{id:'g1',consentHistory:[{at:T('12:00:00.000'),source:'receipt',settlementId:'p1',receipt:true,marketing:true},{at:T('13:00:00.000'),source:'receipt',settlementId:'p1',receipt:true,marketing:false}]},T('13:00:00.000')),
  kv(RID,'aal.guests','g2',{id:'g2',consentHistory:[{at:T('18:55:00.000'),source:'receipt',settlementId:'p2',receipt:true,marketing:true}]},T('18:55:00.000')),
  kv(RID,'aal.guests','g3',{id:'g3',consentHistory:[{at:T('16:10:00.000'),source:'receipt',settlementId:'p9',receipt:true,marketing:true}]},T('16:10:00.000')),   // refunded payment
  kv(RID,'aal.guests','g4',{id:'g4',consentHistory:[{at:'2026-09-29T12:00:00.000Z',source:'receipt',settlementId:'p10',receipt:true,marketing:true}]},T('05:00:00.000')),   // the day before
  kv(RID,'aal.guests','g5',{id:'g5',consentHistory:[{at:T('19:00:00.000'),source:'receipt',settlementId:'p3',receipt:false,marketing:true}]},T('19:00:00.000')),   // no receipt asked
  kv(RID,'aal.guests','g6',{id:'g6',consentHistory:[{at:T('19:20:00.000'),source:'receipt',settlementId:'p3',receipt:true,marketing:true}]},T('19:20:00.000')),
  // ratings
  kv(RID,'aal.events','e1',{eventId:'e1',eventType:'review_submitted',createdAt:T('12:30:00.000'),payload:{rating:5}},T('12:30:00.000')),
  kv(RID,'aal.events','e2',{eventId:'e2',eventType:'review_submitted',createdAt:T('19:30:00.000'),payload:{rating:4,destination:'private'}},T('19:30:00.000')),
  kv(RID,'aal.events','e3',{eventId:'e3',eventType:'review_submitted',createdAt:T('20:30:00.000'),payload:{rating:2}},T('20:30:00.000')),
  kv(RID,'aal.events','e4',{eventId:'e4',eventType:'review_submitted',createdAt:'2026-09-29T20:00:00.000Z',payload:{rating:5}},'2026-09-29T20:00:00.000Z'),   // before the window
  kv(RID,'aal.events','e5',{eventId:'e5',eventType:'review_submitted',createdAt:T('21:30:00.000'),payload:{rating:'abc'}},T('21:30:00.000')),
  kv(RID,'aal.events','e6',{eventId:'e6',eventType:'review_submitted',createdAt:T('21:31:00.000'),payload:{rating:6}},T('21:31:00.000')),
  kv(RID,'aal.events','e7',{eventId:'e7',eventType:'qr_scan',createdAt:T('12:00:00.000'),payload:{rating:1}},T('12:00:00.000')),
  // another venue: its own figures, never mixed in
  settle(RID2,'m1',{checkId:'mc1',table:1,rail:'cash',amount:7,amountUsd:7,status:'confirmed',ts:T('12:00:00.000'),confirmedAt:T('12:01:00.000')}),
  check(RID2,'mc1',{table:1,openedAt:T('11:00:00.000'),closedAt:T('12:05:00.000'),totalCents:700,lines:[{id:'z1',q:1,p:7,name:'Lemonade'}]})
 ];
 return fakeDb({
  venue_profiles:[
   {restaurant_id:RID,name:'Kababji',place:'Hamra',slug:'kababji-hamra'},
   {restaurant_id:RID2,name:'Mayda',place:'Hamra',slug:'mayda'},
   {restaurant_id:RID3,name:'Quiet Cafe',place:'Gemmayzeh',slug:'quiet'}],
  staff_members:[
   {restaurant_id:RID,email:'owner@kababji.example',role:'owner',revoked_at:null},
   {restaurant_id:RID,email:'manager@kababji.example',role:'manager',revoked_at:null},
   {restaurant_id:RID,email:'waiter@kababji.example',role:'waiter',revoked_at:null},
   {restaurant_id:RID,email:'former@kababji.example',role:'manager',revoked_at:'2026-09-01T00:00:00.000Z'},
   {restaurant_id:RID,email:'not-an-email',role:'owner',revoked_at:null},
   {restaurant_id:RID2,email:'owner@mayda.example',role:'owner',revoked_at:null},
   {restaurant_id:RID3,email:'waiter@quiet.example',role:'waiter',revoked_at:null}],
  kv_docs:[
   {restaurant_id:RID,key:'aal.rate',body:89500},
   {restaurant_id:RID,key:'aal.live',body:{items:[{id:'d5',name:'Cola'},{id:'d7',name:'Water'}]}},
   {restaurant_id:RID,key:'aal.floor',body:{tables:{}}}],
  kv_rows:rows
 });
}
function harness(db,{now=CRON_NOW,env={AALAYNA_CRON_SECRET:SECRET},resend=fakeResend()}={}){
 const state={now};
 return mod().then(m=>{
  const handle=m.createHandler({rest:db.rest,send:resend.send,now:()=>state.now,env:name=>env[name]});
  const call=(qs='',{secret=SECRET,method='POST'}={})=>handle(new Request('https://x.test/functions/v1/daily-close'+qs,{method,headers:secret==null?{}:{'X-Aalayna-Cron':secret}}));
  return {m,db,resend,handle,call,state};
 });
}
const body=async r=>r.json();
const summer=at('2026-07-15T01:00:00Z'),winter=at('2026-01-15T02:00:00Z');

/* -------------------------------------------------------------- windows */
test('the window is Beirut 04:00 to 04:00: UTC+3 in summer, UTC+2 in winter, and across both clock changes',async()=>{
 const m=await mod();
 const w=d=>{const x=m.windowFor(d);return [iso(x.start),iso(x.end)];};
 assert.deepEqual(w('2026-07-14'),['2026-07-14T01:00:00.000Z','2026-07-15T01:00:00.000Z']);   // summer
 assert.deepEqual(w('2026-01-14'),['2026-01-14T02:00:00.000Z','2026-01-15T02:00:00.000Z']);   // winter
 assert.deepEqual(w('2026-09-30'),['2026-09-30T01:00:00.000Z','2026-10-01T01:00:00.000Z']);
 const spring=m.windowFor('2026-03-28'),autumn=m.windowFor('2026-10-24');                   // clocks change at midnight on the Sunday
 assert.equal((spring.end-spring.start)/3600000,23);assert.equal(iso(spring.end),'2026-03-29T01:00:00.000Z');
 assert.equal((autumn.end-autumn.start)/3600000,25);assert.equal(iso(autumn.end),'2026-10-25T02:00:00.000Z');
 for(const d of ['2026-07-14','2026-01-14','2026-03-28','2026-10-24']){
  const x=m.windowFor(d),p=m.beirutParts(x.start),q=m.beirutParts(x.end);
  assert.equal(p.hour,4);assert.equal(p.minute,0);assert.equal(q.hour,4);assert.equal(m.beirutDate(x.start),d);assert.equal(m.beirutDate(x.end),m.addDays(d,1));
 }
 assert.equal(m.addDays('2026-12-31',1),'2027-01-01');assert.equal(m.addDays('2026-03-01',-1),'2026-02-28');
 assert.equal(m.dayLabel('2025-09-30'),'Tuesday 30 September');assert.equal(m.dayLabel('2026-09-30'),'Wednesday 30 September');
});
test('start is inclusive and end is exclusive, in summer and in winter, so late-night service belongs to the night it started',async()=>{
 const m=await mod();
 for(const [day,startIso,endIso] of [['2026-07-14','2026-07-14T01:00:00.000Z','2026-07-15T01:00:00.000Z'],['2026-01-14','2026-01-14T02:00:00.000Z','2026-01-15T02:00:00.000Z']]){
  const w=m.windowFor(day),s=at(startIso),e=at(endIso),shift=ms=>iso(ms);
  const opened=[['before',shift(s-1)],['atStart',shift(s)],['lastMs',shift(e-1)],['atEnd',shift(e)],['midnight',shift(s+20*3600000)]];   // 20:00 later = 23:00 Beirut
  const checks=opened.map(([id,t])=>({id,body:{id,table:1,openedAt:t,lines:[]}}));
  const f=m.computeClose({window:w,checks,settles:[],guests:[],events:[],docs:[]});
  assert.equal(f.bills.opened,3,day);                   // atStart, lastMs and the late-night one; not before, not atEnd
  // 03:59 the next morning still belongs to the previous night; 04:00 does not
  const late=m.computeClose({window:w,checks:[{id:'a',body:{id:'a',table:1,openedAt:iso(e-60000),lines:[]}},{id:'b',body:{id:'b',table:2,openedAt:iso(e),lines:[]}}],settles:[],guests:[],events:[],docs:[]});
  assert.equal(late.bills.opened,1);
 }
});

/* ------------------------------------------------------------- figures */
test('the figures on the fixture: bills, cash, digital by rail, tips, pending, cancelled, refunds, receipts, ratings, dishes',async()=>{
 const h=await harness(fixture());
 const r=await h.call('?venue='+encodeURIComponent(RID)+'&date=2026-09-30'),j=await body(r);
 assert.equal(r.status,200);assert.equal(j.results[0].status,'sent');
 // the emailed text is the whole product; computeClose's numbers are asserted separately below
 const mail=h.resend.sent[0];
 assert.equal(mail.subject,'Kababji: Wednesday 30 September, on Aalayna');
 const t=mail.text;
 assert.match(t,/Bills opened:\s+3\n/);
 assert.match(t,/Bills closed:\s+3\n/);
 assert.match(t,/Still open at 04:00:\s+2 \(tables 9, 12\)/);
 assert.match(t,/Cash confirmed:\s+3 payments, \$46\.00 \(LL 4,117,000\)/);              // p1 32 + p4 10 + p11 4; p13 only confirmed after the close
 assert.match(t,/Digital confirmed:\s+3 payments, \$85\.00/);                              // 55 + 20 + 10 (LBP row via amountUsd)
 assert.match(t,/Card:\s+2 payments, \$65\.00/);assert.match(t,/Whish:\s+1 payment, \$20\.00/);
 assert.match(t,/Tips:\s+\$9\.00 \(Card \$6\.00, Cash \$2\.00, Whish \$1\.00\)/);         // the LBP tip is scaled: 89,500 LL = $1.00
 assert.match(t,/Refunds:\s+2 refunds, \$18\.00/);                                          // p9 same day, p10 from the day before; p11 was refunded after the close
 assert.match(t,/Requests cancelled or expired:\s+2 \(and 1 failed\)/);
 assert.match(t,/Receipts requested:\s+3, of which 2 agreed to restaurant offers/);
 assert.match(t,/Guests who rated:\s+3, average 3\.7 out of 5/);
 assert.match(t,/Cash requested and never confirmed: 3, \$28\.00, tables 6, 9, 12; 1 of them from before Wednesday 30 September/);
 assert.match(t,/Bills still open: tables 9, 12\./);
 assert.match(t,/1\. Hummus, 6\n2\. Fattoush, 5\n3\. Kebab, 2\n4\. Cake, 1\n5\. Cola, 1\n/);   // closed bills only; the open bill's 10 Hummus is not counted; Cola named from aal.live
 assert.doesNotMatch(t,/Tea|Water/);
 assert.doesNotMatch(t+mail.html,/[\u2014\u{1F300}-\u{1FAFF}]/u);                            // no em dash, no emoji
});
test('computeClose numbers, exactly',async()=>{
 const db=fixture(),m=await mod(),rid=encodeURIComponent(RID),q=async(t,x)=>db.rest(t+'?'+x);
 const f=m.computeClose({window:m.windowFor('2026-09-30'),checks:await q('kv_rows',`restaurant_id=eq.${rid}&collection=eq.aal.checks`),settles:await q('kv_rows',`restaurant_id=eq.${rid}&collection=eq.aal.settle`),
  guests:await q('kv_rows',`restaurant_id=eq.${rid}&collection=eq.aal.guests`),events:await q('kv_rows',`restaurant_id=eq.${rid}&collection=eq.aal.events`),docs:await q('kv_docs',`restaurant_id=eq.${rid}`)});
 assert.deepEqual(f.bills,{opened:3,closed:3,stillOpen:2,stillOpenTables:['9','12']});
 assert.deepEqual(f.cash,{count:3,usdCents:4600,lbp:4117000});
 assert.equal(f.digital.count,3);assert.equal(f.digital.usdCents,8500);assert.deepEqual(f.digital.rails,{card:{count:2,usdCents:6500},whish:{count:1,usdCents:2000}});
 assert.deepEqual(f.tips,{usdCents:900,byRail:{cash:200,card:600,whish:100}});
 assert.equal(f.pendingCash.count,3);assert.equal(f.pendingCash.usdCents,2800);assert.deepEqual(f.pendingCash.tables,['6','9','12']);assert.equal(f.pendingCash.older,1);
 assert.equal(f.cancelledOrExpired,2);assert.equal(f.failed,1);
 assert.deepEqual(f.refunds,{count:2,usdCents:1800});
 assert.deepEqual(f.receipts,{requested:3,marketingOptIns:2});
 assert.deepEqual(f.ratings,{count:3,average:3.7});
 assert.deepEqual(f.topDishes.map(d=>[d.name,d.qty]),[['Hummus',6],['Fattoush',5],['Kebab',2],['Cake',1],['Cola',1]]);
 assert.equal(f.unconverted,0);
 // the same figures with the close moved a day later: p11's refund and p13's confirmation now count
 const later=m.computeClose({window:m.windowFor('2026-09-30'),checks:[],settles:await q('kv_rows',`restaurant_id=eq.${rid}&collection=eq.aal.settle`),guests:[],events:[],docs:[]});
 assert.equal(later.cash.count,3);   // unchanged: the window, not the rerun date, decides
});
test('without a rate on file the cash line has no lira amount; a rate outside 1,000 to 10,000,000 is ignored like the dashboard does',async()=>{
 const m=await mod(),db=fixture();db.kv_docs=db.kv_docs.filter(d=>d.key!=='aal.rate');
 const h=await harness(db);await h.call('?venue='+encodeURIComponent(RID)+'&date=2026-09-30');
 assert.match(h.resend.sent[0].text,/Cash confirmed:\s+3 payments, \$46\.00\n/);assert.doesNotMatch(h.resend.sent[0].text,/LL /);
 assert.equal(m.readRate([{key:'aal.rate',body:5}]),null);assert.equal(m.readRate([{key:'aal.rate',body:{rate:90000}}]),90000);assert.equal(m.readRate([]),null);
});
test('a payment with no USD value on record is left out of the dollars and said so',async()=>{
 const m=await mod(),rid=RID;
 const rows=[settle(rid,'u1',{rail:'card',amount:500,currency:'EUR',status:'confirmed',ts:T('12:00:00.000'),confirmedAt:T('12:01:00.000'),checkId:'c',table:1})];
 const f=m.computeClose({window:m.windowFor('2026-09-30'),checks:[],settles:rows,guests:[],events:[],docs:[]});
 assert.equal(f.unconverted,1);assert.equal(f.digital.count,1);assert.equal(f.digital.usdCents,0);
 const mail=m.buildEmail({venue:{name:'V'},figures:f,csvName:'x.csv'});assert.match(mail.text,/1 payment had no USD value on record/);
 assert.match(m.buildCsv(f.csvRows),/^u1,c,1,card,confirmed,,,EUR,/m);
});

/* ----------------------------------------------------------------- csv */
test('the CSV has a header and one row per payment record of the window, oldest first, statuses as of the close',async()=>{
 const h=await harness(fixture());await h.call('?venue='+encodeURIComponent(RID)+'&date=2026-09-30');
 const att=h.resend.sent[0].attachments;assert.equal(att.length,1);
 assert.equal(att[0].filename,'close-kababji-hamra-2026-09-30.csv');
 const csv=Buffer.from(att[0].content,'base64').toString('utf8'),lines=csv.split('\r\n');
 assert.equal(lines.pop(),'');
 assert.equal(lines[0],'settlementId,checkId,table,rail,status,amountUsd,tipUsd,currency,confirmedAt,externalRef,refunded');
 const by=Object.fromEntries(lines.slice(1).map(l=>[l.split(',')[0],l]));
 assert.equal(lines.length-1,13);assert.equal(by.p6,undefined,'older pending is an open item, not a row of this day');
 assert.equal(by.p1,`p1,c1,4,cash,confirmed,32.00,2.00,USD,${T('11:05:00.000')},,`);
 assert.equal(by.p3,`p3,c2,7,whish,confirmed,20.00,1.00,USD,${T('18:52:00.000')},'=2+5,`);      // a leading = is defused
 assert.equal(by.p14,`p14,c2,7,card,confirmed,10.00,1.00,LBP,${T('19:11:00.000')},,`);
 assert.equal(by.p9,`p9,c3,5,cash,refunded,12.00,0.00,USD,${T('15:00:00.000')},,${T('16:00:00.000')}`);
 assert.equal(by.p10,`p10,x,6,cash,refunded,6.00,0.00,USD,2026-09-29T12:00:00.000Z,,${T('09:00:00.000')}`);   // refunded today, paid yesterday
 assert.match(by.p11,/^p11,c3,9,cash,confirmed,4\.00,0\.00,USD,[^,]+,,$/);                       // its refund came after the close
 assert.match(by.p13,/^p13,c3,6,cash,pending,5\.00,0\.00,USD,2026-10-01T03:00:00\.000Z,,$/);    // confirmed after the close: pending at 04:00
 assert.match(by.p7,/^p7,c3,9,card,cancelled,/);assert.match(by.p8,/^p8,c3,9,whish,expired,/);assert.match(by.p12,/^p12,c3,9,card,failed,/);
 const order=lines.slice(1).map(l=>l.split(',')[0]);
 assert.deepEqual(order.slice(0,2),['p10','p4']);   // by payment time: p10 was paid the afternoon before (and refunded in this window), then p4 at 04:20 Beirut
});
test('CSV text cells that could be read as formulas or break the row are made safe',async()=>{
 const m=await mod();
 const csv=m.buildCsv([{id:'a"b',s:{checkId:'c,1',table:3,rail:'card',currency:'USD',externalRef:'@SUM(1)',confirmedAt:T('12:00:00.000')},rail:'card',status:'confirmed',usd:{amount:1250,tip:0,ok:true}}]);
 assert.equal(csv.split('\r\n')[1],`"a""b","c,1",3,card,confirmed,12.50,0.00,USD,${T('12:00:00.000')},'@SUM(1),`);
});

/* --------------------------------------------------------------- email */
test('the email: subject, both bodies, the venue name escaped, no marketing text',async()=>{
 const m=await mod(),db=fixture();
 const h=await harness(db);await h.call('?venue='+encodeURIComponent(RID)+'&date=2026-09-30');
 const mail=h.resend.sent[0];
 assert.match(mail.html,/<table/);assert.match(mail.html,/Needs action/);assert.match(mail.html,/Top dishes/);
 assert.equal(mail.from,undefined);
 const f=m.computeClose({window:m.windowFor('2026-09-30'),checks:[],settles:[],guests:[],events:[],docs:[]});
 const e=m.buildEmail({venue:{name:'A & <B>\nBcc: x'},figures:f,csvName:'c.csv'});
 assert.equal(e.subject,'A & <B> Bcc: x: Wednesday 30 September, on Aalayna');            // no line break can survive into the subject
 assert.match(e.html,/A &amp; &lt;B&gt;/);assert.doesNotMatch(e.html,/<B>/);
 assert.match(e.text,/Needs action\n- Nothing\./);assert.match(e.text,/No closed bills with items\./);
 assert.match(e.text,/Guests who rated:\s+0\n/);
 assert.doesNotMatch(mail.text+mail.html,/discount|promo|newsletter|unsubscribe|special offer|download the app/i);
});
test('DAILY_CLOSE_FROM, when set, is passed to send as the sender',async()=>{
 const h=await harness(fixture(),{env:{AALAYNA_CRON_SECRET:SECRET,DAILY_CLOSE_FROM:'Aalayna <close@example.invalid>'}});
 await h.call('?venue='+encodeURIComponent(RID2)+'&date=2026-09-30');assert.equal(h.resend.sent[0].from,'Aalayna <close@example.invalid>');
});

/* ---------------------------------------------------------- recipients */
test('recipients are the venue\'s active owners and managers, one message each, with the CSV attached',async()=>{
 const h=await harness(fixture());
 const j=await body(await h.call('?venue='+encodeURIComponent(RID)+'&date=2026-09-30'));
 assert.deepEqual(h.resend.sent.map(x=>x.to).sort(),['manager@kababji.example','owner@kababji.example']);   // not the waiter, the revoked manager, the malformed address, or another venue's staff
 assert.equal(j.results[0].recipients,2);
 const row=h.db.daily_close_log.find(r=>r.restaurant_id===RID);
 assert.equal(row.status,'sent');assert.equal(row.recipients,2);assert.equal(row.provider_id,'em-1,em-2');assert.equal(row.error,null);assert.equal(row.day,'2026-09-30');
 assert.equal(h.resend.sent[0].attachments[0].content,h.resend.sent[1].attachments[0].content);
});
test('a venue with no owner or manager is skipped and the reason is recorded; other venues still go out',async()=>{
 const h=await harness(fixture());
 const j=await body(await h.call('?date=2026-09-30'));
 assert.equal(j.results.length,3);
 const by=Object.fromEntries(j.results.map(r=>[r.restaurantId,r]));
 assert.equal(by[RID3].status,'skipped');assert.match(by[RID3].reason,/no active owner or manager/);
 const log=h.db.daily_close_log.find(r=>r.restaurant_id===RID3);
 assert.equal(log.status,'skipped');assert.equal(log.recipients,0);assert.match(log.error,/no active owner or manager/);
 assert.equal(by[RID].status,'sent');assert.equal(by[RID2].status,'sent');
 // each venue's email holds its own figures only
 const mayda=h.resend.sent.find(x=>x.to==='owner@mayda.example');
 assert.match(mayda.text,/Cash confirmed:\s+1 payment, \$7\.00/);assert.match(mayda.text,/1\. Lemonade, 1/);assert.doesNotMatch(mayda.text,/Hummus/);
 assert.match(mayda.text,/Bills opened:\s+1/);
});

/* ------------------------------------------------------ the log and reruns */
test('a rerun without force answers "already sent" and sends nothing; force sends again and updates the row',async()=>{
 const h=await harness(fixture());
 const qs='?venue='+encodeURIComponent(RID)+'&date=2026-09-30';
 await h.call(qs);assert.equal(h.resend.sent.length,2);
 const again=await h.call(qs),j=await body(again);
 assert.equal(again.status,200);assert.equal(j.message,'already sent');assert.equal(j.results[0].status,'already sent');
 assert.equal(h.resend.sent.length,2);assert.equal(h.db.daily_close_log.filter(r=>r.restaurant_id===RID).length,1);
 h.state.now+=3600000;
 const forced=await body(await h.call(qs+'&force=1'));
 assert.equal(forced.results[0].status,'sent');assert.equal(h.resend.sent.length,4);
 const rows=h.db.daily_close_log.filter(r=>r.restaurant_id===RID);
 assert.equal(rows.length,1);assert.equal(rows[0].status,'sent');assert.equal(rows[0].provider_id,'em-3,em-4');assert.equal(rows[0].created_at,iso(h.state.now));
 assert.equal((await body(await h.call(qs))).message,'already sent');
});
test('a failed send is recorded and the next plain call retries it; a partial failure still counts as sent and says so',async()=>{
 const h=await harness(fixture()),qs='?venue='+encodeURIComponent(RID)+'&date=2026-09-30';
 h.resend.failFor.add('owner@kababji.example');h.resend.failFor.add('manager@kababji.example');
 const bad=await h.call(qs),j=await body(bad);
 assert.equal(bad.status,500);assert.equal(j.results[0].status,'failed');
 let row=h.db.daily_close_log.find(r=>r.restaurant_id===RID);
 assert.equal(row.status,'failed');assert.match(row.error,/send failed for all 2/);assert.equal(row.recipients,0);
 h.resend.failFor.delete('manager@kababji.example');
 const part=await body(await h.call(qs));
 assert.equal(part.results[0].status,'sent');assert.equal(part.results[0].recipients,1);assert.match(part.results[0].warning,/1 of 2 sends failed/);
 row=h.db.daily_close_log.find(r=>r.restaurant_id===RID);assert.equal(row.status,'sent');assert.equal(row.recipients,1);assert.match(row.error,/1 of 2/);
 assert.equal((await body(await h.call(qs))).message,'already sent');
});
test('a database failure while computing is caught per venue and logged; the other venues still go out',async()=>{
 const db=fixture(),h=await harness(db);
 db.fail=(table,method)=>table==='kv_docs'&&db.calls.filter(c=>c.table==='kv_docs').length===1;   // first venue's read fails once
 const r=await h.call('?date=2026-09-30'),j=await body(r);
 assert.equal(r.status,500);
 const st=Object.fromEntries(j.results.map(x=>[x.restaurantId,x.status]));
 assert.equal(Object.values(st).filter(s=>s==='failed').length,1);assert.ok(Object.values(st).includes('sent'));
 const failedRow=db.daily_close_log.find(x=>x.status==='failed');assert.match(failedRow.error,/database down/);
});
test('a fresh "in progress" row is left alone; a stale one is taken over',async()=>{
 const db=fixture(),h=await harness(db),qs='?venue='+encodeURIComponent(RID)+'&date=2026-09-30';
 db.daily_close_log.push({id:'l1',restaurant_id:RID,day:'2026-09-30',recipients:0,status:'failed',error:'in progress',created_at:iso(CRON_NOW-60000)});
 const j=await body(await h.call(qs));assert.equal(j.results[0].status,'in progress');assert.equal(h.resend.sent.length,0);
 db.daily_close_log[0].created_at=iso(CRON_NOW-11*60000);
 const k=await body(await h.call(qs));assert.equal(k.results[0].status,'sent');assert.equal(h.resend.sent.length,2);
});
test('two calls racing for the same day: the claim is the unique key, only one sends',async()=>{
 const db=fixture(),h=await harness(db),qs='?venue='+encodeURIComponent(RID)+'&date=2026-09-30';
 const [a,b]=await Promise.all([h.call(qs),h.call(qs)]);
 const st=[(await body(a)).results[0].status,(await body(b)).results[0].status].sort();
 assert.deepEqual(st,['in progress','sent']);assert.equal(h.resend.sent.length,2);assert.equal(db.daily_close_log.length,1);
});
test('a forced rerun that fails keeps the record of the send that worked',async()=>{
 const h=await harness(fixture()),qs='?venue='+encodeURIComponent(RID2)+'&date=2026-09-30';
 await h.call(qs);h.resend.failFor.add('owner@mayda.example');
 const j=await body(await h.call(qs+'&force=1'));assert.equal(j.results[0].status,'failed');
 const row=h.db.daily_close_log.find(r=>r.restaurant_id===RID2);assert.equal(row.status,'sent');assert.equal(row.recipients,1);assert.match(row.error,/^rerun failed/);
});
test('more rows than one page are all read (2,300 ratings)',async()=>{
 const db=fixture();
 for(let i=0;i<2300;i++)db.kv_rows.push(kv(RID2,'aal.events','bulk'+i,{eventId:'bulk'+i,eventType:'review_submitted',createdAt:T('15:00:00.000'),payload:{rating:i%2?5:4}},T('15:00:00.000')));
 const h=await harness(db);await h.call('?venue='+encodeURIComponent(RID2)+'&date=2026-09-30');
 assert.match(h.resend.sent[0].text,/Guests who rated:\s+2300, average 4\.5 out of 5/);
 assert.ok(db.calls.filter(c=>c.table==='kv_rows'&&/aal\.events/.test(c.path)).length>=3);
});

/* ------------------------------------------------------- auth and routing */
test('401 without the secret, with a wrong one, or when the function has no secret configured; nothing is read or sent',async()=>{
 const h=await harness(fixture());
 for(const secret of [null,'','wrong',SECRET+'x',SECRET.slice(1)]){
  const r=await h.call('?date=2026-09-30',{secret});assert.equal(r.status,401);
 }
 const open=await harness(fixture(),{env:{}});
 assert.equal((await open.call('?date=2026-09-30',{secret:''})).status,401);assert.equal((await open.call('?date=2026-09-30',{secret:'anything'})).status,401);
 assert.equal(h.db.calls.length,0);assert.equal(h.resend.sent.length,0);assert.equal(open.db.calls.length,0);
 assert.equal((await h.call('?date=2026-09-30',{method:'DELETE'})).status,405);
 assert.equal((await h.call('?date=2026-09-30',{method:'GET'})).status,200);
});
/* a one-venue database for the cron scenarios: one owner, one cash payment at 12:00 UTC on `day` */
function mini(day,{owner='owner@solo.example',activity=true}={}){
 const rid='["solo","hamra"]';
 return fakeDb({venue_profiles:[{restaurant_id:rid,name:'Solo',place:'Hamra',slug:'solo'}],
  staff_members:owner?[{restaurant_id:rid,email:owner,role:'owner',revoked_at:null}]:[],kv_docs:[],
  kv_rows:activity?[settle(rid,'s1',{checkId:'k',table:1,rail:'cash',amount:20,amountUsd:20,status:'confirmed',ts:day+'T12:00:00.000Z',confirmedAt:day+'T12:01:00.000Z'})]:[]});
}
const logOf=(db)=>db.daily_close_log.map(r=>[r.day,r.status,r.error]);
test('the cron call closes the latest finished day, whatever the hour: decision in summer, winter and on the clock-change nights',async()=>{
 const m=await mod(),day=s=>m.cronDecision(at(s)).day;
 assert.equal(day('2026-07-15T01:00:00Z'),'2026-07-14');   // summer, 04:00 Beirut
 assert.equal(day('2026-07-15T02:00:00Z'),'2026-07-14');   // 05:00: same day, the retry
 assert.equal(day('2026-01-15T01:00:00Z'),'2026-01-13');   // winter, 03:00: the day that ended yesterday, already sent by then
 assert.equal(day('2026-01-15T02:00:00Z'),'2026-01-14');   // 04:00 Beirut
 assert.equal(day('2026-01-15T02:00:07Z'),'2026-01-14');   // pg_cron a few seconds late
 assert.equal(day('2026-03-29T01:00:00Z'),'2026-03-28');   // clocks go forward at midnight: 04:00 Beirut is 01:00 UTC
 assert.equal(day('2026-03-29T02:00:00Z'),'2026-03-28');
 assert.equal(day('2026-10-25T01:00:00Z'),'2026-10-23');   // clocks go back: 01:00 UTC is 03:00, the 24th has not ended
 assert.equal(day('2026-10-25T02:00:00Z'),'2026-10-24');
});
test('summer: the 01:00 UTC call sends, the 02:00 UTC call finds the sent row and does nothing',async()=>{
 const db=mini('2026-07-14'),h=await harness(db,{now:at('2026-07-15T01:00:00Z')});
 const a=await h.call(''),j=await body(a);
 assert.equal(a.status,200);assert.equal(j.day,'2026-07-14');assert.equal(j.results[0].status,'sent');assert.equal(h.resend.sent.length,1);
 assert.equal(h.resend.sent[0].subject,'Solo: Tuesday 14 July, on Aalayna');
 h.state.now=at('2026-07-15T02:00:00Z');
 const b=await body(await h.call(''));
 assert.equal(b.message,'already sent');assert.equal(b.results[0].status,'already sent');assert.equal(h.resend.sent.length,1);
 assert.deepEqual(logOf(db),[['2026-07-14','sent',null]]);
});
test('winter: the 01:00 UTC call (03:00 Beirut) has nothing to send, the 02:00 UTC call sends, a later call does nothing',async()=>{
 const db=mini('2026-01-14'),h=await harness(db,{now:at('2026-01-15T01:00:00Z')});
 const a=await body(await h.call(''));                      // the day that just ended is the 13th, which had no activity
 assert.equal(a.day,'2026-01-13');assert.equal(a.results[0].reason,'no activity');assert.equal(h.resend.sent.length,0);
 h.state.now=at('2026-01-15T02:00:00Z');
 const b=await body(await h.call(''));
 assert.equal(b.day,'2026-01-14');assert.equal(b.results[0].status,'sent');assert.equal(h.resend.sent.length,1);
 assert.equal(h.resend.sent[0].subject,'Solo: Wednesday 14 January, on Aalayna');
 h.state.now=at('2026-01-15T05:00:00Z');
 assert.equal((await body(await h.call(''))).message,'already sent');assert.equal(h.resend.sent.length,1);
});
test('a failed 04:00 send is picked up by the next cron call with nobody touching it, in summer and in winter',async()=>{
 for(const [day,first,second] of [['2026-07-14','2026-07-15T01:00:00Z','2026-07-15T02:00:00Z'],['2026-01-14','2026-01-15T02:00:00Z','2026-01-16T01:00:00Z']]){
  const db=mini(day),h=await harness(db,{now:at(first)});
  h.resend.failFor.add('owner@solo.example');
  const bad=await h.call('');assert.equal(bad.status,500);assert.deepEqual(logOf(db)[0].slice(0,2),[day,'failed']);assert.equal(h.resend.sent.length,0);
  h.resend.failFor.clear();h.state.now=at(second);
  const ok=await body(await h.call(''));
  assert.equal(ok.day,day);assert.equal(ok.results[0].status,'sent');assert.equal(h.resend.sent.length,1);
  assert.deepEqual(logOf(db),[[day,'sent',null]]);
  h.state.now=at(second)+600000;assert.equal((await body(await h.call(''))).message,'already sent');assert.equal(h.resend.sent.length,1);
 }
});
test('a cron call only touches venues whose day has no sent row; a venue that just gained a recipient is picked up',async()=>{
 const db=fixture(),h=await harness(db);
 const a=await body(await h.call(''));                         // 04:00 Beirut, 1 Oct: the 30th
 assert.equal(a.day,'2026-09-30');assert.equal(h.resend.sent.length,3);       // Kababji 2, Mayda 1; Quiet has no owner or manager
 const callsBefore=db.calls.length;
 h.state.now=at('2026-10-01T02:00:00Z');
 const b=await body(await h.call(''));
 assert.equal(h.resend.sent.length,3);
 const st=Object.fromEntries(b.results.map(r=>[r.restaurantId,r.status]));
 assert.deepEqual(st,{[RID]:'already sent',[RID2]:'already sent',[RID3]:'skipped'});
 assert.equal(db.calls.slice(callsBefore).filter(c=>c.table==='kv_rows').length,0);   // nothing was recomputed for the sent venues
 db.staff_members.push({restaurant_id:RID3,email:'owner@quiet.example',role:'owner',revoked_at:null});
 h.state.now=at('2026-10-01T03:00:00Z');
 const c=await body(await h.call(''));
 assert.equal(c.results.find(r=>r.restaurantId===RID3).reason,'no activity');   // now it has a recipient, and the day was quiet
 assert.equal(h.resend.sent.length,3);
 assert.equal(db.daily_close_log.length,3);
});
test('quiet days: no bill opened or closed and no payment record means no email, logged skipped "no activity"; force still sends the zero email',async()=>{
 const db=mini('2026-09-30',{activity:false}),rid='["solo","hamra"]',h=await harness(db);
 const j=await body(await h.call('?venue='+encodeURIComponent(rid)+'&date=2026-09-30'));
 assert.equal(j.results[0].status,'skipped');assert.equal(j.results[0].reason,'no activity');assert.equal(h.resend.sent.length,0);
 assert.deepEqual(db.daily_close_log.map(r=>({s:r.status,e:r.error,n:r.recipients})),[{s:'skipped',e:'no activity',n:0}]);
 const f=await body(await h.call('?venue='+encodeURIComponent(rid)+'&date=2026-09-30&force=1'));
 assert.equal(f.results[0].status,'sent');assert.equal(h.resend.sent.length,1);
 const t=h.resend.sent[0].text;
 assert.match(t,/Bills opened:\s+0\n/);assert.match(t,/Cash confirmed:\s+0 payments, \$0\.00\n/);assert.match(t,/Nothing\./);
 assert.equal(Buffer.from(h.resend.sent[0].attachments[0].content,'base64').toString('utf8'),'settlementId,checkId,table,rail,status,amountUsd,tipUsd,currency,confirmedAt,externalRef,refunded\r\n');
 assert.deepEqual(db.daily_close_log.map(r=>[r.status,r.error]),[['sent',null]]);
});
test('any one of a bill opened, a bill closed, a payment record or a refund is activity',async()=>{
 const T2=(rid,name,slug)=>({restaurant_id:rid,name,place:'x',slug}),ids=['a','b','c','d','e','f'].map(x=>`["${x}","x"]`);
 const [none,opened,closedOnly,payment,refundOnly,olderOnly]=ids;
 const db=fakeDb({
  venue_profiles:ids.map((r,i)=>T2(r,'V'+i,'v'+i)),
  staff_members:ids.map(r=>({restaurant_id:r,email:`o${r.charCodeAt(2)}@x.example`,role:'owner',revoked_at:null})),kv_docs:[],
  kv_rows:[
   check(opened,'c',{table:1,openedAt:T('12:00:00.000'),lines:[]}),
   check(closedOnly,'c',{table:1,openedAt:'2026-09-29T12:00:00.000Z',closedAt:T('13:00:00.000'),lines:[]}),
   settle(payment,'p',{checkId:'c',table:1,rail:'cash',amount:5,amountUsd:5,status:'pending',ts:T('14:00:00.000')}),
   settle(refundOnly,'p',{checkId:'c',table:1,rail:'cash',amount:5,amountUsd:5,status:'confirmed',ts:'2026-09-29T11:00:00.000Z',confirmedAt:'2026-09-29T11:01:00.000Z',refunded:T('15:00:00.000')}),
   check(olderOnly,'c',{table:1,openedAt:'2026-09-28T12:00:00.000Z',lines:[]})   // still open, but nothing happened on the day
  ]});
 const h=await harness(db),j=await body(await h.call('?date=2026-09-30'));
 const st=Object.fromEntries(j.results.map(r=>[r.restaurantId,r.status]));
 assert.deepEqual(st,{[none]:'skipped',[opened]:'sent',[closedOnly]:'sent',[payment]:'sent',[refundOnly]:'sent',[olderOnly]:'skipped'});
 assert.ok(db.daily_close_log.filter(r=>r.status==='skipped').every(r=>r.error==='no activity'));
});

test('manual calls: ?venue and ?date pick the day; an unknown venue, a bad date and a day that has not ended are refused',async()=>{
 const h=await harness(fixture());
 assert.equal((await h.call('?venue=nope&date=2026-09-30')).status,404);
 assert.equal((await h.call('?date=2026-02-31')).status,400);assert.equal((await h.call('?date=30-09-2026')).status,400);
 assert.equal((await h.call('?date=2026-10-01')).status,400);      // that day ends at 04:00 on 2 October
 assert.equal((await h.call('?venue='+encodeURIComponent(RID2))).status,200);   // no date: the latest finished day
 assert.equal(h.db.daily_close_log.find(r=>r.restaurant_id===RID2).day,'2026-09-30');
 assert.equal(h.resend.sent.length,1);
 // 03:00 Beirut on 1 Oct: the latest finished day is still the 29th
 const early=await harness(fixture(),{now:at('2026-10-01T00:00:00Z')});await early.call('?venue='+encodeURIComponent(RID2));
 assert.equal(early.db.daily_close_log[0].day,'2026-09-29');
 // a manual date works at any hour of the day, including a summer date rerun from a winter clock
 const w=await harness(fixture(),{now:at('2027-01-20T12:00:00Z')});assert.equal((await w.call('?venue='+encodeURIComponent(RID2)+'&date=2026-09-30')).status,200);
});

/* ------------------------------------------------------------------ sql */
test('daily-close-2026-09-30.sql keeps the rules it states',()=>{
 const sql=fs.readFileSync(path.join(root,'supabase/daily-close-2026-09-30.sql'),'utf8');
 const code=sql.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
 assert.equal((code.match(/^begin;$/gm)||[]).length,1);assert.equal((code.match(/^commit;$/gm)||[]).length,1);
 assert.match(code,/set local search_path = public, extensions, pg_temp;/);
 assert.match(code,/create table if not exists public\.daily_close_log/);
 for(const col of ['id            uuid primary key','restaurant_id text not null','day           date not null','recipients    int','provider_id   text','error         text','created_at    timestamptz not null default now\\(\\)'])assert.match(code,new RegExp(col.replace(/ +/g,' +')),col);
 assert.match(code,/check \(status in \('sent', 'skipped', 'failed'\)\)/);
 assert.match(code,/create unique index if not exists daily_close_log_venue_day on public\.daily_close_log \(restaurant_id, day\)/);
 assert.match(code,/enable row level security/);assert.match(code,/revoke all on public\.daily_close_log from public, anon, authenticated/);
 assert.doesNotMatch(code,/create policy/);
 assert.match(code,/array\[1, 2\]/);assert.match(code,/'0 %s \* \* \*'/);assert.match(code,/daily-close-%s00-utc-or-retry/);
 assert.match(code,/jobname in \('daily-close-0100-utc', 'daily-close-0200-utc'\)[\s\S]*cron\.unschedule\(old_name\)/);
 assert.match(code,/net\.http_post\(/);assert.match(code,/functions\/v1\/daily-close/);assert.match(code,/'X-Aalayna-Cron'/);
 assert.match(code,/vault\.decrypted_secrets where name = 'aalayna_cron_secret'/);
 // it survives a missing pg_cron / pg_net / vault: every path out is a NOTICE and a return, never an exception
 assert.match(code,/if to_regprocedure\('cron\.schedule\(text,text,text\)'\) is null then\s+raise notice '[^']*'[^;]*;\s+return;/);
 assert.match(code,/if to_regprocedure\('net\.http_post\(text,jsonb,jsonb,jsonb,integer\)'\) is null then\s+raise notice '[^']*'[^;]*;\s+return;/);
 assert.match(code,/if to_regclass\('vault\.decrypted_secrets'\) is null then\s+raise notice '[^']*'[^;]*;\s+return;/);
 assert.equal((code.match(/exception when others then\s+raise notice/g)||[]).length,2);
 // the migration stops (before changing anything) only when the tables it needs are absent
 assert.match(code,/raise exception 'Run admin\.sql and auth-2026-09-24\.sql before/);
 assert.equal((code.match(/raise exception/g)||[]).length,1);
 // no key, secret or token value anywhere in the file or in the function
 for(const f of ['supabase/daily-close-2026-09-30.sql','supabase/functions/daily-close/handler.js','supabase/functions/daily-close/index.ts']){
  const s=fs.readFileSync(path.join(root,f),'utf8');
  assert.doesNotMatch(s,/eyJ[A-Za-z0-9_-]{20,}|sk_(live|test)_|re_[A-Za-z0-9]{20,}|service_role_key\s*[:=]\s*['"][^'"]{10,}/i,f);
 }
});
test('index.ts is only a Deno.serve wrapper around handler.js with the shared rest and send',()=>{
 const s=fs.readFileSync(path.join(root,'supabase/functions/daily-close/index.ts'),'utf8');
 assert.match(s,/import \{ createHandler \} from '\.\/handler\.js';/);assert.match(s,/from '\.\.\/_shared\/supabase\.js'/);assert.match(s,/from '\.\.\/_shared\/resend\.js'/);
 assert.match(s,/Deno\.serve\(createHandler\(/);
 assert.ok(s.split('\n').length<25);
});
