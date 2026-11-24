/* The guest page's payment refusals (2026-11-24): every refusal the shared store (aal_mutate
   reserve, cancel, receipt), the sync layer or the demo store can give a guest on the payment
   path reads as a sentence for guests in English, French and Arabic, never the server's own
   wording (written for developers) and never errGeneric when the page knows what happened.
   Runs guest.html's string table, ERR_KEYS, ERR_STR and errText (i18n:start .. pickLang). */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'guest.html'), 'utf8');
const SLICE = html.slice(html.indexOf('/* i18n:start */'), html.indexOf('function pickLang(){'));
function page(lang) {
  const c = { LANG: lang };
  vm.createContext(c);
  vm.runInContext(SLICE + ';this.STR=STR;this.ERR_KEYS=ERR_KEYS;this.ERR_STR=ERR_STR;this.errText=errText;this.errKey=errKey;', c);
  return c;
}
const server = (m) => Object.assign(new Error(m), { serverMessage: true, status: 400 });

/* aal_mutate's refusals a guest can meet, from the SQL itself: every literal raise in the
   guest's operations, less the ones only staff or a provider can meet */
const SQL = fs.readFileSync(path.join(root, 'supabase', 'auth-2026-09-24.sql'), 'utf8');
const body = SQL.slice(SQL.indexOf('create or replace function public.aal_mutate('));
const guestOps = body.slice(body.indexOf(" pid=p_body->>'id';"), body.indexOf('end $$;'));
const STAFF_OR_PROVIDER = ['Only staff may close a bill', 'Bill is not fully settled', 'Cash confirmation requires staff', 'Cash request changed',
  'Verified provider callback required', 'Reservation expired or changed; reconcile received funds', 'Callback amount, currency or reference mismatch',
  'Duplicate provider reference', 'Digital refunds require the payment provider integration', 'Only confirmed cash can be refunded', 'Unknown operation'];
const raised = [...new Set([...guestOps.matchAll(/raise exception '([^'%]+)'/g)].map((m) => m[1]))].filter((m) => !STAFF_OR_PROVIDER.includes(m));

/* what PostgreSQL itself raises on a malformed request (the casts and jsonb functions the
   reserve uses; tests/rehearse-payments.test.cjs shows them on the real SQL) */
const CASTS = ['invalid input syntax for type numeric: "x"', 'bigint out of range', 'cannot convert NaN to bigint', 'cannot call jsonb_each_text on a non-object', 'Access denied'];

test('every refusal aal_mutate gives a guest has a key, and the scan of the SQL found them', () => {
  for (const m of ['Missing payer token', 'Wrong payer token', 'Payment request changed', 'Invalid amount', 'Another payment already covers this balance. Refresh your bill.',
    'Invalid item selection', 'Item already reserved', 'Items do not match the amount', 'Not enough cash', 'Payment unavailable', 'Payment already completed',
    'Payment must be confirmed', 'Separate permissions required', 'Invalid email', 'International number required', 'Invalid channel', 'Payment already linked', 'Wrong bill', 'Bill closed or unavailable'])
    assert.ok(raised.includes(m), 'the scan finds ' + m);
  const p = page('en');
  // 'Separate permissions required' is the page's own mistake, never the guest's: errGeneric
  for (const m of raised.concat(CASTS)) if (m !== 'Separate permissions required') assert.ok(p.errKey(m), 'no key for "' + m + '"');
});

test('payment refusals read as guest sentences in English, French and Arabic; the server\'s wording never shows', () => {
  const sync = ['Paying by card or Whish needs the connection. Try again once you are back online.', 'Card and Whish payments complete on the payment provider\'s page.',
    'Connect to the restaurant before continuing.', 'Your role cannot save this change for this restaurant.'];
  const demo = ['Enter a valid payment and tip.', 'Choose enough cash to cover your share and tip.', 'This payment reference was already used for a different request.',
    'Unknown payment request.', 'This request is cancelled and cannot be confirmed.', 'This payment reservation expired. Please start again.',
    'The bill changed. Refresh your share; another payment or cash request already covers part of it.', 'One of these items is already covered by another payment.'];
  for (const lang of ['en', 'fr', 'ar']) {
    const p = page(lang), generic = p.STR[lang].errGeneric;
    for (const m of raised.concat(CASTS)) {
      const shown = p.errText(server(m));
      assert.notEqual(shown, m, lang + ': "' + m + '" shown as it is');
      if (m !== 'Separate permissions required') {
        assert.notEqual(shown, generic, lang + ': "' + m + '" is errGeneric');
        assert.equal(shown, p.STR[lang][p.errKey(m)], lang + ': ' + m);
      }
    }
    // a server sentence nobody keyed is errGeneric, in English too
    assert.equal(p.errText(server('function aal_mutate(text) does not exist')), generic, lang);
    for (const m of sync.concat(demo)) {
      const shown = p.errText(new Error(m));
      if (lang === 'en') assert.equal(shown, m, 'English keeps the page\'s own sentence: ' + m);
      else { assert.notEqual(shown, generic, lang + ': ' + m); assert.equal(shown, p.STR[lang][p.errKey(m)], lang + ': ' + m); }
    }
  }
  const en = page('en'), fr = page('fr'), ar = page('ar');
  assert.equal(en.errText(server('Wrong payer token')), 'This payment was started on another phone or browser. Finish it there, or ask your server.');
  assert.equal(fr.errText(server('Another payment already covers this balance. Refresh your bill.')), 'Un autre paiement couvre déjà une partie de cette addition. Vérifiez votre part et réessayez.');
  assert.equal(ar.errText(server('Item already reserved')), ar.STR.ar.errTaken);
  assert.equal(en.errText(server('Payment unavailable')), 'This payment is no longer on the bill. Check your bill and try again.');
  // payment-start's answers keep their own wording by status (aalayna-sync.js marks them provider)
  assert.equal(fr.errText(Object.assign(new Error('Wrong payer token'), { provider: true, status: 401, serverMessage: true })), fr.STR.fr.errProviderStart);
});

test('the new texts: in all three languages, no placeholder, French and Arabic typography as the rest of the table', () => {
  const p = page('en'), keys = Object.keys(p.ERR_STR.en);
  assert.ok(keys.length >= 7);
  for (const lang of ['fr', 'ar']) assert.deepEqual(Object.keys(p.ERR_STR[lang]).sort(), keys.slice().sort(), lang);
  for (const lang of ['en', 'fr', 'ar']) for (const k of keys) {
    const s = p.ERR_STR[lang][k];
    assert.ok(s.trim() && !/\{\w+\}/.test(s), lang + '.' + k);
    assert.equal(p.STR[lang][k], s, lang + '.' + k + ' reaches STR');
  }
  for (const k of keys) {
    const fr = p.ERR_STR.fr[k];
    for (const m of fr.matchAll(/[:;?!]/g)) assert.equal(fr[m.index - 1], ' ', 'fr.' + k);
    assert.doesNotMatch(fr, /'/, 'fr.' + k + ' uses the typographic apostrophe');
    assert.doesNotMatch(p.ERR_STR.ar[k], /[٠-٩]/, 'ar.' + k);
    assert.match(p.ERR_STR.ar[k], /[؀-ۿ]/, 'ar.' + k + ' is Arabic');
  }
  // every key ERR_KEYS names exists in every language
  for (const [, k] of p.ERR_KEYS) for (const lang of ['en', 'fr', 'ar']) assert.equal(typeof p.STR[lang][k], 'string', lang + '.' + k);
});
