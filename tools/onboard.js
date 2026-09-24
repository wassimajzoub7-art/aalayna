#!/usr/bin/env node
'use strict';
/* Onboard a signed restaurant, from "signed" to "live", in one command.

     node tools/onboard.js --name "Em Sherif" --place "Beirut" --slug em-sherif --currency USD \
       --tables 24 --owner owner@emsherif.com --staff "sara@emsherif.com:manager,ali@emsherif.com:waiter" menu.pdf

   Seven steps, each a module in tools/steps/ with run(ctx) -> {ok, summary, data}:
   register, theme, menu, tables, staff, verify, welcome. Progress is kept in
   onboarding/<slug>.json (gitignored: it holds the owner key and the table codes, never the
   admin key). A re-run resumes at the first step not done. The menu step stops once for a
   person to read venues/<slug>.json; run again with --approve-menu to publish it.

   Environment: AALAYNA_ADMIN_KEY (register, theme), ANTHROPIC_API_KEY (theme, menu,
   welcome). The Supabase URL and anon key come from aalayna-config.js.
   Run with --help for every flag. `node tools/onboard.js ui` runs the same pipeline from a
   page in the browser (tools/onboard-ui.js). */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { client, ROOT } = require('./lib/supabase');
const { restaurantId, slugify, SLUG, FONT } = require('./lib/venue');

const STEPS = ['register', 'theme', 'menu', 'tables', 'staff', 'verify', 'welcome'].map(function (n) { return require('./steps/' + n); });
const NAMES = STEPS.map(function (s) { return s.name; });
const ROLES = ['owner', 'manager', 'waiter'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOOL = ['approve-menu', 'reimport', 'reset', 'yes', 'dry-run', 'no-theme', 'no-welcome', 'help', 'strict'];
const VALUE = ['name', 'place', 'slug', 'currency', 'tables', 'owner', 'staff', 'from', 'only', 'fixture-dir', 'brand', 'bg', 'font', 'model', 'effort'];

const HELP = [
  'Usage: node tools/onboard.js --name NAME --place PLACE [--slug SLUG] [--currency USD] --tables N',
  '         --owner EMAIL [--staff "email:role,email:role"] MENU.pdf [PHOTO.jpg ...]',
  '',
  'Steps: ' + STEPS.map(function (s, i) { return (i + 1) + ' ' + s.name; }).join(', '),
  STEPS.map(function (s, i) { return '  ' + (i + 1) + '. ' + s.name + ': ' + s.description; }).join('\n'),
  '',
  'A re-run only needs --slug; the other inputs come from onboarding/<slug>.json.',
  '  --approve-menu     publish venues/<slug>.json after you have read it (the one checkpoint)',
  '  --reimport         extract the menu again, replacing venues/<slug>.json',
  '  --from STEP        run from STEP to the end, even steps already done',
  '  --only STEP        run STEP alone, even if already done',
  '  --reset            forget the state file (asks first; --yes skips the question)',
  '  --dry-run          print what each step would do; calls nothing, writes nothing',
  '  --brand HEX --bg HEX --font NAME   theme overrides; with all three no model is asked',
  '  --no-theme --no-welcome            skip those steps',
  '  --model ID         model for theme, menu and welcome (default claude-opus-5-5)',
  '  --strict           send the tools with strict: true (dropped once if the model refuses it)',
  '  --effort LEVEL     low, medium, high, xhigh or max, sent as output_config (not sent unless given)',
  '  --fixture-dir DIR  replay saved model answers: DIR/theme.json, DIR/welcome.json,',
  '                     DIR/import-menu.json (passed to importMenu as its fixture)',
  '',
  'Environment: AALAYNA_ADMIN_KEY (register, theme), ANTHROPIC_API_KEY (theme, menu, welcome).',
  '',
  'node tools/onboard.js ui [--port 8790] [--no-open]   the same steps from a page in the browser'
].join('\n');

class Usage extends Error {}

function parseArgs(argv) {
  const flags = {}, files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') !== 0) { files.push(a); continue; }
    let k = a.slice(2), v = null;
    const eq = k.indexOf('=');
    if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    if (BOOL.indexOf(k) >= 0) { if (v !== null) throw new Usage('--' + k + ' takes no value.'); flags[k] = true; continue; }
    if (VALUE.indexOf(k) < 0) throw new Usage('Unknown flag --' + k + '. Run with --help.');
    if (v === null) {
      if (i + 1 >= argv.length) throw new Usage('--' + k + ' needs a value.');
      v = argv[++i];
    }
    flags[k] = v;
  }
  return { flags, files };
}

function checkName(label, v) {
  if (v.length > 40) throw new Usage(label + ' is longer than 40 characters.');
  if (/["\\\u0000-\u001f]/.test(v)) throw new Usage(label + ' cannot contain double quotes, backslashes or control characters.');
}
function parseStaff(s) {
  if (!s) return [];
  return s.split(',').map(function (x) { return x.trim(); }).filter(Boolean).map(function (x) {
    const at = x.lastIndexOf(':');
    const email = (at > 0 ? x.slice(0, at) : x).trim().toLowerCase(), role = at > 0 ? x.slice(at + 1).trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new Usage('--staff: ' + JSON.stringify(x) + ' has no valid email.');
    if (ROLES.indexOf(role) < 0) throw new Usage('--staff: give each email a role, like ' + email + ':waiter (owner, manager or waiter).');
    return { email, role };
  });
}

/* Inputs for this run: the state's, with what the command line gives on top. */
function resolveInputs(flags, files, saved, shellCwd) {
  const inp = Object.assign({ currency: 'USD', staff: [], files: [] }, saved || {});
  const changed = [];
  if (flags.name != null || flags.place != null) {
    const name = flags.name != null ? flags.name.trim() : inp.name, place = flags.place != null ? flags.place.trim() : inp.place;
    if (!name) throw new Usage('--name cannot be empty.');
    checkName('Name', name); checkName('Place', place || '');
    if (saved && restaurantId(name, place) !== restaurantId(saved.name, saved.place)) {
      throw new Usage('This state file is for ' + saved.name + ', ' + saved.place + '. Name and place make the venue id and cannot change; use another --slug for another venue.');
    }
    inp.name = name; inp.place = place || '';
  }
  if (!inp.name) throw new Usage('--name is required on the first run.');
  if (inp.place == null) throw new Usage('--place is required on the first run (use --place "" for a venue without one).');
  if (flags.currency != null) {
    if (!/^[A-Z]{3}$/.test(flags.currency.toUpperCase())) throw new Usage('--currency is a three letter code, like USD or LBP.');
    inp.currency = flags.currency.toUpperCase();
  }
  if (flags.tables != null) {
    const n = Number(flags.tables);
    if (!(n === Math.floor(n) && n >= 1 && n <= 200)) throw new Usage('--tables is a whole number from 1 to 200.');
    if (saved && saved.tables !== n) changed.push('tables');
    inp.tables = n;
  }
  if (!inp.tables) throw new Usage('--tables is required on the first run.');
  if (flags.owner != null) {
    const e = flags.owner.trim().toLowerCase();
    if (!EMAIL.test(e)) throw new Usage('--owner is not a valid email address.');
    if (saved && saved.owner !== e) changed.push('staff');
    inp.owner = e;
  }
  if (!inp.owner) throw new Usage('--owner is required on the first run.');
  if (flags.staff != null) {
    const st = parseStaff(flags.staff);
    if (saved && JSON.stringify(saved.staff) !== JSON.stringify(st) && changed.indexOf('staff') < 0) changed.push('staff');
    inp.staff = st;
  }
  if (files.length) {
    inp.files = files.map(function (f) {
      const p = path.resolve(shellCwd, f);
      if (!fs.existsSync(p)) throw new Usage('Menu file not found: ' + f);
      return p;
    });
  }
  if (flags.model != null) inp.model = flags.model;
  return { inputs: inp, changed };
}

function emptyState(slug) {
  const steps = {};
  NAMES.forEach(function (n) { steps[n] = { status: 'pending' }; });
  return { version: 1, slug, created_at: new Date().toISOString(), inputs: null, venue: null, steps };
}
function writeState(file, state) {
  state.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function askYesNo(question) {
  return new Promise(function (resolve) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + ' [y/N] ', function (a) { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main(argv, opts) {
  opts = opts || {};
  const out = opts.out || function (l) { process.stdout.write(l + '\n'); };
  // optional, for tools/onboard-ui.js: {step, index, status, summary} at each step change
  const progress = typeof opts.progress === 'function' ? opts.progress : function () {};
  const env = opts.env || process.env;
  const cwd = opts.cwd || ROOT;
  let parsed, flags;
  try {
    parsed = parseArgs(argv);
    flags = parsed.flags;
    if (flags.help) { out(HELP); return 0; }
    if (flags.from && NAMES.indexOf(flags.from) < 0) throw new Usage('--from must be one of ' + NAMES.join(', ') + '.');
    if (flags.only && NAMES.indexOf(flags.only) < 0) throw new Usage('--only must be one of ' + NAMES.join(', ') + '.');
    if (flags.from && flags.only) throw new Usage('Use --from or --only, not both.');
    if (flags.effort && ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(flags.effort) < 0) throw new Usage('--effort must be low, medium, high, xhigh or max.');
    if (flags.font && !FONT.test(flags.font)) throw new Usage('--font must be a Google Fonts name: letters, digits and spaces, up to 40 characters.');
  } catch (e) {
    if (e instanceof Usage) { out('onboard: ' + e.message); return 2; }
    throw e;
  }

  const slug = flags.slug ? flags.slug.trim() : flags.name ? slugify(flags.name) : '';
  if (!slug) { out('onboard: --slug is required (or --name on the first run, to derive one).'); return 2; }
  if (slug.length > 40 || !SLUG.test(slug)) { out('onboard: the slug uses lower-case letters, digits and hyphens only, up to 40 characters, not starting or ending with a hyphen.'); return 2; }
  const dir = path.join(cwd, 'onboarding');
  const paths = { dir, state: path.join(dir, slug + '.json'), cards: path.join(dir, slug + '-table-cards.html'), welcome: path.join(dir, slug + '-welcome.md') };

  if (flags.reset) {
    if (!fs.existsSync(paths.state)) { out('onboard: no state file for ' + slug + '; nothing to reset.'); return 0; }
    const yes = flags.yes || await (opts.confirm || askYesNo)('Forget the onboarding state of ' + slug + '? The venue, its keys and its codes stay on Supabase; a new run finds them again.');
    if (!yes) { out('onboard: kept ' + path.relative(cwd, paths.state) + '.'); return 0; }
    fs.unlinkSync(paths.state);
    out('onboard: removed ' + path.relative(cwd, paths.state) + '. Supabase is unchanged; the next run reuses the venue and its live table codes.');
    return 0;
  }

  let state = null;
  if (fs.existsSync(paths.state)) {
    try { state = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch (e) { out('onboard: ' + path.relative(cwd, paths.state) + ' is not valid JSON (' + e.message + '). Fix it or run with --reset.'); return 1; }
  }
  let resolved;
  try { resolved = resolveInputs(flags, parsed.files, state && state.inputs, opts.shellCwd || process.cwd()); }
  catch (e) { if (e instanceof Usage) { out('onboard: ' + e.message); return 2; } throw e; }
  if (!state) state = emptyState(slug);
  NAMES.forEach(function (n) { if (!state.steps[n]) state.steps[n] = { status: 'pending' }; });
  state.inputs = Object.assign({}, resolved.inputs, { slug });
  const inputs = state.inputs;

  const ctx = {
    inputs, state, env, cwd, paths,
    opts: {
      approveMenu: !!flags['approve-menu'], reimport: !!flags.reimport, noTheme: !!flags['no-theme'], noWelcome: !!flags['no-welcome'],
      brand: flags.brand, bg: flags.bg, font: flags.font, dryRun: !!flags['dry-run'], strict: !!flags.strict, effort: flags.effort || null,
      fixtureDir: flags['fixture-dir'] ? path.resolve(opts.shellCwd || process.cwd(), flags['fixture-dir']) : null
    },
    fetch: opts.fetch, importMenu: opts.importMenu, log: function (l) { out('      ' + l); },
    rid: state.venue ? state.venue.restaurant_id : restaurantId(inputs.name, inputs.place),
    ownerKey: state.venue ? state.venue.owner_key : null
  };

  const selected = flags.only ? [flags.only] : flags.from ? NAMES.slice(NAMES.indexOf(flags.from)) : NAMES.slice();
  const forced = !!(flags.only || flags.from);

  out('Onboarding ' + inputs.name + (inputs.place ? ', ' + inputs.place : '') + ' (' + slug + ')' + (ctx.opts.dryRun ? ': dry run, nothing is called or written' : ''));
  if (ctx.opts.dryRun) {
    STEPS.forEach(function (s, i) {
      const st = state.steps[s.name].status;
      const head = '[' + (i + 1) + '/' + STEPS.length + '] ' + pad(s.name, 9);
      if (selected.indexOf(s.name) < 0) { out(head + ' not selected'); return; }
      if (!forced && (st === 'done' || st === 'skipped')) { out(head + ' already ' + st); return; }
      const skip = s.skip && s.skip(ctx);
      if (skip) { out(head + ' ' + skip); return; }
      const need = (typeof s.env === 'function' ? s.env(ctx) : s.env).filter(function (k) { return !env[k]; });
      out(head + ' would ' + s.plan(ctx) + (need.length ? ' [missing ' + need.join(', ') + ']' : ''));
    });
    return 0;
  }

  // an input a finished step used has changed: that step runs again
  resolved.changed.forEach(function (n) {
    if (state.steps[n].status === 'done') { state.steps[n].status = 'pending'; out('note: --' + (n === 'staff' ? 'owner/--staff' : n) + ' changed, so ' + n + ' runs again'); }
  });

  let sb = null;
  ctx.setVenue = function (v) { state.venue = v; ctx.rid = v.restaurant_id; ctx.ownerKey = v.owner_key; writeState(paths.state, state); };
  let current = null;
  ctx.saveProgress = function (data) { if (current) { state.steps[current].data = Object.assign({}, state.steps[current].data, data); writeState(paths.state, state); } };
  writeState(paths.state, state);

  let code = 0, paused = null;
  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i], rec = state.steps[s.name];
    const head = '[' + (i + 1) + '/' + STEPS.length + '] ' + pad(s.name, 9);
    if (selected.indexOf(s.name) < 0) continue;
    if (!forced && (rec.status === 'done' || rec.status === 'skipped')) { out(head + ' ' + pad(rec.status, 7) + ' (earlier) ' + (rec.summary || '')); progress({ step: s.name, index: i, status: rec.status, summary: rec.summary || '', earlier: true }); continue; }
    const skip = s.skip && s.skip(ctx);
    if (skip) {
      state.steps[s.name] = { status: 'skipped', finished_at: new Date().toISOString(), summary: skip, data: rec.data };
      writeState(paths.state, state);
      out(head + ' skipped ' + skip);
      progress({ step: s.name, index: i, status: 'skipped', summary: skip });
      continue;
    }
    const fail = function (msg) {
      state.steps[s.name] = Object.assign({}, state.steps[s.name], { status: 'failed', finished_at: new Date().toISOString(), error: msg, summary: msg });
      writeState(paths.state, state);
      out(head + ' failed  ' + msg);
      progress({ step: s.name, index: i, status: 'failed', summary: msg });
      code = 1;
    };
    if (s.name !== 'register' && !state.venue) { fail('The venue is not registered yet. Run the register step first.'); break; }
    const need = (typeof s.env === 'function' ? s.env(ctx) : s.env).filter(function (k) { return !env[k]; });
    if (need.length) { fail('The ' + s.name + ' step needs ' + need.join(' and ') + ' in the environment; export ' + (need.length > 1 ? 'them' : 'it') + ' and run again.'); break; }
    if (!sb) {
      try { sb = client({ env, fetch: opts.fetch }); } catch (e) { fail(e.message); break; }
      ctx.sb = sb;
    }
    current = s.name;
    state.steps[s.name] = Object.assign({}, rec, { status: 'pending', started_at: new Date().toISOString(), error: undefined });
    writeState(paths.state, state);
    progress({ step: s.name, index: i, status: 'running', summary: '' });
    let r;
    try { r = await s.run(ctx); }
    catch (e) { r = { ok: false, summary: e.message }; }
    current = null;
    r = r || { ok: false, summary: 'The step returned nothing.' };
    const data = Object.assign({}, state.steps[s.name].data, r.data || {});
    if (!r.ok) {
      state.steps[s.name].data = data;
      fail(r.summary);
      (r.lines || []).forEach(function (l) { out('      ' + l); });
      break;
    }
    state.steps[s.name] = { status: r.pause ? 'pending' : 'done', started_at: state.steps[s.name].started_at, finished_at: new Date().toISOString(), summary: r.summary, data };
    writeState(paths.state, state);
    out(head + ' ' + pad(r.pause ? 'waiting' : 'done', 7) + ' ' + r.summary);
    progress({ step: s.name, index: i, status: r.pause ? 'waiting' : 'done', summary: r.summary });
    (r.lines || []).forEach(function (l) { out('      ' + l); });
    if (r.pause) { paused = s.name; break; }
  }

  if (paused === 'menu') {
    out('');
    out('Review ' + (state.steps.menu.data.path || 'venues/' + slug + '.json') + ', then run again with --approve-menu:');
    out('  node tools/onboard.js --slug ' + slug + ' --approve-menu');
    return 0;
  }
  if (code) {
    out('');
    out('Stopped. Fix the cause above and run the same command again; finished steps are not repeated.');
    return code;
  }
  const settled = NAMES.every(function (n) { return ['done', 'skipped'].indexOf(state.steps[n].status) >= 0; });
  if (!settled) {
    const next = NAMES.filter(function (n) { return ['done', 'skipped'].indexOf(state.steps[n].status) < 0; });
    out('');
    out('Not finished: ' + next.join(', ') + '. Run  node tools/onboard.js --slug ' + slug + '  to continue.');
    return 0;
  }
  out('');
  out(inputs.name + ' is live. Still to do by hand:');
  manualChecklist(state, cwd, paths).forEach(function (l) { out('  ' + l); });
  return 0;
}

/* The list printed once every step is settled, one '[ ] ' or '[x] ' line each. Also read
   by tools/onboard-ui.js for its done view. */
function manualChecklist(state, cwd, paths) {
  const st = state.steps, inputs = state.inputs, rel = function (p) { return path.relative(cwd, p); };
  const theme = st.theme.status === 'done' ? st.theme.data : null;
  const demoOff = !(st.register.data && st.register.data.demo_payments === true);
  const L = [];
  L.push('[ ] Print the table cards: open ' + rel(paths.cards) + ' in a browser and print on card stock');
  L.push(st.welcome.status === 'done'
    ? '[ ] Send the welcome note: ' + rel(paths.welcome) + ' (add your WhatsApp number first)'
    : '[ ] Write and send the welcome note (the welcome step was skipped)');
  L.push('[ ] If they want Google reviews, set their Google place id in admin.html (Venues, ' + inputs.name + '); there is no Places API key here');
  L.push(theme
    ? '[ ] Check brand ' + theme.brand + ', background ' + (theme.bg || 'default') + ' and font ' + (theme.font || 'default') + ' against their Instagram'
    : '[ ] Set brand colour, background and font in admin.html (the theme step was skipped)');
  if (inputs.currency !== 'USD') L.push('[ ] Prices were converted from ' + inputs.currency + ' by the menu import: set the venue exchange rate on the dashboard to the rate it used (its report says which)');
  L.push(demoOff ? '[x] Demo payments are off for this venue (set at registration)' : '[ ] Demo payments are ON for this existing venue: turn them off in admin.html');
  return L;
}

module.exports = { main, parseArgs, resolveInputs, manualChecklist, Usage, STEPS, NAMES, HELP };

if (require.main === module && process.argv[2] === 'ui') {
  // node tools/onboard.js ui: the same pipeline from a local page (tools/onboard-ui.js)
  require('./onboard-ui.js').cli(process.argv.slice(3)).then(function (c) { if (c) process.exitCode = c; }, function (e) {
    process.stderr.write('onboard ui: ' + (e && e.message || e) + '\n');
    process.exitCode = 1;
  });
} else if (require.main === module) {
  main(process.argv.slice(2)).then(function (c) { process.exitCode = c; }, function (e) {
    process.stderr.write('onboard: ' + (e && e.message || e) + '\n');
    process.exitCode = 1;
  });
}
