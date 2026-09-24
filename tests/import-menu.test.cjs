/* Menu importer (T9): tools/import-menu.js turns a menu PDF or photos into a pack in
   venues/<slug>.json. Nothing here calls the Anthropic API. The saved answer in
   tests/fixtures/kababji-response.json is two batches (pages one and two, then page
   three with one dish repeated from the overlap) built from venues/kababji.json, so
   the pack it produces is checked field by field against the hand-typed pack. The
   request side (headers, content blocks, tool_choice fallback, retries, the SSE
   stream) runs against a stubbed fetch; admin.html's manifest loader runs its real
   script against a minimal DOM. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..'),TOOL=path.join(root,'tools','import-menu.js'),FIXTURE=path.join(__dirname,'fixtures','kababji-response.json');
const im=require(TOOL),I=im._internal;
const kababji=JSON.parse(fs.readFileSync(path.join(root,'venues','kababji.json'),'utf8'));
const fixture=()=>JSON.parse(fs.readFileSync(FIXTURE,'utf8'));
const answers=msgs=>msgs.map((m,i)=>I.toolInput(m,'batch '+(i+1)));
const build=(msgs,o={})=>im.buildPack(answers(msgs),{name:'Kababji',currency:'USD',...o});
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'aal-import-'));
const input=(msgs,b)=>msgs[b].content.find(c=>c.type==='tool_use').input;
const itemNamed=(msgs,name)=>{for(const m of msgs){const x=m.content.find(c=>c.type==='tool_use').input.items.find(i=>i.name===name);if(x)return x;}throw new Error(name);};
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('the allergen vocabulary is the store vocabulary, in the tool schema and in post-processing',()=>{
 const map=new Map(),storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};
 const window={location:{search:''},addEventListener(){},localStorage:storage},ctx=vm.createContext({window,localStorage:storage,URLSearchParams});
 vm.runInContext(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),ctx);
 assert.deepEqual([...window.Aalayna.ALLERGENS],I.ALLERGENS);
 const schema=I.toolDefinition().input_schema.properties.items.items.properties.allergens.items;
 assert.deepEqual(schema.enum,I.ALLERGENS);
 assert.equal('strict' in I.toolDefinition(),false);   // strict is opt-in (--strict)
});

test('the fixture becomes a pack that matches venues/kababji.json dish by dish',()=>{
 const {pack}=build(fixture());
 assert.deepEqual(im.validatePack(pack),[]);
 assert.equal(pack.name,'Kababji');
 assert.deepEqual(Object.keys(pack),Object.keys(kababji));
 assert.deepEqual(pack.items.map(x=>x.id),Array.from({length:26},(_,i)=>'i'+String(i+1).padStart(2,'0')));
 const ids=pack.sections.map(s=>s.id);
 assert.ok(ids.every(id=>/^[a-z]{3}$/.test(id)));assert.equal(new Set(ids).size,ids.length);
 /* same section names and windows as the hand-typed pack; All Day Breakfast is not the breakfast window */
 for(const s of pack.sections){const k=kababji.sections.find(x=>x.name===s.name);assert.ok(k,s.name);assert.equal(s.win,k.win);}
 const secName=Object.fromEntries(pack.sections.map(s=>[s.id,s.name])),kSec=Object.fromEntries(kababji.sections.map(s=>[s.id,s.name]));
 for(const x of pack.items){
  const k=kababji.items.find(y=>y.name===x.name);assert.ok(k,x.name);
  assert.deepEqual(Object.keys(x),Object.keys(k),'key order');
  assert.equal(secName[x.sec],kSec[k.sec],x.name);
  for(const f of ['desc','price','ing','al','tr','opts'])assert.deepEqual(x[f],k[f],x.name+' '+f);
  assert.deepEqual([x.kcal,x.pr,x.ft,x.cb],[null,null,null,null]);
  assert.equal(x.conf,0);   // not the kitchen's confirmation: out of guest filters until confirmed
 }
 /* the fixture capitalises some ingredients; the pack lower-cases them */
 assert.deepEqual(pack.items.find(x=>x.name==='Fattoush').ing.slice(0,2),['rocca','lettuce']);
});

test('batches merge by section name and a dish on two overlapping photos is flagged, not dropped',()=>{
 const msgs=fixture();
 input(msgs,1).sections[0].name='  APPETIZERS ';input(msgs,1).items.slice(0,5).forEach(x=>x.section='appetizers');
 const {pack,flags,counts}=build(msgs);
 assert.deepEqual(pack.sections.map(s=>s.name),['Salads','Appetizers','All Day Breakfast','Desserts']);
 const app=pack.sections[1].id;
 assert.equal(counts[app],11);
 assert.deepEqual(pack.items.filter(x=>x.sec===app).map(x=>x.name),
  ['Hummus','Hummus Meat and Almond','Moutabal Eggplant','Warak Enab','Mouhamara','Hindbeh','Hindbeh','Batata w Kezbara','Grilled Potatoes','French Fries','Cheese Rkakat']);
 assert.deepEqual(flags.duplicateNames,[{name:'Hindbeh',ids:['i09','i10'],sections:[app,app]}]);
 assert.deepEqual(flags.emptySections,[]);
 /* a heading with no dish under it and a dish under an unlisted heading */
 input(msgs,0).sections.push({name:'Kids Menu',window:'not_stated'});
 input(msgs,1).items[16].section='Sweets';
 const b=build(msgs);
 assert.deepEqual(b.flags.emptySections,['Kids Menu']);assert.deepEqual(b.flags.addedSections,['Sweets']);
 assert.deepEqual(im.validatePack(b.pack),[]);
});

test('allergens outside the store vocabulary are dropped and reported, known ones are normalised',()=>{
 const msgs=fixture();
 itemNamed(msgs,'Fattoush').allergens=['Wheat','GLUTEN','gluten','mustard'];
 assert.deepEqual(I.answerProblems(input(msgs,0),'batch 1'),[]);
 const {pack,flags}=build(msgs);
 const f=pack.items.find(x=>x.name==='Fattoush');
 assert.deepEqual(f.al,['gluten']);
 assert.deepEqual(flags.droppedAllergens.map(d=>d.allergen),['Wheat','mustard']);
 assert.deepEqual(im.validatePack({...pack,items:[{...f,al:['wheat']}]}).filter(e=>/vocabulary/.test(e)).length,1);
});

test('missing and non-positive prices become null and are listed in the report',async()=>{
 const msgs=fixture();
 itemNamed(msgs,'Tabbouleh').price=null;itemNamed(msgs,'Tabbouleh').options=[];
 itemNamed(msgs,'Raheb Salad').price=0;
 const dir=tmp(),file=path.join(dir,'fx.json');fs.writeFileSync(file,JSON.stringify(msgs));
 const r=await im.importMenu({fixture:file,name:'Kababji',slug:'kababji',currency:'USD',dryRun:true,cwd:dir});
 assert.equal(r.path,null);
 assert.equal(r.pack.items.find(x=>x.name==='Tabbouleh').price,null);
 assert.equal(r.pack.items.find(x=>x.name==='Raheb Salad').price,null);
 assert.deepEqual(r.flags.nullPrices.map(x=>x.name),['Tabbouleh','Raheb Salad']);
 assert.deepEqual(r.flags.nonPositivePrices.map(x=>x.name),['Raheb Salad']);
 assert.match(r.report,/Items with no price \(2\):/);assert.match(r.report,/i02  Tabbouleh \(Salads\)/);
 assert.match(r.report,/Prices that were zero or negative/);
 assert.deepEqual(im.validatePack(r.pack),[]);
 assert.ok(im.validatePack({...r.pack,items:[{...r.pack.items[0],price:0}]}).some(e=>/positive/.test(e)));
 assert.deepEqual(fs.readdirSync(dir),['fx.json'],'a dry run writes nothing');
});

test('an answer that does not fit the schema throws and writes nothing',async()=>{
 const dir=tmp();
 const cases=[
  m=>{input(m,0).items[0].price='4.75';},
  m=>{input(m,0).items[1].name='';},
  m=>{delete input(m,1).items[2].translations;},
  m=>{input(m,0).sections[0].window='lunch';},
  m=>{input(m,1).items[3].options[0].prices_are='sometimes';},
  m=>{m[1].stop_reason='max_tokens';},
  m=>{m[0].content=m[0].content.filter(c=>c.type!=='tool_use');m[0].stop_reason='end_turn';},
  m=>{m[1].stop_reason='refusal';}
 ];
 for(const [i,mutate] of cases.entries()){
  const msgs=fixture();mutate(msgs);const file=path.join(dir,'bad'+i+'.json');fs.writeFileSync(file,JSON.stringify(msgs));
  await assert.rejects(im.importMenu({fixture:file,name:'Kababji',slug:'bad',currency:'USD',cwd:dir}),e=>e.code==='SCHEMA','case '+i);
 }
 assert.equal(fs.existsSync(path.join(dir,'venues')),false);
 const msgs=fixture();input(msgs,0).items[0].price='4.75';const file=path.join(dir,'bad.json');fs.writeFileSync(file,JSON.stringify(msgs));
 const run=spawnSync(process.execPath,[TOOL,'--name','Kababji','--slug','bad','--currency','USD','--fixture',file],{cwd:dir,encoding:'utf8'});
 assert.equal(run.status,1);assert.match(run.stderr,/does not fit the schema/);assert.match(run.stderr,/batch 1\.items\[0\]\.price/);
});

test('writing refuses to overwrite without --force and keeps venues/index.json to one entry per pack',async()=>{
 const dir=tmp(),venues=path.join(dir,'venues');fs.mkdirSync(venues);
 fs.copyFileSync(path.join(root,'venues','index.json'),path.join(venues,'index.json'));
 const o={fixture:FIXTURE,name:'Em Sherif',slug:'em-sherif',currency:'USD',cwd:dir};
 const r=await im.importMenu(o);
 assert.equal(r.path,path.join(venues,'em-sherif.json'));
 assert.deepEqual(JSON.parse(fs.readFileSync(r.path,'utf8')),r.pack);
 const today=new Date().toISOString().slice(0,10);
 let idx=JSON.parse(fs.readFileSync(path.join(venues,'index.json'),'utf8'));
 assert.deepEqual(idx,[{slug:'em-sherif',name:'Em Sherif',items:26,updated:today},{slug:'kababji',name:'Kababji',items:75,updated:'2026-09-01'}]);
 await assert.rejects(im.importMenu(o),e=>e.code==='EXISTS');
 /* refused before any API call: a stub fetch that fails the test if reached */
 const img=path.join(dir,'p1.jpg');fs.writeFileSync(img,Buffer.from([0xff,0xd8,0xff,0xd9]));
 const was=I.deps.fetch;I.deps.fetch=()=>{throw new Error('the API was called');};
 try{await assert.rejects(im.importMenu({files:[img],name:'Em Sherif',slug:'em-sherif',currency:'USD',apiKey:'test-key',cwd:dir}),e=>e.code==='EXISTS');}
 finally{I.deps.fetch=was;}
 const again=await im.importMenu({...o,name:'Em Sherif Beirut',force:true});
 idx=JSON.parse(fs.readFileSync(path.join(venues,'index.json'),'utf8'));
 assert.equal(idx.filter(e=>e.slug==='em-sherif').length,1);
 assert.equal(idx.find(e=>e.slug==='em-sherif').name,'Em Sherif Beirut');
 assert.equal(JSON.parse(fs.readFileSync(again.path,'utf8')).name,'Em Sherif Beirut');
 /* a broken manifest stops the run before anything is written */
 fs.writeFileSync(path.join(venues,'index.json'),'{not json');
 await assert.rejects(im.importMenu({...o,slug:'third'}),/not a JSON list/);
 assert.equal(fs.existsSync(path.join(venues,'third.json')),false);
});

test('slugs follow the admin rule and index is reserved; the other options are checked',()=>{
 const base={name:'X',currency:'USD',fixture:'f.json'};
 for(const slug of ['index','Bad Slug','-x','x-','a/b',''])assert.throws(()=>I.checkOptions({...base,slug}),e=>e.code==='USAGE',slug);
 assert.equal(I.checkOptions({...base,slug:'em-sherif'}).slug,'em-sherif');
 assert.throws(()=>I.checkOptions({...base,slug:'x',currency:'EUR'}),/USD or LBP/);
 assert.throws(()=>I.checkOptions({...base,slug:'x',rate:90000}),/only applies/);
 assert.throws(()=>I.checkOptions({...base,slug:'x',currency:'LBP',rate:5}),/between/);
 assert.equal(I.checkOptions({...base,slug:'x',currency:'lbp'}).rate,89500);
 assert.equal(I.checkOptions({...base,slug:'x'}).model,'claude-opus-5-5');
 assert.throws(()=>I.checkOptions({name:'X',slug:'x',currency:'USD',files:[]}),/at least one menu file/);
 assert.deepEqual(I.parseArgs(['--name','Em Sherif','--slug','em-sherif','--currency','LBP','--rate','90000','--force','a.jpg','b.jpg']),
  {files:['a.jpg','b.jpg'],name:'Em Sherif',slug:'em-sherif',currency:'LBP',rate:90000,force:true});
 assert.throws(()=>I.parseArgs(['--nme','x']),/Unknown option/);
});

test('LBP prices are converted to USD at the rate before option differences are taken',()=>{
 const ans={currency_seen:'LBP',sections:[{name:'Mezze',window:'not_stated'}],items:[{section:'Mezze',name:'Hummus',description:'',price:450000,
  ingredients:['chickpea','tahini'],allergens:['sesame'],translations:{fr:{name:'',description:''},ar:{name:'حمص',description:''}},
  options:[{name:'Portion',type:'one',prices_are:'full_dish_price',choices:[{name:'Small',price:450000},{name:'Large',price:720000}]},
           {name:'Extras',type:'many',prices_are:'amount_added',choices:[{name:'Pine nuts',price:90000},{name:'Bread',price:null}]}]}]};
 const {pack,flags}=im.buildPack([ans],{name:'Em Sherif',currency:'LBP',rate:89500});
 const x=pack.items[0];
 assert.equal(x.price,5.03);
 assert.deepEqual(x.opts[0].choices,[{n:'Small',p:0},{n:'Large',p:3.01}]);
 assert.deepEqual(x.opts[1].choices,[{n:'Pine nuts',p:1.01},{n:'Bread',p:0}]);
 assert.deepEqual(flags.unpricedChoices.map(c=>c.choice),['Bread']);
 /* the guest app shows LL as round(usd * rate / 1000) * 1000: the printed prices come back */
 const ll=v=>Math.round(v*89500/1000)*1000;
 assert.equal(ll(x.price),450000);assert.equal(ll(x.price+x.opts[0].choices[1].p),720000);
 assert.deepEqual(flags.currency,[]);
 ans.items[0].price=450;ans.items[0].options=[];
 assert.match(im.buildPack([ans],{name:'E',currency:'LBP',rate:89500}).flags.currency.join(),/thousands/);
 assert.match(im.buildPack([ans],{name:'E',currency:'USD'}).flags.currency.join(),/saw LBP/);
});

test('breakfast window only for a clear breakfast section; section ids stay unique',()=>{
 assert.equal(I.windowFor('Breakfast','not_stated'),'brkf');
 assert.equal(I.windowFor('All Day Breakfast','not_stated'),'all');
 assert.equal(I.windowFor('Breakfast','all_day'),'all');
 assert.equal(I.windowFor('Morning Plates','breakfast_only'),'brkf');
 assert.equal(I.windowFor('ترويقة','not_stated'),'brkf');
 assert.equal(I.windowFor('Mezze','not_stated'),'all');
 const ids=I.sectionIds(['Salads','Salad Bar','Sal','مشاوي','Ta','Éclairs']);
 assert.equal(new Set(ids).size,6);assert.ok(ids.every(id=>/^[a-z]{3}$/.test(id)));
 assert.equal(ids[0],'sal');assert.equal(ids[5],'ecl');
});

test('files are batched: each PDF alone, photos in order at most 20 per request',()=>{
 const dir=tmp(),files=[];
 const add=(name,bytes=8)=>{fs.writeFileSync(path.join(dir,name),Buffer.alloc(bytes));files.push(name);};
 for(let i=1;i<=25;i++)add('p'+i+'.jpg');
 add('drinks.pdf');
 for(let i=26;i<=45;i++)add('p'+i+(i%2?'.png':'.webp'));
 const b=I.planBatches(files,dir);
 assert.deepEqual(b.map(x=>x.files.length),[20,5,1,20]);
 assert.deepEqual(b.map(x=>x.label),['photos 1 to 20 of 45','photos 21 to 25 of 45','drinks.pdf','photos 26 to 45 of 45']);
 assert.deepEqual([...new Set(b[3].files.map(f=>f.media))].sort(),['image/png','image/webp']);
 fs.writeFileSync(path.join(dir,'menu.gif'),'x');
 assert.throws(()=>I.planBatches(['menu.gif'],dir),e=>e.code==='USAGE');
 assert.throws(()=>I.planBatches(['missing.jpg'],dir),/not found/);
 fs.writeFileSync(path.join(dir,'big.jpg'),'');fs.truncateSync(path.join(dir,'big.jpg'),5*1024*1024+1);
 assert.throws(()=>I.planBatches(['big.jpg'],dir),/5 MB/);
});

/* an SSE body as the API sends it, cut at awkward places */
function sse(msg,{toolInput,splitAt=37}={}){
 const ev=[];const push=(type,data)=>ev.push('event: '+type+'\r\ndata: '+JSON.stringify({type,...data})+'\r\n\r\n');
 push('message_start',{message:{id:msg.id,type:'message',role:'assistant',model:msg.model,content:[],stop_reason:null,usage:{input_tokens:msg.usage.input_tokens,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
 ev.push('event: ping\ndata: {"type":"ping"}\n\n');
 push('content_block_start',{index:0,content_block:{type:'thinking',thinking:'',signature:''}});
 push('content_block_delta',{index:0,delta:{type:'signature_delta',signature:'sig'}});
 push('content_block_stop',{index:0});
 push('content_block_start',{index:1,content_block:{type:'tool_use',id:'toolu_1',name:'record_menu',input:{}}});
 const json=JSON.stringify(toolInput);for(let i=0;i<json.length;i+=50)push('content_block_delta',{index:1,delta:{type:'input_json_delta',partial_json:json.slice(i,i+50)}});
 push('content_block_stop',{index:1});
 push('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:msg.usage.output_tokens}});
 push('message_stop',{});
 const bytes=Buffer.from(ev.join(''),'utf8'),chunks=[];for(let i=0;i<bytes.length;i+=splitAt)chunks.push(new Uint8Array(bytes.subarray(i,i+splitAt)));
 return (async function*(){for(const c of chunks)yield c;})();
}

test('the SSE stream is rebuilt into the message a non-streaming call returns',async()=>{
 const m=fixture()[0],inp=m.content[1].input;
 const msg=await I.readStream(sse(m,{toolInput:inp}));
 assert.equal(msg.stop_reason,'tool_use');
 assert.deepEqual(msg.usage,{input_tokens:m.usage.input_tokens,output_tokens:m.usage.output_tokens,cache_read_input_tokens:0,cache_creation_input_tokens:0});
 assert.deepEqual(I.toolInput(msg,'b'),inp);   // Arabic split across chunks survives
 assert.equal(msg.content[0].signature,'sig');
});

/* a stubbed API: each call takes the next reply; the request bodies are kept */
function stubApi(){
 const calls=[],replies=[],logs=[],was={fetch:I.deps.fetch,sleep:I.deps.sleep};
 I.deps.fetch=async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return replies.shift()();};
 I.deps.sleep=async()=>{};
 const m=fixture()[0],inp=m.content[1].input;
 return {calls,replies,logs,inp,log:l=>logs.push(l),restore:()=>Object.assign(I.deps,was),
  ok:()=>({ok:true,status:200,body:sse(m,{toolInput:inp})}),
  err:(status,type,message)=>()=>({ok:false,status,headers:{get:()=>null},text:async()=>JSON.stringify({type:'error',error:{type,message}})})};
}

test('requests by default: forced tool for every model, no strict, no output_config; tool_choice 400 falls back to auto; overload is retried',async()=>{
 const dir=tmp(),img=path.join(dir,'p1.jpg'),pdf=path.join(dir,'menu.pdf');
 fs.writeFileSync(img,Buffer.from('fake jpeg bytes'));fs.writeFileSync(pdf,Buffer.from('%PDF-1.4 fake'));
 const api=stubApi();
 try{
  /* the real defaults, through importMenu: model claude-opus-5-5, forced tool_choice */
  api.replies.push(api.err(400,'invalid_request_error','tool_choice: type "tool" and "any" are not supported for this model.'),api.err(529,'overloaded_error','Overloaded'),api.ok,api.ok);
  const r=await im.importMenu({files:[pdf,img],name:'Kababji',slug:'kababji',currency:'USD',apiKey:'sk-test-secret',dryRun:true,cwd:dir,log:api.log});
  assert.equal(r.path,null);
  assert.equal(api.calls.length,4);
  const [first,second,third,fourth]=api.calls;
  assert.equal(first.url,'https://api.anthropic.com/v1/messages');
  assert.equal(first.init.headers['x-api-key'],'sk-test-secret');
  assert.equal(first.init.headers['anthropic-version'],'2023-06-01');
  assert.equal(first.init.headers['content-type'],'application/json');
  assert.equal(first.body.model,'claude-opus-5-5');assert.equal(first.body.stream,true);
  assert.deepEqual(first.body.tool_choice,{type:'tool',name:'record_menu'});
  assert.equal('strict' in first.body.tools[0],false);
  assert.equal('output_config' in first.body,false);
  assert.doesNotMatch(first.body.messages[0].content[1].text,/Answer only by calling/);
  /* the 400 about tool_choice flips to auto plus the instruction, and it sticks */
  for(const c of [second,third,fourth]){
   assert.deepEqual(c.body.tool_choice,{type:'auto'});
   assert.match(c.body.messages[0].content.at(-1).text,/Answer only by calling the record_menu tool/);
  }
  /* a PDF is a document block, photos are image blocks; batch two knows batch one's sections */
  assert.equal(first.body.messages[0].content[0].type,'document');
  assert.equal(first.body.messages[0].content[0].source.media_type,'application/pdf');
  assert.deepEqual(fourth.body.messages[0].content[0],{type:'image',source:{type:'base64',media_type:'image/jpeg',data:Buffer.from('fake jpeg bytes').toString('base64')}});
  assert.match(fourth.body.messages[0].content[1].text,/Sections found on earlier pages, in order: Salads; Appetizers/);
  assert.match(fourth.body.messages[0].content[1].text,/Transcribe prices in USD/);
  /* one log line per fallback; neither the key nor any file payload reaches the log */
  const logged=api.logs.join('\n');
  assert.equal(api.logs.filter(l=>/refuses a forced tool_choice/.test(l)).length,1);
  assert.match(logged,/Overloaded Retrying/);
  assert.doesNotMatch(logged,/sk-test-secret/);assert.doesNotMatch(logged,new RegExp(Buffer.from('fake jpeg bytes').toString('base64').slice(0,12)));
  assert.doesNotMatch(logged,new RegExp(Buffer.from('%PDF-1.4 fake').toString('base64').slice(0,12)));
  /* a 400 about anything else is not retried */
  api.calls.length=0;api.replies.push(api.err(400,'invalid_request_error','messages: at least one message is required'));
  await assert.rejects(I.requestBatch({name:'K',currency:'USD',model:'m',effort:'default',strict:false,apiKey:'k',log:api.log,forced:true},I.planBatches([img],dir)[0],[]),e=>e.code==='API'&&/400/.test(e.message));
  assert.equal(api.calls.length,1);
 }finally{api.restore();}
});

test('--strict and --effort are opt-in, and a 400 naming either drops that field once',async()=>{
 const dir=tmp(),img=path.join(dir,'p1.jpg'),pdf=path.join(dir,'menu.pdf');
 fs.writeFileSync(img,Buffer.from('fake jpeg bytes'));fs.writeFileSync(pdf,Buffer.from('%PDF-1.4 fake'));
 assert.equal(I.parseArgs(['--strict','--effort','high']).strict,true);
 const o=I.checkOptions({name:'K',slug:'k',currency:'USD',files:['a.pdf']});
 assert.equal(o.strict,false);assert.equal(o.effort,'default');
 assert.equal(I.toolDefinition(true).strict,true);
 const api=stubApi();
 try{
  api.replies.push(api.err(400,'invalid_request_error','tools.0.strict: Extra inputs are not permitted'),
                   api.err(400,'invalid_request_error','output_config.effort: not supported for this model'),api.ok,api.ok);
  const r=await im.importMenu({files:[img,pdf],name:'Kababji',slug:'kababji',currency:'USD',apiKey:'k',strict:true,effort:'high',dryRun:true,cwd:dir,log:api.log});
  assert.equal(r.pack.items.length,18);   // two batches, both answered with the same page
  const [a,b,c,d]=api.calls;
  assert.equal(a.body.tools[0].strict,true);assert.deepEqual(a.body.output_config,{effort:'high'});
  assert.equal('strict' in b.body.tools[0],false);assert.deepEqual(b.body.output_config,{effort:'high'});
  assert.equal('strict' in c.body.tools[0],false);assert.equal('output_config' in c.body,false);
  assert.deepEqual(c.body.tool_choice,{type:'tool',name:'record_menu'},'still forced');
  assert.equal(api.calls.length,4);
  assert.equal('strict' in d.body.tools[0],false);assert.equal('output_config' in d.body,false);   // the drop sticks for later batches
  assert.deepEqual(api.logs.filter(l=>/refuses/.test(l)),['  claude-opus-5-5 refuses strict tool use; sending the tool without strict','  claude-opus-5-5 refuses output_config; sending no effort']);
  /* a second strict 400 after the field is gone is not retried again */
  api.calls.length=0;api.replies.push(api.err(400,'invalid_request_error','strict mode problem'));
  await assert.rejects(I.requestBatch({name:'K',currency:'USD',model:'m',effort:'default',strict:false,apiKey:'k',log:api.log,forced:true},I.planBatches([img],dir)[0],[]),e=>e.code==='API');
  assert.equal(api.calls.length,1);
 }finally{api.restore();}
});

test('the CLI replays the fixture in --dry-run and prints the review report without touching venues/',()=>{
 const pack=path.join(root,'venues','kababji.json'),index=path.join(root,'venues','index.json'),before=[sha(pack),sha(index)];
 const env={...process.env};delete env.ANTHROPIC_API_KEY;
 const run=spawnSync(process.execPath,[TOOL,'--name','Kababji','--slug','kababji','--currency','USD','--fixture',FIXTURE,'--dry-run'],{cwd:root,env,encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const out=run.stdout;
 assert.match(out,/^Menu import: Kababji \(kababji\)$/m);
 assert.match(out,/^Model: claude-opus-5-5, replayed from .*kababji-response\.json \(no API call\)$/m);
 assert.match(out,/^Batches: 2\. Tokens: 10,711 input, 9,198 output, 0 cache read, 0 cache write\.$/m);
 assert.match(out,/^Sections \(4, 26 items\):$/m);
 assert.match(out,/^  app  Appetizers +11 items  all day$/m);
 assert.match(out,/^  Items with no price \(0\): none$/m);
 assert.match(out,/^    Hindbeh: i09 in Appetizers, i10 in Appetizers$/m);
 assert.match(out,/^  Sections with no items \(0\): none$/m);
 assert.match(out,/^Dry run: nothing written\.$/m);
 assert.doesNotMatch(out,/\u2014|\u2013/,'no dashes');
 assert.deepEqual([sha(pack),sha(index)],before);
 /* usage errors exit 2 before anything else; no key without a fixture is a usage error */
 const bad=spawnSync(process.execPath,[TOOL,'--name','K','--slug','index','--currency','USD','--fixture',FIXTURE],{cwd:root,env,encoding:'utf8'});
 assert.equal(bad.status,2);assert.match(bad.stderr,/reserved/);
 const nokey=spawnSync(process.execPath,[TOOL,'--name','K','--slug','k','--currency','USD','--dry-run','menu.pdf'],{cwd:root,env,encoding:'utf8'});
 assert.equal(nokey.status,2);assert.match(nokey.stderr,/ANTHROPIC_API_KEY/);
});

test('venues/index.json lists every pack with its real name and item count',()=>{
 const idx=JSON.parse(fs.readFileSync(path.join(root,'venues','index.json'),'utf8'));
 assert.ok(idx.some(e=>e.slug==='kababji'));
 for(const e of idx){
  const p=JSON.parse(fs.readFileSync(path.join(root,'venues',e.slug+'.json'),'utf8'));
  assert.equal(e.name,p.name);assert.equal(e.items,p.items.length);assert.match(e.updated,/^\d{4}-\d{2}-\d{2}$/);
 }
});

/* admin.html: the T6 Venues script against a minimal DOM, with venues/index.json served or not */
function adminPage(fetchImpl){
 const html=fs.readFileSync(path.join(root,'admin.html'),'utf8');
 const src=html.split('<!-- ==== T6 Venues (onboarding) script: start ==== -->')[1].split('<!-- ==== T6 Venues (onboarding) script: end ==== -->')[0].replace(/^\s*<script>|<\/script>\s*$/g,'');
 const all=[],byId=new Map();
 class El{constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.style={};this.hidden=false;this.textContent='';this.className='';this.classList={toggle(){},add(){},remove(){}};if(this.tagName!=='SELECT')this.value='';all.push(this);}
  appendChild(c){this.children.push(c);return c;} append(...c){c.forEach(x=>this.appendChild(x));} replaceChildren(...c){this.children=[];this.append(...c);}
  setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return k in this.attrs?this.attrs[k]:null;} removeAttribute(k){delete this.attrs[k];}
  addEventListener(){} focus(){} querySelectorAll(){return [];}
  get id(){return this._id;} set id(v){this._id=v;byId.set(v,this);}}
 /* a select keeps only a value it has an option for, as in a browser */
 class Select extends El{get value(){return this._v==null?(this.children[0]?this.children[0].value:''):this._v;} set value(v){this._v=this.children.some(o=>o.value===v)?v:'';}}
 const document={createElement:t=>t.toLowerCase()==='select'?new Select(t):new El(t),
  getElementById:id=>byId.get(id)||(()=>{const e=new El('div');e.id=id;return e;})(),
  querySelectorAll:sel=>{const m=/^select\[data-f="(\w+)"\]$/.exec(sel);return m?all.filter(e=>e.tagName==='SELECT'&&e.attrs['data-f']===m[1]):[];}};
 const ctx=vm.createContext({document,location:{origin:'https://aalayna.com',hostname:'aalayna.com',pathname:'/admin.html'},
  sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},fetch:fetchImpl,Event:class{}});
 ctx.window=ctx;
 vm.runInContext(src,ctx);
 return {ctx,document,api:ctx.AalaynaAdminVenues};
}
const profile=menu=>({name:'Em Sherif',place:'Achrafieh',slug:'',gplace:'',brand:'',bg:'',font:'',menu});

test('admin.html builds the menu pack list from venues/index.json and validates against it',async()=>{
 const asked=[];
 const {document,api}=adminPage((url,init)=>{asked.push([url,init]);return Promise.resolve({ok:true,json:()=>Promise.resolve([
  {slug:'em-sherif',name:'Em Sherif',items:40,updated:'2026-09-24'},{slug:'kababji',name:'Kababji',items:75,updated:'2026-09-01'},{slug:'../x',name:'Bad'}])});});
 const sel=document.getElementById('reg-menu');
 assert.deepEqual(sel.children.map(o=>o.value),['','kababji'],'fallback until the manifest arrives');
 assert.equal(api.validateProfile(profile('em-sherif'),null).ok,false);
 sel.value='kababji';
 for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.equal(JSON.stringify(asked),JSON.stringify([['venues/index.json',{cache:'no-store'}]]));   // objects from the vm realm
 assert.deepEqual(sel.children.map(o=>[o.value,o.textContent]),[['','None'],['em-sherif','Em Sherif (venues/em-sherif.json)'],['kababji','Kababji (venues/kababji.json)']]);
 assert.equal(sel.value,'kababji','the choice survives the refill');
 assert.equal(api.validateProfile(profile('em-sherif'),null).ok,true);
 assert.equal(api.validateProfile(profile('../x'),null).ok,false);
 assert.equal(api.validateProfile(profile(''),null).ok,true);
});

test('admin.html keeps the hard-coded Kababji entry when the manifest cannot be read',async()=>{
 for(const f of [()=>Promise.reject(new Error('offline')),()=>Promise.resolve({ok:false,status:404,json:()=>Promise.resolve(null)}),
                 ()=>Promise.resolve({ok:true,json:()=>Promise.resolve({not:'a list'})})]){
  const {document,api}=adminPage(f);
  for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
  assert.deepEqual(document.getElementById('reg-menu').children.map(o=>o.value),['','kababji']);
  assert.equal(api.validateProfile(profile('kababji'),null).ok,true);
  assert.equal(api.validateProfile(profile('em-sherif'),null).ok,false);
 }
});
