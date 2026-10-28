#!/usr/bin/env node
'use strict';
/* The printer-stream listener: a POS with no API prints to this service as if it were the
   receipt printer; each guest check it prints becomes a bill pushed to pos-bill
   (docs/pos-integration.md, "The printer-stream path"). Plain Node 18+, no dependencies.

     node tools/pos-printer/listen.js --config tools/pos-printer/config.json
     node tools/pos-printer/listen.js --config ... --dry-run          # write JSON, send nothing
     node tools/pos-printer/listen.js --config ... --replay tests/fixtures/pos-printer/cloud-foodics.bin [--printer front-till] [--push]

   Sources, per printer in the configuration (config.example.json):
   - "tcp": {host, port}: the 9100 convention. One connection is usually one job; a cut also
     ends a ticket. With "forward" ({host, port} or {path}) every byte goes on to the real
     printer and its status replies come back to the POS; if the printer cannot be reached
     the POS's connection is closed, so the POS reports a printer error instead of a ticket
     silently not printing.
   - "serial": {path, idleMs}: a device already configured with stty (Node cannot set a
     baud rate without a package; capture.md gives the commands, and socat can bridge a
     serial line to the TCP source instead). A job ends at a cut or after idleMs of silence.
   - "folder": {path, pollMs, moveProcessed}: print-to-file captures (a Windows local port,
     spool files). Each file is read once it stops growing, once per content.

   Each document is read with the printer's profile (ticket.js). Kitchen tickets, reports and
   unreadable streams are ignored; a bill that needs review (it does not balance, no table,
   no check number, low confidence) is written to reviewDir and never sent. A good bill goes
   through the check ledger: an identical reprint sends nothing, a changed print of the same
   check is sent as the same externalId with a higher version. Pushing follows the spec: the
   same body (same version) is retried after a timeout, a 5xx or a 429 (after Retry-After),
   so a retry is an idempotent no-op on the server; stale_version is dropped (a newer one
   arrived); version_reused moves to a higher version once; every other refusal goes to
   reviewDir with Aalayna's message for staff. Unsent bills wait in stateDir/outbox.json and
   are retried every minute and at start. The integration key is read from the environment
   variable the venue names; it is never logged or written. */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { StreamParser } = require('./escpos.js');
const ticket = require('./ticket.js');

const DEFAULTS = {
  endpoint: 'https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1/pos-bill',
  dryRun: false, stateDir: 'state', outDir: 'out', reviewDir: 'review', captureDir: null,
  timeoutMs: 10000, maxAttempts: 6, retryEveryMs: 60000, windowHours: 14,
};
const KEY = /^pos_[0-9a-f]{64}$/;

function loadConfig(file, overrides) {
  const base = path.dirname(path.resolve(file));
  const cfg = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')), overrides || {});
  return resolvePaths(cfg, base);
}
function resolvePaths(cfg, base) {
  for (const k of ['stateDir', 'outDir', 'reviewDir', 'captureDir']) if (cfg[k]) cfg[k] = path.resolve(base, cfg[k]);
  for (const p of cfg.printers || []) {
    if (p.source && p.source.folder) p.source.folder.path = path.resolve(base, p.source.folder.path);
    if (typeof p.profile === 'string' && /[\\/]|\.json$/.test(p.profile)) p.profile = path.resolve(base, p.profile);
  }
  return cfg;
}
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
const silent = { info() {}, warn() {}, error() {} };

class Bridge {
  constructor(config, deps) {
    deps = deps || {};
    this.cfg = Object.assign({}, DEFAULTS, config);
    this.fetch = deps.fetch || globalThis.fetch;
    this.now = deps.now || (() => new Date());
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log || silent;
    this.env = deps.env || process.env;
    this.seq = 0;
    this.profiles = {};
    this.queues = {};
    // a dry run keeps its own ledger, so going live later does not take its checks as sent
    const ledgerName = this.cfg.dryRun ? 'ledger-dry-run.json' : 'ledger.json';
    this.ledger = new ticket.CheckLedger({ file: this.cfg.stateDir ? path.join(this.cfg.stateDir, ledgerName) : null, now: this.now, windowHours: this.cfg.windowHours });
    this.outboxFile = this.cfg.stateDir ? path.join(this.cfg.stateDir, 'outbox.json') : null;
    this.outbox = [];
    if (this.outboxFile && fs.existsSync(this.outboxFile)) { try { this.outbox = JSON.parse(fs.readFileSync(this.outboxFile, 'utf8')); } catch (e) { this.outbox = []; } }
  }
  printer(name) {
    const list = this.cfg.printers || [];
    const p = name ? list.find((x) => x.name === name) : list[0];
    if (!p) throw new Error(name ? 'no printer named ' + name + ' in the configuration' : 'the configuration has no printer');
    return p;
  }
  venue(p) {
    const v = (this.cfg.venues || {})[p.venue];
    if (!v) throw new Error('printer ' + p.name + ' names venue ' + p.venue + ', which the configuration does not define');
    return v;
  }
  profile(p) {
    const key = typeof p.profile === 'object' ? JSON.stringify(p.profile) : String(p.profile || 'generic');
    if (!this.profiles[key]) this.profiles[key] = ticket.loadProfile(p.profile || 'generic');
    return this.profiles[key];
  }
  parserFor(p) { return new StreamParser(this.profile(p).parser); }
  /* the key for a venue, from the environment; null in dry run */
  keyFor(venueId, venue) {
    const k = venue.integrationKeyEnv ? this.env[venue.integrationKeyEnv] : null;
    return k && KEY.test(k.trim()) ? k.trim() : null;
  }
  check() {
    const problems = [];
    for (const p of this.cfg.printers || []) {
      try { const v = this.venue(p); this.profile(p); if (!this.cfg.dryRun && !this.keyFor(p.venue, v)) problems.push('venue ' + p.venue + ': set ' + (v.integrationKeyEnv || 'integrationKeyEnv') + ' to its pos_ integration key, or run with --dry-run'); }
      catch (e) { problems.push(e.message); }
    }
    return problems;
  }

  write(dir, name, obj) {
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
    return file;
  }
  capture(p, bytes) {
    if (!this.cfg.captureDir || !bytes.length) return null;
    fs.mkdirSync(this.cfg.captureDir, { recursive: true });
    const file = path.join(this.cfg.captureDir, safe(p.name) + '-' + stamp(this.now()) + '-' + (++this.seq) + '.bin');
    fs.writeFileSync(file, bytes);
    return file;
  }

  /* documents of one printer are handled one after the other, in print order */
  enqueue(p, docs) {
    const q = this.queues[p.name] || Promise.resolve();
    const next = q.then(() => this.handleDocuments(p, docs)).catch((e) => { this.log.error('[pos-printer] ' + p.name + ': ' + e.message); return []; });
    this.queues[p.name] = next;
    return next;
  }
  idle() { return Promise.all(Object.values(this.queues)); }
  async handleBytes(p, bytes) {
    const parser = this.parserFor(p);
    const docs = parser.push(bytes).concat(parser.end());
    return this.enqueue(p, docs);
  }
  async handleDocuments(p, docs) {
    const out = [];
    for (const doc of docs) out.push(await this.handleDocument(p, doc));
    return out;
  }
  async handleDocument(p, doc) {
    const venue = this.venue(p);
    const result = ticket.interpret(doc, { profile: this.profile(p), venue });
    const base = { printer: p.name, venue: p.venue, kind: result.kind, confidence: result.confidence, check: result.check.number || null };
    const name = stamp(this.now()) + '-' + safe(p.name) + '-' + (++this.seq) + '.json';
    if (result.kind !== 'bill' && result.kind !== 'image') {
      this.log.info('[pos-printer] ' + p.name + ': ignored a ' + result.kind + ' ticket');
      return Object.assign(base, { action: 'ignored' });
    }
    if (result.needsReview) {
      const file = this.write(this.cfg.reviewDir, name, { reason: 'needs_review', printer: p.name, venue: p.venue, result: summary(result), text: doc.lines.map((l) => l.text) });
      this.log.warn('[pos-printer] ' + p.name + ': check ' + (result.check.number || '?') + ' needs review: ' + result.issues.filter((i) => i.blocking).map((i) => i.reason).join('; '));
      return Object.assign(base, { action: 'review', file, issues: result.issues });
    }
    const step = this.ledger.accept(result, p.venue, venue);
    if (step.action === 'duplicate') {
      this.log.info('[pos-printer] ' + p.name + ': check ' + result.check.number + ' printed again unchanged; nothing sent');
      return Object.assign(base, { action: 'duplicate', externalId: step.externalId, version: step.version });
    }
    const body = ticket.toPosBill(result, venue, step);
    const info = Object.assign(base, { action: step.action, externalId: step.externalId, version: step.version, previousVersion: step.previousVersion, supersedesCheck: step.supersedesCheck });
    if (this.cfg.dryRun) {
      info.file = this.write(this.cfg.outDir, name, { dryRun: true, printer: p.name, venue: p.venue, action: step.action, supersedesCheck: step.supersedesCheck, body, result: summary(result) });
      return info;
    }
    const sent = await this.deliver({ venueId: p.venue, checkNumber: result.check.number, body, attempts: 0 });
    return Object.assign(info, sent);
  }

  saveOutbox() {
    if (!this.outboxFile) return;
    fs.mkdirSync(path.dirname(this.outboxFile), { recursive: true });
    fs.writeFileSync(this.outboxFile + '.tmp', JSON.stringify(this.outbox, null, 1));
    fs.renameSync(this.outboxFile + '.tmp', this.outboxFile);
  }
  async deliver(item) {
    this.outbox = this.outbox.filter((o) => !(o.venueId === item.venueId && o.body.externalId === item.body.externalId && o.body.version <= item.body.version));
    this.outbox.push(item); this.saveOutbox();
    const r = await this.push(item);
    if (r.final) { this.outbox = this.outbox.filter((o) => o !== item); this.saveOutbox(); }
    else this.saveOutbox();
    return r;
  }
  async retryOutbox() {
    for (const item of this.outbox.slice()) {
      const r = await this.push(item);
      if (r.final) this.outbox = this.outbox.filter((o) => o !== item);
    }
    this.saveOutbox();
  }
  /* one bill to pos-bill, with the spec's retry rules -> {status, code, final, pushed} */
  async push(item) {
    const venue = (this.cfg.venues || {})[item.venueId] || {};
    const key = this.keyFor(item.venueId, venue);
    if (!key) return { status: null, code: 'no_key', final: false, pushed: false };
    let reused = false;
    const max = this.cfg.maxAttempts || 6;
    for (let attempt = 1; attempt <= max; attempt++) {
      item.attempts = (item.attempts || 0) + 1;
      let res, json = null;
      try {
        res = await this.fetch(this.cfg.endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Aalayna-Integration-Key': key },
          body: JSON.stringify(item.body), signal: AbortSignal.timeout(this.cfg.timeoutMs || 10000),
        });
        try { json = await res.json(); } catch (e) { json = null; }
      } catch (e) {
        this.log.warn('[pos-printer] ' + item.body.externalId + ' v' + item.body.version + ': network error, attempt ' + attempt);
        await this.sleep(backoff(attempt));
        continue;
      }
      const code = json && json.error ? json.error.code : null;
      if (res.status === 200 || res.status === 201) {
        this.log.info('[pos-printer] ' + item.body.externalId + ' v' + item.body.version + ': ' + (json && json.status));
        return { status: res.status, code: json && json.status, final: true, pushed: true, checkId: json && json.checkId };
      }
      if (res.status === 429) { await this.sleep(1000 * Math.min(60, Math.max(1, Number(res.headers.get('retry-after')) || 1))); continue; }
      if (res.status >= 500) { await this.sleep(backoff(attempt)); continue; }
      if (res.status === 409 && code === 'stale_version') {
        this.log.info('[pos-printer] ' + item.body.externalId + ' v' + item.body.version + ': a newer version is already there; dropped');
        return { status: 409, code, final: true, pushed: false };
      }
      if (res.status === 409 && code === 'version_reused' && !reused) {
        reused = true;
        item.body = Object.assign({}, item.body, { version: this.ledger.bump(item.venueId, item.checkNumber) || item.body.version + 1 });
        continue;
      }
      const message = json && json.error ? json.error.message : 'HTTP ' + res.status;
      const file = this.write(this.cfg.reviewDir, stamp(this.now()) + '-' + safe(item.body.externalId) + '-refused.json',
        { reason: 'refused', status: res.status, code, message, detail: json && json.error, body: item.body });
      this.log.warn('[pos-printer] ' + item.body.externalId + ' v' + item.body.version + ': refused ' + res.status + ' ' + code + ': ' + message);
      return { status: res.status, code, message, final: true, pushed: false, file };
    }
    return { status: null, code: 'retry_later', final: false, pushed: false };
  }

  /* ---------- sources ---------- */
  listenTcp(p) {
    const src = p.source.tcp;
    const server = net.createServer((socket) => {
      const parser = this.parserFor(p), chunks = [];
      let up = null;
      if (p.forward && p.forward.host) {
        up = net.connect({ host: p.forward.host, port: p.forward.port || 9100 });
        up.on('error', (e) => { this.log.error('[pos-printer] ' + p.name + ': the printer at ' + p.forward.host + ' cannot be reached (' + e.code + '); closing the POS connection'); socket.destroy(); });
        up.on('data', (d) => { if (!socket.destroyed) socket.write(d); });
        up.on('close', () => socket.end());
      } else if (p.forward && p.forward.path) {
        up = fs.createWriteStream(p.forward.path, { flags: 'a' });
        up.on('error', (e) => { this.log.error('[pos-printer] ' + p.name + ': cannot write to ' + p.forward.path + ' (' + e.code + ')'); socket.destroy(); });
      }
      socket.on('data', (d) => {
        if (up) up.write(d);
        if (this.cfg.captureDir) chunks.push(Buffer.from(d));
        const docs = parser.push(d);
        if (docs.length) this.enqueue(p, docs);
      });
      const finish = () => {
        if (socket._aalaynaDone) return;
        socket._aalaynaDone = true;
        if (up && up.end) up.end();
        this.capture(p, Buffer.concat(chunks));
        const docs = parser.end();
        if (docs.length) this.enqueue(p, docs);
      };
      socket.on('end', finish); socket.on('close', finish);
      socket.on('error', () => {});
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(src.port === undefined ? 9100 : src.port, src.host || '0.0.0.0', () => { this.log.info('[pos-printer] ' + p.name + ': listening on ' + (src.host || '0.0.0.0') + ':' + server.address().port); resolve(server); });
    });
  }
  watchSerial(p) {
    const src = p.source.serial, idleMs = src.idleMs || 1500;
    let parser = this.parserFor(p), timer = null, stopped = false, chunks = [], stream = null;
    const flush = () => {
      timer = null;
      this.capture(p, Buffer.concat(chunks)); chunks = [];
      const docs = parser.end();
      if (docs.length) this.enqueue(p, docs);
    };
    const open = () => {
      if (stopped) return;
      stream = fs.createReadStream(src.path, { highWaterMark: 1024 });
      stream.on('data', (d) => {
        if (this.cfg.captureDir) chunks.push(Buffer.from(d));
        const docs = parser.push(d);
        if (docs.length) this.enqueue(p, docs);
        clearTimeout(timer); timer = setTimeout(flush, idleMs);
      });
      stream.on('error', (e) => this.log.error('[pos-printer] ' + p.name + ': ' + src.path + ': ' + e.code));
      stream.on('close', () => { clearTimeout(timer); flush(); if (!stopped && !src.once) setTimeout(open, 5000); });
    };
    open();
    return { close: () => { stopped = true; clearTimeout(timer); if (stream) stream.destroy(); } };
  }
  watchFolder(p) {
    const src = p.source.folder;
    const seenFile = this.cfg.stateDir ? path.join(this.cfg.stateDir, 'seen-' + safe(p.name) + '.json') : null;
    let seen = [];
    if (seenFile && fs.existsSync(seenFile)) { try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch (e) { seen = []; } }
    const sizes = new Map();
    let busy = false;
    const scan = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!fs.existsSync(src.path)) return;
        for (const name of fs.readdirSync(src.path).sort()) {
          const file = path.join(src.path, name);
          let st; try { st = fs.statSync(file); } catch (e) { continue; }
          if (!st.isFile() || !st.size) continue;
          const sig = st.size + ':' + st.mtimeMs;
          if (sizes.get(file) !== sig) { sizes.set(file, sig); continue; }  // still growing: next pass
          const bytes = fs.readFileSync(file);
          const hash = crypto.createHash('sha256').update(bytes).digest('hex');
          if (seen.includes(hash)) continue;
          seen.push(hash); seen = seen.slice(-2000);
          if (seenFile) { fs.mkdirSync(path.dirname(seenFile), { recursive: true }); fs.writeFileSync(seenFile, JSON.stringify(seen)); }
          await this.handleBytes(p, bytes);
          if (src.moveProcessed) {
            const done = path.join(src.path, 'processed');
            fs.mkdirSync(done, { recursive: true });
            try { fs.renameSync(file, path.join(done, stamp(this.now()) + '-' + name)); } catch (e) { /* the POS may hold it open */ }
          }
        }
      } finally { busy = false; }
    };
    const timer = setInterval(() => { scan().catch((e) => this.log.error('[pos-printer] ' + p.name + ': ' + e.message)); }, src.pollMs || 1000);
    return { close: () => clearInterval(timer), scan };
  }
}

function backoff(attempt) { return Math.min(30000, 1000 * 2 ** (attempt - 1)); }
function summary(r) {
  return { kind: r.kind, profile: r.profile, confidence: r.confidence, needsReview: r.needsReview, issues: r.issues, check: r.check,
    currency: r.currency, lines: r.lines, subtotalCents: r.subtotalCents, discountCents: r.discountCents, serviceCents: r.serviceCents,
    vat: r.vat, totalCents: r.totalCents, altTotals: r.altTotals, tenders: r.tenders, changeCents: r.changeCents };
}

/* every configured source -> {bridge, close()} */
async function start(config, deps) {
  const bridge = new Bridge(config, deps);
  const problems = bridge.check();
  if (problems.length) throw new Error(problems.join('\n'));
  const handles = [];
  for (const p of config.printers || []) {
    const s = p.source || {};
    if (s.tcp) handles.push(await bridge.listenTcp(p));
    else if (s.serial) handles.push(bridge.watchSerial(p));
    else if (s.folder) handles.push(bridge.watchFolder(p));
    else throw new Error('printer ' + p.name + ' has no source (tcp, serial or folder)');
  }
  const retry = bridge.cfg.dryRun ? null : setInterval(() => { bridge.retryOutbox().catch(() => {}); }, bridge.cfg.retryEveryMs);
  if (!bridge.cfg.dryRun && bridge.outbox.length) bridge.retryOutbox().catch(() => {});
  return {
    bridge, handles,
    async close() { clearInterval(retry); for (const h of handles) await new Promise((r) => (h.close.length ? h.close(r) : (h.close(), r()))); await bridge.idle(); },
  };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--push') o.push = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}
async function main() {
  const o = args(process.argv.slice(2));
  if (o.help || !o.config) {
    console.log('usage: node tools/pos-printer/listen.js --config <config.json> [--dry-run]\n' +
      '       node tools/pos-printer/listen.js --config <config.json> --replay <capture.bin> [--printer <name>] [--push]\n' +
      'See tools/pos-printer/config.example.json and docs/pos-integration.md.');
    process.exit(o.help ? 0 : 2);
  }
  const log = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) };
  if (o.replay) {
    // a replay sends nothing unless --push is given, and then leaves the ledger as it was
    const cfg = loadConfig(o.config, o.push ? {} : { dryRun: true, stateDir: null });
    const bridge = new Bridge(cfg, { log });
    const problems = bridge.check();
    if (problems.length) { console.error(problems.join('\n')); process.exit(2); }
    const outcomes = await bridge.handleBytes(bridge.printer(o.printer), fs.readFileSync(o.replay));
    console.log(JSON.stringify(outcomes, null, 2));
    return;
  }
  const cfg = loadConfig(o.config, o.dryRun ? { dryRun: true } : {});
  let running;
  try { running = await start(cfg, { log }); } catch (e) { console.error(e.message); process.exit(2); }
  const stop = () => { running.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { Bridge, start, loadConfig, resolvePaths, backoff };
