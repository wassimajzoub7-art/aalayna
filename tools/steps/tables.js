'use strict';
/* Step 4. One table code per table, and the print sheet.
   in:  inputs.tables (N); the codes already in state
   out: data {codes: {table: token}, issued: [...], kept: [...], adopted: [...], sheet}
        onboarding/<slug>-table-cards.html with one card per table
   Never reissues a live code: a printed card would stop working. A table whose code the
   server still lists as live keeps it (whether this tool or qr.html issued it); only a
   table with no live code gets one, and a table whose earlier code was revoked is named
   in the summary so its card is reprinted. */
const fs = require('fs');
const path = require('path');
const { sheet } = require('../lib/cards');

const MAX_TABLES = 200;   // qr.html's range limit; 9999 is kept for the smoke test

/* [1,2,3,5,7,8] -> "1-3, 5, 7-8" */
function ranges(list) {
  const out = [];
  list.slice().sort(function (a, b) { return a - b; }).forEach(function (n) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  });
  return out.map(function (r) { return r[0] === r[1] ? String(r[0]) : r[0] + '-' + r[1]; }).join(', ');
}

module.exports = {
  name: 'tables',
  ranges,
  description: 'Issue a code for tables 1 to N (never reissue), write the printable card sheet',
  MAX_TABLES,
  env: [],
  plan: function (ctx) {
    return 'aal_table_tokens list; issue a code for each of tables 1 to ' + ctx.inputs.tables + ' that has no live code; write ' +
      path.relative(ctx.cwd, ctx.paths.cards);
  },
  run: async function (ctx) {
    const n = ctx.inputs.tables;
    const cred = { key: ctx.ownerKey };
    const had = (ctx.state.steps.tables && ctx.state.steps.tables.data && ctx.state.steps.tables.data.codes) || {};
    let res = await ctx.sb.rpc('aal_table_tokens', { p_rid: ctx.rid, p_body: { op: 'list' } }, cred);
    const live = {};
    (res.tokens || []).forEach(function (t) { live[t.table] = t.token; });
    const codes = {}, issued = [], kept = [], adopted = [], replaced = [];
    for (let t = 1; t <= n; t++) {
      if (live[t]) {
        codes[t] = live[t];
        if (had[t] === live[t]) kept.push(t);
        else adopted.push(t);   // issued elsewhere (qr.html) or changed since: the live one is what works
        continue;
      }
      res = await ctx.sb.rpc('aal_table_tokens', { p_rid: ctx.rid, p_body: { op: 'issue', table: t } }, cred);
      const got = (res.tokens || []).filter(function (x) { return x.table === t; })[0];
      if (!got || !/^tbl_/.test(got.token)) return { ok: false, summary: 'The server did not return a code for table ' + t + '.', data: { codes } };
      codes[t] = got.token;
      issued.push(t);
      if (had[t]) replaced.push(t);
      ctx.saveProgress({ codes });   // a failure later in the loop keeps what was issued
    }
    const slug = res.slug || ctx.inputs.slug;
    if (slug !== ctx.inputs.slug) return { ok: false, summary: 'The server says this venue\'s slug is ' + slug + ', not ' + ctx.inputs.slug + '.' };
    const extra = Object.keys(live).map(Number).filter(function (t) { return t > n && t !== 9999; });
    const html = sheet({ slug, name: ctx.inputs.name, place: ctx.inputs.place },
      Object.keys(codes).map(function (t) { return { table: Number(t), token: codes[t] }; }));
    fs.mkdirSync(path.dirname(ctx.paths.cards), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ctx.paths.cards, html, { mode: 0o600 });
    const parts = [];
    if (issued.length) parts.push('issued ' + issued.length);
    if (kept.length) parts.push('kept ' + kept.length);
    if (adopted.length) parts.push('kept ' + adopted.length + ' live code(s) not in the state file (tables ' + ranges(adopted) + ')');
    const lines = [];
    if (replaced.length) lines.push('tables ' + ranges(replaced) + ': the earlier code had been revoked, a new one was issued. Reprint those cards.');
    if (extra.length) lines.push('tables ' + ranges(extra) + ' also have live codes (beyond --tables ' + n + '); left as they are.');
    return {
      ok: true,
      summary: n + ' table codes (' + parts.join(', ') + '); cards in ' + path.relative(ctx.cwd, ctx.paths.cards),
      data: { codes, issued, kept, adopted, replaced, sheet: path.relative(ctx.cwd, ctx.paths.cards) },
      lines
    };
  }
};
