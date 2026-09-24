#!/usr/bin/env node
/* Menu importer: a restaurant's menu (one or more PDFs, or photos) becomes a menu
   pack in venues/<slug>.json, the format of venues/kababji.json, which admin.html
   offers under "Menu pack" and aalayna-store.js loads with ?menu=<slug>.

     node tools/import-menu.js --name "Kababji" --slug kababji --currency USD menu.pdf
     node tools/import-menu.js --name "Em Sherif" --slug em-sherif --currency LBP p1.jpg p2.jpg

   The model only transcribes (Anthropic Messages API, one forced tool call per
   batch). Ids, windows, allergen filtering, currency conversion, option price
   arithmetic and every check run here, in code, so they are the same on every run.
   Node 18+, no dependencies. ANTHROPIC_API_KEY is read from the environment and is
   never written or printed; neither are the base64 file payloads.

   As a module (tools/onboard.js):
     const { importMenu, validatePack, buildPack } = require('./import-menu.js');
     const { pack, report, path } = await importMenu({ files, name, slug, currency,
       model, apiKey, fixture, dryRun, force, cwd });
   Optional: rate, effort, strict, saveResponse, log.
   importMenu throws on a schema failure (err.code 'SCHEMA'), a refused overwrite
   ('EXISTS'), bad arguments ('USAGE') and API failures ('API'). */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5-5';
const TOOL_NAME = 'record_menu';
const MAX_TOKENS = 64000;            // streamed, so no HTTP timeout; fits every current model's output cap
const MAX_IMAGES_PER_REQUEST = 20;   // above 20 images the API shrinks the per-image size limit
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;       // API limit per image
const MAX_BATCH_BASE64 = 28 * 1024 * 1024;     // stays under the 32 MB request limit with room for JSON
const DEFAULT_LBP_RATE = 89500;      // the default of Aalayna.rate() in aalayna-store.js
/* Same list as ALLERGENS in aalayna-store.js; tests/import-menu.test.cjs fails if they drift. */
const ALLERGENS = ['nuts', 'dairy', 'gluten', 'sesame', 'egg', 'shellfish', 'soy'];
const MEDIA = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;   // admin.html slug rule; the store keeps [a-z0-9-] only
const WINDOWS = ['all_day', 'breakfast_only', 'not_stated'];
const PRICES_ARE = ['full_dish_price', 'amount_added', 'no_price_change'];
const CURRENCY_SEEN = ['USD', 'LBP', 'both', 'none'];

class ImportError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details || []; }
}

/* ---------- the tool the model must call ---------------------------------------
   Every object closed and every field required (nullable where the menu may print
   nothing), so the schema is ready for strict tool use. strict itself is opt-in
   (--strict): a model that does not accept it would refuse the whole request. */
function nullable(type) { return { anyOf: [{ type: type }, { type: 'null' }] }; }
function closed(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties: properties };
}
function toolDefinition(strict) {
  const text = { type: 'string' };
  const nameDesc = closed({ name: text, description: text });
  const tool = {
    name: TOOL_NAME,
    description: 'Record every section and item printed on the menu pages shown. Call it exactly once per request.',
    input_schema: closed({
      currency_seen: { type: 'string', enum: CURRENCY_SEEN, description: 'The currency the printed prices use.' },
      sections: {
        type: 'array',
        description: 'Section headings in menu order.',
        items: closed({
          name: { type: 'string', description: 'The heading as printed.' },
          window: { type: 'string', enum: WINDOWS,
            description: 'breakfast_only only when the menu shows the section is served only at breakfast; all_day when it says all day; otherwise not_stated.' }
        })
      },
      items: {
        type: 'array',
        items: closed({
          section: { type: 'string', description: 'Exactly one of the section names listed in sections.' },
          name: text,
          description: { type: 'string', description: 'As printed, or an empty string.' },
          price: Object.assign(nullable('number'), { description: 'The printed number, no symbols or separators. null for market price or no price.' }),
          ingredients: { type: 'array', items: text, description: 'Only ingredients printed in the name or description.' },
          allergens: { type: 'array', items: { type: 'string', enum: ALLERGENS },
            description: 'Only allergens the printed ingredients make certain.' },
          translations: closed({ fr: nameDesc, ar: nameDesc }),
          options: {
            type: 'array',
            description: 'Only choices the menu prints for this dish.',
            items: closed({
              name: text,
              type: { type: 'string', enum: ['one', 'many'] },
              prices_are: { type: 'string', enum: PRICES_ARE },
              choices: { type: 'array', items: closed({ name: text, price: nullable('number') }) }
            })
          }
        })
      }
    })
  };
  if (strict) tool.strict = true;
  return tool;
}

const SYSTEM_PROMPT = [
  'You transcribe restaurant menus into structured data for a QR menu app. You see pages or photos of one restaurant\'s menu and record every dish and drink printed on them with the record_menu tool, called exactly once.',
  '',
  'Transcribe only what is printed. Never invent, complete or guess prices, ingredients, descriptions, translations, allergens, sections or option choices. When something is not printed, leave it empty as the fields below say.',
  '',
  '- sections: each heading as printed (the English heading when the menu has one), in menu order. Every item\'s section is one of these names, spelled identically.',
  '- name and description: as printed, in the menu\'s main language (English when printed). description is "" when nothing is printed.',
  '- price: the printed number in the currency you are told to use, without symbols or thousands separators (450000 for "450,000 LL"). Copy the number exactly as printed, even when the menu prints LBP in thousands. null when the menu says market price or seasonal, or prints no price.',
  '- ingredients: only ingredients printed in the name or description, one per entry, as a common singular noun ("tomato", "olive oil"). [] when none are printed.',
  '- allergens: only when the printed ingredients make them certain: tahini or sesame means sesame; milk, yogurt, labneh, cheese, cream or butter means dairy; bread, dough, flour, cracked wheat, semolina or pastry means gluten; walnut, almond, pistachio, cashew, hazelnut or pine nut means nuts; egg means egg. Never infer allergens from the dish name alone or from typical recipes. [] otherwise.',
  '- translations: copy the French and Arabic name and description only when the menu prints them for that dish. "" for anything not printed. Never translate yourself.',
  '- options: only when the menu prints choices for the dish (portion sizes, sandwich or platter, sides, add-ons). type "one" when the guest picks exactly one, "many" for independent add-ons. prices_are "full_dish_price" when the menu prints the full price of each choice (then list first the choice whose price is the dish price), "amount_added" when it prints a surcharge such as "+1" or "add almonds 1", "no_price_change" when the choices cost the same. A choice\'s price is null when none is printed for it. [] when the menu prints no choices.',
  '- window: breakfast_only only when the section is clearly served only at breakfast (a Breakfast heading without all-day wording, or printed breakfast hours); all_day when the menu says all day; otherwise not_stated.',
  '- currency_seen: the currency the printed prices use.'
].join('\n');

/* ---------- arguments --------------------------------------------------------- */
const USAGE = [
  'Usage: node tools/import-menu.js --name "Venue" --slug venue --currency USD|LBP [options] <menu.pdf | photo.jpg ...>',
  '',
  '  --name <text>        venue name written into the pack and venues/index.json',
  '  --slug <slug>        file name: venues/<slug>.json (lower-case letters, digits, hyphens)',
  '  --currency USD|LBP   the currency the menu prints; LBP prices are converted to USD',
  '  --rate <n>           LBP per USD for the conversion (default 89500, the app default)',
  '  --model <id>         default ' + DEFAULT_MODEL,
  '  --effort <level>     low, medium, high, xhigh or max; not sent unless given',
  '  --strict             send the tool with strict: true (schema-checked arguments)',
  '  --force              overwrite an existing venues/<slug>.json',
  '  --dry-run            print the report, write nothing',
  '  --fixture <file>     replay a saved API response instead of calling the API',
  '  --save-response <f>  save the API responses to a file, to replay later with --fixture',
  '',
  'Needs ANTHROPIC_API_KEY in the environment unless --fixture is given.'
].join('\n');

function parseArgs(argv) {
  const o = { files: [] };
  const takes = { '--name': 'name', '--slug': 'slug', '--currency': 'currency', '--rate': 'rate', '--model': 'model',
    '--effort': 'effort', '--fixture': 'fixture', '--save-response': 'saveResponse' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--force') { o.force = true; continue; }
    if (a === '--strict') { o.strict = true; continue; }
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (takes[a]) {
      if (i + 1 >= argv.length) throw new ImportError('USAGE', a + ' needs a value.');
      o[takes[a]] = argv[++i];
      continue;
    }
    if (a.startsWith('--')) throw new ImportError('USAGE', 'Unknown option ' + a + '.');
    o.files.push(a);
  }
  if (o.rate != null) o.rate = Number(o.rate);
  return o;
}

function checkOptions(o) {
  const name = String(o.name || '').trim();
  if (!name) throw new ImportError('USAGE', '--name is required.');
  if (name.length > 40) throw new ImportError('USAGE', '--name is longer than 40 characters.');
  const slug = String(o.slug || '');
  if (!slug || slug.length > 40 || !SLUG_RE.test(slug)) throw new ImportError('USAGE', '--slug must be lower-case letters, digits and hyphens, up to 40 characters, not starting or ending with a hyphen.');
  if (slug === 'index') throw new ImportError('USAGE', '--slug index is reserved for venues/index.json.');
  const currency = String(o.currency || '').toUpperCase();
  if (currency !== 'USD' && currency !== 'LBP') throw new ImportError('USAGE', '--currency must be USD or LBP.');
  let rate = null;
  if (currency === 'LBP') {
    rate = o.rate == null ? DEFAULT_LBP_RATE : Math.round(Number(o.rate));
    /* same bounds as Aalayna.setRate */
    if (!(rate >= 1000 && rate <= 10000000)) throw new ImportError('USAGE', '--rate must be between 1000 and 10000000 LBP per USD.');
  } else if (o.rate != null) {
    throw new ImportError('USAGE', '--rate only applies with --currency LBP.');
  }
  const effort = o.effort == null ? 'default' : String(o.effort);
  if (['low', 'medium', 'high', 'xhigh', 'max', 'default'].indexOf(effort) < 0) throw new ImportError('USAGE', '--effort must be low, medium, high, xhigh, max or default.');
  if (!o.fixture && !(o.files && o.files.length)) throw new ImportError('USAGE', 'Give at least one menu file (PDF, JPEG, PNG or WebP).');
  return { name: name, slug: slug, currency: currency, rate: rate, effort: effort, strict: !!o.strict, model: o.model || DEFAULT_MODEL };
}

/* ---------- files and batches -----------------------------------------------------
   Each PDF is a request of its own (a document block). Photos go in order, at most
   20 per request and under the request size limit; the batches are merged later. */
function planBatches(files, cwd) {
  const batches = [];
  let photos = null;
  files.forEach(function (f) {
    const abs = path.resolve(cwd || process.cwd(), f);
    const ext = path.extname(abs).toLowerCase();
    const media = MEDIA[ext];
    if (!media) throw new ImportError('USAGE', f + ': only PDF, JPEG, PNG and WebP files are supported.');
    let size;
    try { size = fs.statSync(abs).size; } catch (e) { throw new ImportError('USAGE', f + ': file not found.'); }
    const b64 = Math.ceil(size / 3) * 4;
    if (media === 'application/pdf') {
      if (b64 > MAX_BATCH_BASE64) throw new ImportError('USAGE', f + ': the PDF is too large for one request (about 20 MB at most). Export it with smaller images or send page photos instead.');
      batches.push({ label: path.basename(abs), files: [{ path: abs, media: media, name: path.basename(abs) }], bytes: b64 });
      photos = null;
      return;
    }
    if (size > MAX_IMAGE_BYTES) throw new ImportError('USAGE', f + ': images must be 5 MB or smaller. Resize the photo and run again.');
    if (!photos || photos.files.length >= MAX_IMAGES_PER_REQUEST || photos.bytes + b64 > MAX_BATCH_BASE64) {
      photos = { files: [], bytes: 0 };
      batches.push(photos);
    }
    photos.files.push({ path: abs, media: media, name: path.basename(abs) });
    photos.bytes += b64;
  });
  let n = 0;
  const total = batches.reduce(function (s, b) { return s + (b.label ? 0 : b.files.length); }, 0);
  batches.forEach(function (b) {
    if (b.label) return;
    b.label = 'photos ' + (n + 1) + ' to ' + (n + b.files.length) + ' of ' + total;
    n += b.files.length;
  });
  return batches;
}

function contentBlocks(batch) {
  return batch.files.map(function (f) {
    const data = fs.readFileSync(f.path).toString('base64');
    return { type: f.media === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: f.media, data: data } };
  });
}

function batchPrompt(ctx, batch, earlierSections) {
  const lines = [
    'Menu of ' + ctx.name + '. ' + (batch.files[0].media === 'application/pdf'
      ? 'The attached PDF (' + batch.label + ') is the menu.'
      : 'The attached images are ' + batch.label + ' of the menu, in order.'),
    'Transcribe prices in ' + ctx.currency + (ctx.currency === 'LBP' ? ' (Lebanese pounds).' : ' (US dollars).') +
      ' If the menu prints both currencies, use the ' + ctx.currency + ' prices.'
  ];
  if (earlierSections.length) {
    lines.push('Sections found on earlier pages, in order: ' + earlierSections.join('; ') +
      '. If the first dishes here continue one of them without a new heading, use that exact section name.');
  }
  lines.push('Use the record_menu tool once, with every section and item on these pages.');
  return lines.join('\n');
}

/* ---------- the API ------------------------------------------------------------- */
const deps = { fetch: function () { return globalThis.fetch.apply(globalThis, arguments); }, sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); } };

/* Rebuilds the message a non-streaming call would return, from the SSE stream.
   Streaming keeps a long transcription clear of HTTP timeouts. */
async function readStream(body) {
  const decoder = new TextDecoder();
  let buf = '', msg = null;
  const json = {};
  function handle(ev) {
    if (ev.type === 'message_start') { msg = ev.message; msg.content = []; msg.usage = msg.usage || {}; return; }
    if (ev.type === 'error') {
      const e = ev.error || {};
      throw new ImportError('API', 'The API stopped the stream: ' + (e.type || 'error') + (e.message ? ': ' + e.message : ''), [{ retry: /overloaded|api_error|rate_limit/.test(e.type || '') }]);
    }
    if (!msg) return;
    if (ev.type === 'content_block_start') {
      msg.content[ev.index] = ev.content_block;
      if (ev.content_block.type === 'tool_use') json[ev.index] = '';
    } else if (ev.type === 'content_block_delta') {
      const b = msg.content[ev.index], d = ev.delta || {};
      if (!b) return;
      if (d.type === 'input_json_delta') json[ev.index] += d.partial_json || '';
      else if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
    } else if (ev.type === 'content_block_stop') {
      if (Object.prototype.hasOwnProperty.call(json, ev.index)) {
        const raw = json[ev.index];
        try { msg.content[ev.index].input = raw ? JSON.parse(raw) : {}; }
        catch (e) { msg.content[ev.index].input = null; msg.content[ev.index].invalidJson = true; }
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta) Object.keys(ev.delta).forEach(function (k) { msg[k] = ev.delta[k]; });
      if (ev.usage) Object.keys(ev.usage).forEach(function (k) { if (ev.usage[k] != null) msg.usage[k] = ev.usage[k]; });
    }
  }
  function drain(final) {
    buf = buf.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0 || (final && buf.trim())) {
      const raw = i >= 0 ? buf.slice(0, i) : buf;
      buf = i >= 0 ? buf.slice(i + 2) : '';
      const data = raw.split('\n').filter(function (l) { return l.indexOf('data:') === 0; })
        .map(function (l) { return l.slice(5).replace(/^ /, ''); }).join('\n');
      if (data) handle(JSON.parse(data));
      if (i < 0) break;
    }
  }
  for await (const chunk of body) { buf += decoder.decode(chunk, { stream: true }); drain(false); }
  buf += decoder.decode();
  drain(true);
  if (!msg) throw new ImportError('API', 'The API stream ended before any message.', [{ retry: true }]);
  return msg;
}

async function postMessages(body, apiKey) {
  let res;
  try {
    res = await deps.fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new ImportError('API', 'Could not reach the Anthropic API (' + (e && e.message || 'network error') + ').', [{ retry: true }]);
  }
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch (e) {}
    let err = {};
    try { err = JSON.parse(text).error || {}; } catch (e) {}
    const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0;
    throw new ImportError('API', 'The API answered ' + res.status + (err.type ? ' ' + err.type : '') + (err.message ? ': ' + err.message : '.'),
      [{ status: res.status, message: err.message || '', retry: res.status === 429 || res.status >= 500, retryAfter: retryAfter }]);
  }
  return readStream(res.body);
}

/* One batch: retries overload and network failures. A 400 that names a field this
   request sent is taken as the model's answer about that field: tool_choice falls
   back to auto plus an instruction (and one more ask if no call comes back), strict
   and output_config are dropped. Each fallback is logged and sticks for later batches. */
async function requestBatch(ctx, batch, earlierSections) {
  const blocks = contentBlocks(batch);
  const prompt = batchPrompt(ctx, batch, earlierSections);
  let noCallRetries = 1;
  for (let attempt = 1; ; attempt++) {
    const body = {
      model: ctx.model,
      max_tokens: MAX_TOKENS,
      stream: true,
      system: SYSTEM_PROMPT,
      tools: [toolDefinition(ctx.strict)],
      tool_choice: ctx.forced ? { type: 'tool', name: TOOL_NAME } : { type: 'auto' },
      messages: [{ role: 'user', content: blocks.concat([{ type: 'text', text: prompt + (ctx.forced ? '' : '\nAnswer only by calling the record_menu tool.') }]) }]
    };
    if (ctx.effort !== 'default') body.output_config = { effort: ctx.effort };
    try {
      const msg = await postMessages(body, ctx.apiKey);
      const call = (msg.content || []).some(function (b) { return b && b.type === 'tool_use' && b.name === TOOL_NAME; });
      if (!call && !ctx.forced && msg.stop_reason === 'end_turn' && noCallRetries-- > 0) {
        ctx.log('  no tool call in the answer, asking again');
        continue;
      }
      return msg;
    } catch (e) {
      const d = (e.details && e.details[0]) || {};
      const bad = d.status === 400 ? d.message || '' : '';
      if (ctx.forced && /tool_choice/i.test(bad)) {
        ctx.forced = false;
        ctx.log('  ' + ctx.model + ' refuses a forced tool_choice; using auto with an instruction');
        continue;
      }
      if (ctx.strict && /strict/i.test(bad)) {
        ctx.strict = false;
        ctx.log('  ' + ctx.model + ' refuses strict tool use; sending the tool without strict');
        continue;
      }
      if (ctx.effort !== 'default' && /output_config|effort/i.test(bad)) {
        ctx.effort = 'default';
        ctx.log('  ' + ctx.model + ' refuses output_config; sending no effort');
        continue;
      }
      if (d.retry && attempt < 4) {
        const wait = d.retryAfter ? d.retryAfter * 1000 : 5000 * Math.pow(2, attempt - 1);
        ctx.log('  ' + e.message + ' Retrying in ' + Math.round(wait / 1000) + 's.');
        await deps.sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

/* ---------- reading and checking the model's answer ------------------------------ */
function toolInput(msg, where) {
  if (!msg || typeof msg !== 'object') throw new ImportError('SCHEMA', where + ': not an API message.');
  if (msg.stop_reason === 'refusal') throw new ImportError('SCHEMA', where + ': the model declined the request (stop_reason refusal).');
  const call = (msg.content || []).filter(function (b) { return b && b.type === 'tool_use' && b.name === TOOL_NAME; })[0];
  if (msg.stop_reason === 'max_tokens') throw new ImportError('SCHEMA', where + ': the answer was cut off at max_tokens. Send fewer pages per run (split the PDF or the photos).');
  if (!call) throw new ImportError('SCHEMA', where + ': the model did not call ' + TOOL_NAME + ' (stop_reason ' + msg.stop_reason + ').');
  if (call.invalidJson || !call.input || typeof call.input !== 'object') throw new ImportError('SCHEMA', where + ': the tool input is not valid JSON.');
  return call.input;
}

/* Checks the tool input against the tool schema, field by field. Allergens are only
   checked as strings: names outside the vocabulary are dropped later, and reported. */
function answerProblems(a, where) {
  const out = [];
  const isObj = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
  const str = function (v, p) { if (typeof v !== 'string') out.push(p + ' is not a string'); };
  const num = function (v, p) { if (v !== null && !(typeof v === 'number' && isFinite(v))) out.push(p + ' is not a number or null'); };
  const arr = function (v, p) { if (!Array.isArray(v)) { out.push(p + ' is not an array'); return []; } return v; };
  const oneOf = function (v, list, p) { if (list.indexOf(v) < 0) out.push(p + ' is not one of ' + list.join(', ')); };
  if (!isObj(a)) return [where + ': the answer is not an object'];
  oneOf(a.currency_seen, CURRENCY_SEEN, where + '.currency_seen');
  arr(a.sections, where + '.sections').forEach(function (s, i) {
    const p = where + '.sections[' + i + ']';
    if (!isObj(s)) { out.push(p + ' is not an object'); return; }
    if (typeof s.name !== 'string' || !s.name.trim()) out.push(p + '.name is empty');
    oneOf(s.window, WINDOWS, p + '.window');
  });
  arr(a.items, where + '.items').forEach(function (x, i) {
    const p = where + '.items[' + i + ']';
    if (!isObj(x)) { out.push(p + ' is not an object'); return; }
    if (typeof x.name !== 'string' || !x.name.trim()) out.push(p + '.name is empty');
    if (typeof x.section !== 'string' || !x.section.trim()) out.push(p + '.section is empty');
    str(x.description, p + '.description');
    num(x.price, p + '.price');
    arr(x.ingredients, p + '.ingredients').forEach(function (v, j) { str(v, p + '.ingredients[' + j + ']'); });
    arr(x.allergens, p + '.allergens').forEach(function (v, j) { str(v, p + '.allergens[' + j + ']'); });
    if (!isObj(x.translations)) out.push(p + '.translations is not an object');
    else ['fr', 'ar'].forEach(function (l) {
      const t = x.translations[l];
      if (!isObj(t)) { out.push(p + '.translations.' + l + ' is not an object'); return; }
      str(t.name, p + '.translations.' + l + '.name');
      str(t.description, p + '.translations.' + l + '.description');
    });
    arr(x.options, p + '.options').forEach(function (g, j) {
      const q = p + '.options[' + j + ']';
      if (!isObj(g)) { out.push(q + ' is not an object'); return; }
      str(g.name, q + '.name');
      oneOf(g.type, ['one', 'many'], q + '.type');
      oneOf(g.prices_are, PRICES_ARE, q + '.prices_are');
      arr(g.choices, q + '.choices').forEach(function (c, k) {
        if (!isObj(c)) { out.push(q + '.choices[' + k + '] is not an object'); return; }
        str(c.name, q + '.choices[' + k + '].name');
        num(c.price, q + '.choices[' + k + '].price');
      });
    });
  });
  return out;
}

/* ---------- post-processing ------------------------------------------------------ */
function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function key(s) { return clean(s).toLowerCase(); }
function ascii(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function round2(n) { return Math.round(n * 100) / 100; }

/* Three lower-case letters, unique: the first three letters of the name, then the
   first letter with two later ones, then the first free id. Arabic-only names have
   no Latin letters and take the first free id. */
function sectionIds(names) {
  const used = {};
  return names.map(function (name) {
    const l = ascii(name).replace(/[^a-z]/g, '');
    const cands = [];
    if (l.length >= 3) cands.push(l.slice(0, 3));
    for (let i = 1; i < l.length; i++) for (let j = i + 1; j < l.length; j++) cands.push(l[0] + l[i] + l[j]);
    let id = cands.filter(function (c) { return !used[c]; })[0];
    for (let n = 0; !id && n < 17576; n++) {
      const c = String.fromCharCode(97 + Math.floor(n / 676), 97 + Math.floor(n / 26) % 26, 97 + n % 26);
      if (!used[c]) id = c;
    }
    used[id] = 1;
    return id;
  });
}

/* The guest app hides a 'brkf' section outside 7:00 to 11:30, so a wrong breakfast
   window hides dishes for most of the day. Only a clear breakfast section gets it. */
const BREAKFAST_RE = /\bbreakfast\b|petit[- ]?d[eé]jeuner|فطور|ترويقة/i;
const ALL_DAY_RE = /all[- ]?day|any ?time|toute la journ[eé]e|24\/7|طوال اليوم|كل اليوم/i;
function windowFor(name, hint) {
  if (hint === 'all_day' || ALL_DAY_RE.test(name)) return 'all';
  if (hint === 'breakfast_only' || BREAKFAST_RE.test(name)) return 'brkf';
  return 'all';
}

/* Batches are merged by section name (case and spacing ignored), in the order the
   sections first appear; items keep batch order. */
function mergeAnswers(answers) {
  const sections = [], byKey = {}, items = [], seen = [];
  answers.forEach(function (a) {
    if (seen.indexOf(a.currency_seen) < 0) seen.push(a.currency_seen);
    a.sections.forEach(function (s) {
      const k = key(s.name);
      if (!byKey[k]) { byKey[k] = { name: clean(s.name), window: s.window, added: false }; sections.push(byKey[k]); }
      else if (byKey[k].window === 'not_stated') byKey[k].window = s.window;
    });
    a.items.forEach(function (x) {
      const k = key(x.section);
      if (!byKey[k]) { byKey[k] = { name: clean(x.section), window: 'not_stated', added: true }; sections.push(byKey[k]); }
      items.push({ sectionKey: k, x: x });
    });
  });
  return { sections: sections, byKey: byKey, items: items, currencySeen: seen };
}

/* answers: the record_menu inputs, one per batch. Returns the pack and the review
   flags. All arithmetic on prices happens here: LBP is converted to USD at the
   rate, then option prices become differences from the dish price. */
function buildPack(answers, opts) {
  const currency = opts.currency, rate = opts.rate || DEFAULT_LBP_RATE;
  const conv = function (v) { return v == null ? null : (currency === 'LBP' ? round2(v / rate) : round2(v)); };
  const m = mergeAnswers(answers);
  const ids = sectionIds(m.sections.map(function (s) { return s.name; }));
  const flags = { nullPrices: [], duplicateNames: [], emptySections: [], breakfastSections: [], droppedAllergens: [],
    addedSections: [], nonPositivePrices: [], unpricedChoices: [], priceFromChoice: [], currency: [] };
  m.sections.forEach(function (s, i) {
    s.id = ids[i];
    s.win = windowFor(s.name, s.window);
    if (s.win === 'brkf') flags.breakfastSections.push(s.name);
    if (s.added) flags.addedSections.push(s.name);
  });
  const printed = [];
  const items = m.items.map(function (row, i) {
    const x = row.x, id = 'i' + String(i + 1).padStart(2, '0'), name = clean(x.name);
    const sec = m.byKey[row.sectionKey];
    let price = x.price;
    if (price != null) printed.push(price);
    if (price != null && !(price > 0)) { flags.nonPositivePrices.push({ id: id, name: name, price: price }); price = null; }
    price = conv(price);
    const al = [], ing = [];
    (x.ingredients || []).forEach(function (v) { v = key(v); if (v && ing.indexOf(v) < 0) ing.push(v); });
    (x.allergens || []).forEach(function (v) {
      const a = key(v);
      if (ALLERGENS.indexOf(a) < 0) flags.droppedAllergens.push({ id: id, name: name, allergen: clean(v) });
      else if (al.indexOf(a) < 0) al.push(a);
    });
    const t = x.translations || {};
    const tr = {};
    ['fr', 'ar'].forEach(function (l) { tr[l] = { n: clean(t[l] && t[l].name), d: clean(t[l] && t[l].description) }; });
    /* The guest's default is the first choice of every pick-one group, so the first
       full-price group sets the dish price and every choice becomes a difference. */
    const groups = (x.options || []).map(function (g) {
      return { name: clean(g.name) || 'Options', type: g.type === 'one' ? 'one' : 'many', pricesAre: g.prices_are,
        choices: (g.choices || []).filter(function (c) { return clean(c.name); }) };
    }).filter(function (g) { return g.choices.length; });
    const base = groups.filter(function (g) { return g.pricesAre === 'full_dish_price' && g.choices[0].price != null && g.choices[0].price > 0; })[0];
    if (base) {
      const first = conv(base.choices[0].price);
      if (price !== first) flags.priceFromChoice.push({ id: id, name: name, printed: price, used: first });
      price = first;
    }
    const optGroups = groups.map(function (g) {
      return { name: g.name, type: g.type, choices: g.choices.map(function (c) {
        let p = 0;
        if (g.pricesAre === 'no_price_change') p = 0;
        else if (c.price == null) flags.unpricedChoices.push({ id: id, name: name, group: g.name, choice: clean(c.name) });
        else if (g.pricesAre === 'amount_added') p = conv(c.price);
        else if (price != null) p = round2(conv(c.price) - price);
        else flags.unpricedChoices.push({ id: id, name: name, group: g.name, choice: clean(c.name) });
        return { n: clean(c.name), p: p };
      }) };
    });
    if (price == null) flags.nullPrices.push({ id: id, name: name, section: sec.name });
    /* key order matches venues/kababji.json */
    return { id: id, sec: sec.id, name: name, desc: clean(x.description), price: price, ing: ing, al: al,
      kcal: null, pr: null, ft: null, cb: null, tr: tr,
      /* conf 0: allergens read off a printed menu are not the kitchen's confirmation;
         the owner confirms each dish in the editor (the store's rule for conf). */
      conf: 0, opts: optGroups };
  });
  const counts = {};
  items.forEach(function (x) { counts[x.sec] = (counts[x.sec] || 0) + 1; });
  m.sections.forEach(function (s) { if (!counts[s.id]) flags.emptySections.push(s.name); });
  const byName = {};
  items.forEach(function (x) { const k = key(x.name); (byName[k] = byName[k] || []).push(x); });
  Object.keys(byName).forEach(function (k) {
    if (byName[k].length > 1) flags.duplicateNames.push({ name: byName[k][0].name, ids: byName[k].map(function (x) { return x.id; }),
      sections: byName[k].map(function (x) { return x.sec; }) });
  });
  if (m.currencySeen.some(function (c) { return c !== 'none' && c !== 'both' && c !== currency; }))
    flags.currency.push('The model saw ' + m.currencySeen.join(' and ') + ' prices on the menu but the run used --currency ' + currency + '.');
  if (currency === 'USD' && printed.some(function (p) { return p >= 1000; }))
    flags.currency.push('Some printed prices are 1,000 or more, which looks like LBP. Check --currency.');
  if (currency === 'LBP' && printed.some(function (p) { return p > 0 && p < 1000; }))
    flags.currency.push('Some LBP prices are under 1,000: the menu may print prices in thousands. Check the prices.');
  const pack = { name: clean(opts.name), sections: m.sections.map(function (s) { return { id: s.id, name: s.name, win: s.win }; }), items: items };
  return { pack: pack, flags: flags, counts: counts };
}

/* The invariants a pack must meet before it is written. Returns a list of problems. */
function validatePack(pack) {
  const out = [];
  if (!pack || typeof pack !== 'object') return ['the pack is not an object'];
  if (typeof pack.name !== 'string' || !pack.name.trim()) out.push('the pack has no name');
  if (!Array.isArray(pack.sections) || !Array.isArray(pack.items)) return out.concat(['sections and items must be arrays']);
  const secs = {};
  pack.sections.forEach(function (s, i) {
    if (!s || !/^[a-z]{3}$/.test(s.id)) out.push('section ' + i + ' id is not three lower-case letters');
    else if (secs[s.id]) out.push('duplicate section id ' + s.id);
    else secs[s.id] = 1;
    if (!s || typeof s.name !== 'string' || !s.name.trim()) out.push('section ' + i + ' has no name');
    if (!s || ['all', 'brkf', 'lunch', 'dinner'].indexOf(s.win) < 0) out.push('section ' + i + ' window is not a store window');
  });
  const ids = {};
  pack.items.forEach(function (x, i) {
    const p = 'item ' + (x && x.id || i);
    if (!x || typeof x.id !== 'string' || !x.id) { out.push('item ' + i + ' has no id'); return; }
    if (ids[x.id]) out.push('duplicate item id ' + x.id);
    ids[x.id] = 1;
    if (typeof x.name !== 'string' || !x.name.trim()) out.push(p + ' has no name');
    if (!secs[x.sec]) out.push(p + ' has no valid section');
    if (!(x.price === null || (typeof x.price === 'number' && isFinite(x.price) && x.price > 0))) out.push(p + ' price is not a positive number or null');
    if (!Array.isArray(x.ing) || !Array.isArray(x.al) || !Array.isArray(x.opts)) out.push(p + ' ing, al and opts must be arrays');
    else if (x.al.some(function (a) { return ALLERGENS.indexOf(a) < 0; })) out.push(p + ' has an allergen outside the vocabulary');
    if (!x.tr || !x.tr.fr || !x.tr.ar) out.push(p + ' has no tr.fr and tr.ar');
  });
  return out;
}

/* ---------- the review report ---------------------------------------------------- */
function money(v) { return v == null ? 'no price' : '$' + v.toFixed(2); }
function report(ctx, built, usage, models, target) {
  const f = built.flags, p = built.pack, L = [];
  /* the three lists the founder must always see, then the others only when they have rows */
  const list = function (title, rows, fmt, note, always) {
    if (!rows.length && !always) return;
    L.push('  ' + title + ' (' + rows.length + ')' + (rows.length ? ':' : ': none'));
    if (rows.length && note) L.push('    ' + note);
    rows.forEach(function (r) { L.push('    ' + fmt(r)); });
  };
  const secName = {};
  p.sections.forEach(function (s) { secName[s.id] = s.name; });
  L.push('Menu import: ' + p.name + ' (' + ctx.slug + ')');
  L.push('Model: ' + ctx.model + (models.length && models.join() !== ctx.model ? ' (answered as ' + models.join(', ') + ')' : '') +
    (ctx.fixture ? ', replayed from ' + ctx.fixture + ' (no API call)' : ''));
  L.push('Batches: ' + usage.batches + '. Tokens: ' + usage.input_tokens.toLocaleString('en-US') + ' input, ' +
    usage.output_tokens.toLocaleString('en-US') + ' output, ' + usage.cache_read_input_tokens.toLocaleString('en-US') + ' cache read, ' +
    usage.cache_creation_input_tokens.toLocaleString('en-US') + ' cache write.');
  L.push('Currency: ' + ctx.currency + (ctx.currency === 'LBP' ? ', converted to USD at ' + ctx.rate.toLocaleString('en-US') +
    ' LBP per USD. Set the venue rate to the same value so the LL prices guests see match the menu.' : ', written as printed.'));
  L.push('');
  L.push('Sections (' + p.sections.length + ', ' + p.items.length + ' items):');
  p.sections.forEach(function (s) {
    L.push('  ' + s.id + '  ' + (s.name + ' ').padEnd(28, ' ') + String(built.counts[s.id] || 0).padStart(3, ' ') + ' items  ' + (s.win === 'brkf' ? 'breakfast 7:00 to 11:30' : 'all day'));
  });
  L.push('');
  L.push('Check before loading the pack:');
  list('Items with no price', f.nullPrices, function (r) { return r.id + '  ' + r.name + ' (' + r.section + ')'; },
    'The app stores a missing price as 0 and loading a pack publishes it: set these prices in the pack or the editor first.', true);
  list('Names that appear more than once', f.duplicateNames, function (r) {
    return r.name + ': ' + r.ids.map(function (id, i) { return id + ' in ' + secName[r.sections[i]]; }).join(', ');
  }, 'Often the same dish on two overlapping photos: delete the extra one.', true);
  list('Sections with no items', f.emptySections, function (r) { return r; }, null, true);
  list('Sections on the breakfast window', f.breakfastSections, function (r) { return r; },
    'Guests only see these from 7:00 to 11:30. Change win to "all" if they are served all day.');
  list('Sections named by items but not listed as headings', f.addedSections, function (r) { return r; });
  list('Allergens dropped (outside ' + ALLERGENS.join(', ') + ')', f.droppedAllergens, function (r) { return r.id + '  ' + r.name + ': ' + r.allergen; });
  list('Prices that were zero or negative (now no price)', f.nonPositivePrices, function (r) { return r.id + '  ' + r.name + ': ' + r.price; });
  list('Option choices with no printed price (set to +0)', f.unpricedChoices, function (r) { return r.id + '  ' + r.name + ': ' + r.group + ' / ' + r.choice; });
  list('Dish prices taken from the first choice of a pick-one group', f.priceFromChoice, function (r) {
    return r.id + '  ' + r.name + ': ' + money(r.printed) + ' printed, ' + money(r.used) + ' used';
  });
  f.currency.forEach(function (c) { L.push('  Currency: ' + c); });
  L.push('  Every item has conf 0: allergens read from a printed menu stay out of guest filters until the owner confirms each dish in the editor.');
  L.push('');
  L.push(target ? 'Wrote ' + target + ' and updated venues/index.json.' : 'Dry run: nothing written.');
  return L.join('\n');
}

/* ---------- writing ---------------------------------------------------------------- */
function readManifest(file) {
  if (!fs.existsSync(file)) return [];
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { list = null; }
  if (!Array.isArray(list)) throw new ImportError('USAGE', file + ' is not a JSON list. Fix it before importing.');
  return list;
}
function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function writePack(venuesDir, slug, pack, force, today) {
  const file = path.join(venuesDir, slug + '.json'), index = path.join(venuesDir, 'index.json');
  if (fs.existsSync(file) && !force) throw new ImportError('EXISTS', file + ' already exists. Run with --force to replace it.');
  const list = readManifest(index).filter(function (e) { return e && e.slug !== slug; });
  list.push({ slug: slug, name: pack.name, items: pack.items.length, updated: today });
  list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)) || String(a.slug).localeCompare(String(b.slug)); });
  fs.mkdirSync(venuesDir, { recursive: true });
  writeAtomic(file, JSON.stringify(pack, null, 1) + '\n');
  writeAtomic(index, JSON.stringify(list, null, 1) + '\n');
  return file;
}

/* ---------- the whole run ----------------------------------------------------------- */
async function importMenu(o) {
  o = o || {};
  const opts = checkOptions(o);
  const cwd = o.cwd || ROOT;
  const venuesDir = path.join(cwd, 'venues');
  const target = path.join(venuesDir, opts.slug + '.json');
  const log = typeof o.log === 'function' ? o.log : function () {};
  /* refuse before spending tokens, and again when writing */
  if (!o.dryRun && !o.force && fs.existsSync(target)) throw new ImportError('EXISTS', target + ' already exists. Run with --force to replace it.');
  if (!o.dryRun) readManifest(path.join(venuesDir, 'index.json'));

  let messages;
  if (o.fixture) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.resolve(o.fixture), 'utf8')); }
    catch (e) { throw new ImportError('USAGE', o.fixture + ': not a readable JSON file.'); }
    messages = Array.isArray(raw) ? raw : [raw];
  } else {
    const apiKey = o.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ImportError('USAGE', 'Set ANTHROPIC_API_KEY in the environment (or pass --fixture to replay a saved response).');
    const batches = planBatches(o.files, process.cwd());
    const ctx = { name: opts.name, currency: opts.currency, model: opts.model, effort: opts.effort, strict: opts.strict,
      apiKey: apiKey, log: log, forced: true };
    messages = [];
    const earlier = [];
    for (let i = 0; i < batches.length; i++) {
      log('Batch ' + (i + 1) + ' of ' + batches.length + ': ' + batches[i].label);
      const msg = await requestBatch(ctx, batches[i], earlier);
      messages.push(msg);
      /* later batches learn the headings so far, to continue a section across pages */
      try {
        toolInput(msg, 'batch').sections.forEach(function (s) {
          if (s && typeof s.name === 'string' && earlier.indexOf(clean(s.name)) < 0) earlier.push(clean(s.name));
        });
      } catch (e) { /* reported with the others below */ }
    }
    if (o.saveResponse) fs.writeFileSync(path.resolve(o.saveResponse), JSON.stringify(messages, null, 1) + '\n');
  }

  const answers = [], problems = [];
  messages.forEach(function (msg, i) {
    const where = 'batch ' + (i + 1);
    let input;
    try { input = toolInput(msg, where); } catch (e) { problems.push(e.message); return; }
    const p = answerProblems(input, where);
    if (p.length) problems.push.apply(problems, p); else answers.push(input);
  });
  if (problems.length) throw new ImportError('SCHEMA', 'The model answer does not fit the schema; nothing was written.', problems);

  const built = buildPack(answers, { name: opts.name, currency: opts.currency, rate: opts.rate });
  const invalid = validatePack(built.pack);
  if (invalid.length) throw new ImportError('SCHEMA', 'The pack failed validation; nothing was written.', invalid);

  const usage = { batches: messages.length, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const models = [];
  messages.forEach(function (m) {
    const u = m.usage || {};
    Object.keys(usage).forEach(function (k) { if (k !== 'batches') usage[k] += Number(u[k]) || 0; });
    if (m.model && models.indexOf(m.model) < 0) models.push(m.model);
  });
  let written = null;
  if (!o.dryRun) written = writePack(venuesDir, opts.slug, built.pack, !!o.force, new Date().toISOString().slice(0, 10));
  const ctx = { slug: opts.slug, model: opts.model, currency: opts.currency, rate: opts.rate, fixture: o.fixture || null };
  const text = report(ctx, built, usage, models, written && path.relative(cwd, written));
  return { pack: built.pack, report: text, path: written, flags: built.flags };
}

async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(e.message + '\n\n' + USAGE + '\n'); return 2; }
  if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
  o.log = function (line) { process.stderr.write(line + '\n'); };
  try {
    const r = await importMenu(o);
    process.stdout.write(r.report + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    process.stderr.write(e.message + '\n');
    e.details.forEach(function (d) { if (typeof d === 'string') process.stderr.write('  ' + d + '\n'); });
    if (e.code === 'USAGE') process.stderr.write('\n' + USAGE + '\n');
    return e.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = {
  importMenu: importMenu, validatePack: validatePack, buildPack: buildPack,
  /* for tests */
  _internal: { parseArgs: parseArgs, checkOptions: checkOptions, planBatches: planBatches, readStream: readStream, requestBatch: requestBatch,
    toolDefinition: toolDefinition, answerProblems: answerProblems, toolInput: toolInput, sectionIds: sectionIds, windowFor: windowFor,
    writePack: writePack, deps: deps, ALLERGENS: ALLERGENS, ImportError: ImportError, SYSTEM_PROMPT: SYSTEM_PROMPT }
};

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) {
    process.stderr.write('Unexpected error: ' + (e && e.message || e) + '\n');
    process.exitCode = 1;
  });
}
