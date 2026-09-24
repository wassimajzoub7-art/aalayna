/* The onboarding page's server (T11): tools/onboard-ui.js, driven over HTTP as the page
   drives it, against the fake Supabase and Messages API of tests/fixtures/onboard-server.cjs,
   with importMenu stubbed as tests/onboard.test.cjs does. Proves that:
   - every call without the session token, or for another Host, is refused;
   - a run started from the form reaches the menu checkpoint and the event stream shows it;
   - a price edited through PUT lands in venues/<slug>.json; a bad pack is refused with the
     validator's message; a pack with a dish without a price is not published;
   - approve completes the run, and the done view has the 12 verify checks, the card sheet,
     the welcome note and the manual checklist;
   - the venues list shows each run; resume after a failure and reset work; one run at a
     time per venue (409);
   - no response and no event carries own_, tbl_, chk_, sk-ant- or the admin key. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), cp = require('node:child_process');
const root = path.join(__dirname, '..');
const { start } = require('./fixtures/onboard-server.cjs');
const { createServer } = require('../tools/onboard-ui.js');
const { loadConfig } = require('../tools/lib/supabase.js');

const SLUG = 'em-sherif', RID = JSON.stringify(['em sherif', 'beirut']);
const ANON = loadConfig({}).anonKey;
const API_KEY = 'sk-ant-test-not-real-0123456789';

const tr = (ar) => ({ fr: { n: '', d: '' }, ar: { n: ar || '', d: '' } });
const PACK = {
  name: 'Em Sherif',
  sections: [{ id: 'mez', name: 'Cold Mezze', win: 'all' }, { id: 'grl', name: 'Grills', win: 'all' }, { id: 'swt', name: 'Sweets', win: 'all' }],
  items: [
    { id: 'i01', sec: 'mez', name: 'Hummus', desc: 'Chickpeas, tahini, lemon', price: 6, ing: ['chickpeas', 'tahini'], al: ['sesame'], kcal: null, pr: null, ft: null, cb: null, tr: tr('حمص'), conf: 0, opts: [] },
    { id: 'i02', sec: 'mez', name: 'Moutabal', desc: 'Smoked aubergine, tahini', price: 7, ing: [], al: [], kcal: null, pr: null, ft: null, cb: null, tr: tr(), conf: 0, opts: [] },
    { id: 'i03', sec: 'grl', name: 'Shish Taouk', desc: 'Chicken, garlic', price: 14, ing: ['chicken'], al: [], kcal: null, pr: null, ft: null, cb: null, tr: tr(), conf: 0, opts: [] },
    { id: 'i04', sec: 'grl', name: 'Kafta', desc: 'Lamb, parsley', price: 15, ing: ['lamb'], al: [], kcal: null, pr: null, ft: null, cb: null, tr: tr(), conf: 0, opts: [] },
    { id: 'i05', sec: 'swt', name: 'Knefeh', desc: 'Akkawi, semolina', price: 8, ing: ['akkawi'], al: ['dairy', 'gluten'], kcal: null, pr: null, ft: null, cb: null, tr: tr(), conf: 0, opts: [] }
  ]
};
const toolAnswer = (name, input) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'tool_use', id: 'toolu_test', name, input }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
const THEME = toolAnswer('set_theme', { brand: '#8a1c2b', bg: '#F7F1E6', font: 'Playfair Display', reasoning: 'Deep red on cream.' });
const WELCOME = toolAnswer('draft_welcome', {
  arabic_greeting: 'أهلا وسهلا',
  what_it_does: ['Guests scan the card and see the menu.', 'They see their bill and split it.', 'They ask to pay cash and staff confirm it.'],
  day_one: 'Waiters enter each bill on the dashboard. Guests scan and ask to pay cash. Staff confirm the cash.'
});

const b64 = buf => buf.toString('base64');
const PDF = Buffer.from('%PDF-1.4\n% test menu\n');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FORM = {
  name: 'Em Sherif', place: 'Beirut', slug: SLUG, currency: 'USD', tables: 24, owner: 'Owner@EmSherif.com',
  staff: [{ email: 'sara@emsherif.com', role: 'manager' }, { email: 'ali@emsherif.com', role: 'waiter' }, { email: '', role: 'waiter' }],
  files: [{ name: 'page 2.jpg', data: b64(JPG) }, { name: 'page1.png', data: b64(PNG) }, { name: 'menu.pdf', data: b64(PDF) }]
};

async function setup(o) {
  o = o || {};
  const server = await start({ anonKey: ANON, answers: { set_theme: THEME, draft_welcome: WELCOME } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aal-onboard-ui-'));
  fs.mkdirSync(path.join(dir, 'venues'));
  const imports = [];
  let hold = null;
  const importMenu = {
    importMenu: async function (a) {
      imports.push(a);
      if (hold) await hold.promise;
      const file = path.join(a.cwd, 'venues', a.slug + '.json');
      if (fs.existsSync(file) && !a.force) throw new Error('venues/' + a.slug + '.json exists; pass force');
      fs.writeFileSync(file, JSON.stringify(PACK, null, 1));
      return { pack: PACK, report: 'Menu import: Em Sherif\n5 items in 3 sections\n  Items with no price (0): none', path: file };
    }
  };
  const env = Object.assign({ AALAYNA_SUPABASE_URL: server.url, ANTHROPIC_BASE_URL: server.url }, o.env || {});
  const ui = await createServer({ cwd: dir, env, importMenu, port: 0 });
  const seen = [];                                          // every response body and event stream, for the secret check
  async function call(method, p, body, opts) {
    opts = opts || {};
    const headers = {};
    if (opts.token !== null) headers['X-Onboard-Token'] = opts.token || ui.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(ui.origin + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    seen.push(p + ' ' + text);
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* text answers */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  /* the whole event stream: the server ends it at the end of the run (or at once when idle) */
  async function stream(slug, since) {
    const res = await fetch(ui.origin + '/api/venues/' + slug + '/events?since=' + (since || 0), { headers: { 'X-Onboard-Token': ui.token } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const text = await res.text();
    seen.push('events ' + text);
    return text.split('\n\n').filter(Boolean).map(block => {
      const ev = {};
      block.split('\n').forEach(l => { if (l.indexOf('event: ') === 0) ev.event = l.slice(7); if (l.indexOf('data: ') === 0) ev.data = JSON.parse(l.slice(6)); if (l.indexOf('id: ') === 0) ev.id = Number(l.slice(4)); });
      return ev;
    });
  }
  const setKeys = () => call('POST', '/api/keys', { admin: server.ADMIN, anthropic: API_KEY });
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'onboarding', SLUG + '.json'), 'utf8'));
  function noSecrets() {
    const all = seen.join('\n');
    for (const bad of ['own_', 'tbl_', 'chk_', 'sk-ant-', server.ADMIN, API_KEY]) assert.ok(!all.includes(bad), 'a response or event contains ' + bad);
    const st = fs.existsSync(path.join(dir, 'onboarding', SLUG + '.json')) ? fs.readFileSync(path.join(dir, 'onboarding', SLUG + '.json'), 'utf8') : '';
    assert.ok(!st.includes(server.ADMIN) && !st.includes(API_KEY), 'the state file holds a model or admin key');
  }
  const hold_ = () => { let release; const promise = new Promise(r => { release = r; }); hold = { promise, release }; return () => { hold = null; release(); }; };
  return { server, dir, ui, call, stream, setKeys, state, imports, seen, noSecrets, hold: hold_,
    close: async () => { await ui.close(); await server.close(); } };
}
const steps = evs => evs.filter(e => e.event === 'step').map(e => e.data.step + ':' + e.data.status);
// the stream ends with the run's end event, or, when the run finished before it connected, with the backlog and idle
const lastId = evs => evs.filter(e => e.id).slice(-1)[0].id;

test('every call without the session token, or for another Host, is refused', async () => {
  const s = await setup();
  try {
    for (const [m, p] of [['GET', '/api/status'], ['POST', '/api/keys'], ['POST', '/api/venues'], ['GET', '/api/venues/' + SLUG], ['GET', '/api/venues/' + SLUG + '/events'], ['PUT', '/api/venues/' + SLUG + '/pack']]) {
      assert.equal((await s.call(m, p, m === 'GET' ? undefined : {}, { token: null })).status, 403, m + ' ' + p + ' without a token');
      assert.equal((await s.call(m, p, m === 'GET' ? undefined : {}, { token: 'f'.repeat(64) })).status, 403, m + ' ' + p + ' with a wrong token');
    }
    // the key sent without the token did not land
    await s.call('POST', '/api/keys', { admin: 'adm_should_not_land' }, { token: null });
    assert.deepEqual((await s.call('GET', '/api/status')).json.keys, { admin: 'missing', anthropic: 'missing' });
    // the page and its files take the token in the address, since a browser opens them directly
    assert.equal((await fetch(s.ui.origin + '/')).status, 403);
    assert.equal((await fetch(s.ui.origin + '/app.js')).status, 403);
    assert.equal((await fetch(s.ui.origin + '/?t=' + '0'.repeat(64))).status, 403);
    const page = await fetch(s.ui.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('app.js?t=' + s.ui.token) && html.includes('app.css?t=' + s.ui.token));
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await fetch(s.ui.origin + '/app.js?t=' + s.ui.token)).status, 200);
    // no CORS: a response never invites another origin
    const ok = await s.call('GET', '/api/status');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    // another Host (DNS rebinding) is refused even with the token
    const other = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.ui.port, path: '/api/status', headers: { Host: 'evil.example:' + s.ui.port, 'X-Onboard-Token': s.ui.token } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(other, 403);
    // bound to 127.0.0.1 only
    assert.match(s.ui.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally { await s.close(); }
});

test('a run from the form reaches the checkpoint, edits save to the pack, approve completes it, and nothing secret leaves the server', async () => {
  const s = await setup();
  try {
    const st0 = (await s.call('GET', '/api/status')).json;
    assert.deepEqual(st0.keys, { admin: 'missing', anthropic: 'missing' });
    assert.deepEqual(st0.venues, []);
    const k = await s.setKeys();
    assert.equal(k.status, 200);
    assert.deepEqual(k.json, { keys: { admin: 'set', anthropic: 'set' } });   // "set", never the key

    const r = await s.call('POST', '/api/venues', FORM);
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(r.json, { slug: SLUG });
    const evs = await s.stream(SLUG, 0);
    assert.deepEqual(steps(evs), ['register:running', 'register:done', 'theme:running', 'theme:done', 'menu:running', 'menu:waiting']);
    const end = evs.find(e => e.event === 'end');
    assert.deepEqual([end.data.code, end.data.status, end.data.kind], [0, 'waiting', 'start']);
    const menuEv = evs.find(e => e.event === 'step' && e.data.status === 'waiting');
    assert.match(menuEv.data.summary, /^extracted 5 items in 3 sections\. Review venues\/em-sherif\.json/);
    const log = evs.filter(e => e.event === 'log').map(e => e.data.line).join('\n');
    assert.match(log, /\[1\/7\] register\s+done\s+Em Sherif, Beirut registered as em-sherif/);   // the terminal's lines
    assert.match(log, /\[2\/7\] theme\s+done\s+brand #8A1C2B/);
    assert.match(log, /5 items in 3 sections/);                                           // the importer's report
    const ids = evs.filter(e => e.id).map(e => e.id);
    assert.deepEqual(ids, ids.slice().sort((x, y) => x - y));                             // in order, for since= resumes

    // the files arrived in the page's order, named by what they are, readable by the founder only
    assert.deepEqual(s.imports[0].files.map(f => path.basename(f)), ['01-page-2.jpg', '02-page1.png', '03-menu.pdf']);
    assert.ok(s.imports[0].files.every(f => f.startsWith(path.join(s.dir, 'onboarding', SLUG, 'uploads'))));
    assert.equal(fs.statSync(s.imports[0].files[0]).mode & 0o077, 0);
    assert.deepEqual(fs.readFileSync(s.imports[0].files[2]), PDF);
    assert.equal(s.imports[0].rate, undefined);                                           // USD: no rate
    const st = s.state();
    assert.equal(st.inputs.owner, 'owner@emsherif.com');
    assert.deepEqual(st.inputs.staff, [{ email: 'sara@emsherif.com', role: 'manager' }, { email: 'ali@emsherif.com', role: 'waiter' }]);
    assert.equal(s.server.rpcCalls('aal_admin_register_venue').length, 1);

    // the list and the venue view
    const list = (await s.call('GET', '/api/status')).json.venues;
    assert.deepEqual(list.map(v => [v.slug, v.name, v.place, v.lastStep, v.status, v.running]), [[SLUG, 'Em Sherif', 'Beirut', 'menu', 'waiting', false]]);
    const view = (await s.call('GET', '/api/venues/' + SLUG)).json.venue;
    assert.deepEqual(view.steps.map(x => x.status), ['done', 'done', 'waiting', 'pending', 'pending', 'pending', 'pending']);
    assert.deepEqual(view.inputs.files, ['01-page-2.jpg', '02-page1.png', '03-menu.pdf']);
    assert.deepEqual(view.pack, { path: 'venues/em-sherif.json', items: 5, sections: 3 });
    assert.ok(!('venue' in view) && !JSON.stringify(view).includes(st.venue.owner_key));

    // the pack: read, edited, refused when broken
    const pk = (await s.call('GET', '/api/venues/' + SLUG + '/pack')).json;
    assert.deepEqual(pk.pack, PACK);
    assert.deepEqual(pk.blockers, []);
    assert.match(pk.report, /Menu import: Em Sherif/);
    const file = path.join(s.dir, 'venues', SLUG + '.json');
    const edited = JSON.parse(JSON.stringify(PACK));
    edited.items[1].price = 7.5;
    edited.items = edited.items.filter(x => x.id !== 'i04');                               // Delete row
    const put = await s.call('PUT', '/api/venues/' + SLUG + '/pack', edited);
    assert.equal(put.status, 200, put.text);
    assert.deepEqual(put.json, { ok: true, blockers: [], items: 4 });
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.items.find(x => x.id === 'i02').price, 7.5);
    assert.equal(disk.items.length, 4);
    const bad = JSON.parse(JSON.stringify(edited));
    bad.items[0].price = -3;
    bad.items[1].al = ['peanuts'];
    const refused = await s.call('PUT', '/api/venues/' + SLUG + '/pack', bad);
    assert.equal(refused.status, 422);
    assert.equal(refused.json.error, 'Not saved: item i01 price is not a positive number or null; item i02 has an allergen outside the vocabulary.');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].price, 6);            // unchanged on disk
    // a dish without a price is a valid pack (the importer writes null) but is not published
    const noPrice = JSON.parse(JSON.stringify(edited));
    noPrice.items[1].price = null;
    const saved = await s.call('PUT', '/api/venues/' + SLUG + '/pack', noPrice);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.blockers, ['item 2 (Moutabal) has no price: write one in']);
    const blocked = await s.call('POST', '/api/venues/' + SLUG + '/approve', {});
    assert.equal(blocked.status, 422);
    assert.match(blocked.json.error, /^Not published yet: item 2 \(Moutabal\) has no price: write one in\.$/);
    assert.equal(s.state().steps.menu.status, 'pending');                                  // still at the checkpoint
    assert.equal(s.server.calls.filter(c => c.path === '/rest/v1/kv_docs').length, 0);
    assert.equal((await s.call('PUT', '/api/venues/' + SLUG + '/pack', edited)).status, 200);

    // approve: publish, then tables, staff, verify, welcome
    const ap = await s.call('POST', '/api/venues/' + SLUG + '/approve', {});
    assert.equal(ap.status, 202, ap.text);
    const evs2 = await s.stream(SLUG, end.id);
    assert.equal(evs2[0].event, 'start');
    assert.equal(evs2[0].data.kind, 'approve');
    assert.deepEqual(steps(evs2), ['register:done', 'theme:done', 'menu:running', 'menu:done', 'tables:running', 'tables:done', 'staff:running', 'staff:done',
      'verify:running', 'verify:done', 'welcome:running', 'welcome:done']);
    assert.deepEqual(evs2.filter(e => e.event === 'step' && e.data.earlier).map(e => e.data.step), ['register', 'theme']);
    const end2 = evs2.find(e => e.event === 'end');
    assert.deepEqual([end2.event, end2.data.code, end2.data.status], ['end', 0, 'done']);
    const live = s.server.db.docs.get(RID + '|aal.live').body;
    assert.deepEqual(live.items.map(x => [x.id, x.price]), [['i01', 6], ['i02', 7.5], ['i03', 14], ['i05', 8]]);   // what the page left

    const done = (await s.call('GET', '/api/venues/' + SLUG)).json.venue;
    assert.equal(done.status, 'done');
    assert.equal(done.checks.length, 12);
    assert.deepEqual(done.checks.map(c => c.status), Array(12).fill('pass'));
    assert.equal(done.checks[11].name, 'revoke table 9999\'s code');
    assert.deepEqual(done.published, { version: 1, items: 4, sections: 3 });
    assert.deepEqual(done.tables, { count: 24 });
    assert.equal(done.cards, '/onboarding/em-sherif-table-cards.html');
    assert.equal(done.welcome, true);
    assert.deepEqual(done.theme, { brand: '#8A1C2B', bg: '#F7F1E6', font: 'Playfair Display', source: 'model' });
    assert.deepEqual(done.checklist, [
      '[ ] Print the table cards: open onboarding/em-sherif-table-cards.html in a browser and print on card stock',
      '[ ] Send the welcome note: onboarding/em-sherif-welcome.md (add your WhatsApp number first)',
      '[ ] If they want Google reviews, set their Google place id in admin.html (Venues, Em Sherif); there is no Places API key here',
      '[ ] Check brand #8A1C2B, background #F7F1E6 and font Playfair Display against their Instagram',
      '[x] Demo payments are off for this venue (set at registration)']);
    assert.match(evs2.filter(e => e.event === 'log').map(e => e.data.line).join('\n'), /Em Sherif is live\. Still to do by hand:\n  \[ \] Print the table cards/);   // the terminal's list, unchanged
    assert.equal((await s.call('GET', '/api/status')).json.venues[0].status, 'done');

    // the card sheet (with the token in the address, as a new tab opens it) and the welcome note
    assert.equal((await fetch(s.ui.origin + done.cards)).status, 403);
    const sheet = await fetch(s.ui.origin + done.cards + '?t=' + s.ui.token);
    assert.equal(sheet.status, 200);
    const html = await sheet.text();                                                       // holds the codes by design: not in `seen`
    assert.equal((html.match(/<div class="tent">/g) || []).length, 24);
    assert.ok(html.includes(s.state().steps.tables.data.codes[1]));
    assert.equal((await fetch(s.ui.origin + '/onboarding/other-table-cards.html?t=' + s.ui.token)).status, 404);
    const note = await s.call('GET', '/api/venues/' + SLUG + '/welcome');
    assert.equal(note.status, 200);
    assert.match(note.headers.get('content-type'), /^text\/plain/);
    assert.match(note.text, /# Welcome to Aalayna, Em Sherif/);
    assert.match(note.text, /Wassim, WhatsApp \[WhatsApp number\]/);

    // a finished venue: the stream is idle at once
    const idle = await s.stream(SLUG, done.seq);
    assert.deepEqual(idle.map(e => e.event), ['idle']);
    s.noSecrets();
  } finally { await s.close(); }
});

test('a failed run shows the step message; resume continues it; reset forgets it; a new start can re-extract', async () => {
  const s = await setup();
  try {
    await s.call('POST', '/api/keys', { anthropic: API_KEY });                           // the admin key is missing
    assert.equal((await s.call('POST', '/api/venues', FORM)).status, 202);
    let evs = await s.stream(SLUG, 0);
    assert.deepEqual(steps(evs), ['register:failed']);
    assert.equal(evs.find(e => e.event === 'step').data.summary, 'The register step needs AALAYNA_ADMIN_KEY in the environment; export it and run again.');
    let v = (await s.call('GET', '/api/venues/' + SLUG)).json.venue;
    assert.equal(v.status, 'failed');
    assert.equal(v.steps[0].error, 'The register step needs AALAYNA_ADMIN_KEY in the environment; export it and run again.');
    assert.deepEqual((await s.call('GET', '/api/status')).json.venues.map(x => [x.slug, x.lastStep, x.status]), [[SLUG, 'register', 'failed']]);
    assert.equal(s.server.calls.length, 0);
    // a second start with the same short name is refused: the venue is in the list
    const again = await s.call('POST', '/api/venues', FORM);
    assert.equal(again.status, 409);
    assert.equal(again.json.field, 'slug');

    await s.call('POST', '/api/keys', { admin: s.server.ADMIN });
    assert.equal((await s.call('POST', '/api/venues/' + SLUG + '/resume', {})).status, 202);
    evs = await s.stream(SLUG, lastId(evs));
    assert.deepEqual(steps(evs), ['register:running', 'register:done', 'theme:running', 'theme:done', 'menu:running', 'menu:waiting']);
    assert.equal(s.imports.length, 1);

    // reset: the state file and the uploads go, Supabase and the pack stay
    const reset = await s.call('POST', '/api/venues/' + SLUG + '/reset', {});
    assert.equal(reset.status, 200, reset.text);
    assert.match(reset.json.message, /removed onboarding\/em-sherif\.json\. Supabase is unchanged/);
    assert.ok(!fs.existsSync(path.join(s.dir, 'onboarding', SLUG + '.json')));
    assert.ok(!fs.existsSync(path.join(s.dir, 'onboarding', SLUG)));
    assert.ok(fs.existsSync(path.join(s.dir, 'venues', SLUG + '.json')));
    assert.equal((await s.call('GET', '/api/venues/' + SLUG)).status, 404);
    assert.deepEqual((await s.call('GET', '/api/status')).json.venues, []);
    assert.equal((await s.call('POST', '/api/venues/' + SLUG + '/resume', {})).status, 404);
    const slugInfo = (await s.call('GET', '/api/slug?slug=' + SLUG)).json;
    assert.deepEqual(slugInfo, { slug: SLUG, valid: true, taken: false, pack: { items: 5 } });

    // started again: the venue is found again, not registered twice; the kept pack is shown unless re-read
    assert.equal((await s.call('POST', '/api/venues', FORM)).status, 202);
    evs = await s.stream(SLUG, 0);
    assert.match(evs.filter(e => e.event === 'log').map(e => e.data.line).join('\n'), /already registered as em-sherif; reused it, keys unchanged/);
    assert.match(evs.find(e => e.event === 'step' && e.data.status === 'waiting').data.summary, /^found 5 items/);
    assert.equal(s.imports.length, 1);
    await s.call('POST', '/api/venues/' + SLUG + '/reset', {});
    assert.equal((await s.call('POST', '/api/venues', Object.assign({}, FORM, { reimport: true }))).status, 202);
    evs = await s.stream(SLUG, 0);
    assert.match(evs.find(e => e.event === 'step' && e.data.status === 'waiting').data.summary, /^extracted 5 items/);
    assert.equal(s.imports.length, 2);
    assert.equal(s.imports[1].force, true);
    // re-extract from the checkpoint
    assert.equal((await s.call('POST', '/api/venues/' + SLUG + '/reimport', {})).status, 202);
    evs = await s.stream(SLUG, lastId(evs));
    assert.deepEqual(steps(evs).slice(-2), ['menu:running', 'menu:waiting']);
    assert.equal(s.imports.length, 3);
    assert.equal(s.server.rpcCalls('aal_admin_register_venue').length, 1);
    s.noSecrets();
  } finally { await s.close(); }
});

test('one run at a time per venue: a second start, a resume, an edit or a reset during a run is refused with 409', async () => {
  const s = await setup();
  try {
    await s.setKeys();
    const release = s.hold();
    assert.equal((await s.call('POST', '/api/venues', FORM)).status, 202);
    for (let i = 0; i < 200 && !s.imports.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(s.imports.length, 1, 'the run reached the importer');
    const v = (await s.call('GET', '/api/venues/' + SLUG)).json.venue;
    assert.deepEqual([v.running, v.status, v.lastStep, v.steps[2].status], [true, 'running', 'menu', 'running']);
    assert.deepEqual((await s.call('GET', '/api/status')).json.venues.map(x => [x.status, x.running]), [['running', true]]);
    for (const [m, p, body] of [['POST', '/api/venues', FORM], ['POST', '/api/venues/' + SLUG + '/resume', {}], ['POST', '/api/venues/' + SLUG + '/approve', {}],
      ['POST', '/api/venues/' + SLUG + '/reset', {}], ['PUT', '/api/venues/' + SLUG + '/pack', PACK]]) {
      const r = await s.call(m, p, body);
      assert.equal(r.status, 409, m + ' ' + p + ': ' + r.text);
      assert.match(r.json.error, /already going|is going/);
    }
    // polling sees the same progress as the stream
    const polled = (await s.call('GET', '/api/venues/' + SLUG + '?since=0')).json.events;
    assert.deepEqual(steps(polled.map(e => ({ event: e.type, data: e }))), ['register:running', 'register:done', 'theme:running', 'theme:done', 'menu:running']);
    const streaming = s.stream(SLUG, polled.slice(-1)[0].seq);
    release();
    const rest = await streaming;
    assert.deepEqual(steps(rest), ['menu:waiting']);
    assert.deepEqual(rest.filter(e => e.event === 'end').map(e => e.data.status), ['waiting']);
    assert.equal((await s.call('POST', '/api/venues/' + SLUG + '/resume', {})).status, 202);   // free again
    await s.stream(SLUG, 0);
    s.noSecrets();
  } finally { await s.close(); }
});

test('the form is checked field by field; the LBP rate reaches the importer; files are checked by their bytes and capped at 40 MB', async () => {
  const s = await setup();
  try {
    await s.setKeys();
    const bad = async (patch, field, re, status) => {
      const r = await s.call('POST', '/api/venues', Object.assign({}, FORM, patch));
      assert.equal(r.status, status || 400, JSON.stringify(patch).slice(0, 80) + ': ' + r.text.slice(0, 200));
      assert.equal(r.json.field, field);
      assert.match(r.json.error, re);
    };
    await bad({ slug: 'Em Sherif!' }, 'slug', /lower-case letters, digits and hyphens/);
    await bad({ slug: '-em' }, 'slug', /not starting or ending with a hyphen/);
    await bad({ slug: 'index' }, 'slug', /reserved/);
    await bad({ name: '' }, 'name', /The name is required/);
    await bad({ name: 'Em "Sherif"' }, 'name', /double quotes/);
    await bad({ tables: 0 }, 'tables', /1 to 200/);
    await bad({ tables: 2.5 }, 'tables', /1 to 200/);
    await bad({ owner: 'owner' }, 'owner', /not a valid email/);
    await bad({ staff: [{ email: 'owner@emsherif.com', role: 'waiter' }] }, 'staff', /is the owner email already/);
    await bad({ staff: [{ email: 'a@b.co', role: 'chef' }] }, 'staff', /owner, manager or waiter/);
    await bad({ currency: 'EUR' }, 'currency', /USD or LBP/);
    await bad({ currency: 'LBP', rate: 12 }, 'rate', /1,000 to 10,000,000/);
    await bad({ brand: 'red' }, 'brand', /six digit hex/);
    await bad({ font: 'Comic<Sans>' }, 'font', /Google Fonts name/);
    await bad({ files: [] }, 'files', /Add the menu/);
    await bad({ files: [{ name: 'menu.pdf', data: b64(Buffer.from('not a pdf at all')) }] }, 'files', /menu\.pdf is not a PDF, JPG, PNG or WebP file/);
    await bad({ files: [{ name: 'IMG_1.heic', data: b64(Buffer.from('....ftypheic')) }] }, 'files', /HEIC/);
    await bad({ files: [{ name: 'big.jpg', data: b64(Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)])) }] }, 'files', /over 5 MB/);
    const half = b64(Buffer.concat([PDF, Buffer.alloc(20.5 * 1024 * 1024)]));
    await bad({ files: [{ name: 'a.pdf', data: half }, { name: 'b.pdf', data: half }] }, 'files', /over 40 MB together/, 413);
    assert.ok(!fs.existsSync(path.join(s.dir, 'onboarding')), 'nothing written for a refused form');
    assert.equal(s.imports.length, 0);

    // LBP: the rate goes to the importer, and survives a re-extract
    const r = await s.call('POST', '/api/venues', Object.assign({}, FORM, { currency: 'LBP', rate: 90000, slug: '' }));
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.slug, 'em-sherif');                                              // derived from the name, as the command line does
    await s.stream(SLUG, 0);
    assert.deepEqual([s.imports[0].currency, s.imports[0].rate], ['LBP', 90000]);
    assert.equal((await s.call('POST', '/api/venues/' + SLUG + '/reimport', {})).status, 202);
    await s.stream(SLUG, 0);
    assert.equal(s.imports[1].rate, 90000);
    const v = (await s.call('GET', '/api/venues/' + SLUG)).json.venue;
    assert.deepEqual([v.inputs.currency, v.inputs.rate], ['LBP', 90000]);
  } finally { await s.close(); }
});

test('node tools/onboard.js ui starts the server on 127.0.0.1 and prints the address; the page ships and the uploads stay out of git', async () => {
  const child = cp.spawn(process.execPath, [path.join(root, 'tools', 'onboard.js'), 'ui', '--port', '0', '--no-open'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let out = '';
    const url = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no address printed: ' + out)), 5000);
      child.stdout.on('data', d => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64})/.exec(out); if (m) { clearTimeout(t); resolve(m[1]); } });
    });
    assert.match(out, /Aalayna onboarding is running at/);
    assert.match(out, /The page will ask for the admin key and the Anthropic key \(kept in memory for this session only\)/);
    const u = new URL(url);
    const st = await fetch(u.origin + '/api/status', { headers: { 'X-Onboard-Token': u.searchParams.get('t') } });
    assert.equal(st.status, 200);
    assert.deepEqual((await st.json()).keys, { admin: 'missing', anthropic: 'missing' });
  } finally { child.kill('SIGINT'); }
  const usage = cp.spawnSync(process.execPath, [path.join(root, 'tools', 'onboard.js'), 'ui', '--bogus'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /Usage: node tools\/onboard\.js ui/);
  const ig = f => cp.spawnSync('git', ['check-ignore', '-q', f], { cwd: root }).status === 0;
  assert.ok(!ig('tools/onboard-ui.js'));
  assert.ok(!ig('tools/ui/index.html') && !ig('tools/ui/app.js') && !ig('tools/ui/app.css'));
  assert.ok(ig('onboarding/em-sherif/uploads/01-menu.pdf'));
  assert.ok(ig('onboarding/em-sherif/ui.json'));
});
