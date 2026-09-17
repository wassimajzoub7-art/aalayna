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
