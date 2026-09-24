'use strict';
/* A local page for the onboarding pipeline, for the founder who does not use a terminal:

     node tools/onboard.js ui [--port 8790] [--no-open]

   Starts an HTTP server on 127.0.0.1 only, prints its address and opens it in the default
   browser. The page (tools/ui/) fills in the same inputs as the command line, runs main()
   of tools/onboard.js in this process, shows each step as it happens, lets the founder
   edit the extracted menu at the checkpoint, and shows the verify checks, the card sheet
   and the welcome note at the end.

   Security: a random 32-byte token is made at start. The address that is opened carries
   it (?t=); the page keeps it in memory and sends it as the X-Onboard-Token header on
   every API call. A request without it, or for another Host than 127.0.0.1 or localhost
   on this port, gets 403, so another page open in the browser cannot drive the tool.
   No CORS headers are sent. The admin key and the Anthropic key entered on the page live
   in this process only: never written to disk, never sent back (the page learns "set" or
   "missing"). No API response or event carries the owner key, a table code, a bill key or
   a model key: responses are built from a list of allowed fields, and everything that
   leaves the server also goes through redact() below. The one exception is the card
   sheet itself, whose QR codes are the table codes; it is served only with the token.

   Files: uploads go to onboarding/<slug>/uploads/ (ignored by git, like the state file),
   the page's own options (LBP rate, theme overrides) to onboarding/<slug>/ui.json, the
   importer's report to onboarding/<slug>/import-report.txt. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const onboard = require('./onboard.js');
const { slugify, SLUG, FONT, hex } = require('./lib/venue');
const { checkPack } = require('./lib/draft');
const { ROOT } = require('./lib/supabase');
const { FONTS } = require('./steps/theme');

const UI_DIR = path.join(__dirname, 'ui');
const DEFAULT_PORT = 8790;
const MAX_UPLOAD = 40 * 1024 * 1024;               // decoded bytes of all menu files together
const MAX_IMAGE = 5 * 1024 * 1024;                 // the Messages API limit per image (tools/import-menu.js)
const MAX_UPLOAD_BODY = Math.ceil(MAX_UPLOAD / 3) * 4 + 1024 * 1024;   // base64 plus the form
const MAX_JSON_BODY = 5 * 1024 * 1024;
const MAX_EVENTS = 4000;                           // kept per venue for late subscribers and polling
const DEFAULT_LBP_RATE = 89500;                    // tools/import-menu.js default
const EMAIL = /^[^\s@,:]+@[^\s@,:]+\.[^\s@,:]+$/;
const ROLES = ['owner', 'manager', 'waiter'];
const STATIC = { '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };

class HttpError extends Error { constructor(status, message, field) { super(message); this.status = status; this.field = field; } }

function realImporter() { return require('./import-menu.js'); }

/* The type a file really is, from its first bytes; the name's extension is not trusted. */
function sniff(buf) {
  if (buf.length >= 4 && buf.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function checkText(label, v, field, required) {
  v = typeof v === 'string' ? v.trim() : '';
  if (required && !v) throw new HttpError(400, label + ' is required.', field);
  if (v.length > 40) throw new HttpError(400, label + ' is longer than 40 characters.', field);
  if (/["\\\u0000-\u001f]/.test(v)) throw new HttpError(400, label + ' cannot contain double quotes or backslashes.', field);
  return v;
}

/* The form, checked field by field with the page's words; tools/onboard.js checks the
   resulting arguments once more before anything is written. */
function checkForm(b) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'The form did not arrive.');
  const f = {};
  f.name = checkText('The name', b.name, 'name', true);
  f.place = checkText('The place', b.place, 'place', false);
  f.slug = typeof b.slug === 'string' && b.slug.trim() ? b.slug.trim() : slugify(f.name);
  if (f.slug.length > 40 || !SLUG.test(f.slug)) throw new HttpError(400, 'The short name uses lower-case letters, digits and hyphens only, up to 40 characters, not starting or ending with a hyphen.', 'slug');
  if (f.slug === 'index') throw new HttpError(400, 'The short name "index" is reserved. Choose another.', 'slug');
  f.currency = String(b.currency || 'USD').toUpperCase();
  if (['USD', 'LBP'].indexOf(f.currency) < 0) throw new HttpError(400, 'The currency is USD or LBP.', 'currency');
  f.rate = null;
  if (f.currency === 'LBP') {
    f.rate = b.rate == null || b.rate === '' ? DEFAULT_LBP_RATE : Number(b.rate);
    if (!(f.rate === Math.floor(f.rate) && f.rate >= 1000 && f.rate <= 10000000)) throw new HttpError(400, 'The rate is a whole number of LBP per USD, from 1,000 to 10,000,000.', 'rate');
  }
  f.tables = Number(b.tables);
  if (!(f.tables === Math.floor(f.tables) && f.tables >= 1 && f.tables <= 200)) throw new HttpError(400, 'The number of tables is a whole number from 1 to 200.', 'tables');
  f.owner = String(b.owner || '').trim().toLowerCase();
  if (!EMAIL.test(f.owner)) throw new HttpError(400, 'The owner email is not a valid email address.', 'owner');
  const seen = {}; seen[f.owner] = 'owner';
  f.staff = (Array.isArray(b.staff) ? b.staff : []).filter(function (s) { return s && String(s.email || '').trim(); }).map(function (s, i) {
    const email = String(s.email).trim().toLowerCase(), role = String(s.role || '').toLowerCase();
    if (!EMAIL.test(email)) throw new HttpError(400, 'Staff row ' + (i + 1) + ': ' + JSON.stringify(email) + ' is not a valid email address.', 'staff');
    if (ROLES.indexOf(role) < 0) throw new HttpError(400, 'Staff row ' + (i + 1) + ': choose owner, manager or waiter.', 'staff');
    if (seen[email]) throw new HttpError(400, 'Staff row ' + (i + 1) + ': ' + email + (seen[email] === 'owner' ? ' is the owner email already.' : ' is listed twice.'), 'staff');
    seen[email] = 'staff';
    return { email, role };
  });
  ['brand', 'bg'].forEach(function (k) {
    const v = typeof b[k] === 'string' ? b[k].trim() : '';
    f[k] = v ? hex(v) : null;
    if (v && !f[k]) throw new HttpError(400, (k === 'brand' ? 'The brand colour' : 'The background') + ' is a six digit hex colour, like #EA312B.', k);
  });
  f.font = typeof b.font === 'string' && b.font.trim() ? b.font.trim() : null;
  if (f.font && !FONT.test(f.font)) throw new HttpError(400, 'The font is a Google Fonts name: letters, digits and spaces, up to 40 characters.', 'font');
  f.reimport = b.reimport === true;
  if (!Array.isArray(b.files) || !b.files.length) throw new HttpError(400, 'Add the menu: a PDF or photos of its pages.', 'files');
  let total = 0;
  f.files = b.files.map(function (x, i) {
    const label = (x && typeof x.name === 'string' && x.name) || 'file ' + (i + 1);
    const data = x && typeof x.data === 'string' ? x.data : '';
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, label + ' did not arrive whole. Add it again.', 'files');
    const buf = Buffer.from(data, 'base64');
    total += buf.length;
    if (total > MAX_UPLOAD) throw new HttpError(413, 'The menu files are over 40 MB together. Send fewer or smaller files.', 'files');
    const kind = sniff(buf);
    if (!kind) throw new HttpError(400, label + ' is not a PDF, JPG, PNG or WebP file. Photos from an iPhone may be HEIC: export them as JPEG first.', 'files');
    if (kind !== 'pdf' && buf.length > MAX_IMAGE) throw new HttpError(400, label + ' is over 5 MB. Photos must be 5 MB or smaller: resize it and add it again.', 'files');
    const base = path.basename(label).replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'menu';
    return { file: String(i + 1).padStart(2, '0') + '-' + base + '.' + kind, buf };
  });
  return f;
}

function createServer(o) {
  o = o || {};
  const cwd = o.cwd || ROOT;
  const baseEnv = o.env || process.env;
  const token = crypto.randomBytes(32).toString('hex');
  const tokenBuf = Buffer.from(token);
  const mem = { admin: null, anthropic: null };        // keys typed on the page; process memory only
  const runs = new Map();                              // slug -> {kind, current}
  const hist = new Map();                              // slug -> {seq, events, subs}
  let port = null;

  const onboardingDir = path.join(cwd, 'onboarding');
  const P = function (slug) {
    return {
      state: path.join(onboardingDir, slug + '.json'), cards: path.join(onboardingDir, slug + '-table-cards.html'),
      welcome: path.join(onboardingDir, slug + '-welcome.md'), dir: path.join(onboardingDir, slug),
      uploads: path.join(onboardingDir, slug, 'uploads'), ui: path.join(onboardingDir, slug, 'ui.json'),
      report: path.join(onboardingDir, slug, 'import-report.txt'), pack: path.join(cwd, 'venues', slug + '.json')
    };
  };

  function env() {
    const e = Object.assign({}, baseEnv);
    if (mem.admin) e.AALAYNA_ADMIN_KEY = mem.admin;
    if (mem.anthropic) e.ANTHROPIC_API_KEY = mem.anthropic;
    return e;
  }
  function keyStatus() {
    const e = env();
    return { admin: e.AALAYNA_ADMIN_KEY ? 'set' : 'missing', anthropic: e.ANTHROPIC_API_KEY ? 'set' : 'missing' };
  }

  /* Last line of defence: whatever leaves this server loses anything shaped like a key. */
  function redact(text) {
    let s = String(text).replace(/\b(own|tbl|chk|gst|adm)_[0-9A-Za-z]{6,}/g, '[hidden]').replace(/sk-ant-[0-9A-Za-z_-]+/g, '[hidden]');
    const e = env();
    [e.AALAYNA_ADMIN_KEY, e.ANTHROPIC_API_KEY, mem.admin, mem.anthropic].forEach(function (k) {
      if (!k || String(k).length < 8) return;
      [String(k), JSON.stringify(String(k)).slice(1, -1)].forEach(function (v) { s = s.split(v).join('[hidden]'); });
    });
    return s;
  }

  /* ---- events: step changes and log lines of each run, per venue ---- */
  function histOf(slug) {
    if (!hist.has(slug)) hist.set(slug, { seq: 0, events: [], subs: new Set() });
    return hist.get(slug);
  }
  function emit(slug, ev) {
    const h = histOf(slug);
    ev = JSON.parse(redact(JSON.stringify(ev)));
    ev.seq = ++h.seq;
    h.events.push(ev);
    if (h.events.length > MAX_EVENTS) h.events.splice(0, h.events.length - MAX_EVENTS);
    h.subs.forEach(function (fn) { try { fn(ev); } catch (e) { /* a closed stream */ } });
  }
  function eventsSince(slug, since) {
    const h = hist.get(slug);
    return h ? h.events.filter(function (e) { return e.seq > since; }) : [];
  }

  /* ---- the venue as the page sees it ---- */
  function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }
  function readUi(slug) { return readJSON(P(slug).ui) || {}; }
  function stepStatus(name, rec, run) {
    if (run && run.current === name) return 'running';
    const s = (rec && rec.status) || 'pending';
    if (s === 'pending' && name === 'menu' && rec.finished_at && rec.data && rec.data.extracted) return 'waiting';
    return s;
  }
  function overall(steps, run) {
    if (run) return 'running';
    const st = steps.map(function (s) { return s.status; });
    if (st.indexOf('failed') >= 0) return 'failed';
    if (st.indexOf('waiting') >= 0) return 'waiting';
    if (st.every(function (s) { return s === 'done' || s === 'skipped'; })) return 'done';
    return st.some(function (s) { return s !== 'pending'; }) ? 'stopped' : 'new';
  }
  function summaryOf(slug) {
    const p = P(slug), state = readJSON(p.state);
    if (!state || !state.steps) return null;
    const run = runs.get(slug);
    const steps = onboard.NAMES.map(function (n, i) {
      const rec = state.steps[n] || {};
      return { name: n, index: i, status: stepStatus(n, rec, run), summary: rec.summary || '' };
    });
    const touched = steps.filter(function (s) { return s.status !== 'pending'; });
    const inputs = state.inputs || {};
    return {
      slug, name: inputs.name || slug, place: inputs.place || '', status: overall(steps, run), running: !!run,
      lastStep: run && run.current ? run.current : touched.length ? touched[touched.length - 1].name : onboard.NAMES[0],
      updated_at: state.updated_at || state.created_at || null, steps
    };
  }
  function venueView(slug) {
    const sum = summaryOf(slug);
    if (!sum) return null;
    const p = P(slug), state = readJSON(p.state), st = state.steps, inputs = state.inputs || {}, ui = readUi(slug);
    const data = function (n) { return (st[n] && st[n].data) || {}; };
    sum.steps.forEach(function (s) { const rec = st[s.name] || {}; if (rec.status === 'failed' && rec.error) s.error = rec.error; });
    const settled = sum.steps.every(function (s) { return s.status === 'done' || s.status === 'skipped'; });
    const pack = readJSON(p.pack);
    const theme = data('theme');
    return Object.assign(sum, {
      runKind: runs.has(slug) ? runs.get(slug).kind : null,
      inputs: {
        name: inputs.name, place: inputs.place, currency: inputs.currency, rate: ui.rate || null, tables: inputs.tables, owner: inputs.owner,
        staff: (inputs.staff || []).map(function (s) { return { email: s.email, role: s.role }; }),
        files: (inputs.files || []).map(function (f) { return path.basename(f); })
      },
      overrides: { brand: ui.brand || null, bg: ui.bg || null, font: ui.font || null },
      theme: st.theme && st.theme.status === 'done' ? { brand: theme.brand || null, bg: theme.bg || null, font: theme.font || null, source: theme.source || null } : null,
      pack: pack && Array.isArray(pack.items) ? { path: path.relative(cwd, p.pack), items: pack.items.length, sections: (pack.sections || []).length } : null,
      published: st.menu && st.menu.status === 'done' ? { version: data('menu').version, items: data('menu').items, sections: data('menu').sections } : null,
      checks: (data('verify').checks || []).map(function (c) { return { name: c.name, status: c.status, detail: c.detail || '' }; }),
      tables: { count: Object.keys(data('tables').codes || {}).length },
      cards: fs.existsSync(p.cards) ? '/onboarding/' + slug + '-table-cards.html' : null,
      welcome: fs.existsSync(p.welcome),
      report: fs.existsSync(p.report),
      checklist: settled ? onboard.manualChecklist(state, cwd, { cards: p.cards, welcome: p.welcome }) : [],
      seq: hist.has(slug) ? hist.get(slug).seq : 0
    });
  }
  function listVenues() {
    let files = [];
    try { files = fs.readdirSync(onboardingDir); } catch (e) { return []; }
    return files.filter(function (f) { return /\.json$/.test(f) && SLUG.test(f.slice(0, -5)); })
      .map(function (f) { const s = summaryOf(f.slice(0, -5)); if (s) delete s.steps; return s; })
      .filter(Boolean)
      .sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
  }

  /* ---- runs ---- */
  function overrideArgs(slug) {
    const ui = readUi(slug), a = [];
    if (ui.brand) a.push('--brand', ui.brand);
    if (ui.bg) a.push('--bg', ui.bg);
    if (ui.font) a.push('--font', ui.font);
    return a;
  }
  function importerFor(slug) {
    const base = o.importMenu || realImporter();
    return {
      importMenu: async function (args) {
        const ui = readUi(slug), a = Object.assign({}, args);
        if (a.currency === 'LBP' && ui.rate) a.rate = ui.rate;
        const res = await base.importMenu(a);
        const r = res && res.report;
        const text = r == null ? '' : typeof r === 'string' ? r : Array.isArray(r) ? r.join('\n') : typeof r.text === 'string' ? r.text : JSON.stringify(r, null, 2);
        fs.mkdirSync(P(slug).dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(P(slug).report, text + '\n', { mode: 0o600 });
        return res;
      },
      validatePack: base.validatePack || realImporter().validatePack
    };
  }
  function startRun(slug, argv, kind) {
    if (runs.has(slug)) throw new HttpError(409, 'A run for ' + slug + ' is already going. Wait for it to finish.');
    const run = { kind, current: null };
    runs.set(slug, run);
    emit(slug, { type: 'start', kind });
    const opts = {
      cwd, shellCwd: cwd, env: env(), fetch: o.fetch, importMenu: importerFor(slug), confirm: async function () { return true; },
      out: function (line) { emit(slug, { type: 'log', line: String(line) }); },
      progress: function (p) {
        run.current = p.status === 'running' ? p.step : null;
        emit(slug, { type: 'step', step: p.step, index: p.index, status: p.status, summary: p.summary || '', earlier: !!p.earlier });
      }
    };
    const finish = function (code) {
      runs.delete(slug);
      const s = summaryOf(slug);
      emit(slug, { type: 'end', kind, code, status: s ? s.status : 'removed' });
    };
    Promise.resolve().then(function () { return onboard.main(argv, opts); }).then(finish, function (e) {
      emit(slug, { type: 'log', line: 'onboard: ' + ((e && e.message) || e) });
      finish(1);
    });
  }
  function needState(slug) {
    if (!fs.existsSync(P(slug).state)) throw new HttpError(404, 'There is no onboarding for ' + slug + '.');
  }
  function notRunning(slug) {
    if (runs.has(slug)) throw new HttpError(409, 'A run for ' + slug + ' is going. Wait for it to finish.');
  }

  function createVenue(body) {
    const f = checkForm(body);
    const p = P(f.slug);
    notRunning(f.slug);
    if (fs.existsSync(p.state)) throw new HttpError(409, 'The short name ' + f.slug + ' is already in the list on the left. Open it there, or choose another short name.', 'slug');
    const argv = ['--name', f.name, '--place', f.place, '--slug', f.slug, '--currency', f.currency, '--tables', String(f.tables), '--owner', f.owner];
    if (f.staff.length) argv.push('--staff', f.staff.map(function (s) { return s.email + ':' + s.role; }).join(','));
    if (f.brand) argv.push('--brand', f.brand);
    if (f.bg) argv.push('--bg', f.bg);
    if (f.font) argv.push('--font', f.font);
    try {   // the command line's own checks, before anything is written
      const parsed = onboard.parseArgs(argv);
      onboard.resolveInputs(parsed.flags, [], null, cwd);
    } catch (e) {
      if (e instanceof onboard.Usage) throw new HttpError(400, e.message.replace(/--([a-z]+)/g, '$1'));
      throw e;
    }
    fs.rmSync(p.dir, { recursive: true, force: true });
    fs.mkdirSync(p.uploads, { recursive: true, mode: 0o700 });
    fs.chmodSync(p.dir, 0o700);
    const files = f.files.map(function (x) {
      const file = path.join(p.uploads, x.file);
      fs.writeFileSync(file, x.buf, { mode: 0o600 });
      return file;
    });
    fs.writeFileSync(p.ui, JSON.stringify({ rate: f.rate, brand: f.brand, bg: f.bg, font: f.font }, null, 1) + '\n', { mode: 0o600 });
    if (f.reimport && fs.existsSync(p.pack)) argv.push('--reimport');
    hist.delete(f.slug);
    startRun(f.slug, argv.concat(files), 'start');
    return { slug: f.slug };
  }

  /* ---- HTTP ---- */
  function securityHeaders(extra) {
    return Object.assign({
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
        "img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }, extra || {});
  }
  function sendJSON(res, status, obj) {
    const text = redact(JSON.stringify(obj));
    res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(text);
  }
  function sendText(res, status, text, type, extra) {
    res.writeHead(status, securityHeaders(Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8' }, extra || {})));
    res.end(text);
  }
  /* A body over the limit is read to its end and dropped, so the page gets the 413 answer
     instead of a reset connection. */
  function readBody(req, limit) {
    return new Promise(function (resolve, reject) {
      const chunks = []; let size = 0;
      req.on('data', function (c) {
        size += c.length;
        if (size > limit) { chunks.length = 0; return; }
        chunks.push(c);
      });
      req.on('end', function () {
        if (size > limit) return reject(new HttpError(413, limit === MAX_UPLOAD_BODY ? 'The menu files are over 40 MB together. Send fewer or smaller files.' : 'The request is too large.', limit === MAX_UPLOAD_BODY ? 'files' : undefined));
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve(null);
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new HttpError(400, 'The request is not valid JSON.')); }
      });
      req.on('error', reject);
    });
  }
  function tokenOk(given) {
    const b = Buffer.from(String(given || ''));
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  }
  function hostOk(req) {
    const h = String(req.headers.host || '').toLowerCase();
    return h === '127.0.0.1:' + port || h === 'localhost:' + port;
  }

  function streamEvents(req, res, slug, since) {
    res.writeHead(200, securityHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }));
    const write = function (ev) { res.write('id: ' + ev.seq + '\nevent: ' + ev.type + '\ndata: ' + redact(JSON.stringify(ev)) + '\n\n'); };
    eventsSince(slug, since).forEach(write);
    if (!runs.has(slug)) { res.write('event: idle\ndata: {}\n\n'); res.end(); return; }
    const h = histOf(slug);
    const ping = setInterval(function () { res.write(': ping\n\n'); }, 15000);
    const sub = function (ev) { write(ev); if (ev.type === 'end') close(); };
    const close = function () { clearInterval(ping); h.subs.delete(sub); res.end(); };
    h.subs.add(sub);
    req.on('close', function () { clearInterval(ping); h.subs.delete(sub); });
  }

  async function api(req, res, u) {
    const m = req.method, pn = u.pathname;
    if (pn === '/api/status' && m === 'GET') {
      return sendJSON(res, 200, { keys: keyStatus(), venues: listVenues(), fonts: FONTS, allergens: realImporter()._internal.ALLERGENS, maxUpload: MAX_UPLOAD, maxImage: MAX_IMAGE, defaultRate: DEFAULT_LBP_RATE });
    }
    if (pn === '/api/keys' && m === 'POST') {
      const b = await readBody(req, 64 * 1024) || {};
      [['admin', 'The admin key'], ['anthropic', 'The Anthropic key']].forEach(function (k) {
        const v = b[k[0]];
        if (v == null || v === '') return;
        if (typeof v !== 'string' || /\s/.test(v.trim()) || v.trim().length > 400) throw new HttpError(400, k[1] + ' looks wrong: paste it again, without spaces.', k[0]);
      });
      if (b.admin) mem.admin = b.admin.trim();
      if (b.anthropic) mem.anthropic = b.anthropic.trim();
      return sendJSON(res, 200, { keys: keyStatus() });
    }
    if (pn === '/api/slug' && m === 'GET') {
      const slug = String(u.searchParams.get('slug') || '');
      const valid = slug.length <= 40 && SLUG.test(slug) && slug !== 'index';
      const pack = valid ? readJSON(P(slug).pack) : null;
      return sendJSON(res, 200, { slug, valid, taken: valid && fs.existsSync(P(slug).state), pack: pack && Array.isArray(pack.items) ? { items: pack.items.length } : null });
    }
    if (pn === '/api/venues' && m === 'POST') {
      const b = await readBody(req, MAX_UPLOAD_BODY);
      return sendJSON(res, 202, createVenue(b));
    }
    const mm = /^\/api\/venues\/([a-z0-9-]{1,40})(?:\/(approve|reimport|resume|reset|pack|events|welcome))?$/.exec(pn);
    if (!mm || !SLUG.test(mm[1])) throw new HttpError(404, 'Not found.');
    const slug = mm[1], action = mm[2] || '', p = P(slug);
    const since = Math.max(0, Number(u.searchParams.get('since')) || 0);
    if (!action && m === 'GET') {
      const v = venueView(slug);
      if (!v) throw new HttpError(404, 'There is no onboarding for ' + slug + '.');
      return sendJSON(res, 200, { venue: v, events: eventsSince(slug, since) });
    }
    if (action === 'events' && m === 'GET') { needState(slug); return streamEvents(req, res, slug, since); }
    if (action === 'resume' && m === 'POST') {
      needState(slug); notRunning(slug);
      startRun(slug, ['--slug', slug].concat(overrideArgs(slug)), 'resume');
      return sendJSON(res, 202, { slug });
    }
    if (action === 'approve' && m === 'POST') {
      needState(slug); notRunning(slug);
      const pack = readJSON(p.pack);
      if (!pack) throw new HttpError(409, 'venues/' + slug + '.json is missing or not valid JSON. Extract the menu again.');
      const errs = checkPack(pack).concat(realImporter().validatePack(pack));
      if (errs.length) throw new HttpError(422, 'Not published yet: ' + errs.join('; ') + '.');
      startRun(slug, ['--slug', slug, '--approve-menu'].concat(overrideArgs(slug)), 'approve');
      return sendJSON(res, 202, { slug });
    }
    if (action === 'reimport' && m === 'POST') {
      needState(slug); notRunning(slug);
      const files = ((readJSON(p.state) || {}).inputs || {}).files || [];
      if (!files.length || !files.every(function (f) { return fs.existsSync(path.resolve(cwd, f)); })) throw new HttpError(409, 'The menu files of ' + slug + ' are no longer on this computer. Start over to add them again.');
      startRun(slug, ['--slug', slug, '--reimport'].concat(overrideArgs(slug)), 'reimport');
      return sendJSON(res, 202, { slug });
    }
    if (action === 'reset' && m === 'POST') {
      needState(slug); notRunning(slug);
      const lines = [];
      const code = await onboard.main(['--slug', slug, '--reset', '--yes'], { cwd, shellCwd: cwd, env: env(), out: function (l) { lines.push(l); } });
      if (code !== 0) throw new HttpError(500, lines.join(' ') || 'The reset did not finish.');
      fs.rmSync(p.dir, { recursive: true, force: true });
      hist.delete(slug);
      return sendJSON(res, 200, { ok: true, message: lines.join(' ') });
    }
    if (action === 'pack' && m === 'GET') {
      needState(slug);
      const pack = readJSON(p.pack);
      if (!pack) throw new HttpError(404, 'venues/' + slug + '.json is not there yet.');
      let report = null;
      try { report = fs.readFileSync(p.report, 'utf8'); } catch (e) { /* the pack was already there: no report */ }
      return sendJSON(res, 200, { pack, blockers: checkPack(pack), report });
    }
    if (action === 'pack' && m === 'PUT') {
      needState(slug); notRunning(slug);
      const pack = await readBody(req, MAX_JSON_BODY);
      const errs = realImporter().validatePack(pack);
      if (errs.length) throw new HttpError(422, 'Not saved: ' + errs.slice(0, 5).join('; ') + '.');
      const tmp = p.pack + '.tmp-ui';
      fs.writeFileSync(tmp, JSON.stringify(pack, null, 1) + '\n');
      fs.renameSync(tmp, p.pack);
      return sendJSON(res, 200, { ok: true, blockers: checkPack(pack), items: pack.items.length });
    }
    if (action === 'welcome' && m === 'GET') {
      needState(slug);
      let md;
      try { md = fs.readFileSync(p.welcome, 'utf8'); } catch (e) { throw new HttpError(404, 'The welcome note is not written yet.'); }
      return sendText(res, 200, redact(md), 'text/plain; charset=utf-8');
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (!hostOk(req)) return sendText(res, 403, 'Forbidden.');
    if (u.pathname.indexOf('/api/') === 0) {
      if (!tokenOk(req.headers['x-onboard-token'])) return sendJSON(res, 403, { error: 'This page is not the one the onboarding tool opened. Open the address printed in the terminal.' });
      return api(req, res, u);
    }
    if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed.');
    // pages a browser opens directly cannot send a header: the token comes in the query
    if (!tokenOk(u.searchParams.get('t'))) {
      return sendText(res, 403, 'This address needs the key of the running tool. Open the full address printed in the terminal (node tools/onboard.js ui).');
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8').split('{{TOKEN}}').join(token);
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    }
    if (STATIC[u.pathname]) return sendText(res, 200, fs.readFileSync(path.join(UI_DIR, STATIC[u.pathname][0])), STATIC[u.pathname][1]);
    const cm = /^\/onboarding\/([a-z0-9-]{1,40})-table-cards\.html$/.exec(u.pathname);
    if (cm && SLUG.test(cm[1]) && fs.existsSync(P(cm[1]).cards)) {
      // the sheet holds the table codes, by design; it has its own inline style and fonts
      return sendText(res, 200, fs.readFileSync(P(cm[1]).cards), 'text/html; charset=utf-8', {
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; frame-ancestors 'none'"
      });
    }
    return sendText(res, 404, 'Not found.');
  }

  const server = http.createServer(function (req, res) {
    handle(req, res).catch(function (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const body = { error: status === 500 ? 'Something went wrong on the tool side: ' + ((e && e.message) || e) : e.message };
      if (e && e.field) body.field = e.field;
      if (res.headersSent) { try { res.end(); } catch (x) { /* gone */ } return; }
      sendJSON(res, status, body);
    });
  });

  function listen(want) {
    return new Promise(function (resolve, reject) {
      const onErr = function (e) { server.removeListener('listening', onOk); reject(e); };
      const onOk = function () { server.removeListener('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(want, '127.0.0.1');
    });
  }
  async function start() {
    const first = o.port != null ? Number(o.port) : DEFAULT_PORT;
    const tries = first === 0 ? [0] : [first, first + 1, first + 2, first + 3, first + 4, 0];
    for (const t of tries) {
      try { await listen(t); break; } catch (e) { if (e.code !== 'EADDRINUSE' || t === 0) throw e; }
    }
    port = server.address().port;
    return {
      url: 'http://127.0.0.1:' + port + '/?t=' + token, origin: 'http://127.0.0.1:' + port, token, port,
      close: function () {
        hist.forEach(function (h) { h.subs.clear(); });
        return new Promise(function (r) { server.close(function () { r(); }); if (server.closeAllConnections) server.closeAllConnections(); });
      },
      running: function () { return Array.from(runs.keys()); }
    };
  }
  return start();
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  return new Promise(function (resolve) {
    let child;
    try { child = cp.spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }); } catch (e) { return resolve(false); }
    child.on('error', function () { resolve(false); });
    child.on('spawn', function () { child.unref(); resolve(true); });
  });
}

async function cli(argv) {
  let port = DEFAULT_PORT, open = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-open') open = false;
    else if (argv[i] === '--port' && i + 1 < argv.length && /^\d{1,5}$/.test(argv[i + 1])) port = Number(argv[++i]);
    else { process.stdout.write('Usage: node tools/onboard.js ui [--port 8790] [--no-open]\n'); return 2; }
  }
  const ui = await createServer({ port });
  const k = [process.env.AALAYNA_ADMIN_KEY ? null : 'the admin key', process.env.ANTHROPIC_API_KEY ? null : 'the Anthropic key'].filter(Boolean);
  process.stdout.write('Aalayna onboarding is running at\n\n  ' + ui.url + '\n\n' +
    (open ? 'Opening it in your browser. ' : '') + 'Keep this window open while you work; press Ctrl+C to stop.\n' +
    (k.length ? 'The page will ask for ' + k.join(' and ') + ' (kept in memory for this session only).\n' : ''));
  if (open && !(await openBrowser(ui.url))) process.stdout.write('Could not open a browser: copy the address above into one.\n');
  await new Promise(function (resolve) {
    const stop = function () { process.stdout.write('\nStopped.\n'); ui.close().then(resolve); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

module.exports = { createServer, cli, checkForm, sniff, MAX_UPLOAD };
