'use strict';
/* The printable table-card sheet. The card is qr.html's tent() card, copied markup for
   markup with its CSS (the .tent rules and the print rules), so a sheet printed from here
   looks like one printed from qr.html. The QR comes from qr-lib.js itself: it ends in a
   UMD wrapper, so Node can require it. */
const qrcode = require('../../qr-lib.js');

const BASE = 'https://aalayna.com/';

function tableURL(slug, table, token) {
  return BASE + 'guest.html?v=' + encodeURIComponent(slug) + '&t=' + table + '&s=' + token;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function qrSvg(url) {
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// qr.html tent(), same markup and copy
function tent(url, name, place, table) {
  return '<div class="tent">' +
    '<div class="top"><div class="vn">' + esc(name) + '</div>' +
    (place ? '<div class="vp">' + esc(place) + '</div>' : '') +
    '<div class="rule"></div></div>' +
    (table ? '<div class="tno">Table ' + table + '</div>' : '') +
    '<div class="mid"><div class="cta">See the menu · split the bill · pay</div>' +
    '<div class="cta-ar">شوف المنيو · اقسم الحساب · ادفع</div></div>' +
    '<div class="qr">' + qrSvg(url) + '</div>' +
    '<div class="how">Point your camera at the code, no app, no account. English, français, عربي.</div>' +
    '<div class="foot">powered by <b>Aalayna</b></div></div>';
}

const CSS = [
  ':root{--bg:#F6F6F4;--line:#E7E5E0;--ink:#171D1A;--sub:#68716B;--faint:#9AA29C;--green:#0F4B3A;--gold:#C9A227}',
  '*{margin:0;padding:0;box-sizing:border-box}',
  "body{font-family:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif;background:var(--bg);color:var(--ink);padding:28px 16px 48px;-webkit-font-smoothing:antialiased}",
  'header{max-width:960px;margin:0 auto 20px;font-size:12.5px;color:var(--sub);line-height:1.6}',
  'header h1{font-size:19px;font-weight:600;color:var(--ink);margin-bottom:4px}',
  '.sheet{display:flex;flex-wrap:wrap;gap:14px;justify-content:center}',
  '.tent{width:300px;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;text-align:center;box-shadow:0 1px 2px rgba(23,29,26,.05)}',
  '.tent .top{background:var(--green);color:#fff;padding:18px 16px 16px}',
  ".tent .vn{font-family:'Amiri',serif;font-size:22px;font-weight:700;line-height:1.15}",
  '.tent .vp{font-size:10px;color:#9DBBAC;margin-top:5px;letter-spacing:.14em;text-transform:uppercase}',
  '.tent .rule{width:36px;height:1px;background:var(--gold);margin:10px auto 0}',
  '.tent .mid{padding:18px 16px 6px}',
  '.tent .cta{font-size:13px;font-weight:600}',
  '.tent .cta-ar{font-size:13px;color:var(--sub);direction:rtl;margin-top:3px}',
  '.tent .qr{display:flex;justify-content:center;padding:12px 0 6px}',
  '.tent .qr svg{width:150px;height:150px}',
  '.tent .how{font-size:10.5px;color:var(--sub);line-height:1.55;padding:0 18px}',
  '.tent .foot{font-size:10px;color:var(--faint);padding:12px 0 14px}',
  '.tent .foot b{color:var(--sub);font-weight:600}',
  '.tent .tno{font-size:15px;font-weight:600;margin-top:10px;letter-spacing:.02em}',
  '.tcard{display:flex;flex-direction:column;align-items:center}',
  '.tlink{width:300px;font-size:10.5px;color:var(--faint);word-break:break-all;margin-top:6px}',
  '@media print{body{background:#fff;padding:0}header,.tlink{display:none !important}.sheet{gap:8mm}.tent{box-shadow:none;border:1px dashed #bbb;page-break-inside:avoid}}'
].join('\n');

/* tokens: [{table, token}] */
function sheet(venue, tokens) {
  const cards = tokens.slice().sort(function (a, b) { return a.table - b.table; }).map(function (t) {
    const url = tableURL(venue.slug, t.table, t.token);
    return '<div class="tcard" data-table="' + t.table + '">' + tent(url, venue.name, venue.place, t.table) + '<div class="tlink">' + esc(url) + '</div></div>';
  });
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(venue.name) + ' table cards</title>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=Amiri:wght@700&display=swap" rel="stylesheet">\n' +
    '<style>\n' + CSS + '\n</style>\n</head>\n<body>\n' +
    '<header><h1>' + esc(venue.name) + (venue.place ? ', ' + esc(venue.place) : '') + ': ' + cards.length + ' table card' + (cards.length === 1 ? '' : 's') + '</h1>' +
    'Print on card stock (this header and the links under the cards do not print). Each card opens that table\'s current bill. ' +
    'The codes are credentials: keep this file private, and replace a lost or copied card from qr.html.</header>\n' +
    '<div class="sheet">\n' + cards.join('\n') + '\n</div>\n</body>\n</html>\n';
}

module.exports = { sheet, tableURL, qrSvg, BASE };
