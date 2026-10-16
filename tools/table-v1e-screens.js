#!/usr/bin/env node
/* Writes the guest app's screens into the table's phones (table-v1e.html, ar/table-v1e.html), version E.

   The screens are HTML replicas of the real guest app (guest.html, ?theme=balat), drawn at the film's evening: the
   film's twelve dishes ($152.50), four guests, $38.13 each, a 10% tip, $41.94. table-v1e.js repaints them from its
   state when the reader changes something; this writes what the page shows before any script runs (and without
   one), from the same data and the same words (table-v1e.js exports them under Node).

   Each region sits between <!--g:name--> and <!--/g:name--> in the two pages. Run: node tools/table-v1e-screens.js */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = require('../table-v1e.js');
const ROOT = path.join(__dirname, '..');

// The line logo of "powered by", as brand/svg/3layna/line.svg draws it (its two paths, byte for byte).
const LINE = '<path class="logo-ink" d="M60 0L70 0L70 40.8L110 40.8L110 50L60 50ZM120 0L170 0L170 50L160 50L160 29.6L130 29.6L130 50L120 50ZM130 9.2L130 20.4L160 20.4L160 9.2ZM180 0L190 0L190 20.4L220 20.4L220 0L230 0L230 29.6L210 29.6L210 50L200 50L200 29.6L180 29.6ZM240 0L250 0L250 50L240 50ZM280 0L290 0L290 50L280 50ZM240 0L252.5 0L290 50L277.5 50ZM300 0L350 0L350 50L340 50L340 29.6L310 29.6L310 50L300 50ZM310 9.2L310 20.4L340 20.4L340 9.2Z"/><path class="logo-red" d="M0 0L50 0L50 50L0 50L0 40.8L40 40.8L40 29.6L20 29.6L20 20.4L40 20.4L40 9.2L0 9.2Z"/>';
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Words that belong to the page (its own language), not to the app: the hints beside the phones and the controls
// the caption carries on a phone.
const PAGE = {
  en: { tryMenu: 'Try it: change the language or the currency, or tap a dish.', trySplit: 'Try it: change how many of you there are.', tryPay: 'Try it: choose the tip.',
    menuG: 'Try the menu', langG: 'Language', ccyG: 'Currency', usd: 'USD', lbp: 'LBP', guests: 'Guests', fewer: 'One fewer', more: 'One more',
    noTip: 'No tip', tipG: 'Tip', menuL: 'The guest app: the menu', splitL: 'The guest app: the split', payL: 'The guest app: the payment' },
  ar: { tryMenu: 'جرّبها: غيّر اللغة أو العملة، أو اضغط على طبق.', trySplit: 'جرّبها: غيّر عدد الأشخاص.', tryPay: 'جرّبها: اختر الإكرامية.',
    menuG: 'جرّب القائمة', langG: 'اللغة', ccyG: 'العملة', usd: 'دولار', lbp: 'ليرة', guests: 'الضيوف', fewer: 'شخص أقل', more: 'شخص أكثر',
    noTip: 'بلا', tipG: 'الإكرامية', menuL: 'تطبيق الضيف: القائمة', splitL: 'تطبيق الضيف: التقسيم', payL: 'تطبيق الضيف: الدفع' }
};

function screens(page) {
  const S = APP.initial(page), L = S.lang, T = APP.T[L], c = APP.calc(S), v = APP.vars(S, c), P = PAGE[page];
  v.langName = L.toUpperCase(); v.ccyName = T[S.ccy];
  c.others.forEach((x, i) => { v['o' + i] = v.others[i]; v['l' + i] = v.othersLL[i]; });
  const dir = L === 'ar' ? 'rtl' : 'ltr';
  const t = key => esc(APP.fill(T[key], v));
  const tt = key => `<span data-t="${key}">${t(key)}</span>`;
  const f = tpl => esc(APP.fill(tpl, v));
  const app = (cls, label) => `<span class="g ${cls}" data-app dir="${dir}" lang="${L}"${label ? ` role="group" aria-label="${esc(label)}"` : ''}>`;
  // The status bar, the back arrow and the "powered by" line, as on every screen of the app.
  const bar = '<span class="g-sb" aria-hidden="true"><span class="g-time">9:41</span><svg class="g-sbi" viewBox="0 0 68 14" focusable="false"><path d="M0 9.5h3v4H0zM4.6 7h3v6.5h-3zM9.2 4.5h3v9h-3zM13.8 1.5h3v12h-3z"/><path d="M30 13.6l-2.4-2.8a3.6 3.6 0 0 1 4.8 0zM24.2 7.4a8.4 8.4 0 0 1 11.6 0l-1.7 2a5.8 5.8 0 0 0-8.2 0zM20.8 4.2a13 13 0 0 1 18.4 0l-1.7 2a10.4 10.4 0 0 0-15 0z"/><path class="g-bat" d="M44.5 1.5h19v11h-19z"/><path d="M46.5 3.5h15v7h-15zM65 5h1.6v4H65z"/></svg></span>';
  const back = `<span class="g-back" aria-hidden="true">←</span>`;
  const powered = (cls = '') => `<span class="g-pw${cls}"><span data-t="powered">${t('powered')}</span> <svg class="g-logo" viewBox="0 0 350 50" role="img" aria-label="Aalayna" focusable="false">${LINE}</svg></span>`;
  const tile = (k, cls = '') => `<span class="g-tile k${k}${cls}" aria-hidden="true"></span>`;

  /* ---------- The menu ---------- */
  const row = id => {
    const q = S.q[id] || 0, k = APP.CAT_ORDER.indexOf(APP.D[id][0]), nm = APP.name(id, L), pr = APP.price(id, S);
    const label = nm + ', ' + pr + ', ' + (q ? APP.fill(T.onBill, { q }) : T.offBill);
    return `<button type="button" class="g-mi${q ? ' on' : ''}" data-act="dish" data-dish="${id}" aria-pressed="${q ? 'true' : 'false'}" aria-label="${esc(label)}" disabled>${tile(k, ' g-dt')}<span class="g-tx"><span class="g-mn">${esc(nm)}</span><span class="g-mar" lang="${L === 'ar' ? 'en' : 'ar'}">${esc(APP.alt(id, L))}</span></span><span class="g-end"><span class="g-qn">${q ? '×' + q : ''}</span><span class="g-mp">${esc(pr)}</span></span></button>`;
  };
  const sect = id => `<span class="g-sect"><span data-cat="${id}">${esc(APP.cat(id, L))}</span><span class="g-sect-ar" lang="ar">${esc(APP.cat(id, 'ar'))}</span></span>`;
  const sel = (act, opts, shown, cls) => `<span class="g-sel ${cls}"><span class="g-selv" data-f="{${act === 'lang' ? 'langName' : 'ccyName'}}">${esc(shown)}</span><select class="g-pick" data-act="${act}" aria-label="${t(act)}" data-t-aria="${act}" disabled>${opts}</select></span>`;
  const [sal, appz] = APP.SECTIONS;
  const menu = '<span class="screen">' + app('g-menu', P.menuL) +
    `<span class="scr-head g-hd">${bar}${back}<span class="g-mh"><span class="g-vn">Mayda</span><span class="g-vs" data-t="sub">${t('sub')}</span></span>` +
    `<span class="g-sels">${sel('lang', ['en', 'fr', 'ar'].map(x => `<option value="${x}" lang="${x}"${x === L ? ' selected' : ''}>${x.toUpperCase()}</option>`).join(''), v.langName, 'g-sel-l')}` +
    `${sel('ccy', ['usd', 'lbp'].map(x => `<option value="${x}" data-t="${x}"${x === S.ccy ? ' selected' : ''}>${t(x)}</option>`).join(''), v.ccyName, 'g-sel-c')}</span></span>` +
    `<span class="dish g-fc"><span class="g-fbtn" aria-hidden="true"><span class="g-fi">☰</span> ${tt('filters')}</span>` +
    `<span class="g-cats" aria-hidden="true">${APP.CAT_ORDER.map((id, k) => `<span class="g-cat${k ? '' : ' on'}">${tile(k)}<span data-cat="${id}">${esc(APP.cat(id, L))}</span></span>`).join('')}</span></span>` +
    `<span class="dish g-blk">${sect(sal[0])}${row(sal[1][0])}</span>` +
    `<span class="dish g-blk">${row(sal[1][1])}</span>` +
    `<span class="dish g-blk">${row(sal[1][2])}</span>` +
    `<span class="dish g-blk">${sect(appz[0])}${appz[1].map(row).join('')}</span>` +
    `<span class="dish g-barw"><span class="g-bar"><span class="g-bar-l"><span class="g-count" data-f="{count}" aria-hidden="true">${f('{count}')}</span>${tt('openBill')}</span><span class="g-bar-a" data-f="{total}" aria-live="polite">${f('{total}')}</span></span></span>` +
    '</span></span>';

  /* ---------- The split ---------- */
  const split = '<span class="screen">' + app('g-split', P.splitL) +
    `<span class="scr-head g-top">${bar}${back}</span>` +
    `<span class="sp-row g-q"><span class="g-title" data-t="splitTitle">${t('splitTitle')}</span><span class="g-subt" data-t="splitSub">${t('splitSub')}</span></span>` +
    `<span class="sp-row g-seg" aria-hidden="true"><span class="on" data-t="even">${t('even')}</span><span data-t="mine">${t('mine')}</span><span data-t="custom">${t('custom')}</span><span data-t="all">${t('all')}</span></span>` +
    `<span class="sp-row g-ppl"><span class="g-lab" data-t="howMany">${t('howMany')}</span><span class="g-stp">` +
    `<button type="button" class="g-sbm" data-act="ppl" data-d="-1" aria-label="${t('fewer')}" data-t-aria="fewer" aria-disabled="false" disabled>−</button>` +
    `<span class="g-n" data-f="{people}" aria-live="polite">${f('{people}')}</span>` +
    `<button type="button" class="g-sbp" data-act="ppl" data-d="1" aria-label="${t('more')}" data-t-aria="more" aria-disabled="false" disabled>+</button></span></span>` +
    `<span class="sp-row g-rest" data-t="rest">${t('rest')}</span>` +
    `<span class="sp-row g-dock"><span class="g-cta" data-t="cont">${t('cont')}</span>${powered()}</span>` +
    '</span></span>';
  const shareBox = (amt, ll, live) => `<span class="sv g-share"><span class="g-k" data-t="yourShare">${t('yourShare')}</span><span class="g-v" data-f="${amt}"${live ? ' aria-live="polite"' : ''}>${f(amt)}</span><span class="g-ll" data-f="${ll}">${f(ll)}</span></span>`;
  const splitFree = '<span class="free"><span class="spot" id="land-bill"></span>' +
    [0, 1, 2, 3, 4].map(k => `<span class="share share-o${k < S.people - 1 ? '' : ' off'}" data-k="${k}" data-app dir="${dir}" lang="${L}" aria-hidden="true">${shareBox('{o' + k + '}', '{l' + k + '}')}</span>`).join('') +
    `<span class="share share-me go" data-go="land-share" data-app dir="${dir}" lang="${L}">${shareBox('{share}', '{shareLL}', true)}<i class="go-sh"></i></span></span>`;

  /* ---------- The payment, and the thank-you screen under it ---------- */
  const tipB = (r, tp, tv) => `<button type="button" class="g-tipb${r === S.tip ? ' on' : ''}" data-act="tip" data-r="${r}" aria-pressed="${r === S.tip ? 'true' : 'false'}" disabled>${tp}${tv}</button>`;
  const pm = (on, mark, markCls, name, desc) => `<span class="g-pm${on ? ' on' : ''}"><span class="g-mark ${markCls}">${mark}</span><span class="g-pmt"><span class="g-pn">${name}</span><span class="g-pd">${desc}</span></span><span class="g-radio"></span></span>`;
  const done = app('g-done') + bar + `<span class="g-band">${[2, 5, 0, 4, 1, 3].map(k => tile(k)).join('')}</span>` +
    `<span class="g-seal">✓</span><span class="g-shk" data-t="thanks">${t('thanks')}</span>` +
    `<span class="g-rcpt"><span class="g-rca" data-f="{pay}">${f('{pay}')}</span><span class="g-rcr"><span data-t="paidVia">${t('paidVia')}</span><b>Whish Money</b></span><span class="g-rcr"><span data-t="tableL">${t('tableL')}</span><b>12</b></span></span>` +
    `<span class="g-mail"><span class="g-in" data-t="mailPh">${t('mailPh')}</span><span class="g-mb" data-t="send">${t('send')}</span></span>` +
    `<span class="g-cons"><span class="g-cb"></span><span data-t="offers">${t('offers')}</span></span>` +
    `<span class="g-rq" data-t="rateQ">${t('rateQ')}</span><span class="g-stars">★★★★★</span>${powered(' dk')}</span>`;
  const pay = '<span class="screen">' + app('g-pay', P.payL) +
    `<span class="pay-row g-top" data-k="0">${bar}${back}<span class="g-who" data-t="toPay">${t('toPay')}</span><span class="g-big" data-f="{pay}" aria-live="polite">${f('{pay}')}</span><span class="g-bll" data-f="{payLL}">${f('{payLL}')}</span></span>` +
    `<span class="pay-amt g-bd" id="land-share"><span><span data-t="billShare">${t('billShare')}</span><b data-f="{share}">${f('{share}')}</b></span><span><span data-t="tip">${t('tip')}</span><b data-f="{tip}">${f('{tip}')}</b></span></span>` +
    `<span class="pay-row g-tipw" data-k="1"><span class="g-tiph" data-t="tipFor">${t('tipFor')}</span><span class="g-tips">` +
    tipB(0, `<span class="g-tp" data-t="noTip">${t('noTip')}</span>`, '<span class="g-tv"> </span>') +
    tipB(0.05, `<span class="g-tp" data-f="{p5}">${f('{p5}')}</span>`, `<span class="g-tv" data-f="{t5}">${f('{t5}')}</span>`) +
    tipB(0.1, `<span class="g-tp" data-f="{p10}">${f('{p10}')}</span>`, `<span class="g-tv" data-f="{t10}">${f('{t10}')}</span>`) +
    tipB(0.15, `<span class="g-tp" data-f="{p15}">${f('{p15}')}</span>`, `<span class="g-tv" data-f="{t15}">${f('{t15}')}</span>`) + '</span></span>' +
    `<span class="pay-row g-pays" data-k="2" aria-hidden="true">${pm(true, 'whish', 'g-wh', 'Whish Money', `<span data-t="whishDesc">${t('whishDesc')}</span>`)}${pm(false, 'VISA', 'g-visa', `<span data-t="card">${t('card')}</span>`, 'Visa, Mastercard, Amex')}${pm(false, `<span data-t="cashMark">${t('cashMark')}</span>`, 'g-cash', `<span data-t="cash">${t('cash')}</span>`, `<span data-t="cashDesc">${t('cashDesc')}</span>`)}</span>` +
    `<span class="pay-row g-pww" data-k="3">${powered()}</span>` +
    `<span class="pay-row pay-btn g-cta" data-k="4" data-t="pay">${t('pay')}</span>` +
    `<span class="ly pay-thanks" aria-hidden="true">${done}</span>` +
    '</span></span>';
  const tick = L === 'ar' ? 'M190 20l6 6 12-12' : 'M96 20l6 6 12-12';
  const payFree = `<span class="free"><span class="paid-go go" data-go="land-paid" data-app dir="${dir}" lang="${L}" aria-hidden="true"><span class="g-chip"><svg viewBox="0 0 24 24" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span class="paid-line">${esc(APP.paidLine(S))}</span></span><i class="go-sh"></i></span></span>`;

  /* ---------- On the table: the receipt on the tray, the review card's Paid line ---------- */
  const r = APP.receipt(S, page);
  const receipt = `<span class="rc-pz receipt" style="--ar:200/${r.h}"><svg class="rc-ink" viewBox="0 0 200 ${r.h}" focusable="false">${r.svg}</svg></span>`;
  const rvPaid = `<svg class="ly rv-paid" viewBox="0 0 300 40" focusable="false"><rect class="paid" width="300" height="40"/><path class="tick paid-tick" d="${tick}"/><text class="z-b w6 wt paid-line" x="${L === 'ar' ? 132 : 162}" y="26" text-anchor="middle">${esc(APP.paidLine(S))}</text></svg>`;

  /* ---------- The captions: a hint on a wide screen, the controls themselves on a phone ---------- */
  const cb = (act, val, label, on, extra = '') => `<button type="button" class="ctl-b" data-act="${act}" data-v="${val}" aria-pressed="${on ? 'true' : 'false'}"${extra} disabled>${label}</button>`;
  const tryMenu = `<p class="try">${esc(P.tryMenu)}</p><div class="ctl" data-for="menu" role="group" aria-label="${esc(P.menuG)}">` +
    `<span class="ctl-g" role="group" aria-label="${esc(P.langG)}">${['en', 'fr', 'ar'].map(x => cb('lang', x, x.toUpperCase(), x === L, ` lang="${x}"`)).join('')}</span>` +
    `<span class="ctl-g" role="group" aria-label="${esc(P.ccyG)}">${cb('ccy', 'usd', esc(P.usd), S.ccy === 'usd')}${cb('ccy', 'lbp', esc(P.lbp), S.ccy === 'lbp')}</span></div>`;
  const trySplit = `<p class="try">${esc(P.trySplit)}</p><div class="ctl" data-for="split"><span class="ctl-l">${esc(P.guests)}</span><span class="ctl-g">` +
    `<button type="button" class="ctl-b" data-act="ppl" data-d="-1" aria-label="${esc(P.fewer)}" aria-disabled="false" disabled>−</button><span class="ctl-n" data-f="{people}" aria-live="polite">${S.people}</span>` +
    `<button type="button" class="ctl-b" data-act="ppl" data-d="1" aria-label="${esc(P.more)}" aria-disabled="false" disabled>+</button></span></div>`;
  const tryPay = `<p class="try">${esc(P.tryPay)}</p><div class="ctl" data-for="pay" role="group" aria-label="${esc(P.tipG)}">` +
    [[0, P.noTip], [0.05, '5%'], [0.1, '10%'], [0.15, '15%']].map(([r, l]) => `<button type="button" class="ctl-b" data-act="tip" data-r="${r}" aria-pressed="${r === S.tip ? 'true' : 'false'}" disabled>${esc(l)}</button>`).join('') + '</div>';


  return { menu, split, 'split-free': splitFree, pay, 'pay-free': payFree, receipt, 'rv-paid': rvPaid,
    'try-menu': tryMenu, 'try-split': trySplit, 'try-pay': tryPay };
}

for (const [file, page] of [['table-v1e.html', 'en'], ['ar/table-v1e.html', 'ar']]) {
  const p = path.join(ROOT, file);
  let s = fs.readFileSync(p, 'utf8');
  const parts = screens(page);
  for (const [name, html] of Object.entries(parts)) {
    const re = new RegExp('<!--g:' + name + '-->[\\s\\S]*?<!--/g:' + name + '-->');
    if (!re.test(s)) throw new Error(file + ': no region ' + name);
    s = s.replace(re, () => '<!--g:' + name + '-->' + html + '<!--/g:' + name + '-->');
  }
  fs.writeFileSync(p, s);
  console.log('wrote', file);
}
