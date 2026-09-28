/* The menu editor (editor.html) reads the shared draft into its own lists (pull) and writes them back on every
   edit (push). A section's translations (tr: its French and Arabic names) must survive that round trip, or the
   guest menu's category names fall back to English after any change. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','editor.html'),'utf8');
const code=src.slice(src.indexOf('var SECTIONS = [], ITEMS = [];'),src.indexOf('function active(){'));

test('an edit in the menu editor keeps every section\'s French and Arabic names',()=>{
 const draft={sections:[{id:'sal',name:'Salads',win:'all',tr:{fr:{n:'Salades'},ar:{n:'سلطات'}}},{id:'grl',name:'Charcoal Grill',win:'all'}],items:[]};
 let saved=null;
 const ctx={Aalayna:{draft:()=>JSON.parse(JSON.stringify(draft)),published:()=>({items:[]}),saveDraft:d=>{saved=d;},actor:()=>'owner'},JSON,Object};
 vm.createContext(ctx);
 vm.runInContext(code+';pull();SECTIONS[1].w="dinner";push();',ctx);
 const out=JSON.parse(JSON.stringify(saved.sections));
 assert.deepEqual(out[0],{id:'sal',name:'Salads',win:'all',tr:{fr:{n:'Salades'},ar:{n:'سلطات'}}},'translations kept');
 assert.deepEqual(out[1],{id:'grl',name:'Charcoal Grill',win:'dinner'},'a section without translations gets none invented');
});
