#!/usr/bin/env node
/* Read the morning close's narrative without sending anything (T4).

     node tools/close-preview.js --demo good            yesterday at Mayda (demo), a busy night
     node tools/close-preview.js --demo bad --lang fr   a thin night, in French
     node tools/close-preview.js --demo empty --lang ar
     node tools/close-preview.js --fixture rows.json --date 2026-10-27
     node tools/close-preview.js --demo good --email     the whole email text, narrative on top
     node tools/close-preview.js --demo good --model     also try the optional model rewrite
                                                         (needs CLOSE_NARRATIVE_MODEL_KEY)

   --demo good|bad|empty  five weeks of fictional activity at Mayda (tools/lib/close-demo.js)
   --fixture FILE         a JSON file {venue, kv_rows, kv_docs, webhook_endpoints?,
                          webhook_deliveries?} in the shape of the Supabase tables
   --date YYYY-MM-DD      the business day (default: yesterday's, the one the 04:00 close sends)
   --lang en|fr|ar, --currency USD|LBP   override the venue's own settings
   --json                 print the narrative object (rules and sentences) instead of the text
   Nothing is sent and no database is read. Node 18+, no dependencies. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { demoRows, venueData } = require('./lib/close-demo.js');

const ROOT = path.join(__dirname, '..');
const esm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

function args(argv) {
  const o = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--email', '--model', '--json', '--help', '-h'].includes(a)) o.flags.add(a.replace(/^-+/, ''));
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else throw new Error('Unknown argument ' + a);
  }
  return o;
}

async function preview(o) {
  const H = await esm('supabase/functions/daily-close/handler.js');
  const N = await esm('supabase/functions/_shared/close-narrative.js');
  const day = o.date || H.lastCompletedDay(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('--date must be YYYY-MM-DD');
  let set;
  if (o.fixture) set = JSON.parse(fs.readFileSync(path.resolve(o.fixture), 'utf8'));
  else if (o.demo) {
    if (!['good', 'bad', 'empty'].includes(o.demo)) throw new Error('--demo is good, bad or empty');
    set = demoRows({ day, scenario: o.demo, windowFor: H.windowFor, addDays: H.addDays });
  } else throw new Error('Give --demo good|bad|empty or --fixture FILE (see the top of this file).');
  const venue = Object.assign({}, set.venue, o.lang ? { lang: o.lang } : {}, o.currency ? { currency: o.currency } : {});
  const w = H.windowFor(day);
  const data = venueData(set, w);
  const input = H.narrativeInput({ venue, window: w, data });
  let narrative = N.closeNarrative(input);
  if (o.flags.has('model')) {
    const M = await esm('supabase/functions/_shared/close-narrative-model.js');
    narrative = await M.createNarrator({ env: process.env, log: (m) => process.stderr.write(m + '\n') })(input);
  }
  if (o.flags.has('json')) return JSON.stringify(narrative, null, 2);
  if (o.flags.has('email')) {
    const figures = H.computeClose({ window: w, ...data });
    const mail = H.buildEmail({ venue, figures, csvName: `close-${H.slugOf(venue.slug)}-${day}.csv`, narrative });
    return 'Subject: ' + mail.subject + '\n\n' + mail.text;
  }
  return narrative.text;
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  if (o.flags.has('help') || o.flags.has('h')) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0] + '*/\n'); process.exit(0); }
  preview(o).then((t) => process.stdout.write(t + '\n'), (e) => { process.stderr.write(e.message + '\n'); process.exit(1); });
}

module.exports = { preview };
