/* Onboarding pipeline (T10): tools/onboard.js and tools/steps/*, run in process against a
   fake Supabase and a fake Messages API on a local HTTP server
   (tests/fixtures/onboard-server.cjs), with the model steps replayed from fixture files and
   importMenu stubbed (tools/import-menu.js belongs to T9). Proves that:
   - a fresh run registers, themes and extracts, then stops at the menu checkpoint;
   - the run with --approve-menu publishes what the founder left in venues/<slug>.json
     (aal.draft and aal.live, as the editor's publish makes them), issues the codes, invites
     the staff, passes the live smoke test and drafts the welcome note;
   - a re-run, a --from re-run and a run after --reset register nothing twice and reissue
     no table code; a revoked code is replaced and named, one issued elsewhere is kept;
   - a missing admin key fails the register step with one sentence and calls nothing;
   - verify asserts each check, stops at the first failure, still revokes table 9999, and
     the next run closes the test bill it left open;
   - the card sheet has one card per table with the right link, drawn by qr-lib.js;
   - the state file never holds the admin key; the console never shows a key or a code;
   - the model request has the documented headers and blocks; Supabase messages are shown. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const root = path.join(__dirname, '..');
const { start } = require('./fixtures/onboard-server.cjs');
const { main } = require('../tools/onboard.js');
const { qrSvg, tableURL } = require('../tools/lib/cards.js');
const { loadConfig } = require('../tools/lib/supabase.js');
const { FONTS } = require('../tools/steps/theme.js');

const SLUG = 'em-sherif', RID = JSON.stringify(['em sherif', 'beirut']);
const ARGS = ['--name', 'Em Sherif', '--place', 'Beirut', '--slug', SLUG, '--currency', 'USD', '--tables', '24',
  '--owner', 'owner@emsherif.com', '--staff', 'sara@emsherif.com:manager,ali@emsherif.com:waiter', 'menu.pdf'];
const ANON = loadConfig({}).anonKey;

const PACK = {
  name: 'Em Sherif',
  sections: [{ id: 'mez', name: 'Cold Mezze', win: 'all' }, { id: 'grl', name: 'Grills', win: 'all' }, { id: 'swt', name: 'Sweets', win: 'all' }],
  items: [
    { id: 'm01', sec: 'mez', name: 'Hummus', desc: 'Chickpeas, tahini, lemon', price: 6, ing: ['chickpeas', 'tahini', 'lemon'], al: ['sesame'], kcal: null, pr: null, ft: null, cb: null, tr: { fr: { n: '', d: '' }, ar: { n: 'حمص', d: '' } } },
    { id: 'm02', sec: 'mez', name: 'Moutabal', desc: 'Smoked aubergine, tahini', price: 7, ing: [], al: [] },
    { id: 'g01', sec: 'grl', name: 'Shish Taouk', desc: 'Chicken, garlic', price: 14, ing: ['chicken', 'garlic'], al: [] },
    { id: 'g02', sec: 'grl', name: 'Kafta', desc: 'Lamb, parsley, onion', price: 15, ing: ['lamb', 'parsley', 'onion'], al: [] },
    { id: 's01', sec: 'swt', name: 'Knefeh', desc: 'Akkawi, semolina, syrup', price: 8, ing: ['akkawi', 'semolina', 'syrup'], al: ['dairy', 'gluten'] }
  ]
};
const toolAnswer = (name, input, model) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: model || 'claude-opus-5-5',
  content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id: 'toolu_test', name, input }], stop_reason: 'tool_use',
  usage: { input_tokens: 1, output_tokens: 1 } });
const THEME = toolAnswer('set_theme', { brand: '#8a1c2b', bg: '#F7F1E6', font: 'Playfair Display', reasoning: 'Deep red headings on cream paper, set in a high-contrast serif.' });
const WELCOME = toolAnswer('draft_welcome', {
  arabic_greeting: 'أهلا وسهلا بكم في عائلة عليناء',
  what_it_does: ['Your guests scan the card on their table and see your menu \u2014 no app needed.', 'They see their bill on their phone and split it.', 'They ask to pay cash and your staff confirm it.'],
  day_one: 'Your waiters enter each table\'s bill on the dashboard. Guests scan, check the bill and ask to pay cash. Staff confirm the cash once collected.'
});

async function setup(o) {
  o = o || {};
  const server = await start({ anonKey: ANON, answers: { set_theme: THEME, draft_welcome: WELCOME }, missing: o.missing });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aal-onboard-'));
  fs.mkdirSync(path.join(dir, 'venues'));
  fs.writeFileSync(path.join(dir, 'menu.pdf'), '%PDF-1.4\n% test menu\n');
  const fx = path.join(dir, 'fixtures');
  fs.mkdirSync(fx);
  fs.writeFileSync(path.join(fx, 'theme.json'), JSON.stringify(THEME));
  fs.writeFileSync(path.join(fx, 'welcome.json'), JSON.stringify(WELCOME));
  const imports = [];
  const importMenu = {
    importMenu: async function (a) {
      imports.push(a);
      const file = path.join(a.cwd, 'venues', a.slug + '.json');
      if (fs.existsSync(file) && !a.force) throw new Error('venues/' + a.slug + '.json exists; pass force');
      fs.writeFileSync(file, JSON.stringify(PACK, null, 1));
      return { pack: PACK, report: '5 items in 3 sections\n1 item has no ingredients (Moutabal)', path: file };
    }
  };
  const env = Object.assign({ AALAYNA_ADMIN_KEY: server.ADMIN, ANTHROPIC_API_KEY: 'sk-ant-test-not-real', AALAYNA_SUPABASE_URL: server.url }, o.env || {});
  (o.unset || []).forEach(k => delete env[k]);
  const outputs = [];
  async function run(args, extra) {
    const lines = [];
    const code = await main(args, Object.assign({ cwd: dir, shellCwd: dir, env, out: l => lines.push(l), importMenu, confirm: async () => true }, extra || {}));
    const text = lines.join('\n');
    outputs.push(text);
    return { code, text };
  }
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'onboarding', SLUG + '.json'), 'utf8'));
  const fixture = ['--fixture-dir', fx];
  return { server, dir, env, run, state, imports, outputs, fixture, close: () => server.close() };
}
const tokensOf = s => s.state().steps.tables.data.codes;
const issues = (server, pred) => server.rpcCalls('aal_table_tokens').filter(c => c.body.p_body.op === 'issue' && (!pred || pred(c.body.p_body.table)));

test('a fresh run registers, themes and extracts the menu, then stops at the checkpoint', async () => {
  const s = await setup();
  try {
    const r = await s.run(ARGS.concat(s.fixture));
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /\[1\/7\] register\s+done\s+Em Sherif, Beirut registered as em-sherif/);
    assert.match(r.text, /\[2\/7\] theme\s+done\s+brand #8A1C2B, background #F7F1E6, font Playfair Display \(from the menu\)/);
    assert.match(r.text, /\[3\/7\] menu\s+waiting\s+extracted 5 items in 3 sections\. Review venues\/em-sherif\.json, then run again with --approve-menu/);
    assert.match(r.text, /1 item has no ingredients \(Moutabal\)/);                       // the importer's report is printed
    assert.match(r.text, /node tools\/onboard\.js --slug em-sherif --approve-menu/);
    assert.doesNotMatch(r.text, /\[4\/7\]/);
    const st = s.state();
    assert.deepEqual(Object.fromEntries(Object.entries(st.steps).map(([k, v]) => [k, v.status])),
      { register: 'done', theme: 'done', menu: 'pending', tables: 'pending', staff: 'pending', verify: 'pending', welcome: 'pending' });
    assert.equal(st.venue.restaurant_id, RID);
    assert.match(st.venue.owner_key, /^own_[0-9a-f]{36}$/);
    assert.equal(st.inputs.tables, 24);
    assert.deepEqual(st.inputs.staff, [{ email: 'sara@emsherif.com', role: 'manager' }, { email: 'ali@emsherif.com', role: 'waiter' }]);
    // the profile: slug, menu pack, demo payments off, then the theme
    const reg = s.server.rpcCalls('aal_admin_register_venue');
    assert.equal(reg.length, 1);
    assert.deepEqual(reg[0].body, { p_name: 'Em Sherif', p_place: 'Beirut', p_slug: SLUG, p_profile: { slug: SLUG, menu_pack: SLUG, demo_payments: false } });
    assert.equal(reg[0].headers['x-aalayna-admin'], s.server.ADMIN);
    assert.equal(reg[0].headers.apikey, ANON);
    const prof = s.server.db.profiles.get(RID);
    assert.deepEqual([prof.slug, prof.menu_pack, prof.demo_payments, prof.brand, prof.bg, prof.font], [SLUG, SLUG, false, '#8A1C2B', '#F7F1E6', 'Playfair Display']);
    // importMenu got the same files and the venue details; nothing is published yet
    assert.equal(s.imports.length, 1);
    assert.deepEqual([s.imports[0].files, s.imports[0].name, s.imports[0].slug, s.imports[0].currency, s.imports[0].force, s.imports[0].cwd],
      [[path.join(s.dir, 'menu.pdf')], 'Em Sherif', SLUG, 'USD', false, s.dir]);
    assert.equal(s.server.calls.filter(c => c.path === '/rest/v1/kv_docs').length, 0);
    // a run without --approve-menu stops again and does not extract again
    const again = await s.run(['--slug', SLUG].concat(s.fixture));
    assert.equal(again.code, 0);
    assert.match(again.text, /menu\s+waiting\s+found 5 items/);
    assert.equal(s.imports.length, 1);
    assert.equal(s.server.rpcCalls('aal_admin_register_venue').length, 1);
  } finally { await s.close(); }
});

test('--approve-menu publishes the reviewed pack as the editor would, then tables, staff, verify and welcome complete', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    // the founder edits the pack before approving: a price and a new dish
    const file = path.join(s.dir, 'venues', SLUG + '.json');
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    pack.items[0].price = 6.5;
    pack.items.push({ id: 's02', sec: 'swt', name: 'Maamoul', desc: 'Dates, semolina', price: 4, ing: ['dates', 'semolina'], al: ['gluten'] });
    fs.writeFileSync(file, JSON.stringify(pack));
    const r = await s.run(['--slug', SLUG, '--approve-menu'].concat(s.fixture));
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /register\s+done\s+\(earlier\)/);
    assert.match(r.text, /menu\s+done\s+published version 1: 6 items in 3 sections, read back from the server/);
    assert.match(r.text, /tables\s+done\s+24 table codes \(issued 24\); cards in onboarding\/em-sherif-table-cards\.html/);
    assert.match(r.text, /staff\s+done\s+invited 3, already on the list 0; 3 live staff member\(s\), no email sent/);
    assert.match(r.text, /verify\s+done\s+12 of 12 checks passed; test bill left closed on table 9999/);
    assert.match(r.text, /welcome\s+done\s+drafted onboarding\/em-sherif-welcome\.md with an Arabic greeting; not sent/);
    assert.match(r.text, /Em Sherif is live\. Still to do by hand:/);
    assert.match(r.text, /\[ \] Print the table cards: open onboarding\/em-sherif-table-cards\.html/);
    assert.match(r.text, /\[ \] Send the welcome note: onboarding\/em-sherif-welcome\.md/);
    assert.match(r.text, /\[ \] If they want Google reviews, set their Google place id in admin\.html/);
    assert.match(r.text, /\[ \] Check brand #8A1C2B, background #F7F1E6 and font Playfair Display against their Instagram/);
    assert.match(r.text, /\[x\] Demo payments are off for this venue/);
    assert.ok(Object.values(s.state().steps).every(x => x.status === 'done'));

    // one upsert, both documents, owner key, the editor's conflict target and Prefer
    const up = s.server.calls.filter(c => c.path === '/rest/v1/kv_docs');
    assert.equal(up.length, 1);
    assert.equal(up[0].search, '?on_conflict=restaurant_id,key');
    assert.match(up[0].headers.prefer, /resolution=merge-duplicates/);
    assert.equal(up[0].headers['x-aalayna-key'], s.state().venue.owner_key);
    assert.deepEqual(up[0].body.map(d => [d.restaurant_id, d.key]), [[RID, 'aal.draft'], [RID, 'aal.live']]);
    const live = s.server.db.docs.get(RID + '|aal.live').body, draft = s.server.db.docs.get(RID + '|aal.draft').body;
    // the store's publish: version, sections, items and at; draft equals live
    assert.deepEqual(Object.keys(live).sort(), ['at', 'items', 'sections', 'version']);
    assert.equal(live.version, 1);
    assert.ok(Date.parse(live.at) > Date.now() - 60000);
    assert.deepEqual(draft, live);
    assert.deepEqual(live.sections, PACK.sections);
    assert.deepEqual(live.items.map(x => [x.id, x.price]), [['m01', 6.5], ['m02', 7], ['g01', 14], ['g02', 15], ['s01', 8], ['s02', 4]]);
    // every item went through the store's normalise(): no demo dish, full shape
    const m02 = live.items.find(x => x.id === 'm02');
    assert.equal(m02.status, 'incomplete');
    assert.equal(m02.available, true);
    assert.equal(m02.archivedAt, null);
    assert.deepEqual(m02.tr, { fr: { n: '', d: '' }, ar: { n: '', d: '' } });
    assert.equal(live.items.find(x => x.id === 'm01').ar, 1);
    assert.ok(!live.items.some(x => x.id === 'i17' || x.id === 'i01'));

    // verify: every check recorded, and what it leaves behind
    const v = s.state().steps.verify.data;
    assert.deepEqual(v.checks.map(c => c.status), Array(12).fill('pass'));
    assert.deepEqual(v.checks.map(c => c.name), ['issue a code for table 9999', 'open a $1.00 bill on table 9999', 'first scan returns the open bill and a bill key',
      'second scan returns the same key', 'the scan carries the published menu', 'guest reserves $1.00 cash with a 40-character payer token', 'owner confirms the cash',
      'owner closes the bill', 'guest key reads the closed bill', 'guest receipt request to onboarding-check@example.com is accepted',
      'a fresh scan returns no bill key', 'revoke table 9999\'s code']);
    const bill = s.server.db.rows.get(RID + '|aal.checks|' + v.checkId);
    assert.ok(bill.closedAt);
    assert.equal(bill.table, 9999);
    assert.ok(!s.server.db.tokens.some(t => t.table === 9999 && !t.revoked_at));
    const reserve = s.server.rpcCalls('aal_mutate').find(c => c.body.p_op === 'reserve');
    assert.equal(reserve.body.p_token.length, 40);
    assert.match(reserve.headers['x-aalayna-key'], /^chk_/);                           // as the guest, with the scanned key
    assert.equal(s.server.rpcCalls('aal_mutate').find(c => c.body.p_op === 'receipt').body.p_body.contact, 'onboarding-check@example.com');
    assert.match(r.text, /left in place: the closed \$1\.00 test bill onboard-verify-/);

    // staff: invited with the owner key, owner first
    assert.deepEqual(s.server.rpcCalls('aal_staff').filter(c => c.body.p_body.op === 'invite').map(c => [c.body.p_body.email, c.body.p_body.role]),
      [['owner@emsherif.com', 'owner'], ['sara@emsherif.com', 'manager'], ['ali@emsherif.com', 'waiter']]);

    // the welcome note: model prose cleaned, facts from the code
    const md = fs.readFileSync(path.join(s.dir, 'onboarding', SLUG + '-welcome.md'), 'utf8');
    assert.match(md, /^أهلا وسهلا بكم في عائلة عليناء\n\n# Welcome to Aalayna, Em Sherif\n/);
    assert.match(md, /https:\/\/aalayna\.com\/dashboard\.html/);
    assert.match(md, /https:\/\/aalayna\.com\/editor\.html/);
    assert.match(md, /Sign in with owner@emsherif\.com\. A six-digit code arrives by email/);
    assert.match(md, /- sara@emsherif\.com \(manager\)\n- ali@emsherif\.com \(waiter\)/);
    assert.match(md, /24 cards, one per table, are in the print sheet/);
    assert.match(md, /6 dishes in 3 sections/);
    assert.match(md, /Wassim, WhatsApp \[WhatsApp number\]/);
    assert.doesNotMatch(md, /[\u2014\u2013]/);
    assert.match(md, /see your menu, no app needed/);
  } finally { await s.close(); }
});

test('re-runs are idempotent: no second registration, no reissued code, no second invite, even after --reset', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    await s.run(['--slug', SLUG, '--approve-menu'].concat(s.fixture));
    const codes = tokensOf(s), ownerKey = s.state().venue.owner_key;
    const before = s.server.calls.length;
    const plain = await s.run(['--slug', SLUG].concat(s.fixture));
    assert.equal(plain.code, 0);
    assert.equal(s.server.calls.length, before);                                          // everything done: nothing called
    assert.equal((plain.text.match(/\(earlier\)/g) || []).length, 7);

    const again = await s.run(['--slug', SLUG, '--from', 'register', '--approve-menu'].concat(s.fixture));
    assert.equal(again.code, 0, again.text);
    assert.equal(s.server.rpcCalls('aal_admin_register_venue').length, 1);
    assert.match(again.text, /already registered as em-sherif; reused it, keys unchanged/);
    assert.equal(issues(s.server, t => t !== 9999).length, 24);                           // only the first run's
    assert.match(again.text, /24 table codes \(kept 24\)/);
    assert.deepEqual(tokensOf(s), codes);
    assert.equal(s.server.rpcCalls('aal_staff').filter(c => c.body.p_body.op === 'invite').length, 3);
    assert.match(again.text, /invited 0, already on the list 3/);
    assert.equal(s.server.db.docs.get(RID + '|aal.live').body.version, 2);               // a re-publish is a new version

    const reset = await s.run(['--slug', SLUG, '--reset', '--yes']);
    assert.equal(reset.code, 0);
    assert.ok(!fs.existsSync(path.join(s.dir, 'onboarding', SLUG + '.json')));
    const fresh = await s.run(ARGS.concat(s.fixture, ['--approve-menu']));
    assert.equal(fresh.code, 0, fresh.text);
    assert.equal(s.server.rpcCalls('aal_admin_register_venue').length, 1);
    assert.equal(s.state().venue.owner_key, ownerKey);                                    // recovered, not rotated
    assert.equal(issues(s.server, t => t !== 9999).length, 24);
    assert.match(fresh.text, /24 table codes \(kept 24 live code\(s\) not in the state file \(tables 1-24\)\)/);   // state lost, live codes kept
    assert.deepEqual(tokensOf(s), codes);
    assert.match(fresh.text, /menu\s+done\s+published version 3: 5 items/);          // the reviewed pack is published, not re-extracted
    assert.equal(s.imports.length, 1);
  } finally { await s.close(); }
});

test('--reset asks first and keeps the state on no', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    const r = await s.run(['--slug', SLUG, '--reset'], { confirm: async () => false });
    assert.equal(r.code, 0);
    assert.match(r.text, /kept onboarding\/em-sherif\.json/);
    assert.ok(fs.existsSync(path.join(s.dir, 'onboarding', SLUG + '.json')));
  } finally { await s.close(); }
});

test('a table code revoked elsewhere is replaced and named; one issued in qr.html is kept', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    await s.run(['--slug', SLUG, '--approve-menu'].concat(s.fixture));
    const codes = tokensOf(s);
    s.server.db.tokens.find(t => t.table === 5 && !t.revoked_at).revoked_at = new Date().toISOString();
    const t7 = s.server.db.tokens.find(t => t.table === 7 && !t.revoked_at);
    t7.revoked_at = new Date().toISOString();
    s.server.db.tokens.push({ rid: RID, table: 7, token: 'tbl_' + '7'.repeat(48), created_at: new Date().toISOString(), revoked_at: null });
    const r = await s.run(['--slug', SLUG, '--only', 'tables']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /24 table codes \(issued 1, kept 22, kept 1 live code\(s\) not in the state file \(tables 7\)\)/);
    assert.match(r.text, /tables 5: the earlier code had been revoked, a new one was issued\. Reprint those cards\./);
    const now = tokensOf(s);
    assert.notEqual(now[5], codes[5]);
    assert.equal(now[7], 'tbl_' + '7'.repeat(48));
    assert.equal(now[1], codes[1]);
    // --tables grows: only the new tables get codes
    const grow = await s.run(['--slug', SLUG, '--tables', '26', '--only', 'tables']);
    assert.match(grow.text, /26 table codes \(issued 2, kept 24\)/);
  } finally { await s.close(); }
});

test('a missing admin key fails the register step in one sentence and calls nothing', async () => {
  const s = await setup({ unset: ['AALAYNA_ADMIN_KEY'] });
  try {
    const r = await s.run(ARGS.concat(s.fixture));
    assert.equal(r.code, 1);
    assert.match(r.text, /\[1\/7\] register\s+failed\s+The register step needs AALAYNA_ADMIN_KEY in the environment; export it and run again\./);
    assert.match(r.text, /Stopped\. Fix the cause above and run the same command again/);
    assert.equal(s.server.calls.length, 0);
    assert.equal(s.state().steps.register.status, 'failed');
    // a missing model key fails the theme step the same way, after register
    s.env.AALAYNA_ADMIN_KEY = s.server.ADMIN; delete s.env.ANTHROPIC_API_KEY;
    const t = await s.run(['--slug', SLUG]);
    assert.equal(t.code, 1);
    assert.match(t.text, /theme\s+failed\s+The theme step needs ANTHROPIC_API_KEY in the environment/);
  } finally { await s.close(); }
});

test('verify asserts each check, stops at the first failure, still revokes table 9999, and the next run closes the bill it left', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    // the server mints a new key on every scan (the behaviour before followups-2026-09-24.sql)
    const real = s.server.db.checkKeys;
    let sabotage = true;
    Object.defineProperty(s.server.db, 'checkKeys', { get() { return sabotage ? real.filter(() => false).concat([]) : real; }, configurable: true });
    const r = await s.run(['--slug', SLUG, '--approve-menu'].concat(s.fixture));
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /verify\s+failed\s+4 of 12 checks passed; failed: second scan returns the same key; the scan carries the published menu;/);
    assert.match(r.text, /fail  second scan returns the same key: the second scan returned a different key/);
    assert.match(r.text, /fail  owner confirms the cash: not run: an earlier check failed/);
    assert.match(r.text, /pass  revoke table 9999's code/);
    const v = s.state().steps.verify;
    assert.equal(v.status, 'failed');
    assert.deepEqual(v.data.checks.map(c => c.status), ['pass', 'pass', 'pass', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'pass']);
    assert.ok(!s.server.db.tokens.some(t => t.table === 9999 && !t.revoked_at));
    const left = v.data.checkId;
    assert.ok(!s.server.db.rows.get(RID + '|aal.checks|' + left).closedAt);             // the bill stayed open
    sabotage = false;
    const again = await s.run(['--slug', SLUG].concat(s.fixture));
    assert.equal(again.code, 0, again.text);
    assert.match(again.text, /closed a test bill left open by an earlier run \(onboard-verify-/);
    assert.match(again.text, /verify\s+done\s+12 of 12 checks passed/);
    assert.ok(s.server.db.rows.get(RID + '|aal.checks|' + left).closedAt);
  } finally { await s.close(); }
});

test('verify refuses to touch an open bill on table 9999 that it did not open', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture, ['--no-welcome']));
    s.server.db.rows.set(RID + '|aal.checks|real-bill', { id: 'real-bill', venueId: RID, table: 9999, totalCents: 500, source: 'staff' });
    const r = await s.run(['--slug', SLUG, '--approve-menu'].concat(s.fixture));
    assert.equal(r.code, 1);
    assert.match(r.text, /verify\s+failed\s+Table 9999 has an open bill \(real-bill\) that this tool did not open/);
    assert.equal(s.server.rpcCalls('aal_mutate').filter(c => c.body.p_op !== undefined).length, 0);
  } finally { await s.close(); }
});

test('the card sheet has one card per table with its link and its QR from qr-lib.js', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    await s.run(['--slug', SLUG, '--approve-menu', '--no-welcome'].concat(s.fixture));
    const html = fs.readFileSync(path.join(s.dir, 'onboarding', SLUG + '-table-cards.html'), 'utf8');
    const codes = tokensOf(s);
    assert.equal((html.match(/<div class="tent">/g) || []).length, 24);
    assert.equal((html.match(/<div class="tcard"/g) || []).length, 24);
    for (let t = 1; t <= 24; t++) {
      const url = tableURL(SLUG, t, codes[t]);
      assert.equal(url, 'https://aalayna.com/guest.html?v=em-sherif&t=' + t + '&s=' + codes[t]);
      assert.ok(html.includes('<div class="tlink">' + url.replace(/&/g, '&amp;') + '</div>'), 'link of table ' + t);
      assert.ok(html.includes(qrSvg(url)), 'QR of table ' + t);
      assert.ok(html.includes('<div class="tno">Table ' + t + '</div>'));
    }
    assert.ok(!html.includes('t=9999'));
    assert.match(html, /<div class="vn">Em Sherif<\/div><div class="vp">Beirut<\/div>/);
    assert.match(html, /See the menu · split the bill · pay/);
    // the card CSS is qr.html's
    const qr = fs.readFileSync(path.join(root, 'qr.html'), 'utf8');
    for (const rule of ['.tent .top{background:var(--green);color:#fff;padding:18px 16px 16px}', '.tent .qr svg{width:150px;height:150px}', '.tent .tno{font-size:15px;font-weight:600;margin-top:10px;letter-spacing:.02em}']) {
      assert.ok(qr.replace(/\s+/g, ' ').includes(rule.replace(/\s+/g, ' ')), 'qr.html has ' + rule);
      assert.ok(html.includes(rule), 'sheet has ' + rule);
    }
    assert.equal(fs.statSync(path.join(s.dir, 'onboarding', SLUG + '-table-cards.html')).mode & 0o077, 0);
  } finally { await s.close(); }
});

test('the state file never holds the admin key, and the console shows no key or table code', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    await s.run(['--slug', SLUG, '--approve-menu'].concat(s.fixture));
    await s.run(['--slug', SLUG, '--from', 'theme', '--approve-menu'].concat(s.fixture));
    const file = path.join(s.dir, 'onboarding', SLUG + '.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(s.server.ADMIN));
    assert.ok(!raw.includes('adm_'));
    assert.ok(!raw.includes('sk-ant-'));
    assert.ok(raw.includes(s.state().venue.owner_key));                                    // the owner key is kept, as the brief says
    assert.equal(fs.statSync(file).mode & 0o077, 0);                                      // readable by the founder only
    const all = s.outputs.join('\n');
    assert.ok(!all.includes(s.server.ADMIN));
    assert.doesNotMatch(all, /own_[0-9a-f]{8}|tbl_[0-9a-f]{8}|chk_[0-9a-f]{8}|sk-ant-/);
    // the git allowlist ignores onboarding/ and ships tools/ and the fixtures
    const ig = f => cp.spawnSync('git', ['check-ignore', '-q', f], { cwd: root }).status === 0;
    assert.ok(ig('onboarding/em-sherif.json'));
    assert.ok(ig('onboarding/em-sherif-table-cards.html'));
    assert.ok(!ig('tools/onboard.js'));
    assert.ok(!ig('tools/steps/verify.js'));
    assert.ok(!ig('tools/lib/supabase.js'));
    assert.ok(!ig('tests/fixtures/onboard-server.cjs'));
  } finally { await s.close(); }
});

test('the model request: documented headers and blocks, the tool forced for every model, no strict and no output_config by default', async () => {
  const s = await setup({ env: {} });
  try {
    s.env.ANTHROPIC_BASE_URL = s.server.url;
    fs.writeFileSync(path.join(s.dir, 'page2.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const r = await s.run(ARGS.concat(['page2.jpg']));                                    // no fixture: the fake Messages API
    assert.equal(r.code, 0, r.text);
    assert.equal(s.server.models.requests.length, 1);
    const req = s.server.models.requests[0];
    assert.equal(req.headers['x-api-key'], 'sk-ant-test-not-real');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.body.model, 'claude-opus-5-5');
    assert.deepEqual(req.body.tool_choice, { type: 'tool', name: 'set_theme' });         // forced, whatever the model
    assert.equal(req.body.tools[0].name, 'set_theme');
    assert.ok(!('strict' in req.body.tools[0]), 'strict only with --strict');
    assert.ok(!('output_config' in req.body), 'output_config only with --effort');
    assert.deepEqual(req.body.tools[0].input_schema.properties.font.enum, FONTS);
    const blocks = req.body.messages[0].content;
    assert.deepEqual(blocks.map(b => b.type), ['document', 'image', 'text']);
    assert.deepEqual(blocks[0].source, { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4\n% test menu\n').toString('base64') });
    assert.equal(blocks[1].source.media_type, 'image/jpeg');
    assert.doesNotMatch(blocks[2].text, /Answer only by calling/);
    // an answer without the tool fails the step with a sentence; flags win over the model
    s.server.models.answers.set_theme = { type: 'message', content: [{ type: 'text', text: 'Red.' }], stop_reason: 'end_turn' };
    const bad = await s.run(['--slug', SLUG, '--only', 'theme']);
    assert.equal(bad.code, 1);
    assert.match(bad.text, /theme\s+failed\s+The model did not answer with the set_theme tool \(stop reason end_turn\)\./);
    assert.equal(s.server.models.requests.length, 2);                                     // forced: no second ask
    const flags = await s.run(['--slug', SLUG, '--only', 'theme', '--brand', '123abc', '--bg', 'fafafa', '--font', 'Cairo']);
    assert.equal(flags.code, 0, flags.text);
    assert.match(flags.text, /brand #123ABC, background #FAFAFA, font Cairo \(from flags\)/);
    assert.equal(s.server.models.requests.length, 2);                                     // no model call with all three flags
    assert.equal(s.server.db.profiles.get(RID).font, 'Cairo');
  } finally { await s.close(); }
});

test('a 400 naming tool_choice, strict or output_config is retried once without it, with one line of log, as tools/import-menu.js does', async () => {
  const s = await setup({ env: {} });
  try {
    s.env.ANTHROPIC_BASE_URL = s.server.url;
    await s.run(ARGS.concat(['--no-theme']));                                             // register only, then the checkpoint
    const since = () => s.server.models.requests.length;
    const bodies = from => s.server.models.requests.slice(from).map(q => q.body);
    // a forced tool_choice refused: auto plus the instruction
    s.server.models.refuseForced = true;
    let n = since();
    let r = await s.run(['--slug', SLUG, '--only', 'theme']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(bodies(n).map(b => b.tool_choice), [{ type: 'tool', name: 'set_theme' }, { type: 'auto' }]);
    assert.match(bodies(n)[1].messages[0].content.slice(-1)[0].text, /Answer only by calling the set_theme tool\.$/);
    assert.equal((r.text.match(/claude-opus-5-5 refuses a forced tool_choice; using auto with an instruction/g) || []).length, 1);
    // under auto, an answer without the tool is asked once more, then fails
    s.server.models.answers.set_theme = { type: 'message', content: [{ type: 'text', text: 'Red.' }], stop_reason: 'end_turn' };
    n = since();
    r = await s.run(['--slug', SLUG, '--only', 'theme']);
    assert.equal(r.code, 1);
    assert.equal(since() - n, 3);                                                         // forced (400), auto, auto again
    assert.match(r.text, /no tool call in the answer, asking again/);
    s.server.models.answers.set_theme = THEME;
    s.server.models.refuseForced = false;
    // --strict sends strict; refused, it is dropped once
    s.server.models.refuseStrict = true;
    n = since();
    r = await s.run(['--slug', SLUG, '--only', 'theme', '--strict']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(bodies(n).map(b => b.tools[0].strict), [true, undefined]);
    assert.match(r.text, /claude-opus-5-5 refuses strict tool use; sending the tool without strict/);
    s.server.models.refuseStrict = false;
    // --effort sends output_config; refused, it is dropped once
    s.server.models.refuseOutputConfig = true;
    n = since();
    r = await s.run(['--slug', SLUG, '--only', 'theme', '--effort', 'high']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(bodies(n).map(b => b.output_config), [{ effort: 'high' }, undefined]);
    assert.match(r.text, /claude-opus-5-5 refuses output_config; sending no effort/);
    // any other 400 is not retried
    s.server.models.refuseOutputConfig = false;
    s.server.models.answers.set_theme = null;
    n = since();
    r = await s.run(['--slug', SLUG, '--only', 'theme']);
    assert.equal(r.code, 1);
    assert.equal(since() - n, 1);
    assert.match(r.text, /The model API refused the request: no fake answer for set_theme\./);
    // --strict and --effort reach the importer too; a bad level is a usage error
    const bad = await s.run(['--slug', SLUG, '--effort', 'turbo']);
    assert.equal(bad.code, 2);
    assert.match(bad.text, /--effort must be low, medium, high, xhigh or max\./);
  } finally { await s.close(); }
});

test('--strict and --effort are passed to the importer; neither is sent by default', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    assert.equal(s.imports[0].strict, false);
    assert.equal(s.imports[0].effort, undefined);
    await s.run(['--slug', SLUG, '--reimport', '--strict', '--effort', 'xhigh'].concat(s.fixture));
    assert.equal(s.imports[1].strict, true);
    assert.equal(s.imports[1].effort, 'xhigh');
  } finally { await s.close(); }
});

test('a dark background or an unlisted font from the model is dropped with a note', async () => {
  const s = await setup();
  try {
    fs.writeFileSync(path.join(s.dir, 'fixtures', 'theme.json'), JSON.stringify(toolAnswer('set_theme', { brand: '#123456', bg: '#202020', font: 'Comic Sans', reasoning: 'x' })));
    const r = await s.run(ARGS.concat(s.fixture));
    assert.match(r.text, /brand #123456, background default, font default \(from the menu\); background #202020 is too dark for the guest app, left at the default; font "Comic Sans" is not on the list, left at the default/);
    const p = s.server.db.profiles.get(RID);
    assert.equal(p.bg, undefined);
    assert.equal(p.font, undefined);
  } finally { await s.close(); }
});

test('staff: a revoked email is not brought back and a different role is not changed', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    s.server.db.staff.push({ rid: RID, email: 'sara@emsherif.com', role: 'waiter', invited_by: 'owner key', created_at: '2026-09-01T00:00:00Z', revoked_at: null });
    s.server.db.staff.push({ rid: RID, email: 'ali@emsherif.com', role: 'waiter', invited_by: 'owner key', created_at: '2026-09-01T00:00:00Z', revoked_at: '2026-09-10T00:00:00Z' });
    const r = await s.run(['--slug', SLUG, '--only', 'staff']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /invited 1, already on the list 1/);
    assert.match(r.text, /sara@emsherif\.com is already on the list as waiter, not manager; left unchanged/);
    assert.match(r.text, /ali@emsherif\.com was revoked on 2026-09-10; not invited again/);
    assert.deepEqual(s.server.rpcCalls('aal_staff').filter(c => c.body.p_body.op === 'invite').map(c => c.body.p_body.email), ['owner@emsherif.com']);
  } finally { await s.close(); }
});

test('Supabase refusals are shown with the server message; a missing function names its SQL file', async () => {
  const s = await setup({ missing: ['aal_table_tokens'] });
  try {
    await s.run(ARGS.concat(s.fixture));
    const r = await s.run(['--slug', SLUG, '--approve-menu'].concat(s.fixture));
    assert.equal(r.code, 1);
    assert.match(r.text, /tables\s+failed\s+aal_table_tokens is not installed on the server\. Run supabase\/sessions-2026-09-24\.sql in the Supabase SQL editor\./);
    const s2 = await setup();
    try {
      await s2.run(ARGS.concat(s2.fixture));
      const other = await s2.run(['--name', 'Other Place', '--place', 'Hamra', '--slug', SLUG, '--tables', '3', '--owner', 'o@x.com'].concat(s2.fixture), {});
      assert.equal(other.code, 2);
      assert.match(other.text, /This state file is for Em Sherif, Beirut/);
      fs.rmSync(path.join(s2.dir, 'onboarding'), { recursive: true });
      const clash = await s2.run(['--name', 'Other Place', '--place', 'Hamra', '--slug', SLUG, '--tables', '3', '--owner', 'o@x.com'].concat(s2.fixture));
      assert.equal(clash.code, 1);
      assert.match(clash.text, /register\s+failed\s+The slug em-sherif already belongs to another venue \(Em Sherif, Beirut\)/);
      s2.env.AALAYNA_ADMIN_KEY = 'adm_wrong';
      const wrong = await s2.run(['--name', 'Third', '--place', 'Jounieh', '--slug', 'third', '--tables', '2', '--owner', 'o@x.com'].concat(s2.fixture));
      assert.match(wrong.text, /register\s+failed\s+Supabase refused aal_admin_list_venues: Admin key required\. \(HTTP 403\)/);
      assert.ok(!wrong.text.includes('adm_wrong'));
    } finally { await s2.close(); }
  } finally { await s.close(); }
});

test('--dry-run calls nothing and writes nothing; --help and bad flags from the real command line', async () => {
  const s = await setup();
  try {
    const r = await s.run(ARGS.concat(['--dry-run']));
    assert.equal(r.code, 0);
    assert.equal(s.server.calls.length, 0);
    assert.ok(!fs.existsSync(path.join(s.dir, 'onboarding')));
    assert.match(r.text, /\[1\/7\] register\s+would find "em-sherif" in aal_admin_list_venues, else aal_admin_register_venue\("Em Sherif", "Beirut"\)/);
    assert.match(r.text, /\[3\/7\] menu\s+would importMenu\(1 file\(s\)\) writes venues\/em-sherif\.json/);
    assert.match(r.text, /\[6\/7\] verify\s+would on table 9999/);
    assert.equal(s.imports.length, 0);
    const cli = (args, env) => cp.spawnSync(process.execPath, [path.join(root, 'tools', 'onboard.js')].concat(args), { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env || {}) });
    const help = cli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: node tools\/onboard\.js/);
    const bad = cli(['--tabels', '3']);
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /Unknown flag --tabels/);
    const dry = cli(ARGS.concat(['--dry-run']).map(a => a === 'menu.pdf' ? path.join(s.dir, 'menu.pdf') : a));
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /register\s+would .*\[missing AALAYNA_ADMIN_KEY\]/);
    assert.ok(!fs.existsSync(path.join(root, 'onboarding', SLUG + '.json')));
  } finally { await s.close(); }
});

test('a pack with a missing price is not published', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    const file = path.join(s.dir, 'venues', SLUG + '.json');
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    pack.items[1].price = null;
    fs.writeFileSync(file, JSON.stringify(pack));
    const r = await s.run(['--slug', SLUG, '--approve-menu'].concat(s.fixture));
    assert.equal(r.code, 1);
    assert.match(r.text, /menu\s+failed\s+venues\/em-sherif\.json cannot be published: item 2 \(Moutabal\) has no price: write one in\./);
    assert.equal(s.server.calls.filter(c => c.path === '/rest/v1/kv_docs').length, 0);
  } finally { await s.close(); }
});

/* The real tools/import-menu.js (T9) with its own replayed fixture, through the checkpoint
   and the approval. Skipped while T9's importer or fixture is not in the tree. */
const T9 = path.join(root, 'tools', 'import-menu.js'), T9_FIXTURE = path.join(root, 'tests', 'fixtures', 'kababji-response.json');
test('with the real importer (T9) and its fixture, the pipeline stops for review and then publishes', { skip: !(fs.existsSync(T9) && fs.existsSync(T9_FIXTURE)) && 'tools/import-menu.js or its fixture is not there yet' }, async () => {
  const s = await setup();
  try {
    fs.copyFileSync(T9_FIXTURE, path.join(s.dir, 'fixtures', 'import-menu.json'));
    const args = ['--name', 'Kababji', '--place', 'Hamra', '--slug', 'kababji-hamra', '--tables', '3', '--owner', 'o@kababji.test', 'menu.pdf'].concat(s.fixture);
    const r = await s.run(args, { importMenu: null });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /menu\s+waiting\s+extracted \d+ items in \d+ sections\. Review venues\/kababji-hamra\.json/);
    assert.match(r.text, /Menu import: Kababji \(kababji-hamra\)/);                      // T9's report, printed
    const pack = JSON.parse(fs.readFileSync(path.join(s.dir, 'venues', 'kababji-hamra.json'), 'utf8'));
    const ok = await s.run(['--slug', 'kababji-hamra', '--approve-menu', '--no-welcome'].concat(s.fixture), { importMenu: null });
    const rid = JSON.stringify(['kababji', 'hamra']);
    if (pack.items.some(x => x.price == null)) { assert.equal(ok.code, 1); return; }
    assert.equal(ok.code, 0, ok.text);
    const live = s.server.db.docs.get(rid + '|aal.live').body;
    assert.equal(live.items.length, pack.items.length);
    assert.deepEqual(live.sections, pack.sections);
  } finally { await s.close(); }
});

test('a dish dropped from the pack on a later approval stays in the menu as archived, as in the editor', async () => {
  const s = await setup();
  try {
    await s.run(ARGS.concat(s.fixture));
    await s.run(['--slug', SLUG, '--approve-menu', '--no-welcome'].concat(s.fixture));
    const file = path.join(s.dir, 'venues', SLUG + '.json');
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    pack.items = pack.items.filter(x => x.id !== 'g02');
    fs.writeFileSync(file, JSON.stringify(pack));
    const r = await s.run(['--slug', SLUG, '--only', 'menu', '--approve-menu']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /published version 2: 4 items in 3 sections, read back from the server \(1 earlier item\(s\) kept as archived\)/);
    const live = s.server.db.docs.get(RID + '|aal.live').body;
    const g02 = live.items.find(x => x.id === 'g02');
    assert.ok(g02 && g02.archivedAt, 'kept as archived');
    assert.deepEqual(s.server.db.docs.get(RID + '|aal.draft').body, live);
  } finally { await s.close(); }
});
