/* A menu style per venue (supabase/theme-2026-09-28.sql): venue_profiles.theme holds the standard
   menu (null) or 'balat'; the admin page picks it (Menu style); a table scan (aal_table_session)
   returns it, and guest.html puts it in the address (tests/table-sessions.test.cjs). The SQL
   file's functions are the live text (admin.sql, followups-2026-09-24.sql) changed only on the
   lines marked "-- theme"; the optional PGlite block runs the whole chain, as the other SQL
   suites do (PGLITE_MODULE). */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const SQL=read('supabase/theme-2026-09-28.sql');
const fn=(src,name)=>{const s=src.slice(src.indexOf('create or replace function public.'+name+'('));return s.slice(0,s.indexOf('end $$;')+7);};
const norm=(src,dropTheme)=>src.split('\n').filter(l=>!(dropTheme&&/-- theme$/.test(l.trim()))).map(l=>l.replace(/--.*$/,'').trim()).filter(Boolean).join('\n');

test('theme SQL: the admin functions are admin.sql\'s text with only the "-- theme" lines added',()=>{
 for(const name of ['aal_admin_field','aal_admin_write_profile'])
  assert.equal(norm(fn(SQL,name),true),norm(fn(read('supabase/admin.sql'),name),false),name);
});

test('theme SQL: aal_table_session is followups-2026-09-24.sql\'s text with theme added to the venue it returns',()=>{
 const before=fn(read('supabase/followups-2026-09-24.sql'),'aal_table_session'),after=fn(SQL,'aal_table_session');
 const line="'menu_pack', vp.menu_pack),";
 assert.equal(before.split(line).length,2);
 assert.equal(norm(after,false),norm(before.replace(line,"'menu_pack', vp.menu_pack, 'theme', vp.theme),"),false));
 assert.match(after,/'theme', vp\.theme\), -- theme\n/);
});

test('theme SQL: one transaction, repeatable, guarded, the same list as the store and the admin page, and in the README',()=>{
 assert.match(SQL,/^begin;$/m);assert.match(SQL,/^commit;\n$/m);
 assert.match(SQL,/add column if not exists theme text;/);
 assert.match(SQL,/drop constraint if exists venue_profiles_theme;/);
 assert.match(SQL,/raise exception 'Run followups-2026-09-24\.sql before theme-2026-09-28\.sql'/);
 // the list: THEMES in the store = the check constraint = aal_admin_field = MENU_STYLES in admin.html
 const store=JSON.parse(read('aalayna-store.js').match(/var THEMES = (\[[^\]]*\]);/)[1].replace(/'/g,'"'));
 const list=s=>s.split(',').map(x=>x.trim().replace(/^'|'$/g,''));
 assert.deepEqual(list(SQL.match(/check \(theme is null or theme in \(([^)]*)\)\)/)[1]),store);
 assert.deepEqual(list(SQL.match(/if v not in \(([^)]*)\) then -- theme/)[1]),store);
 const styles=read('admin.html').match(/var MENU_STYLES=(\[[^\]]*\]);/)[1];
 assert.deepEqual([...styles.matchAll(/v:'([^']*)'/g)].map(m=>m[1]),[''].concat(store));
 // privileges as the files it replaces give them
 assert.match(SQL,/revoke all on function public\.aal_admin_field\(text, text\) from public, anon, authenticated;/);
 assert.match(SQL,/revoke all on function public\.aal_admin_write_profile\(text, jsonb\) from public, anon, authenticated;/);
 assert.match(SQL,/grant execute on function public\.aal_table_session\(text, int, text\) to anon, authenticated;/);
 assert.match(read('supabase/README.md'),/theme-2026-09-28\.sql/);
});

/* admin.html: the Venues script against a minimal DOM (as tests/import-menu.test.cjs runs it) */
function adminPage(){
 const html=read('admin.html');
 const src=html.split('<!-- ==== T6 Venues (onboarding) script: start ==== -->')[1].split('<!-- ==== T6 Venues (onboarding) script: end ==== -->')[0].replace(/^\s*<script>|<\/script>\s*$/g,'');
 const byId=new Map();
 class El{constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.style={};this.hidden=false;this.textContent='';this.className='';this.classList={toggle(){},add(){},remove(){}};if(this.tagName!=='SELECT')this.value='';}
  appendChild(c){this.children.push(c);return c;} append(...c){c.forEach(x=>this.appendChild(x));} replaceChildren(...c){this.children=[];this.append(...c);}
  setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return k in this.attrs?this.attrs[k]:null;} removeAttribute(k){delete this.attrs[k];}
  addEventListener(){} focus(){} querySelectorAll(){return [];}
  get id(){return this._id;} set id(v){this._id=v;byId.set(v,this);}}
 class Select extends El{get value(){return this._v==null?(this.children[0]?this.children[0].value:''):this._v;} set value(v){this._v=this.children.some(o=>o.value===v)?v:'';}}
 const document={createElement:t=>t.toLowerCase()==='select'?new Select(t):new El(t),
  getElementById:id=>byId.get(id)||(()=>{const e=new El('div');e.id=id;return e;})(),querySelectorAll:()=>[]};
 const ctx=vm.createContext({document,location:{origin:'https://aalayna.com',hostname:'aalayna.com',pathname:'/admin.html'},
  sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},fetch:()=>Promise.reject(new Error('offline')),Event:class{}});
 ctx.window=ctx;
 vm.runInContext(src,ctx);
 return {document,api:ctx.AalaynaAdminVenues};
}
const plain=x=>JSON.parse(JSON.stringify(x));

test('admin.html: Menu style is a Standard/Balat select on the register form, validated, saved and shown',()=>{
 const {document,api}=adminPage();
 const sel=document.getElementById('reg-theme');
 assert.equal(sel.tagName,'SELECT');
 assert.deepEqual(sel.children.map(o=>[o.value,o.textContent]),[['','Standard'],['balat','Balat · Beirut cement tiles']]);
 const base={name:'Test Bistro',place:'Achrafieh',slug:'',gplace:'',brand:'',bg:'',font:'',menu:''};
 const ok=api.validateProfile(Object.assign({},base,{theme:' Balat '}),null);
 assert.equal(ok.ok,true);assert.equal(ok.profile.theme,'balat');
 assert.equal(plain(api.profilePayload(ok.profile)).theme,'balat');
 assert.equal(api.validateProfile(Object.assign({},base),null).profile.theme,'',"no choice is the standard menu");
 const bad=api.validateProfile(Object.assign({},base,{theme:'ember'}),null);
 assert.equal(bad.ok,false);assert.equal(bad.field,'theme');
 // a stored profile reads back; none means the standard menu
 assert.equal(api.profileOf({restaurant_id:'["x",""]',profile:{name:'X',theme:'balat'}}).theme,'balat');
 assert.equal(api.profileOf({restaurant_id:'["x",""]',profile:null}).theme,'');
 // owner links are unchanged: the style reaches guests through the table scan, not the staff pages
 assert.ok(!/theme=/.test(plain(api.venueLinks({restaurant_id:'["x",""]',owner_key:'own_1',profile:{name:'X',theme:'balat'}})).ownerDashboard));
 assert.match(read('admin.html'),/' · Menu style '\+\(p\.theme==='balat'\?'Balat':'standard'\)/);
});

const modulePath=process.env.PGLITE_MODULE;
test('theme SQL: the admin sets a venue\'s menu style, a table scan returns it, and nothing else can be stored',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite(),sql=f=>read('supabase/'+f).replace('create extension if not exists pgcrypto;','');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;`);
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  await db.exec(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);`);
  for(const f of ['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql','admin.sql','sessions-2026-09-24.sql','auth-2026-09-24.sql'])await db.exec(sql(f));
  await assert.rejects(db.exec(sql('theme-2026-09-28.sql')),/Run followups-2026-09-24\.sql before theme-2026-09-28\.sql/);
  await db.exec('rollback');
  for(const f of ['followups-2026-09-24.sql','theme-2026-09-28.sql','theme-2026-09-28.sql'])await db.exec(sql(f));   // twice: repeatable
  await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
  const as=async(role,headers)=>{await db.exec('reset role');await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify(headers||{}),JSON.stringify({role})]);await db.exec('set role '+role);};
  const one=async(q,args)=>(await db.query(q,args)).rows[0].value;
  const admin=()=>as('anon',{'x-aalayna-admin':'adm_test'});
  await admin();
  const v=await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra',$1::jsonb) as value",[JSON.stringify({theme:' Balat ',brand:'#2f6b4f'})]);
  const rid=v.restaurant_id;
  assert.equal(v.profile.theme,'balat');assert.equal(v.profile.brand,'#2F6B4F');
  const update=p=>one('select aal_admin_update_profile($1,$2::jsonb) as value',[rid,JSON.stringify(p)]);
  assert.equal((await update({font:'Cairo'})).profile.theme,'balat','a profile without theme keeps it');
  await assert.rejects(update({theme:'ember'}),/Menu style is the standard menu \(leave it empty\) or balat\./);
  assert.equal((await one('select aal_admin_list_venues() as value'))[0].profile.theme,'balat','a refused change changes nothing');
  // a table scan carries it
  await as('anon',{'x-aalayna-key':v.owner_key});
  const code=(await one('select aal_table_tokens($1,$2::jsonb) as value',[rid,JSON.stringify({op:'issue',table:7})])).tokens[0].token;
  await as('anon',{});
  const scan=()=>one('select aal_table_session($1,$2,$3) as value',['mayda-hamra',7,code]);
  const s1=await scan();
  assert.equal(s1.venue.theme,'balat');assert.equal(s1.venue.brand,'#2F6B4F');assert.equal(s1.venue.name,'Mayda');
  // empty returns to the standard menu
  await admin();
  assert.equal((await update({theme:''})).profile.theme,null);
  await as('anon',{});assert.equal((await scan()).venue.theme,null);
  // nothing outside the list, however it is written; and no one but the admin writes it
  await db.exec('reset role');
  await assert.rejects(db.query("update venue_profiles set theme='ember'"),/venue_profiles_theme/);
  await as('anon',{});await assert.rejects(update({theme:'balat'}),/Admin key required/);
  await as('anon',{'x-aalayna-key':v.owner_key});await assert.rejects(update({theme:'balat'}),/Admin key required/);
  await assert.rejects(db.query("select aal_admin_write_profile($1,'{\"theme\":\"balat\"}'::jsonb)",[rid]),/permission denied/);
 }finally{await db.close();}
});
