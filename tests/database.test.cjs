// Run with PGLITE_MODULE pointing to @electric-sql/pglite (see supabase/README.md).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const modulePath=process.env.PGLITE_MODULE;
test('database permissions, scoped bill reads, atomic reservations and payment transitions',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;`);
  // WASM PostgreSQL omits pgcrypto; only the test RNG shim substitutes that extension.
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  for(const file of ['migration.sql','site-events.sql','hardening-2026-09-15.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../supabase',file),'utf8').replace('create extension if not exists pgcrypto;',''));
  // Migrations are repeatable, including permissions.
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/hardening-2026-09-15.sql'),'utf8'));
  const a=(await db.query(`select * from aal_register_venue('A','Beirut')`)).rows[0],b=(await db.query(`select * from aal_register_venue('B','Beirut')`)).rows[0];
  await db.exec('set role anon');
  await assert.rejects(db.query(`select * from aal_register_venue('A','Beirut')`),/permission denied/);
  const auth=async(key,provider=false)=>{await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify({'x-aalayna-key':key}),JSON.stringify({role:provider?'service_role':'anon'})]);};
  const call=async(rid,op,body,token='')=>(await db.query('select aal_mutate($1,$2,$3::jsonb,$4) as value',[rid,op,JSON.stringify(body),token])).rows[0].value;
  await auth(a.owner_key);
  await call(a.restaurant_id,'open_check',{id:'bill-A',table:1,totalCents:10000,lines:[{id:'dish',q:2,p:100}],currency:'USD',fxRateUsed:89500});
  const guest=(await call(a.restaurant_id,'issue_key',{checkId:'bill-A'})).key;
  await auth(b.owner_key);await call(b.restaurant_id,'open_check',{id:'bill-B',table:2,totalCents:2000,lines:[]});
  await auth(guest);
  await assert.rejects(call(b.restaurant_id,'reserve',{id:'cross',checkId:'bill-B',amount:1,tip:0,items:{},rail:'cash'},'x'.repeat(40)),/Access denied/);
  await assert.rejects(db.query(`insert into kv_rows values($1,'aal.settle','forged',$2,now())`,[a.restaurant_id,JSON.stringify({venueId:a.restaurant_id,status:'confirmed'})]),/row-level security/);
  const token='x'.repeat(40),request={id:'payment-A',requestId:'payment-A',checkId:'bill-A',amount:100,tip:0,rail:'card',items:{dish:2}};
  const reservation=await call(a.restaurant_id,'reserve',request,token);assert.equal(reservation.status,'initiated');
  assert.equal((await call(a.restaurant_id,'reserve',request,token)).id,'payment-A');
  await assert.rejects(call(a.restaurant_id,'reserve',{...request,id:'payment-B',requestId:'payment-B'},'y'.repeat(40)),/already covers/);
  await assert.rejects(call(a.restaurant_id,'confirm_digital',{id:'payment-A',externalRef:'fake',amountCents:10000,currency:'USD'}),/Verified provider/);
  await assert.rejects(call(a.restaurant_id,'cancel',{id:'payment-A'},'wrong'),/payer token/);
  await call(a.restaurant_id,'cancel',{id:'payment-A'},token);
  const cash=await call(a.restaurant_id,'reserve',{...request,id:'cash',requestId:'cash',rail:'cash',note:100},token);assert.equal(cash.status,'pending');
  await assert.rejects(call(a.restaurant_id,'confirm_cash',{id:'cash'}),/requires staff/);
  await auth(a.owner_key);assert.equal((await call(a.restaurant_id,'confirm_cash',{id:'cash'})).status,'confirmed');
  await auth(guest);
  await call(a.restaurant_id,'receipt',{id:'cash',requestId:'receipt-1',contact:'person@example.invalid',channel:'email',receipt:true,marketing:false},token);
  const snapshot=(await db.query('select aal_snapshot($1) as value',[a.restaurant_id])).rows[0].value;
  assert.equal(snapshot.checkId,'bill-A');assert.ok(snapshot.rows.every(r=>r.collection!=='aal.guests'));assert.ok(snapshot.rows.every(r=>!r.body.deviceId&&!r.body.customerId));
  await assert.rejects(db.query('select aal_snapshot($1)',[b.restaurant_id]),/current bill link/);
  await auth(a.owner_key);await call(a.restaurant_id,'close_check',{checkId:'bill-A'});
  await assert.rejects(call(a.restaurant_id,'reserve',{...request,id:'closed',requestId:'closed',rail:'cash'},token),/closed/);
  const raw=await db.query("select body from kv_rows where restaurant_id=$1 and collection='aal.events'",[a.restaurant_id]);assert.equal(raw.rows.filter(r=>r.body.eventType==='payment_completed').length,1);
  await db.query("insert into kv_rows values($1,'aal.campaigns','c',$2,now())",[a.restaurant_id,JSON.stringify({venueId:a.restaurant_id})]);
  await assert.rejects(db.query("update kv_rows set collection='aal.settle' where restaurant_id=$1 and id='c'",[a.restaurant_id]),/row-level security/);
 }finally{await db.close();}
});
// 2026-09-24: open_check with lines and update_check (supabase/hardening-2026-09-24.sql).
test('bill entry: open_check computes the total from lines; update_check applies the demo store rules',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;`);
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  for(const file of ['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../supabase',file),'utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/hardening-2026-09-24.sql'),'utf8'));   // re-runnable
  const a=(await db.query(`select * from aal_register_venue('A','Beirut')`)).rows[0];
  await db.exec('set role anon');
  const auth=async(key)=>{await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify({'x-aalayna-key':key}),JSON.stringify({role:'anon'})]);};
  const call=async(op,body,token='')=>(await db.query('select aal_mutate($1,$2,$3::jsonb,$4) as value',[a.restaurant_id,op,JSON.stringify(body),token])).rows[0].value;
  await auth(a.owner_key);
  const lines=[{id:'i07',q:1,p:16,name:'Grill'},{id:'i06',q:1,p:5,name:'Hummus'},{id:'i06',q:1,p:5},{id:'i14',q:4,p:10,name:'Coffee'}];
  const c=await call('open_check',{id:'bill-1',table:5,totalCents:1,lines,closedAt:'forged',revision:9,currency:'USD'});
  assert.equal(c.totalCents,3600);assert.equal(c.revision,1);assert.equal(c.source,'staff');assert.equal(c.closedAt,undefined);
  assert.deepEqual(c.lines.map(l=>[l.id,l.q,Number(l.p)]),[['i07',1,16],['i06',2,10],['i14',4,10]]);
  await assert.rejects(call('open_check',{id:'bill-x',table:6,lines:[{id:'i07',q:1.5,p:16}]}),/whole quantity/);
  // before any payment lines change freely
  let u=await call('update_check',{checkId:'bill-1',requestId:'r1',baseRevision:1,lines:[{id:'i07',q:1,p:16},{id:'i06',q:2,p:10},{id:'i14',q:4,p:10},{id:'i13',q:1,p:2}]});
  assert.equal(u.revision,2);assert.equal(u.totalCents,3800);
  assert.equal((await call('update_check',{checkId:'bill-1',requestId:'r1',baseRevision:1,lines:[]})).revision,2);   // resend is idempotent
  await assert.rejects(call('update_check',{checkId:'bill-1',requestId:'r2',baseRevision:1,lines:[]}),/changed on another device/);
  const guest=(await call('issue_key',{checkId:'bill-1'})).key;
  await auth(guest);
  await assert.rejects(call('update_check',{checkId:'bill-1',lines:[]}),/Only staff/);
  await call('reserve',{id:'pay-1',requestId:'pay-1',checkId:'bill-1',amount:5,tip:0,rail:'cash',items:{i06:1}},'t'.repeat(40));
  await auth(a.owner_key);
  await assert.rejects(call('update_check',{checkId:'bill-1',baseRevision:2,lines:[{id:'i07',q:1,p:16},{id:'i14',q:4,p:10},{id:'i13',q:1,p:2}]}),/Hummus is covered by a payment/);
  await assert.rejects(call('update_check',{checkId:'bill-1',baseRevision:2,lines:[{id:'i07',q:1,p:16},{id:'i06',q:2,p:10},{id:'i14',q:3,p:7.5},{id:'i13',q:1,p:2}]}),/added, not removed/);
  await assert.rejects(call('update_check',{checkId:'bill-1',baseRevision:2,lines:[{id:'i07',q:1,p:12},{id:'i06',q:2,p:10},{id:'i14',q:4,p:10},{id:'i13',q:1,p:2}]}),/Prices of existing items/);
  u=await call('update_check',{checkId:'bill-1',baseRevision:2,lines:[{id:'i07',q:1,p:16},{id:'i06',q:3,p:15},{id:'i14',q:4,p:10},{id:'i13',q:1,p:2}]});
  assert.equal(u.totalCents,4300);assert.equal(u.revision,3);
  const events=(await call('confirm_cash',{id:'pay-1'}),await db.query("select body from kv_rows where restaurant_id=$1 and collection='aal.events' and body->>'eventType'='order_placed' order by (body->'payload'->>'revision')::int",[a.restaurant_id])).rows.map(r=>r.body);
  assert.deepEqual(events.map(e=>[e.payload.revision,e.payload.change,e.tableId]),[[1,'opened','5'],[2,'updated','5'],[3,'updated','5']]);
  assert.deepEqual(events[2].payload.items.map(i=>[i.itemId,i.qty,Number(i.unitPrice)]),[['i07',1,16],['i06',3,5],['i14',4,2.5],['i13',1,2]]);
 }finally{await db.close();}
});
