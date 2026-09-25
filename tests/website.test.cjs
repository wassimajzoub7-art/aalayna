// Marketing site (index.html, book.html, numbers.html): copy rules, CTA labels, contact links,
// and the calculator's on-screen arithmetic. Runs the numbers.html script against a tiny DOM stub.
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
const CTA_LABELS = ['Book a 15-min call', 'WhatsApp us'];

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

test('homepage minutes match the calculator default exactly', () => {
  const turns = runNumbers('?focus=turns')[0];
  const saved = turns.steps.find(s => s.label === 'Minutes given back on every table').value;
  const minutes = parseShown(saved).raw;
  const index = read('index.html');
  assert.ok(index.includes('Up to ' + minutes + ' minutes back per table (illustrative)'), 'outcome sentence');
  assert.ok(index.includes('<p class="outcome-figure">' + minutes + ' min</p>'), 'in-numbers figure');
  assert.ok(!/Fourteen minutes/i.test(index));
});

test('contact links: one WhatsApp number and at most one email address across every page', () => {
  const files = rootFiles('.html').concat(rootFiles('.js'));
  const numbers = [], mails = [];
  files.forEach(f => {
    const s = read(f);
    (s.match(/wa\.me\/[^?"'\s]*/g) || []).forEach(m => numbers.push(m));
    (s.match(/mailto:[^?"'\s]*/g) || []).forEach(m => mails.push(m));
  });
  assert.ok(numbers.length >= 5, 'WhatsApp links found: ' + numbers.length);
  assert.equal(new Set(numbers).size, 1, 'different WhatsApp numbers: ' + [...new Set(numbers)].join(', '));
  assert.ok(new Set(mails).size <= 1, 'different email addresses: ' + [...new Set(mails)].join(', '));
});

test('copy: no "a Aalayna", no em dashes on the marketing pages', () => {
  rootFiles('.html').concat(rootFiles('.js')).forEach(f => assert.ok(!/\ba Aalayna|\ba%20Aalayna/.test(read(f)), f));
  SITE.concat(['website.css']).forEach(f => assert.ok(!/—|&mdash;|\\2014/.test(read(f)), f + ' has an em dash'));
});

test('CTAs: two labels site-wide, booking goes to book.html, WhatsApp goes to wa.me', () => {
  const retired = ['Let’s talk', 'Let\'s talk', 'Discuss a pilot', 'Book a conversation', 'Check compatibility with us', 'Discuss repeat visits',
    'Contact us on WhatsApp', 'Book via WhatsApp', 'Book by email', 'Open booking calendar', 'Check this number on a call'];
  SITE.forEach(f => {
    const s = read(f);
    retired.forEach(r => assert.ok(!s.includes(r), f + ' still says "' + r + '"'));
    for (const m of s.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const attrs = m[2], text = strip(m[3]);
      if (/class="[^"]*\bbtn\b/.test(attrs)) assert.ok(CTA_LABELS.includes(text), f + ': button "' + text + '"');
      if (/data-track="booking_click"/.test(attrs)) { assert.equal(text, 'Book a 15-min call', f); assert.match(attrs, /href="book\.html"/); }
      if (/data-track="whatsapp_click"/.test(attrs)) {
        assert.match(attrs, /href="https:\/\/wa\.me\//);
        assert.ok(text === 'WhatsApp us' || (f === 'book.html' && text === 'Message us'), f + ': WhatsApp link "' + text + '"');
      }
    }
  });
  runNumbers('?focus=all').forEach(o => o.buttons.forEach(b => {
    assert.equal(b.text, 'Book a 15-min call'); assert.equal(b.href, 'book.html');
    assert.equal(b.track, 'booking_click'); assert.equal(b.placement, 'numbers_' + o.key);
  }));
  const book = read('book.html');
  assert.match(book, /<p class="alt">Prefer WhatsApp\? <a [^>]*data-track="whatsapp_click"[^>]*>Message us<\/a>\.<\/p>/);
});

test('funnel: tracked placements keep their names and every event is one analytics.js accepts', () => {
  const allowed = JSON.parse(read('analytics.js').match(/var allowed = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const pairs = f => [...read(f).matchAll(/data-track="([a-z_]+)" data-placement="([a-z_]+)"/g)].map(m => m[1] + ':' + m[2]);
  const index = pairs('index.html');
  // booking_click:experience went with the mid-page booking card (W2, item 23); the editor screenshot sits there now.
  ['booking_click:navigation', 'booking_click:hero', 'booking_click:pilot', 'booking_click:footer',
   'whatsapp_click:hero', 'whatsapp_click:pricing', 'whatsapp_click:footer', 'whatsapp_click:footer_contact', 'numbers_click:outcomes']
    .forEach(p => assert.ok(index.includes(p), 'index.html lost ' + p));
  assert.deepEqual(pairs('book.html'), ['whatsapp_click:booking_fallback']);
  assert.deepEqual(pairs('numbers.html').sort(), ['booking_click:numbers_nav', 'whatsapp_click:numbers_footer']);
  SITE.forEach(f => pairs(f).forEach(p => assert.ok(allowed.includes(p.split(':')[0]), f + ' ' + p)));
  assert.equal(index.filter(p => p.startsWith('numbers_click')).length, 1);
  assert.equal((read('index.html').match(/href="numbers\.html/g) || []).length, 1);
});

test('homepage structure: hero, WhatsApp first, nav, coming-next section, FAQ order, numbering', () => {
  const s = read('index.html');
  assert.ok(s.includes('<p class="lead">Guests view, split and pay from the table: one QR, their language, USD or LBP.</p>'));
  const nav = s.match(/<div class="nav-links">([\s\S]*?)<\/div>/)[1];
  assert.ok(!/Bring guests back|return-visits/.test(nav));
  ['hero-copy', 'id="contact"'].forEach(anchor => {
    const block = s.slice(s.indexOf(anchor)), actions = block.match(/<div class="actions">([\s\S]*?)<\/div>/)[1].trim();
    assert.match(actions, /^<a class="btn" data-track="whatsapp_click"[^>]*>WhatsApp us<\/a>\s*<a class="btn outline" data-track="booking_click"[^>]*>Book a 15-min call<\/a>$/, anchor);
  });
  const retention = s.match(/<section[^>]*id="return-visits"[\s\S]*?<\/section>/)[0];
  assert.ok(s.indexOf('id="return-visits"') > s.indexOf('id="pricing"'), 'Bring guests back sits below pricing');
  assert.match(retention, /<p class="eyebrow">Coming next<\/p>/);
  assert.ok(!/data-track|href=/.test(retention), 'no CTA in the coming-next section');
  const faq = [...s.matchAll(/<summary>([^<]*)<\/summary>/g)].map(m => m[1]);
  assert.deepEqual(faq.slice(0, 3), ['Will it work with my POS?', 'What if a guest wants to pay cash?', 'Does every guest need an app or an account?']);
  assert.ok(faq.indexOf('Is this ready to take real payments?') > 2);
  const numbers = [...s.matchAll(/<span class="number">([^<]*)<\/span>/g)].map(m => m[1]);
  assert.ok(numbers.length >= 9);
  numbers.forEach(n => assert.match(n, /^\d{2} · \S/));
  assert.ok(!/<ol(?![^>]*pilot-steps)/.test(s), 'every numbered list uses the 01 · Label pattern');
  const figures = [...s.matchAll(/<p class="outcome-figure">([^<]*)<\/p><p class="outcome-source"><span class="source-tag">(Assumption|Benchmark|Product)<\/span> [^<]+<\/p>/g)].map(m => m[1]);
  assert.deepEqual(figures, ['13 min', '10%', '1 tap', 'your list']);
});

test('book.html: site colour token, one calendar that needs no script, one WhatsApp line', () => {
  const s = read('book.html');
  assert.equal(s.match(/<title>([^<]*)<\/title>/)[1], 'Book a 15-min call · Aalayna');
  assert.ok(!/#E8555B/i.test(s) && !/--brand\s*:/.test(s), 'no local brand colour');
  assert.match(s, /<link rel="stylesheet" href="website\.css/);
  assert.equal((s.match(/<iframe\b/g) || []).length, 1);
  assert.match(s, /<iframe [^>]*title="Book a 15-min call with Aalayna"/);
  assert.equal((s.match(/wa\.me\//g) || []).length, 1);
  assert.ok(!/mailto:/.test(s));
  assert.ok(!/<script>/.test(s), 'the calendar is in the HTML, not injected');
  assert.match(read('website.css'), /--brand:#C9414B/);
});

test('browser scripts on the marketing pages stay ES5', () => {
  SITE.forEach(f => (read(f).match(/<script>([\s\S]*?)<\/script>/g) || []).forEach(code => {
    assert.ok(!/=>|\blet\s|\bconst\s|`/.test(code), f + ' inline script uses ES2015 syntax');
  }));
});

/* ---------- W2: design system, product screens, share previews ---------- */
const TYPE_SCALE = { small: 14, body: 16, lead: 19, heading: 30, display: 54, hero: 67 };
const styleText = f => f.endsWith('.css') ? read(f) : (read(f).match(/<style>([\s\S]*?)<\/style>/g) || []).join('\n') + (read(f).match(/style="[^"]*"/g) || []).join('\n');

test('type scale: six size tokens, and every font-size on the marketing pages uses one of them', () => {
  const css = read('website.css');
  Object.entries(TYPE_SCALE).forEach(([name, px]) => {
    const m = css.match(new RegExp('--fs-' + name + ':([\\d.]+)rem'));
    assert.ok(m, '--fs-' + name + ' is defined');
    assert.equal(Number(m[1]) * 16, px, '--fs-' + name);
  });
  assert.equal((css.match(/--fs-[a-z]+:/g) || []).length, 6, 'exactly six size tokens');
  ['website.css'].concat(SITE).forEach(f => {
    for (const m of styleText(f).matchAll(/font-size:\s*([^;}"]+)/g)) {
      assert.match(m[1].trim(), /^var\(--fs-(small|body|lead|heading|display|hero)\)$/, f + ': font-size:' + m[1]);
    }
  });
});

test('red: text uses --brand-text (#B3363F), fills keep --brand (#C9414B), and the text red passes 4.5:1', () => {
  const css = read('website.css');
  assert.match(css, /--brand-text:#B3363F/);
  const lum = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const tok = n => { const h = css.match(new RegExp('--' + n + ':#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\\b'))[1]; return '#' + (h.length === 3 ? h.replace(/./g, c => c + c) : h); };
  ['bg', 'brand-bg', 'surface'].forEach(bg => assert.ok(ratio(tok('brand-text'), tok(bg)) >= 4.5, 'red text on --' + bg));
  assert.ok(ratio('#FFFFFF', tok('brand')) >= 4.5, 'white on the button red');
  ['website.css'].concat(SITE).forEach(f => assert.ok(!/(^|[;{\s])color:\s*var\(--brand\)/.test(styleText(f)), f + ' sets text in the button red'));
});

test('share previews: og and twitter tags on every marketing page, image at an absolute URL', () => {
  const urls = { 'index.html': 'https://aalayna.com/', 'numbers.html': 'https://aalayna.com/numbers.html', 'book.html': 'https://aalayna.com/book.html' };
  SITE.forEach(f => {
    const s = read(f), meta = k => { const m = s.match(new RegExp('<meta (?:property|name)="' + k + '" content="([^"]*)">')); return m && m[1]; };
    assert.equal(meta('og:image'), 'https://aalayna.com/images/og-image.png', f);
    assert.equal(meta('og:url'), urls[f], f);
    assert.ok(meta('og:title') && meta('og:description'), f + ' og:title and og:description');
    assert.equal(meta('twitter:card'), 'summary_large_image', f);
  });
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'og-image.png')));
});

test('product screens: every image exists in WebP and PNG, has its size, an alt, and is lazy except the hero', () => {
  const s = read('index.html');
  const pics = [...s.matchAll(/<picture><source srcset="images\/([\w-]+)\.webp" type="image\/webp"><img ([^>]*)><\/picture>/g)];
  assert.equal(pics.length, (s.match(/<img\b/g) || []).length, 'every img sits in a picture with a WebP source');
  assert.ok(pics.length >= 6, 'hero, three steps, guest menu and editor');
  pics.forEach(([, name, attrs], i) => {
    assert.match(attrs, new RegExp('src="images/' + name + '\\.png"'), name);
    ['webp', 'png'].forEach(ext => assert.ok(fs.existsSync(path.join(ROOT, 'images', name + '.' + ext)), name + '.' + ext));
    assert.match(attrs, /width="\d+" height="\d+"/, name + ' size');
    assert.match(attrs, /alt="[^"]{20,}"/, name + ' alt');
    if (i === 0) { assert.equal(name, 'guest-pay', 'the hero shows the pay screen'); assert.ok(!/loading=/.test(attrs), 'the hero is not lazy'); }
    else assert.match(attrs, /loading="lazy"/, name + ' is lazy');
  });
  assert.ok(!/conversation-card|Tell us about your floor/.test(s), 'the mid-page booking card is gone');
  assert.ok(!/w1-/.test(s + read('website.css')), 'W1 classes folded into the system');
});

/* ---------- W4: French homepage (fr/index.html) ---------- */
const FR = 'fr/index.html';
const FR_CTA = ['Réserver un appel de 15 min', 'Écrivez-nous sur WhatsApp'];
const decode = s => s.replace(/&#8239;/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// The language switch is the one link with hreflang; the English page has it in the header, the French page in the footer.
const LANG_SWITCH = /\s*<a href="[^"]*" hreflang="(?:en|fr)"[^>]*>(?:EN|FR)<\/a>/g;
const noSwitch = s => s.replace(LANG_SWITCH, '');
const all = (s, re) => [...s.matchAll(re)].map(m => m[1]);
// What a reader or a screen reader gets: text between tags in the body, alt and aria-label, and the head's title and meta contents.
function visible(s) {
  const body = s.slice(s.indexOf('<body'));
  const text = body.replace(/<script[\s\S]*?<\/script>/g, '').split(/<[^>]*>/).map(t => t.trim()).filter(Boolean);
  const attrs = all(s, /\b(?:alt|aria-label)="([^"]*)"/g);
  const head = all(s, /<meta (?:property|name)="(?:description|og:[a-z:_]+|twitter:[a-z]+)" content="([^"]*)">/g).filter(v => /[a-z] [a-z]/i.test(v));
  return text.concat(attrs, head, all(s, /<title>([^<]*)<\/title>/g)).map(decode);
}

test('fr homepage: same ids, classes, tags, images and tracked placements as index.html', () => {
  const en = noSwitch(read('index.html')), fr = noSwitch(read(FR));
  assert.deepEqual(all(fr, /\bid="([^"]*)"/g), all(en, /\bid="([^"]*)"/g), 'ids');
  assert.deepEqual(all(fr, /\bclass="([^"]*)"/g), all(en, /\bclass="([^"]*)"/g), 'classes');
  const tags = s => all(s.slice(s.indexOf('<body')), /<([a-z][a-z0-9]*)\b/g);
  assert.deepEqual(tags(fr), tags(en), 'element sequence in the body');
  const pairs = s => [...s.matchAll(/data-track="([a-z_]+)" data-placement="([a-z_]+)"/g)].map(m => m[1] + ':' + m[2]);
  assert.deepEqual(pairs(fr), pairs(en), 'tracked placements, in order');
  assert.deepEqual(all(fr, /(?:src|srcset)="\.\.\/(images\/[^"]+)"/g), all(en, /(?:src|srcset)="(images\/[^"]+)"/g), 'the same images, from ../images/');
  assert.equal((fr.match(/(?:src|srcset)="images\//g) || []).length, 0, 'no image path left relative to the root');
  const imgAttrs = s => all(s, /<img ([^>]*)>/g).map(a => a.replace(/ alt="[^"]*"/, '').replace('src="../', 'src="'));
  assert.deepEqual(imgAttrs(fr), imgAttrs(en), 'sizes, lazy loading and fetchpriority');
});

test('fr homepage: exactly the two French CTA labels, booking to ../book.html, WhatsApp to the same number in French', () => {
  const s = read(FR), en = read('index.html');
  const number = en.match(/wa\.me\/(\d+)/)[1];
  const labels = new Set();
  for (const m of s.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const attrs = m[2], text = decode(strip(m[3]));
    if (/class="[^"]*\bbtn\b/.test(attrs)) { assert.ok(FR_CTA.includes(text), 'button "' + text + '"'); labels.add(text); }
    if (/data-track="booking_click"/.test(attrs)) { assert.equal(text, FR_CTA[0]); assert.match(attrs, /href="\.\.\/book\.html"/); }
    if (/data-track="whatsapp_click"/.test(attrs)) {
      assert.equal(text, FR_CTA[1]);
      const href = attrs.match(/href="https:\/\/wa\.me\/(\d+)\?text=([^"]*)"/);
      assert.ok(href, 'WhatsApp link with a prefilled message');
      assert.equal(href[1], number, 'the same WhatsApp number as index.html');
      assert.match(decodeURIComponent(href[2]), /^Bonjour, /, 'the prefilled message is French');
    }
  }
  assert.deepEqual([...labels].sort(), FR_CTA.slice().sort(), 'both labels are used, and only them');
  ['Book a 15-min call', 'WhatsApp us', 'Message us', 'Hi%2C', 'Let’s talk', 'Discuss a pilot'].forEach(t => assert.ok(!s.includes(t), 'English CTA text left: ' + t));
  ['hero-copy', 'id="contact"'].forEach(anchor => {
    const actions = s.slice(s.indexOf(anchor)).match(/<div class="actions">([\s\S]*?)<\/div>/)[1].trim();
    assert.match(actions, /^<a class="btn" data-track="whatsapp_click"[^>]*>Écrivez-nous sur WhatsApp<\/a>\s*<a class="btn outline" data-track="booking_click"[^>]*>Réserver un appel de 15 min<\/a>$/, anchor);
  });
});

test('fr homepage: every relative path on both homepages resolves to a file', () => {
  [['index.html', 12], [FR, 12]].forEach(([f, min]) => {
    const dir = path.dirname(path.join(ROOT, f));
    const refs = all(read(f), /\b(?:href|src|srcset)="([^"]*)"/g).filter(u => !/^(?:[a-z]+:|#|\/\/)/i.test(u));
    assert.ok(refs.length >= min, f + ': ' + refs.length + ' relative paths');
    refs.forEach(u => {
      let p = path.resolve(dir, u.split(/[?#]/)[0] || '.');
      if (u.split(/[?#]/)[0] === '' || /\/$/.test(u.split(/[?#]/)[0]) || (fs.existsSync(p) && fs.statSync(p).isDirectory())) p = path.join(p, 'index.html');
      assert.ok(p.startsWith(ROOT + path.sep) && fs.existsSync(p), f + ': "' + u + '" does not resolve');
    });
  });
  assert.match(read(FR), /<link rel="stylesheet" href="\.\.\/website\.css\?v=\d+">/);
  assert.match(read('.gitignore'), /^!fr\/$/m);
  assert.match(read('.gitignore'), /^!fr\/\*$/m);
});

test('languages: lang, hreflang on both pages, a 44 px switch each way, French share tags', () => {
  const en = read('index.html'), fr = read(FR);
  assert.match(en, /<html lang="en">/);
  assert.match(fr, /<html lang="fr">/);
  [en, fr].forEach((s, i) => {
    const alt = all(s, /<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g);
    assert.deepEqual(alt, ['en', 'fr', 'x-default'], ['index.html', FR][i] + ' hreflang set');
    assert.ok(s.includes('<link rel="alternate" hreflang="en" href="https://aalayna.com/">'));
    assert.ok(s.includes('<link rel="alternate" hreflang="fr" href="https://aalayna.com/fr/">'));
    assert.ok(s.includes('<link rel="alternate" hreflang="x-default" href="https://aalayna.com/">'));
  });
  const toFr = en.match(/<a href="fr\/" hreflang="fr" lang="fr"([^>]*)>FR<\/a>/);
  const toEn = fr.match(/<a href="\.\.\/" hreflang="en" lang="en"([^>]*)>EN<\/a>/);
  assert.ok(toFr, 'FR link on the English page');
  assert.ok(toEn, 'EN link on the French page');
  [toFr[1], toEn[1]].forEach(a => assert.match(a, /min-height:44px/));
  assert.ok(en.match(/<header[\s\S]*?<\/header>/)[0].includes(toFr[0]), 'FR sits in the English header, next to the CTA');
  assert.ok(fr.match(/<footer[\s\S]*?<\/footer>/)[0].includes(toEn[0]), 'EN sits in the French footer (the French CTA leaves no room in the header at 375 px)');
  const meta = k => { const m = fr.match(new RegExp('<meta (?:property|name)="' + k + '" content="([^"]*)">')); return m && decode(m[1]); };
  assert.equal(meta('og:url'), 'https://aalayna.com/fr/');
  assert.equal(meta('og:locale'), 'fr_FR');
  assert.match(meta('og:locale:alternate'), /^en(_[A-Z]{2})?$/);
  assert.equal(meta('og:image'), 'https://aalayna.com/images/og-image.png');
  assert.equal(meta('twitter:card'), 'summary_large_image');
  assert.equal(meta('og:title'), decode(fr.match(/<title>([^<]*)<\/title>/)[1]));
  ['description', 'og:description', 'og:image:alt'].forEach(k => assert.notEqual(meta(k), en.match(new RegExp('<meta (?:property|name)="' + k + '" content="([^"]*)">'))[1], k + ' translated'));
});

test('fr copy: no em dash, nothing left in English, French spacing before : ; ? !, the same figures and terms', () => {
  const en = read('index.html'), fr = read(FR);
  assert.ok(!/—|&mdash;|&#8212;|\\2014/.test(fr), 'em dash');
  // Every English phrase of two words or more, cut at punctuation, is gone from the French page; names and the greeting stay.
  const keep = ['English · Français · العربية', 'Whish Money', 'Ahla w sahla'];
  const frText = visible(fr).join('\n');
  const phrases = [].concat(...visible(en).map(t => t.split(/[.:;,?!()]/))).map(t => t.trim()).filter(t => (t.match(/\p{L}{2,}/gu) || []).length >= 2 && !keep.includes(t));
  assert.ok(phrases.length > 150, phrases.length + ' English phrases checked');
  phrases.forEach(t => assert.ok(!frText.includes(t), 'still in English: "' + t + '"'));
  visible(fr).forEach(t => {
    for (const m of t.matchAll(/[:;?!]/g)) assert.equal(t[m.index - 1], ' ', 'no narrow no-break space before "' + m[0] + '" in "' + t + '"');
  });
  // Numbers stay as in English: the same dollar amounts, percentages and minutes.
  const figures = s => [...new Set(visible(s).join(' ').replace(/(\d)-min\b/g, '$1 min').match(/\$\d[\d,.]*\d|\d+%|\d+ min\b/g))].sort();
  assert.deepEqual(figures(fr), figures(en));
  const tags = { Assumption: 'Hypothèse', Product: 'Produit', Benchmark: 'Référence' };
  assert.deepEqual(all(fr, /<span class="source-tag">([^<]*)<\/span>/g), all(en, /<span class="source-tag">([^<]*)<\/span>/g).map(t => tags[t]));
  assert.deepEqual(all(fr, /<p class="outcome-figure">([^<]*)<\/p>/g).slice(0, 2), ['13 min', '10%']);
  const retention = fr.match(/<section[^>]*id="return-visits"[\s\S]*?<\/section>/)[0];
  assert.match(retention, /<p class="eyebrow">Prochainement<\/p>/);
  assert.ok(!/data-track|href=/.test(retention), 'no CTA in the coming-next section');
  ['$150 <span>/ mois / établissement</span>', '<strong>$100/mois par établissement.</strong>', 'Deux mois gratuits à partir de la mise en service'].forEach(t => assert.ok(fr.includes(t), t));
  assert.ok(!/<p class="price">\$(?!150 )/.test(fr), 'standard price');
  ['aalay<b>na</b>', 'USD', 'LBP', 'Whish', 'POS', 'QR'].forEach(t => assert.ok(fr.includes(t), t + ' kept'));
});
