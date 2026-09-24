'use strict';
/* Step 3. The menu, with the one human checkpoint of the pipeline.
   in:  inputs.files, name, slug, currency; --approve-menu; --reimport
   out: without --approve-menu: venues/<slug>.json written by importMenu (tools/import-menu.js),
        its report printed, and a pause (the step stays pending).
        with --approve-menu: venues/<slug>.json (as the founder left it) folded into the draft
        and published to aal.draft and aal.live (kv_docs, owner key), then read back with
        aal_snapshot; data {version, items, sections}.
   An existing venues/<slug>.json is never overwritten unless --reimport is given, so the
   founder's edits survive a re-run. A pack extracted in this same run is never published
   in this same run: a person reads it first. */
const fs = require('fs');
const path = require('path');
const { publishPack, checkPack, visibleCount } = require('../lib/draft');

function packPath(ctx) { return path.join(ctx.cwd, 'venues', ctx.inputs.slug + '.json'); }
function rel(ctx, p) { return path.relative(ctx.cwd, p) || p; }
function fixture(ctx) {
  const f = ctx.opts.fixtureDir && path.join(ctx.opts.fixtureDir, 'import-menu.json');
  return f && fs.existsSync(f) ? f : null;
}
function mustExtract(ctx) { return ctx.opts.reimport || !fs.existsSync(packPath(ctx)); }

function importer(ctx) {
  if (ctx.importMenu) return ctx.importMenu;
  let mod;
  try { mod = require('../import-menu.js'); } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && /import-menu/.test(e.message)) throw new Error('tools/import-menu.js is not there yet, so the menu cannot be extracted. Write venues/' + ctx.inputs.slug + '.json by hand or add the importer.');
    throw e;
  }
  return mod;
}

function reportText(report) {
  if (report == null) return [];
  if (typeof report === 'string') return report.split('\n');
  if (Array.isArray(report)) return report.map(String);
  if (typeof report.text === 'string') return report.text.split('\n');
  return JSON.stringify(report, null, 2).split('\n');
}

async function readDocs(ctx) {
  const snap = await ctx.sb.rpc('aal_snapshot', { p_rid: ctx.rid }, { key: ctx.ownerKey });
  const docs = {};
  ((snap && snap.docs) || []).forEach(function (d) { docs[d.key] = d.body; });
  return { snap, docs };
}

module.exports = {
  name: 'menu',
  description: 'Extract the menu (importMenu), stop for review, then publish it with --approve-menu',
  env: function (ctx) { return mustExtract(ctx) && !fixture(ctx) ? ['ANTHROPIC_API_KEY'] : []; },
  plan: function (ctx) {
    const steps = [];
    if (mustExtract(ctx)) steps.push('importMenu(' + ctx.inputs.files.length + ' file(s)) writes ' + rel(ctx, packPath(ctx)) + ' and prints its report, then stop for review');
    else steps.push(rel(ctx, packPath(ctx)) + ' exists: no extraction');
    steps.push(ctx.opts.approveMenu && !mustExtract(ctx)
      ? 'publish it to aal.draft and aal.live (kv_docs, owner key), read back aal_snapshot'
      : 'publish only when run again with --approve-menu');
    return steps.join('; ');
  },
  run: async function (ctx) {
    const file = packPath(ctx);
    let extracted = false, lines = [];
    if (mustExtract(ctx)) {
      const mod = importer(ctx);
      const fx = fixture(ctx);
      if (!ctx.inputs.files.length && !fx) return { ok: false, summary: 'No menu file was given. Pass the menu PDF or photos after the flags.' };
      const res = await mod.importMenu({
        files: ctx.inputs.files.map(function (f) { return path.resolve(ctx.cwd, f); }), name: ctx.inputs.name, slug: ctx.inputs.slug,
        currency: ctx.inputs.currency, model: ctx.inputs.model, apiKey: ctx.env.ANTHROPIC_API_KEY, fixture: fx,
        dryRun: false, force: !!ctx.opts.reimport, cwd: ctx.cwd, log: ctx.log,
        strict: ctx.opts.strict, effort: ctx.opts.effort || undefined
      });
      if (res && res.path && path.resolve(ctx.cwd, res.path) !== file) {
        return { ok: false, summary: 'importMenu wrote ' + res.path + ', expected ' + rel(ctx, file) + '.' };
      }
      if (!fs.existsSync(file)) {
        if (!res || !res.pack) return { ok: false, summary: 'importMenu returned no menu pack.' };
        fs.writeFileSync(file, JSON.stringify(res.pack, null, 1) + '\n');
      }
      extracted = true;
      lines = reportText(res && res.report);
    }
    if (!ctx.opts.approveMenu || extracted) {
      const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        ok: true, pause: true,
        summary: (extracted ? 'extracted ' : 'found ') + ((pack.items || []).length) + ' items in ' + ((pack.sections || []).length) + ' sections. Review ' +
          rel(ctx, file) + ', then run again with --approve-menu',
        data: { extracted: true, path: rel(ctx, file), extracted_at: extracted ? new Date().toISOString() : undefined },
        lines
      };
    }

    // --approve-menu: publish what is in the file now
    let pack;
    try { pack = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, summary: rel(ctx, file) + ' is not valid JSON: ' + e.message }; }
    const errs = checkPack(pack);
    const mod = ctx.importMenu || (function () { try { return require('../import-menu.js'); } catch (e) { return null; } })();
    if (mod && typeof mod.validatePack === 'function') {
      try {
        const v = mod.validatePack(pack);
        const more = Array.isArray(v) ? v : v && Array.isArray(v.errors) ? v.errors : v && v.ok === false ? [v.error || 'invalid pack'] : [];
        more.forEach(function (m) { errs.push(typeof m === 'string' ? m : JSON.stringify(m)); });
      } catch (e) { errs.push(e.message); }
    }
    if (errs.length) return { ok: false, summary: rel(ctx, file) + ' cannot be published: ' + errs.join('; ') + '.' };

    const before = await readDocs(ctx);
    const out = publishPack(pack, before.docs['aal.draft'] || null, before.docs['aal.live'] || null);
    await ctx.sb.upsertDocs([
      { restaurant_id: ctx.rid, key: 'aal.draft', body: out.draft },
      { restaurant_id: ctx.rid, key: 'aal.live', body: out.live }
    ], { key: ctx.ownerKey });
    const after = await readDocs(ctx);
    const live = after.docs['aal.live'];
    const want = visibleCount({ items: pack.items });
    if (!live) return { ok: false, summary: 'Published, but aal_snapshot shows no live menu.' };
    if (live.version !== out.live.version) return { ok: false, summary: 'Published version ' + out.live.version + ', but the server shows version ' + live.version + '.' };
    if (visibleCount(live) !== want) return { ok: false, summary: 'The live menu shows ' + visibleCount(live) + ' items, the pack has ' + want + '.' };
    const archived = (live.items || []).length - visibleCount(live);
    return {
      ok: true,
      summary: 'published version ' + live.version + ': ' + want + ' items in ' + (live.sections || []).length + ' sections, read back from the server' +
        (archived ? ' (' + archived + ' earlier item(s) kept as archived)' : ''),
      data: { version: live.version, items: want, sections: (live.sections || []).length, path: rel(ctx, file), published_at: live.at }
    };
  }
};
