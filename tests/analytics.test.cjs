const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup({ endpoint = '', dnt = false } = {}) {
  const records = new Map(), sent = [], listeners = {};
  const window = {
    navigator: { doNotTrack: dnt ? '1' : '0', sendBeacon: (url, body) => { sent.push({url,body}); return true; } },
    document: { addEventListener: (name, cb) => listeners[name] = cb },
    location: { pathname: '/index.html', search: '?contact=private' },
    localStorage: { getItem: k => records.get(k), setItem: (k,v) => records.set(k,v), removeItem: k => records.delete(k) },
    dispatchEvent() {}, AalaynaAnalyticsConfig: { endpoint }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../analytics.js'),'utf8'), { window, Blob, CustomEvent: class { constructor(type,init) { this.type=type;this.detail=init.detail; } } });
  return { a: window.AalaynaAnalytics, sent, listeners };
}
test('tracks navigation and completion without contact data or an unconfigured network request', () => {
  const {a,sent,listeners} = setup();
  listeners.click({ target: { closest: () => ({ dataset: { track: 'demo_start', placement: 'hero' } }) } });
  a.track('demo_complete','card');
  a.track('unexpected_event','email@example.com');
  assert.equal(a.events().length,2);
  assert.equal(a.events()[0].placement,'hero');
  assert.equal(sent.length,0);
  assert.ok(!JSON.stringify(a.events()).includes('contact'));
});
test('configured collector receives only allowlisted anonymous event fields', async () => {
  const {a,sent} = setup({endpoint:'https://collector.example/events'});
  a.track('demo_cash_requested','private@example.com');
  assert.equal(sent.length,1);
  const body = JSON.parse(await sent[0].body.text());
  assert.equal(body.placement,'unspecified');
  assert.deepEqual(Object.keys(body).sort(),['at','name','path','placement']);
});
test('honors Do Not Track and bounds local event retention', () => {
  const quiet = setup({endpoint:'https://collector.example/events',dnt:true});
  quiet.a.track('demo_start','hero');
  assert.equal(quiet.a.events().length,0); assert.equal(quiet.sent.length,0);
  const {a} = setup(); for(let i=0;i<350;i++) a.track('demo_start','hero');
  assert.equal(a.events().length,300); a.clear(); assert.equal(a.events().length,0);
});
