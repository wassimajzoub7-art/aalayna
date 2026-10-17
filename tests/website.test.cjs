// Marketing site (index.html, fr/, ar/, book.html, numbers.html): the homepage (version E of the table, docs/table-brief.md),
// copy rules, CTA labels, the funnel, contact links, and the calculator's on-screen arithmetic (numbers.html in a DOM stub).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SITE = ['index.html', 'book.html', 'numbers.html'];
const rootFiles = ext => fs.readdirSync(ROOT).filter(f => f.endsWith(ext));
const strip = h => h.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
const OPS = ['×', '÷', '+', '−'];
const CTA_LABELS = ['Book a demo', 'WhatsApp us'];

/* ---------- numbers.html in a DOM stub ---------- */
function makeEl(tag) {
  return { tagName: String(tag).toUpperCase(), children: [], dataset: {}, attrs: {}, className: '', _html: '',
    appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener() {},
    get innerHTML() { return this._html; }, set innerHTML(h) { this._html = String(h); this.children = []; } };
}
function runNumbers(search) {
  const html = read('numbers.html');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const main = makeEl('main');
  const ctx = { document: { getElementById: id => (id === 'main' ? main : null), createElement: makeEl, querySelectorAll: () => [] },
    location: { search, href: '' }, URLSearchParams, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('numbers-model.js'), ctx);
  vm.runInContext(inline, ctx);
  return main.children.filter(c => c.dataset.key).map(sec => {
    const inputs = [];
    (function walk(e) { if (e.tagName === 'INPUT') inputs.push({ key: e.dataset.key, value: Number(e.value) }); e.children.forEach(walk); })(sec);
    const steps = sec._parts.ol.children.map(li => {
      const [label, desc = ''] = li.children[0].innerHTML.split('<small>');
      return { label: strip(label), desc: strip(desc), value: strip(li.children[1].innerHTML) };
    });
    const buttons = [];
    (function walk(e) { if (e.tagName === 'A' && /\bbtn\b/.test(e.className)) buttons.push({ text: e.innerHTML, track: e.dataset.track, placement: e.dataset.placement, href: e.href }); e.children.forEach(walk); })(sec);
    return { key: sec.dataset.key, inputs, steps, buttons, figure: strip(sec._parts.fig.innerHTML).replace(/\*$/, ''), unit: strip(sec._parts.unit.innerHTML) };
  });
}

/* A shown figure: its value, and half a unit of its last shown digit (the rounding it can carry). */
function parseShown(text) {
  const m = text.replace(/,/g, '').match(/([+−-])?\$?(\d+(?:\.(\d+))?)(%)?/);
  assert.ok(m, 'no number in "' + text + '"');
  const decimals = m[3] ? m[3].length : 0, scale = m[4] ? 100 : 1;
  const sign = m[1] === '−' || m[1] === '-' ? -1 : 1;
  return { value: sign * Number(m[2]) / scale, raw: Number(m[2]), tol: 0.5 * Math.pow(10, -decimals) / scale + 1e-9 };
}
const tokens = text => text.match(/[×÷+−]|\$?\d[\d,]*(?:\.\d+)?%?/g) || [];
const operandRaw = tok => Number(tok.replace(/[$,%]/g, ''));
function evaluate(toks) {
  let total = 0, term = null, sign = 1, op = null, unary = 1, expect = true;
  for (const t of toks) {
    if (OPS.includes(t)) {
      if (expect) { assert.equal(t, '−', 'operator where a number was expected'); unary = -unary; continue; }
      if (t === '+' || t === '−') { total += sign * term; sign = t === '+' ? 1 : -1; term = null; }
      op = t; expect = true;
    } else {
      const n = unary * operandRaw(t) / (t.endsWith('%') ? 100 : 1); unary = 1;
      term = term === null ? n : op === '÷' ? term / n : term * n;
      op = null; expect = false;
    }
  }
  assert.equal(expect, false, 'formula ends on an operator');
  return total + sign * term;
}
const has = (list, x) => list.some(y => Math.abs(y - x) < 1e-9);

function checkOutcome(o) {
  const shown = o.inputs.map(i => i.value).concat([4.33, 3]);
  let formulas = 0;
  o.steps.forEach(s => {
    if (OPS.some(c => s.desc.includes(c))) {
      formulas++;
      const toks = tokens(s.desc);
      toks.filter(t => !OPS.includes(t)).forEach(t => assert.ok(has(shown, operandRaw(t)),
        o.key + ': "' + t + '" in "' + s.desc + '" is not a figure shown above it'));
      const got = evaluate(toks), want = parseShown(s.value);
      assert.ok(Math.abs(got - want.value) <= want.tol,
        o.key + ': "' + s.label + '": ' + s.desc + ' = ' + got + ', shown as ' + s.value);
    }
    if (s.value) shown.push(parseShown(s.value).raw);
  });
  assert.ok(formulas >= 3, o.key + ': expected the arithmetic to be shown step by step');
  const fig = parseShown(o.figure);
  assert.ok(o.steps.some(s => s.value && Math.abs(parseShown(s.value).raw - fig.raw) <= fig.tol), o.key + ': headline ' + o.figure + ' is not a step result, within its rounding');
  const mult = o.unit.match(/about ([\d.,]+), ([\d.]+) times as many/);
  if (mult) {
    const today = o.inputs.find(i => i.key === 'reviews').value;
    assert.ok(Math.abs(Number(mult[1].replace(/,/g, '')) / today - Number(mult[2])) <= 0.05 + 1e-9, o.key + ': multiplier ' + mult[2]);
  }
  tokens(o.unit.replace(/, [\d.]+ times as many/, '')).forEach(t => assert.ok(has(shown, operandRaw(t)), o.key + ': headline figure ' + t + ' is not shown in the steps'));
}

const SCENARIOS = {
  defaults: '?focus=all',
  typed: '?focus=all&done=25&after=5&tables=18&sit=75&peak=3&check=38.5&paid=410&tiprate=8&tipshare=70&newtipshare=72&newtiprate=7&reviews=9&adoption=35&capture=15&unique=55&permission=40&returnrate=6&fill=65&reviewrate=3',
  fractional: '?focus=all&done=17.5&after=2.5&tables=44&sit=105&peak=5&check=61&paid=1250&reviews=0&adoption=80&capture=33&unique=71&permission=45&returnrate=12&fill=35'
};

test('calculator: every step on screen follows from the figures shown next to it, in all four outcomes', () => {
  for (const [name, search] of Object.entries(SCENARIOS)) {
    const outcomes = runNumbers(search);
    assert.deepEqual(outcomes.map(o => o.key), ['turns', 'tips', 'reviews', 'guests'], name);
    outcomes.forEach(checkOutcome);
  }
});

test('calculator defaults: the displayed chain for each outcome', () => {
  const byKey = Object.fromEntries(runNumbers('?focus=all').map(o => [o.key, o]));
  const values = k => byKey[k].steps.filter(s => s.value).map(s => s.value);
  assert.deepEqual(values('turns'), ['20 min', '4 min', '3 min', '7 min', '13 min', '14.4%', '1.08', '9', '$405']);
  assert.equal(byKey.turns.figure, '+9');
  assert.match(byKey.turns.unit, /worth \$405 at your average bill/);
  assert.deepEqual(values('tips'), ['3%', '$2,104', '75%', '9%', '6.75%', '3.75%', '$1.69', '$1,315']);
  assert.equal(byKey.tips.figure, '+$1,315');
  assert.deepEqual(values('reviews'), ['360', '4%', '7.2', '2', '+29', '33']);
  assert.match(byKey.reviews.unit, /from 4 today to about 33, 8\.3 times as many/);
  assert.deepEqual(values('guests'), ['180', '36', '467.6', '280.6', '140.3', '11', '$495']);
  assert.equal(byKey.guests.figure, '140');
});

/* The same outcomes at full precision, straight from the inputs, with no display rounding at all. */
function exact(v) {
  let acc = 0, change = 0;
  [.15, .15, .25, .15, .15, .15].forEach((x, i) => { const m = i === 5 ? Math.max(1, v.done - acc) : Math.max(1, Math.round(v.done * x)); acc += m; change = m; });
  const saved = Math.max(0, v.done - (v.after + change));
  return {
    turns: v.tables * saved / v.sit * v.adoption / 100 * v.fill / 100 * v.peak * 4.33,
    tips: v.check * (v.newtiprate * v.newtipshare - v.tiprate * v.tipshare) / 10000 * v.paid * v.adoption / 100 * 4.33,
    reviews: v.paid * v.adoption / 100 * v.reviewrate / 100 * 4.33 - v.reviews * v.adoption / 100,
    guests: require('../numbers-model.js').guests(v).quarter
  };
}
function scenarioValues(outcomes) {
  const v = {};
  outcomes.forEach(o => o.inputs.forEach(i => { v[i.key] = i.value; }));
  return v;
}
function randomScenarios(n) {
  let seed = 20260925;
  const rnd = (lo, hi) => { seed = (seed * 1103515245 + 12345) % 2147483648; return lo + seed % (hi - lo + 1); };
  const out = [];
  for (let k = 0; k < n; k++) {
    const p = { done: rnd(8, 40), after: rnd(2, 8), tables: rnd(5, 80), sit: rnd(45, 150), peak: rnd(0, 7), check: rnd(10, 120), paid: rnd(50, 2000),
      tiprate: rnd(0, 15), tipshare: rnd(10, 90), newtipshare: rnd(30, 95), newtiprate: rnd(5, 15), reviews: rnd(0, 40), reviewrate: rnd(1, 8),
      adoption: rnd(10, 90), fill: rnd(10, 100), capture: rnd(5, 40), unique: rnd(30, 90), permission: rnd(20, 80), returnrate: rnd(2, 20) };
    out.push('?focus=all&' + Object.entries(p).map(([a, b]) => a + '=' + b).join('&'));
  }
  return out;
}

test('calculator: no headline is rounded up (or down) through an intermediate step', () => {
  const searches = Object.values(SCENARIOS).concat(randomScenarios(400));
  for (const search of searches) {
    const outcomes = runNumbers(search), want = exact(scenarioValues(outcomes));
    outcomes.forEach(o => {
      const shown = parseShown(o.figure).value;
      assert.ok(Math.abs(shown - want[o.key]) <= 0.5 + 1e-9, o.key + ': headline ' + o.figure + ' but the full-precision figure is ' + want[o.key].toFixed(3) + ' (' + search + ')');
    });
    outcomes.forEach(checkOutcome);
  }
});


/* ---------- The homepages: index.html, fr/index.html, ar/index.html (version E of the table, docs/table-brief.md) ---------- */
const HOMES = ['index.html', 'fr/index.html', 'ar/index.html'];
const FR = 'fr/index.html', AR = 'ar/index.html';
const LABELS = {
  'index.html': { book: 'Book a demo', wa: 'WhatsApp us', hello: /^Hi, / },
  'fr/index.html': { book: 'Réserver une démo', wa: 'Écrivez-nous sur WhatsApp', hello: /^Bonjour, / },
  'ar/index.html': { book: 'احجز عرضاً توضيحياً', wa: 'راسلنا على واتساب', hello: /^مرحباً، / },
};
const up = f => (f.includes('/') ? '../' : '');
const all = (s, re) => [...s.matchAll(re)].map(m => m[1]);
const decode = s => s.replace(/&#8239;/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const meta = (s, k) => { const m = s.match(new RegExp('<meta (?:property|name)="' + k + '" content="([^"]*)">')); return m && decode(m[1]); };
const pairs = s => [...s.matchAll(/data-track="([a-z_]+)" data-placement="([a-z_]+)"/g)].map(m => m[1] + ':' + m[2]);
// The language links differ from page to page by design; everything else in the body is the same markup.
const LANG_LINKS = /<a class="(?:lang|foot-lang)" href="[^"]*" hreflang="[a-z]+" lang="[a-z]+" aria-label="[^"]*">[^<]*<\/a>/g;
// The printed receipt on the tray is drawn per language (its lines set right to left in Arabic): compared apart.
const noLang = s => s.replace(LANG_LINKS, '').replace(/<!--g:receipt-->[\s\S]*?<!--\/g:receipt-->/, '');
// What a reader or a screen reader gets: text between tags in the body, alt and aria-label, and the head's title and meta contents.
function visible(s) {
  const body = s.slice(s.indexOf('<body'));
  const text = body.replace(/<script[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, '').split(/<[^>]*>/).map(t => t.trim()).filter(Boolean);
  const attrs = all(s, /\b(?:alt|aria-label)="([^"]*)"/g);
  const head = all(s, /<meta (?:property|name)="(?:description|og:[a-z:_]+|twitter:[a-z]+)" content="([^"]*)">/g).filter(v => /[a-z] [a-z]/i.test(v));
  return text.concat(attrs, head, all(s, /<title>([^<]*)<\/title>/g)).map(decode);
}

test('homepage figures: what the restaurant gets, none of them from the calculator, their sources noted in the page source', () => {
  // The four figures sit on the table beside the stretch they prove; where each comes from is kept in a comment.
  for (const f of HOMES) {
    const s = read(f);
    const figs = [...s.matchAll(/<article class="stretch (s-[a-z]+)[^"]*"[^>]*>([\s\S]*?)<\/article>/g)]
      .map(m => [m[1], m[2].match(/<div class="fig"><p class="num" data-count>([^<]+)<\/p><p class="src">[^<]+<\/p><\/div>/)]).filter(x => x[1]).map(x => x[0] + ' ' + x[1][1]);
    assert.deepEqual(figs, f === AR ? ['s-bill 10 دقائق', 's-pay 22%', 's-review 83%', 's-again 50%'] : ['s-bill 10 min', 's-pay 22%', 's-review 83%', 's-again 50%'], f);
    const note = s.match(/<!-- Where the figures come from \(for meetings; not shown\): ([^>]*) -->/);
    assert.ok(note, f + ': the sources, noted');
    ['Barclaycard', 'The New York Times', 'BrightLocal', 'Toast Regulars Report'].forEach(src => assert.ok(note[1].includes(src), f + ': ' + src));
    assert.ok(!/<cite>|illustrative|\(indicatif\)|توضيحي\)/.test(s), f + ': no calculator defaults or illustrative figures on the page');
  }
  const en = read('index.html');
  assert.deepEqual(all(en, /<p class="src">([^<]+)<\/p>/g), ['Saved per table: nobody waits for the bill.', 'Average tip per table once it is suggested at payment, up from 10%.',
    'Of customers asked for a review leave one. Aalayna asks every table.', 'Of orders can come from the few guests who return. Aalayna tells you who they are.']);
});

test('contact links: one WhatsApp number and at most one email address across every page', () => {
  const files = rootFiles('.html').concat(rootFiles('.js'), ['fr/index.html', 'ar/index.html']);
  const numbers = [], mails = [];
  files.forEach(f => {
    const s = read(f);
    (s.match(/wa\.me\/[^?"'\s]*/g) || []).forEach(m => numbers.push(m));
    (s.match(/mailto:[^?"'\s]*/g) || []).forEach(m => mails.push(m));
  });
  assert.ok(numbers.length >= 9, 'WhatsApp links found: ' + numbers.length);
  assert.equal(new Set(numbers).size, 1, 'different WhatsApp numbers: ' + [...new Set(numbers)].join(', '));
  assert.ok(new Set(mails).size <= 1, 'different email addresses: ' + [...new Set(mails)].join(', '));
});

test('copy: no "a Aalayna", no em dashes on the marketing pages and the homepage sheet and script', () => {
  rootFiles('.html').concat(rootFiles('.js')).forEach(f => assert.ok(!/\ba Aalayna|\ba%20Aalayna/.test(read(f)), f));
  SITE.concat([FR, AR, 'website.css', 'home.css', 'home.js', 'tools/home-screens.js']).forEach(f => assert.ok(!/—|&mdash;|&#8212;|\\2014/.test(read(f)), f + ' has an em dash'));
});

test('CTAs: two labels per language, booking goes to book.html, WhatsApp goes to wa.me with a message in the page\'s language', () => {
  const retired = ['Let’s talk', 'Let\'s talk', 'Discuss a pilot', 'Book a conversation', 'Check compatibility with us', 'Discuss repeat visits',
    'Contact us on WhatsApp', 'Book via WhatsApp', 'Book by email', 'Open booking calendar', 'Check this number on a call'];
  SITE.forEach(f => {
    const s = read(f);
    retired.forEach(r => assert.ok(!s.includes(r), f + ' still says "' + r + '"'));
    for (const m of s.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const attrs = m[2], text = strip(m[3]);
      if (/class="[^"]*\bbtn\b/.test(attrs)) assert.ok(CTA_LABELS.includes(text), f + ': button "' + text + '"');
      if (/data-track="booking_click"/.test(attrs)) { assert.equal(text, 'Book a demo', f); assert.match(attrs, /href="book\.html"/); }
      if (/data-track="whatsapp_click"/.test(attrs)) {
        assert.match(attrs, /href="https:\/\/wa\.me\//);
        assert.ok(text === 'WhatsApp us' || (f === 'book.html' && text === 'Message us'), f + ': WhatsApp link "' + text + '"');
      }
    }
  });
  const number = read('index.html').match(/wa\.me\/(\d+)/)[1];
  for (const f of HOMES) {
    const s = read(f), L = LABELS[f], used = new Set();
    for (const m of s.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const attrs = m[1], text = decode(strip(m[2]));
      if (/class="btn\b/.test(attrs)) { assert.ok([L.book, L.wa].includes(text), f + ': button "' + text + '"'); used.add(text); }
      if (/data-track="booking_click"/.test(attrs)) { assert.equal(text, L.book, f); assert.match(attrs, new RegExp('href="' + up(f) + 'book\\.html"'), f); }
      if (/data-track="whatsapp_click"/.test(attrs)) {
        assert.equal(text, L.wa, f);
        const href = attrs.match(/href="https:\/\/wa\.me\/(\d+)\?text=([^"]*)"/);
        assert.ok(href, f + ': WhatsApp with a prefilled message');
        assert.equal(href[1], number, f + ': the same number');
        assert.match(decodeURIComponent(href[2]), L.hello, f + ': the message is in the page\'s language');
      }
    }
    assert.deepEqual([...used].sort(), [L.book, L.wa].sort(), f + ': both labels, and only them');
    const actions = s.slice(s.indexOf('class="poster"')).match(/<div class="actions">([\s\S]*?)<\/div>/)[1];
    assert.match(actions, /^<a class="btn" data-track="booking_click" data-placement="hero"[^>]*>[^<]+<\/a><a class="btn outline" data-track="whatsapp_click" data-placement="hero"[^>]*>[^<]+<\/a>$/, f + ': the poster carries both asks');
  }
  runNumbers('?focus=all').forEach(o => o.buttons.forEach(b => {
    assert.equal(b.text, 'Book a demo'); assert.equal(b.href, 'book.html');
    assert.equal(b.track, 'booking_click'); assert.equal(b.placement, 'numbers_' + o.key);
  }));
  assert.match(read('book.html'), /<p class="alt">Prefer WhatsApp\? <a [^>]*data-track="whatsapp_click"[^>]*>Message us<\/a>\.<\/p>/);
});

test('funnel: six booking placements on every homepage, the names the funnel already knows, and every event one analytics.js accepts', () => {
  const allowed = JSON.parse(read('analytics.js').match(/var allowed = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  // The table's placements map onto the old homepage's: the split's ask is "how", the regulars' is "outcomes".
  for (const f of HOMES) {
    const p = pairs(read(f));
    assert.deepEqual(p.filter(x => x.startsWith('booking_click')),
      ['booking_click:navigation', 'booking_click:hero', 'booking_click:how', 'booking_click:outcomes', 'booking_click:pricing', 'booking_click:footer'], f);
    assert.deepEqual(p.filter(x => x.startsWith('whatsapp_click')), ['whatsapp_click:hero', 'whatsapp_click:footer', 'whatsapp_click:footer_contact'], f);
    p.forEach(x => assert.ok(allowed.includes(x.split(':')[0]), f + ' ' + x));
    const s = read(f);
    assert.match(s.match(/<article class="stretch s-split[\s\S]*?<\/article>/)[0], /data-placement="how"/, f + ': the split ends on the "how" ask');
    assert.match(s.match(/<article class="stretch s-again[\s\S]*?<\/article>/)[0], /data-placement="outcomes"/, f + ': the regulars end on the "outcomes" ask');
    assert.match(s.match(/<article class="stretch s-price[\s\S]*?<\/article>/)[0], /data-placement="pricing"/, f + ': the price ends on the "pricing" ask');
    assert.match(s.match(/<section class="ask"[\s\S]*?<\/section>/)[0], /data-track="booking_click" data-placement="footer"/, f + ': the close');
    assert.match(s.match(/<header[\s\S]*?<\/header>/)[0], /data-track="booking_click" data-placement="navigation"/, f + ': the header');
  }
  assert.deepEqual(pairs(read('book.html')), ['whatsapp_click:booking_fallback']);
  assert.deepEqual(pairs(read('numbers.html')).sort(), ['booking_click:numbers_nav', 'whatsapp_click:numbers_footer']);
  SITE.forEach(f => pairs(read(f)).forEach(p => assert.ok(allowed.includes(p.split(':')[0]), f + ' ' + p)));
});

test('launch head: indexable, real titles and descriptions, analytics and config scripts as before, the homepage sheet and script by version', () => {
  const versions = { css: new Set(), js: new Set() };
  for (const f of HOMES) {
    const s = read(f), head = s.slice(0, s.indexOf('</head>')), p = up(f);
    assert.ok(!/name="robots"|noindex/.test(s), f + ': indexable');
    assert.ok(!/table-v1|V1|النسخة 1|prototype|Prototype|التجريبية/.test(head), f + ': no prototype words or addresses');
    const order = all(head, /<script src="([^"]+)"/g);
    assert.deepEqual(order.map(u => u.replace(/\?v=\d+$/, '')), [p + 'aalayna-config.js', p + 'analytics-config.js', p + 'analytics.js', p + 'home.js'], f + ': the scripts, in order');
    assert.ok(head.includes('<script src="' + p + 'aalayna-config.js"></script>'), f + ': the config first, not deferred');
    assert.ok(head.includes('<script src="' + p + 'analytics-config.js" defer></script>\n<script src="' + p + 'analytics.js" defer></script>'), f + ': analytics deferred, as before');
    const css = head.match(new RegExp('<link rel="stylesheet" href="' + p.replace(/\./g, '\\.') + 'home\\.css\\?v=(\\d+)">'));
    const js = head.match(new RegExp('<script src="' + p.replace(/\./g, '\\.') + 'home\\.js\\?v=(\\d+)" defer></script>'));
    assert.ok(css && js, f + ': home.css and home.js with a version');
    versions.css.add(css[1]); versions.js.add(js[1]);
    assert.ok(!/website\.css|site\.js/.test(head), f + ': not the old sheet or script');
    assert.ok(meta(s, 'description').length >= 120, f + ': a real description');
  }
  assert.equal(versions.css.size, 1, 'one home.css version on all three'); assert.equal(versions.js.size, 1, 'one home.js version on all three');
  const en = read('index.html');
  assert.equal(en.match(/<title>([^<]*)<\/title>/)[1], 'Aalayna: scan, split, settle.');
  assert.match(meta(en, 'description'), /^Nobody waits for the bill: tables turn faster, tips go up, reviews come in\./, 'the outcome line leads the description');
  assert.match(meta(read(FR), 'description'), /^Personne n’attend l’addition : les tables tournent plus vite/);
  assert.match(meta(read(AR), 'description'), /^لا أحد ينتظر الفاتورة: الطاولات تدور أسرع/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'site.js')), 'site.js served only the old homepage');
  ['home.css', 'home.js', 'images/table/'].forEach(x => assert.match(read('.gitignore'), new RegExp('^!' + x.replace(/\./g, '\\.') + '$', 'm'), '.gitignore lets ' + x + ' in'));
});

test('share previews: og and twitter tags on every marketing page, the image at an absolute URL, the hreflang trio on every homepage', () => {
  const urls = { 'index.html': 'https://aalayna.com/', 'fr/index.html': 'https://aalayna.com/fr/', 'ar/index.html': 'https://aalayna.com/ar/', 'numbers.html': 'https://aalayna.com/numbers.html', 'book.html': 'https://aalayna.com/book.html' };
  const locale = { 'index.html': 'en_GB', 'fr/index.html': 'fr_FR', 'ar/index.html': 'ar_LB' };
  Object.keys(urls).forEach(f => {
    const s = read(f);
    assert.equal(meta(s, 'og:image'), 'https://aalayna.com/images/og-image.png', f);
    assert.equal(meta(s, 'og:url'), urls[f], f);
    assert.ok(meta(s, 'og:title') && meta(s, 'og:description') && meta(s, 'og:image:alt'), f + ' og:title, og:description, og:image:alt');
    assert.equal(meta(s, 'twitter:card'), 'summary_large_image', f);
    if (!locale[f]) return;
    assert.equal(meta(s, 'og:locale'), locale[f], f);
    assert.deepEqual(all(s, /<meta property="og:locale:alternate" content="([^"]+)">/g).sort(), Object.values(locale).filter(l => l !== locale[f]).sort(), f + ': the other two locales');
    assert.deepEqual(all(s, /<link rel="alternate" hreflang="([^"]+)" href="[^"]+">/g), ['en', 'fr', 'ar', 'x-default'], f);
    ['<link rel="alternate" hreflang="en" href="https://aalayna.com/">', '<link rel="alternate" hreflang="fr" href="https://aalayna.com/fr/">',
      '<link rel="alternate" hreflang="ar" href="https://aalayna.com/ar/">', '<link rel="alternate" hreflang="x-default" href="https://aalayna.com/">'].forEach(l => assert.ok(s.includes(l), f + ': ' + l));
  });
  ['description', 'og:title', 'og:description', 'og:image:alt'].forEach(k => assert.equal(new Set(HOMES.map(f => meta(read(f), k))).size, 3, k + ' translated on every homepage'));
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'og-image.png')));
});

test('the poster sells the outcome: the benefit first, the name, the two asks, what it does under them, no price', () => {
  const want = {
    'index.html': ['Nobody waits for the bill.', 'Tables turn faster. Tips go up. Reviews come in.', 'Scan. Split. Settle.', 'For restaurants in Lebanon'],
    'fr/index.html': ['Personne n’attend l’addition.', 'Les tables tournent plus vite. Les pourboires montent. Les avis arrivent.', 'Scannez. Partagez. Réglez.', 'Pour les restaurants au Liban'],
    'ar/index.html': ['لا أحد ينتظر الفاتورة.', 'الطاولات تدور أسرع. الإكرامية تكبر. والمراجعات تتوالى.', 'امسح. قسّم. ادفع.', 'للمطاعم في لبنان'],
  };
  for (const f of HOMES) {
    const s = read(f), poster = s.match(/<section class="poster"[\s\S]*?<\/section>/)[0], [tag, sub, does, eyebrow] = want[f];
    const name = f === AR ? '<span class="sr-only">علينا.</span><span class="name" aria-hidden="true"><em>علينا.</em></span>' : '<span class="sr-only">Aalayna.</span><span class="name" aria-hidden="true"><em>3</em>layna.</span>';
    assert.ok(poster.includes('<p class="eyebrow">' + eyebrow + '</p>'), f + ': eyebrow');
    assert.ok(poster.includes('<h1 class="poster-title" id="poster-title">' + name + '<span class="tag">' + tag + '</span></h1>'), f + ': the name, then the benefit, in the one h1');
    assert.ok(poster.includes('<p class="poster-sub">' + sub + '</p>'), f + ': the outcomes, in poster language');
    assert.ok(poster.includes('<p class="poster-does">' + does + '</p>'), f + ': what it does, under the asks');
    assert.ok(poster.indexOf('class="actions"') < poster.indexOf('poster-does'), f + ': the asks before the line');
    assert.ok(!/\$\d/.test(poster), f + ': no price on the poster');
    assert.equal((s.match(/<h1\b/g) || []).length, 1, f + ': one h1');
  }
  assert.ok(!/<video|film-en\.mp4|reel-play/.test(read('index.html')), 'the film is off the homepage');
  assert.match(read('index.html'), /<p class="film"><a href="reel\.html">Or watch the 96-second film<\/a><\/p>/, 'and reachable from the close');
});

test('the table: one point per stretch, in order, each with its hero object and its line', () => {
  const ORDER = ['s-qr', 's-menu', 's-bill', 's-split', 's-pay', 's-review', 's-again', 's-price'];
  const HERO = ['ob-qr', 'ob-menu', 'ob-tray', 'ob-split', 'ob-pay', 'ob-review', 'ob-again', 'ob-price'];
  const HEADS = { 'index.html': ['Scan.', 'Browse.', 'The bill.', 'Split.', 'Settle.', 'Rate.', 'Again.'],
    'fr/index.html': ['Scannez.', 'Parcourez.', 'L’addition.', 'Partagez.', 'Réglez.', 'Notez.', 'Ils reviennent.'] };
  for (const f of HOMES) {
    const s = read(f), table = s.match(/<section class="table" id="table"[\s\S]*?\n  <\/section>/)[0];
    const stretches = [...table.matchAll(/<article class="stretch (s-[a-z]+)[^"]*"[^>]*>([\s\S]*?)<\/article>/g)];
    assert.deepEqual(stretches.map(m => m[1]), ORDER, f + ': the stretches, in order');
    stretches.forEach((m, i) => {
      assert.equal((m[2].match(/class="ob hero /g) || []).length, 1, f + ' ' + m[1] + ': one hero');
      assert.match(m[2], new RegExp('class="ob hero [^"]*\\b' + HERO[i] + '\\b'), f + ' ' + m[1] + ': ' + HERO[i]);
      assert.match(m[2], /<div class="note"><p class="step">[^<]+<\/p><h3 class="head" id="[^"]+">/, f + ' ' + m[1] + ': its note, a label then the point');
    });
    const steps = all(table, /<p class="step">([^<]+)<\/p>/g);
    assert.equal(steps.length, 8);
    steps.slice(0, 7).forEach((t, i) => assert.match(t, new RegExp('^0' + (i + 1) + ' · \\S'), f + ': ' + t));
    if (HEADS[f]) assert.deepEqual(all(table, /<h3 class="head" id="s-[a-z]+">([^<]+)<\/h3>/g), HEADS[f], f + ': the seven points');
    // The foot of the table: the restaurant's own bill, then a card that says Reserved; the close asks once more.
    assert.match(table, /<div class="board board-end board-foot"[^>]*><div class="ob hero ob-reserved"/);
    assert.match(s, /<section class="ask" id="ask" aria-labelledby="ask-title">/);
    // The price, with the two free months and the founders' rate, and the way to the pilot and the questions.
    const price = stretches[7][2];
    assert.match(price, /<span class="amt">\$150<\/span>/);
    assert.match(price, /<strong>\$100/);
    assert.match(price, /<span class="pill">[^<]+<\/span>/);
    assert.match(price, new RegExp('<p class="more"><a href="' + up(f) + 'book\\.html#pilot">[^<]+</a></p>'), f + ': the pilot and the questions, on book.html');
    assert.ok(!/<details|class="faq|pilot-steps/.test(s), f + ': the questions and the pilot timeline live on book.html');
    // No JavaScript needed to read it: the board describes the table, and every object that is only a picture is hidden.
    assert.match(table, /<div class="board" style="--h:380" role="img" aria-label="[^"]{200,}">/, f + ': the table, described once');
  }
  assert.deepEqual(all(read('index.html'), /<h3 class="head" id="(s-[a-z]+|price-title)">/g), ['s-scan', 's-menu', 's-bill', 's-split', 's-pay', 's-review', 's-again', 'price-title']);
});

test('live screens: the guest app on the phones, written by tools/home-screens.js, at the film\'s evening', () => {
  const tool = require('../tools/home-screens.js');
  for (const [f, lang] of tool.PAGES) {
    assert.equal(read(f), tool.fillPage(f, lang), f + ' holds what tools/home-screens.js writes (run node tools/home-screens.js)');
    const s = read(f), text = sel => { const m = s.match(sel); assert.ok(m, f + ': ' + sel); return m[1].replace(/[⁦-⁩]/g, ''); };
    // Every phone speaks the page's language and direction.
    const apps = [...s.matchAll(/<span class="g [a-z-]+" data-app dir="(ltr|rtl)" lang="([a-z]+)"/g)];
    assert.ok(apps.length >= 3, f + ': three app screens');
    apps.forEach(m => { assert.equal(m[2], lang, f + ': app lang'); assert.equal(m[1], lang === 'ar' ? 'rtl' : 'ltr', f + ': app dir'); });
    // The film's evening, before any tap: twelve dishes, $152.50, four of you at $38.13, a 10% tip, $41.94.
    assert.equal(text(/<span class="g-bar-a" data-f="\{total\}" aria-live="polite">([^<]+)<\/span>/), '$152.50', f + ': the bill');
    assert.equal(text(/<span class="g-n" data-f="\{people\}" aria-live="polite">([^<]+)<\/span>/), '4', f + ': four guests');
    assert.equal(text(/<span class="share share-me go"[^>]*><span class="sv g-share"><span class="g-k" data-t="yourShare">[^<]+<\/span><span class="g-v" data-f="\{share\}" aria-live="polite">([^<]+)<\/span>/), '$38.13', f + ': your share');
    assert.equal(text(/<span class="g-big" data-f="\{pay\}" aria-live="polite">([^<]+)<\/span>/), '$41.94', f + ': the total to pay');
    assert.equal(text(/<span class="g-rca" data-f="\{pay\}">([^<]+)<\/span>/), '$41.94', f + ': paid');
    assert.match(s, /<button type="button" class="g-tipb on" data-act="tip" data-r="0\.1" aria-pressed="true" disabled>/, f + ': 10% chosen');
    assert.equal((s.match(/class="g-mi on"/g) || []).length, 2, f + ': the two dishes of the film\'s bill on the menu screen');
    assert.match(s, /<span class="rc-pz receipt" style="--ar:200\/\d+"><svg class="rc-ink"/, f + ': the receipt on the tray');
    // The controls are in the page and inert until home.js runs; the caption carries them at full size on a phone.
    ['menu', 'split', 'pay'].forEach(k => assert.match(s, new RegExp('<div class="ctl" data-for="' + k + '"'), f + ': the ' + k + ' controls'));
    all(s, /<button ([^>]*data-act[^>]*)>/g).forEach(a => assert.match(a, /\bdisabled$/, f + ': ' + a.slice(0, 60)));
  }
  const APP = require('../home.js');
  const S = APP.initial('fr'), c = APP.calc(S), v = APP.vars(S, c);
  assert.deepEqual([S.lang, v.total, v.share, v.pay, v.p10], ['fr', '$152.50', '$38.13', '$41.94', '10 %'], 'French: the app\'s own formats');
  assert.equal(APP.T.fr.howMany, 'Combien êtes-vous ?', 'the real app\'s French, with its narrow space');
  S.people = 3; assert.equal(APP.vars(S).share, '$50.83');
  S.people = 4; S.tip = 0.15; assert.equal(APP.vars(S).pay, '$43.85');
  S.tip = 0.1; S.q.i05 = 0; assert.equal(APP.vars(S).total, '$139.50');
  assert.match(APP.receipt(APP.initial('fr'), 'fr').svg, /Table 12 · 4 convives · 21:40[\s\S]*Total[\s\S]*Shukran, à bientôt/, 'the French receipt');
});

test('photographs: every picture on the table exists in WebP and PNG, sized, described and lazy; the cloth and the paper come from the sheet', () => {
  for (const f of HOMES) {
    const s = read(f), p = up(f);
    const pics = [...s.matchAll(/<picture(?: aria-hidden="true")?><source srcset="([^"]+)\.webp" type="image\/webp"><img ([^>]*)><\/picture>/g)];
    assert.equal(pics.length, (s.match(/<img\b/g) || []).length, f + ': every img sits in a picture with a WebP source');
    const names = new Set(pics.map(m => m[1].replace(p, '')));
    assert.deepEqual([...names].sort(), ['images/table/phone', 'images/table/plate', 'images/table/tray'], f + ': the phone, the plate, the tray');
    pics.forEach(([, base, attrs]) => {
      assert.ok(attrs.includes('src="' + base + '.png"'), base);
      ['webp', 'png'].forEach(x => assert.ok(fs.existsSync(path.join(ROOT, path.dirname(f), base + '.' + x)), base + '.' + x));
      assert.match(attrs, /width="\d+" height="\d+"/);
      assert.match(attrs, /alt="[^"]{12,}"/);
      assert.match(attrs, /loading="lazy" decoding="async"/);
    });
  }
  const css = read('home.css');
  ['linen', 'paper', 'receipt'].forEach(n => { assert.match(css, new RegExp('url\\(images/table/' + n + '\\.webp\\)'), n); assert.ok(fs.existsSync(path.join(ROOT, 'images/table/' + n + '.webp')), n); });
});

test('the French and Arabic homepages mirror the English: the same ids, classes, elements and placements; French left to right, Arabic right to left', () => {
  const en = noLang(read('index.html'));
  const tags = s => all(s.slice(s.indexOf('<body')), /<([a-z][a-z0-9]*)\b/g);
  for (const f of [FR, AR]) {
    const s = noLang(read(f));
    assert.deepEqual(all(s, /\bid="([^"]*)"/g), all(en, /\bid="([^"]*)"/g), f + ': ids');
    // Lettering on the paper objects takes the Arabic face (arb) where the Latin takes a weight (w5, w6) or figures (tn).
    const cls = x => all(x, /\bclass="([^"]*)"/g).map(c => c.split(' ').filter(k => !['arb', 'w5', 'w6', 'tn'].includes(k)).join(' '));
    assert.deepEqual(cls(s), cls(en), f + ': classes');
    assert.deepEqual(tags(s), tags(en), f + ': the elements in the body');
    assert.deepEqual(pairs(s), pairs(en), f + ': tracked placements, in order');
    assert.equal((s.match(/(?:src|srcset|href)="(?:images|brand|home\.|book\.html|reel\.html|analytics|aalayna-config)/g) || []).length, 0, f + ': no path left relative to the root');
  }
  assert.match(read('index.html'), /^<!DOCTYPE html>\n<html lang="en">/);
  assert.match(read(FR), /^<!DOCTYPE html>\n<html lang="fr">/, 'French: no dir, so left to right');
  assert.match(read(AR), /^<!DOCTYPE html>\n<html lang="ar" dir="rtl">/);
  // Every header carries the other two languages, by their own names; every footer too.
  const langs = { 'index.html': [['fr/', 'fr', 'FR'], ['ar/', 'ar', 'عربي']], 'fr/index.html': [['../', 'en', 'EN'], ['../ar/', 'ar', 'عربي']], 'ar/index.html': [['../', 'en', 'EN'], ['../fr/', 'fr', 'FR']] };
  for (const [f, want] of Object.entries(langs)) {
    const s = read(f), header = s.match(/<header[\s\S]*?<\/header>/)[0], footer = s.match(/<footer[\s\S]*?<\/footer>/)[0];
    assert.deepEqual([...header.matchAll(/<a class="lang" href="([^"]*)" hreflang="([a-z]+)" lang="\2" aria-label="[^"]+">([^<]+)<\/a>/g)].map(m => [m[1], m[2], m[3]]), want, f + ': the header');
    assert.deepEqual([...footer.matchAll(/<a class="foot-lang" href="([^"]*)" hreflang="([a-z]+)" lang="\2" aria-label="[^"]+">([^<]+)<\/a>/g)].map(m => [m[1], m[2], m[3]]), want, f + ': the footer');
  }
  assert.match(read('home.css'), /\n\.top-links a,\.lang\{[^}]*min-width:44px;min-height:44px/, 'the language links are 44 px targets');
  assert.match(read('home.css'), /\[lang="ar"\]\{--font-text:'IBM Plex Sans Arabic',/);
  assert.match(read('home.css'), /\[lang="ar"\] \.poster-title \.name\{font-family:'Noto Kufi Arabic',/, 'the name, علينا, in the Kufi of the mark');
  assert.match(read(FR), /<a href="\.\.\/reel\.html\?lang=fr">/, 'the French film');
  assert.match(read(AR), /<a href="\.\.\/reel\.html\?lang=ar">/, 'the Arabic film');
});

// Names that stay as they are in every language: the venue, the greeting, the providers, the guests, the dishes'
// own names the menu prints beside the translation, and the receipt's names that are the same in French.
const KEEP = ['USD $', 'LBP LL', 'Whish Money', 'Ahla w sahla', 'Mayda · Table 12', 'Visa, Mastercard, Amex', 'Abou Karim', 'Arayes kafta', 'Batata kezbara', 'Warak enab', 'Table 12', 'Lebanese Grill', 'Raheb Salad', 'Hummus Meat and Almond', 'English version', 'version française', 'Lebanese Grill'];

test('fr copy: written in French, nothing left in English, French spacing before : ; ? !, the same figures and terms', () => {
  const en = read('index.html'), fr = read(FR);
  const frText = visible(fr).join('\n');
  const phrases = [].concat(...visible(en).map(t => t.split(/[.:;,?!()·]/))).map(t => t.trim()).filter(t => (t.match(/\p{Script=Latin}{2,}/gu) || []).length >= 2 && !KEEP.some(k => k.includes(t) || t.includes(k)));
  assert.ok(phrases.length > 80, phrases.length + ' English phrases checked');
  phrases.forEach(t => assert.ok(!frText.includes(t), 'still in English: "' + t + '"'));
  visible(fr).forEach(t => {
    for (const m of t.matchAll(/[:;?!]/g)) if (!/\d/.test(t[m.index - 1] || '')) assert.ok(t[m.index - 1] === ' ' || t[m.index - 1] === ' ', 'no narrow no-break space before "' + m[0] + '" in "' + t + '"');
  });
  // French sets a narrow space before % (the app does too): the same figures either way.
  const figures = s => [...new Set(visible(s).join(' ').replace(/(\d)\u202F%/g, '$1%').match(/\$\d[\d,.]*\d|\b\d+%|\d+ min\b/g))].sort();
  assert.deepEqual(figures(fr), figures(en), 'the same amounts, percentages and minutes');
  ['<span class="amt">$150</span> <span class="unit">/ mois / établissement</span>', '<strong>$100/mois par établissement.</strong>', 'Deux mois gratuits à partir de la mise en service', 'Pilote gratuit de deux mois'].forEach(t => assert.ok(fr.includes(t), t));
  ['Aalayna', 'USD', 'LBP', 'Whish', 'QR'].forEach(t => assert.ok(fr.includes(t), t + ' kept'));
  assert.equal(fr.match(/<title>([^<]*)<\/title>/)[1], 'Aalayna&#8239;: scannez, partagez, réglez.');
});

test('ar copy: nothing left in English, the same prices and percentages', () => {
  const en = read('index.html'), ar = read(AR);
  const arText = visible(ar).join('\n');
  const phrases = [].concat(...visible(en).map(t => t.split(/[.:;,?!()·]/))).map(t => t.trim()).filter(t => (t.match(/\p{Script=Latin}{2,}/gu) || []).length >= 2 && !KEEP.some(k => k.includes(t) || t.includes(k)));
  assert.ok(phrases.length > 80, phrases.length + ' English phrases checked');
  // The Arabic menu prints each dish's English name under its Arabic one, as the real app does.
  const dishes = Object.values(require('../home.js').D).map(d => d[1]);
  phrases.filter(t => !dishes.some(d => d.includes(t))).forEach(t => assert.ok(!arText.includes(t), 'still in English: "' + t + '"'));
  const figures = s => [...new Set(visible(s).join(' ').replace(/[⁦-⁩]/g, '').match(/\$\d[\d,.]*\d|\d+%/g))].sort();
  assert.deepEqual(figures(ar), figures(en), 'the same dollar amounts and percentages');
});

test('every link on the three homepages resolves to a file in the site', () => {
  for (const f of HOMES) {
    const dir = path.dirname(path.join(ROOT, f));
    const refs = all(read(f), /\b(?:href|src|srcset)="([^"]*)"/g).filter(u => !/^(?:[a-z]+:|#|\/\/)/i.test(u));
    assert.ok(refs.length >= 25, f + ': ' + refs.length + ' relative paths');
    refs.forEach(u => {
      const bare = u.split(/[?#]/)[0];
      let p = path.resolve(dir, bare || '.');
      if (!bare || /\/$/.test(bare) || (fs.existsSync(p) && fs.statSync(p).isDirectory())) p = path.join(p, 'index.html');
      assert.ok(p.startsWith(ROOT + path.sep) && fs.existsSync(p), f + ': "' + u + '" does not resolve');
      const hash = u.split('#')[1];
      if (hash) assert.ok(new RegExp('\\bid="' + hash + '"').test(fs.readFileSync(p, 'utf8')), f + ': "' + u + '" has no #' + hash);
    });
  }
  for (const gone of ['table-v1.html', 'table-v1b.html', 'table-v1c.html', 'table-v1d.html', 'table-v1e.html', 'table-v1e.css', 'table-v1e.js', 'tools/table-v1e-screens.js', 'ar/table-v1e.html'])
    assert.ok(!fs.existsSync(path.join(ROOT, gone)), gone + ' is retired (git history keeps it)');
});

test('book.html: the calendar that needs no script, the pilot in four stops with go-live, the six questions owners ask', () => {
  const s = read('book.html');
  assert.equal(s.match(/<title>([^<]*)<\/title>/)[1], 'Book a demo · Aalayna');
  assert.ok(!/#E8555B/i.test(s) && !/--brand\s*:/.test(s), 'no local brand colour');
  assert.match(s, /<link rel="stylesheet" href="website\.css\?v=\d+">/);
  assert.equal((s.match(/<iframe\b/g) || []).length, 1);
  assert.match(s, /<iframe [^>]*title="Book a demo with Aalayna"/);
  assert.equal((s.match(/wa\.me\//g) || []).length, 1);
  assert.ok(!/mailto:/.test(s));
  assert.ok(!/<script>/.test(s), 'the calendar is in the HTML, not injected');
  const main = s.match(/<main[\s\S]*?<\/main>/)[0];
  assert.match(main, /<h1 class="sr-only">Book a demo<\/h1>/);
  assert.ok(main.indexOf('<iframe') < main.indexOf('id="pilot"'), 'the calendar first');
  // The pilot, moved from the old homepage: three steps and go-live, before the review.
  const pilot = main.match(/<section id="pilot" aria-labelledby="pilot-title">[\s\S]*?<\/section>/);
  assert.ok(pilot, 'book.html#pilot');
  const steps = [...pilot[0].matchAll(/<li(?: class="go-live")?><span class="number">([^<]+)<\/span> ([^<]+)<\/li>/g)].map(m => m[1]);
  assert.deepEqual(steps, ['01 · Check the fit', '02 · Prepare your floor', 'Go-live', '03 · Look at the evidence']);
  assert.match(pilot[0], /<li class="go-live"><span class="number">Go-live<\/span> Your two free months start\.<\/li>/);
  const faq = main.match(/<section id="faq" aria-labelledby="faq-title">[\s\S]*?<\/section>/);
  assert.ok(faq, 'book.html#faq');
  assert.deepEqual(all(faq[0], /<summary>([^<]*)<\/summary>/g), ['Will it work with my POS?', 'What if a guest wants to pay cash?', 'Does every guest need an app or an account?', 'Where do payments and tips go?', 'Is this ready to take real payments?', 'What is included in the price?']);
  assert.match(faq[0], /<summary>What is included in the price\?<\/summary><p>[^<]*No commission on your sales/);
  assert.equal((faq[0].match(/<details><summary>[^<]+<\/summary><p>[^<]{80,}<\/p><\/details>/g) || []).length, 6, 'six answers');
  assert.match(read('website.css'), /\n\.pilot-steps \.go-live::before\{/);
  assert.match(read('website.css'), /\n\.faq summary\{[^}]*min-height:4rem/);
  assert.match(read('website.css'), /--brand:#C9414B/);
  assert.ok(!/\.hero|#how|\.steps|\.benefits-band|\.contact|\.reel-|details\.lang|\.lang summary/.test(read('website.css')), 'the old homepage\'s rules are gone from website.css');
});

test('browser scripts on the marketing pages stay ES5', () => {
  SITE.concat([FR, AR]).forEach(f => (read(f).match(/<script>([\s\S]*?)<\/script>/g) || []).forEach(code => {
    assert.ok(!/=>|\blet\s|\bconst\s|`/.test(code), f + ' inline script uses ES2015 syntax');
  }));
  const js = read('home.js');
  assert.ok(!/=>|\blet\s|\bconst\s|`/.test(js.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'home.js stays ES5');
});

/* ---------- Design rules: type, red, corners, motion ---------- */
const TYPE_SCALE = { small: 14, body: 16, lead: 19, heading: 30, display: 54, hero: 67 };
const styleText = f => f.endsWith('.css') ? read(f) : (read(f).match(/<style>([\s\S]*?)<\/style>/g) || []).join('\n') + (read(f).match(/style="[^"]*"/g) || []).join('\n');
const SHEETS = ['website.css', 'home.css'];

test('type scale: six size tokens, and every font-size on the marketing pages and the homepage uses one of them', () => {
  for (const sheet of SHEETS) {
    const css = read(sheet);
    Object.entries(TYPE_SCALE).forEach(([name, px]) => {
      const m = css.match(new RegExp('--fs-' + name + ':([\\d.]+)rem'));
      assert.ok(m, sheet + ': --fs-' + name + ' is defined');
      assert.equal(Number(m[1]) * 16, px, sheet + ': --fs-' + name);
    });
    assert.equal(new Set(css.match(/--fs-[a-z]+(?=:)/g)).size, 6, sheet + ': exactly six size tokens');
    // The app's screens set the same six sizes in their own points (one point is --p, a 390th of the screen).
    for (const m of css.matchAll(/--fs-([a-z]+):calc\((\d+) \* var\(--p\)\)/g)) assert.equal(Number(m[2]), TYPE_SCALE[m[1]], sheet + ': --fs-' + m[1] + ' in points');
  }
  SHEETS.concat(SITE, [FR, AR]).forEach(f => {
    for (const m of styleText(f).matchAll(/font-size:\s*([^;}"]+)/g)) {
      assert.match(m[1].trim(), /^var\(--fs-(small|body|lead|heading|display|hero)\)$/, f + ': font-size:' + m[1]);
    }
  });
});

test('red: text uses --brand-text (#B3363F), fills keep --brand (#C9414B), and the text red passes 4.5:1 on every ground', () => {
  const lum = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const grounds = { 'website.css': ['bg', 'brand-bg', 'surface'], 'home.css': ['floor', 'paper'] };
  for (const sheet of SHEETS) {
    const css = read(sheet);
    assert.match(css, /--brand-text:#B3363F/, sheet);
    assert.match(css, /--brand:#C9414B/, sheet);
    const tok = n => { const h = css.match(new RegExp('--' + n + ':#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\\b'))[1]; return '#' + (h.length === 3 ? h.replace(/./g, c => c + c) : h); };
    grounds[sheet].forEach(bg => assert.ok(ratio(tok('brand-text'), tok(bg)) >= 4.5, sheet + ': red text on --' + bg));
    assert.ok(ratio('#FFFFFF', tok('brand')) >= 4.5, sheet + ': white on the button red');
  }
  SHEETS.concat(SITE, [FR, AR]).forEach(f => assert.ok(!/(^|[;{\s])color:\s*var\(--brand\)/.test(styleText(f)), f + ' sets text in the button red'));
});

test('square corners on the homepage: only round things are round (the plates, the phone, its screen and the app\'s own dots)', () => {
  const css = read('home.css');
  for (const m of css.matchAll(/([^{}]*)\{[^}]*border-radius:([^;}]+)/g)) {
    const sel = m[1].trim(), r = m[2].trim();
    assert.ok(r === '0' || /\.osh\.(round|phone)|\.screen|\.glass|\.g-radio|\.g-seal/.test(sel), sel + ' has border-radius ' + r);
  }
  // The photographs cast soft shadows (amendment 8 of the brief), so home.css is not held to the hard-shadow rule.
});

test('homepage motion: the site\'s two curves, no transition: all, nothing from nothing, hover only with a real pointer, reduced motion respected', () => {
  const css = read('home.css'), js = read('home.js');
  assert.match(css, /--ease-out:cubic-bezier\(\.23,1,\.32,1\);--ease-in-out:cubic-bezier\(\.77,0,\.175,1\)/);
  assert.ok(!/transition:\s*all|transition-property:\s*all/.test(css), 'never transition: all');
  assert.ok(!/scale\(0\)|scale\(0,|scaleX?\(0\)/.test(css), 'nothing grows from nothing');
  for (const m of css.matchAll(/@keyframes ([a-z]+)\{((?:[a-z0-9%]+\{[^}]*\})+)\}/g)) {
    for (const d of m[2].matchAll(/([a-z-]+):/g)) assert.ok(['opacity', 'transform'].includes(d[1]), '@keyframes ' + m[1] + ' animates ' + d[1]);
  }
  const hover = [...css.matchAll(/@media \(hover:hover\) and \(pointer:fine\)(?: and \(prefers-reduced-motion:reduce\))?\{[\s\S]*?\n\}|@media \(hover:hover\) and \(pointer:fine\) and \(prefers-reduced-motion:reduce\)\{[^\n]*\}/g)].map(m => m[0]);
  let rest = css; hover.forEach(h => { rest = rest.replace(h, ''); });
  assert.ok(!/:hover/.test(rest), 'every :hover is inside (hover:hover) and (pointer:fine)');
  for (const m of css.matchAll(/([^{}]*:active[^{}]*)\{/g)) assert.match(m[1], /:active:not\(:focus-visible\)/, m[1].trim());
  assert.match(js, /if \(mm\('\(prefers-reduced-motion: reduce\)'\)\) return;/, 'reduced motion: the table is simply laid');
  assert.match(js, /el\.textContent = text;/, 'the figures end on the value in the page');
});

test('no script, no service worker: sw.js keeps to the guest app and never mentions the homepage or the retired previews', () => {
  const sw = read('sw.js');
  assert.match(read('guest.html'), /navigator\.serviceWorker\.register\('sw\.js', \{ scope: 'guest\.html'/);
  assert.ok(!/index\.html|home\.(css|js)|website\.css|site\.js|table-v1/.test(sw), 'sw.js caches nothing of the homepage');
});

test('404.html: static, absolute paths, the way home, the site CTAs and the one WhatsApp number', () => {
  const s = read('404.html'), index = read('index.html');
  assert.match(s, /<link rel="stylesheet" href="\/website\.css/);
  assert.match(s, /<a [^>]*href="\/"[^>]*>Back to the homepage/);
  assert.match(s, /href="\/fr\/"/); assert.match(s, /href="\/ar\/"/);
  assert.match(s, /<a class="btn" href="\/book\.html">Book a demo<\/a>/);
  assert.match(s, /<a class="btn outline" href="https:\/\/wa\.me\/[^"]*">WhatsApp us<\/a>/);
  assert.deepEqual(new Set(s.match(/wa\.me\/[^?"'\s]*/g)), new Set(index.match(/wa\.me\/[^?"'\s]*/g)));
  assert.ok(!/<script\b/.test(s), '404.html loads no script');
  assert.ok(!/(?:href|src)="(?!\/|https:|#)/.test(s), '404.html uses only absolute paths');
  assert.ok(!/—|&mdash;/.test(s), '404.html has an em dash');
  assert.match(read('.gitignore'), /^!404\.html$/m);
});
