#!/usr/bin/env node
'use strict';
/* Writes the SYNTHETIC ticket captures in this folder (*.bin) from the readable
   descriptions below. They are written from knowledge of typical guest-check layouts,
   not captured from a real POS; README.md says so and says how to add real ones.

     node tests/fixtures/pos-printer/make-fixtures.cjs          # rewrite the .bin files
     node tests/fixtures/pos-printer/make-fixtures.cjs --check  # exit 1 if any differs

   tests/pos-printer.test.cjs checks that the committed .bin files are what this script
   writes, and that each one parses to its *.expected.json, which was written by hand from
   the ticket as printed (not from the parser's output). */
const fs = require('node:fs');
const path = require('node:path');
const { encode, visualToLogical } = require('../../../tools/pos-printer/escpos.js');

const ESC = 0x1B, GS = 0x1D, DLE = 0x10, LF = 0x0A, HT = 0x09;

/* a tiny writer: every call appends bytes in the current code page */
function writer(codePage) {
  const parts = [];
  let cp = codePage || 'cp437';
  const w = {
    raw(...bytes) { parts.push(Buffer.from(bytes.flat())); return w; },
    init() { return w.raw(ESC, 0x40); },
    codePage(n, name) { cp = name; return w.raw(ESC, 0x74, n); },
    align(a) { return w.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); },
    mode(n) { return w.raw(ESC, 0x21, n); },
    bold(on) { return w.raw(ESC, 0x45, on ? 1 : 0); },
    size(wd, h) { return w.raw(GS, 0x21, ((wd - 1) << 4) | (h - 1)); },
    text(s) { parts.push(encode(s, cp)); return w; },
    line(s) { return w.text(s || '').raw(LF); },
    tabs(...stops) { return w.raw(ESC, 0x44, ...stops, 0); },
    tab() { return w.raw(HT); },
    feed(n) { return w.raw(ESC, 0x64, n); },
    cut(kind) { return kind === 'feed' ? w.raw(GS, 0x56, 65, 3) : kind === 'partial' ? w.raw(GS, 0x56, 1) : w.raw(GS, 0x56, 0); },
    raster(widthBytes, heightDots) {   // GS v 0: a logo; its data holds LF and ESC bytes on purpose
      const data = Array.from({ length: widthBytes * heightDots }, (_, i) => [0x0A, 0x1B, 0xFF, 0x00, 0x1D, 0x3C][i % 6]);
      return w.raw(GS, 0x76, 0x30, 0, widthBytes & 255, widthBytes >> 8, heightDots & 255, heightDots >> 8, data);
    },
    bitImage(columns) {                // ESC * 33: a 24-dot band of a legacy logo
      const data = Array.from({ length: 3 * columns }, (_, i) => (i % 5 === 0 ? 0x0A : 0x7E));
      return w.raw(ESC, 0x2A, 33, columns & 255, columns >> 8, data).raw(LF);
    },
    qr(data) {
      const d = Buffer.from(data, 'utf8'), n = d.length + 3;
      return w.raw(GS, 0x28, 0x6B, 4, 0, 49, 65, 50, 0)       // model 2
        .raw(GS, 0x28, 0x6B, 3, 0, 49, 67, 6)                  // module size
        .raw(GS, 0x28, 0x6B, 3, 0, 49, 69, 48)                 // error correction
        .raw(GS, 0x28, 0x6B, n & 255, n >> 8, 49, 80, 48, [...d])
        .raw(GS, 0x28, 0x6B, 3, 0, 49, 81, 48);
    },
    barcode(data) { return w.raw(GS, 0x68, 60, GS, 0x77, 2, GS, 0x6B, 73, data.length, [...Buffer.from(data, 'latin1')]); },
    drawer() { return w.raw(ESC, 0x70, 0, 25, 250); },
    beep() { return w.raw(ESC, 0x42, 3, 2); },
    status() { return w.raw(DLE, 0x04, 1); },
    bytes() { return Buffer.concat(parts); },
  };
  return w;
}
const row = (left, right, width = 48) => left + ' '.repeat(Math.max(1, width - Array.from(left).length - Array.from(right).length)) + right;
const SEP = (c = '-', n = 48) => c.repeat(n);

/* 1. A cloud POS (Foodics-style), 80 mm, CP437, raster logo, VAT added on top, QR code. */
function foodics() {
  const w = writer('cp437');
  w.status().raw(0, 0).init().align('center').raster(24, 16)
    .mode(0x30).line('MAYDA').mode(0).line('Hamra Street, Beirut').line('Tel: 01 345 678').line('VAT No: 123456-601')
    .align('left').line(SEP('='))
    .line(row('Order #1042', 'Dine In')).line(row('Table: 7', 'Guests: 2'))
    .line('Date: 27/10/2026 21:14').line('Cashier: Rami').line(SEP())
    .line(row('Qty  Item', 'Amount')).line(SEP())
    .line(row('2    Hummus', '10.00'))
    .line(row('1    Shish Taouk', '12.00'))
    .line(row('       + Extra garlic', '0.50'))
    .line('       + Fries')
    .line(row('1    Fattoush', '6.00'))
    .line(row('3    Pepsi', '6.00'))
    .line(SEP())
    .line(row('Subtotal', '34.50')).line(row('VAT 11%', '3.80'))
    .mode(0x30).line(row('TOTAL', 'USD 38.30', 24)).mode(0)
    .line(row('Total LBP', '3,427,850')).line(row('Rate', '89,500'))
    .feed(1).align('center').line('Thank you for dining with us').qr('https://receipts.example.invalid/1042')
    .feed(4).cut('feed');
  return w.bytes();
}

/* 2. Loyverse-style, 58 mm (32 columns), CP858, two-row items, paid in cash. */
function loyverse() {
  const W = 32, w = writer('cp437');
  w.init().codePage(19, 'cp858').align('center').bold(true).line('Café Younes').bold(false).line('Hamra, Beirut')
    .align('left').line(SEP('-', W))
    .line('Ticket: Table 4').line('Receipt #2-1015').line('POS: POS 1').line('Dining option: Dine in').line(SEP('-', W))
    .line(row('Espresso', '$6.00', W)).line('2 x $3.00')
    .line(row('Croissant', '$3.50', W))
    .line(row('Orange juice', '$4.50', W))
    .line(SEP('-', W))
    .bold(true).line(row('Total', '$14.00', W)).bold(false)
    .line(row('Cash', '$20.00', W)).line(row('Change', '$6.00', W))
    .line(SEP('-', W)).line(row('27/10/2026 10:42', '#2-1015', W))
    .align('center').line('Thank you!').barcode('{B21015').drawer().feed(3).cut('partial');
  return w.bytes();
}

/* 3. A legacy Windows POS (Omega-style): CP1252, French, LBP, double-width total, VAT included. */
function omega() {
  const w = writer('cp437');
  w.init().codePage(16, 'cp1252').align('center').bitImage(64).bitImage(64)
    .bold(true).line('LE PETIT CAFÉ').bold(false).line('Rue Gouraud, Gemmayzé').line('Tél: 01 567 890')
    .align('left').line(SEP())
    .line('Facture N°: 000587').line(row('Table: 12', 'Couverts: 4')).line('Serveur: Georges')
    .line('Date: 27/10/2026  Heure: 22:05').line(SEP())
    .line(row('Qté Désignation', 'P.U.'.padStart(9) + 'Montant'.padStart(13))).line(SEP())
    .line(row('2   Entrecôte', '1,250,000' + '2,500,000'.padStart(13)))
    .line(row('1   Crème brûlée', '450,000'.padStart(9) + '450,000'.padStart(13)))
    .line(row('2   Café', '180,000'.padStart(9) + '360,000'.padStart(13)))
    .line(row('1   Eau minérale', '135,000'.padStart(9) + '135,000'.padStart(13)))
    .line(SEP())
    .line(row('Sous-total', '3,445,000'))
    .mode(0x20).line(row('TOTAL L.L.', '3,445,000', 24)).mode(0)
    .line(row('dont TVA 11%', '341,396'))
    .line(row('Total USD', '38.49'))
    .feed(1).align('center').line('Merci de votre visite').feed(5).cut();
  return w.bytes();
}

/* 4. A generic guest check with a discount and a service charge; columns set with tabs. */
function discountServiceDoc(w, o) {
  w.init().align('center').mode(0x30).line('BEIT ZEITOUN').mode(0).line('Achrafieh, Beirut');
  if (o.reprint) w.bold(true).line('*** REPRINT ***').bold(false);
  w.align('left').line(SEP())
    .line(row('CHK 2291', 'TBL 14/1  GST 6')).line(o.when).line(SEP())
    .tabs(5, 30);
  for (const [q, name, amount] of o.items) w.text(q).tab().text(name).tab().line(amount.padStart(18));
  w.line(SEP())
    .line(row('Subtotal', o.subtotal)).line(row('Discount 10%', '-' + o.discount)).line(row('Service 12%', o.service))
    .mode(0x18).line(row('Total', o.total)).mode(0)
    .line('Prices include VAT 11%').line(row('Total LBP', o.lbp))
    .feed(2).align('center').line('Sahtein!').feed(3).cut('feed');
  return w;
}
const BEIT = {
  when: '27 Oct 2026 21:52',
  items: [['2', 'Mixed grill', '36.00'], ['1', 'Kebbeh nayyeh', '14.00'], ['4', 'Arak glass', '20.00'], ['1', 'Tabbouleh', '7.00'], ['1', 'Batata harra', '5.00']],
  subtotal: '82.00', discount: '8.20', service: '8.86', total: '82.66', lbp: '7,398,070',
};
function discountService() { return discountServiceDoc(writer('cp437'), BEIT).bytes(); }

/* 5. The same check printed again: first an exact reprint, then with a dessert added. */
function reprint() {
  const w = writer('cp437');
  discountServiceDoc(w, Object.assign({}, BEIT, { reprint: true }));
  discountServiceDoc(w, {
    when: '27 Oct 2026 22:10', items: BEIT.items.concat([['1', 'Knefeh', '6.00']]),
    subtotal: '88.00', discount: '8.80', service: '9.50', total: '88.70', lbp: '7,938,650',
  });
  return w.bytes();
}

/* 6. An Arabic guest check: CP1256, every line in visual order, right-aligned header. */
function arabic() {
  const W = 48, w = writer('cp437');
  const vis = (logical, width) => visualToLogical(logical.padEnd(width || W));   // logical -> visual, padded on the left of the paper
  const item = (name, qty, amount) => name + ' '.repeat(W - name.length - 6 - amount.length) + qty.padEnd(6) + amount;
  w.init().codePage(50, 'cp1256')
    .align('center').mode(0x30).line(visualToLogical('مطعم الزيتونة')).mode(0).line(visualToLogical('الحمرا - بيروت'))
    .align('right').line(visualToLogical('فاتورة رقم: 3318')).line(visualToLogical('طاولة: 5')).line(visualToLogical('التاريخ: 27/10/2026 20:45'))
    .align('left').line(SEP())
    .line(vis(item('حمص', '2', '10.00')))
    .line(vis(item('متبل', '1', '5.50')))
    .line(vis(item('شيش طاووق', '2', '24.00')))
    .line(vis('  بدون ثوم'))
    .line(vis(item('تبولة', '1', '6.00')))
    .line(vis(item('عصير ليمون', '3', '9.00')))
    .line(SEP())
    .line(vis(row('المجموع الفرعي', '54.50')))
    .line(vis(row('خدمة 10%', '5.45')))
    .mode(0x30).line(vis(row('المجموع', '$59.95', 24), 24)).mode(0)
    .feed(1).align('center').line(visualToLogical('شكرا لزيارتكم')).feed(4).cut('feed');
  return w.bytes();
}

/* 7. A kitchen ticket for the same table: no prices; it must be ignored. */
function kitchen() {
  const w = writer('cp437');
  w.init().align('center').mode(0x30).line('KITCHEN').mode(0).align('left')
    .line(row('Table: 7', 'Order #1042')).line('27/10/2026 21:02').line(SEP())
    .mode(0x10).line('2  Hummus').line('1  Shish Taouk').mode(0).line('   -- no garlic').line('   + Fries')
    .line(SEP()).beep().feed(3).cut('partial');
  return w.bytes();
}

const FIXTURES = {
  'cloud-foodics.bin': foodics,
  'loyverse-paid.bin': loyverse,
  'legacy-omega-cp1252.bin': omega,
  'discount-service.bin': discountService,
  'reprint.bin': reprint,
  'arabic-cp1256.bin': arabic,
  'kitchen.bin': kitchen,
};

function build() { return Object.fromEntries(Object.entries(FIXTURES).map(([name, fn]) => [name, fn()])); }

if (require.main === module) {
  const check = process.argv.includes('--check');
  let differs = 0;
  for (const [name, bytes] of Object.entries(build())) {
    const file = path.join(__dirname, name);
    const same = fs.existsSync(file) && fs.readFileSync(file).equals(bytes);
    if (check) { if (!same) { differs++; console.log('differs: ' + name); } }
    else if (!same) { fs.writeFileSync(file, bytes); console.log('wrote ' + name + ' (' + bytes.length + ' bytes)'); }
  }
  if (check) process.exit(differs ? 1 : 0);
}
module.exports = { build, writer, row };
