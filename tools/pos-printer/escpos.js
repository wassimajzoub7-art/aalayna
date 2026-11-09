'use strict';
/* ESC/POS stream parser: the bytes a receipt or kitchen printer receives become text lines
   with their print attributes, split into documents at each paper cut. Plain Node, no
   dependencies. tools/pos-printer/ticket.js turns the lines into a bill.

     const { parse, StreamParser } = require('./escpos.js');
     const { documents, warnings } = parse(buffer, { codePages: { 22: 'cp864' } });
     // documents: [{ lines: [{ text, align, bold, underline, width, height, invert,
     //               codePage, segments: [...] }], events: [...], cut: true|false }]

     const p = new StreamParser(opts);       // for a socket or a serial line
     p.push(chunk) -> documents completed by this chunk (a cut ends one)
     p.end()       -> the rest, then the parser is ready for the next job

   Handled: initialise (ESC @), print modes (ESC !), bold (ESC E, ESC G), underline
   (ESC -), alignment (ESC a), character size (GS !), reverse (GS B), fonts (ESC M), code
   pages (ESC t, with Epson's numbering and a per-printer override), line feeds (LF, ESC d,
   ESC J), tabs (HT, ESC D), absolute and relative positions (ESC $, ESC \), cuts (GS V,
   ESC i, ESC m), barcodes (GS k) and QR and PDF417 codes (GS ( k, the stored data is
   kept), drawer kick (ESC p), and the image commands (ESC *, GS v 0, GS ( L, GS 8 L,
   GS *), which are skipped by their declared length. Every other ESC, GS, FS and DLE
   command of the Epson set is skipped by its length; an unknown one costs two bytes and a
   warning. Text is decoded per run in the code page selected when it was printed: CP437,
   CP850, CP858, CP1252, CP864 and CP1256 are built in, others go through TextDecoder when
   the platform has them, and opts.encoding forces one (for example 'utf8') for printers
   that take UTF-8.

   Robust to partial reads: a command split across chunks waits for its remaining bytes.
   Robust to garbage: stray control bytes are dropped, a declared length over MAX_SKIP is
   treated as garbage, and at the end of a stream an incomplete command costs only its
   first byte, so the text after a bogus length prefix is still read. Nothing is thrown. */

const MAX_SKIP = 1 << 20;
const DEFAULT_TABS = [8, 16, 24, 32, 40, 48, 56, 64, 72, 80];

/* upper halves (0x80 to 0xFF) as code points; the lower half is ASCII except where noted */
const hex = (s) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));
const UPPER = {
  cp437: hex(`
    00C7 00FC 00E9 00E2 00E4 00E0 00E5 00E7 00EA 00EB 00E8 00EF 00EE 00EC 00C4 00C5
    00C9 00E6 00C6 00F4 00F6 00F2 00FB 00F9 00FF 00D6 00DC 00A2 00A3 00A5 20A7 0192
    00E1 00ED 00F3 00FA 00F1 00D1 00AA 00BA 00BF 2310 00AC 00BD 00BC 00A1 00AB 00BB
    2591 2592 2593 2502 2524 2561 2562 2556 2555 2563 2551 2557 255D 255C 255B 2510
    2514 2534 252C 251C 2500 253C 255E 255F 255A 2554 2569 2566 2560 2550 256C 2567
    2568 2564 2565 2559 2558 2552 2553 256B 256A 2518 250C 2588 2584 258C 2590 2580
    03B1 00DF 0393 03C0 03A3 03C3 00B5 03C4 03A6 0398 03A9 03B4 221E 03C6 03B5 2229
    2261 00B1 2265 2264 2320 2321 00F7 2248 00B0 2219 00B7 221A 207F 00B2 25A0 00A0`),
  cp850: hex(`
    00C7 00FC 00E9 00E2 00E4 00E0 00E5 00E7 00EA 00EB 00E8 00EF 00EE 00EC 00C4 00C5
    00C9 00E6 00C6 00F4 00F6 00F2 00FB 00F9 00FF 00D6 00DC 00F8 00A3 00D8 00D7 0192
    00E1 00ED 00F3 00FA 00F1 00D1 00AA 00BA 00BF 00AE 00AC 00BD 00BC 00A1 00AB 00BB
    2591 2592 2593 2502 2524 00C1 00C2 00C0 00A9 2563 2551 2557 255D 00A2 00A5 2510
    2514 2534 252C 251C 2500 253C 00E3 00C3 255A 2554 2569 2566 2560 2550 256C 00A4
    00F0 00D0 00CA 00CB 00C8 0131 00CD 00CE 00CF 2518 250C 2588 2584 00A6 00CC 2580
    00D3 00DF 00D4 00D2 00F5 00D5 00B5 00FE 00DE 00DA 00DB 00D9 00FD 00DD 00AF 00B4
    00AD 00B1 2017 00BE 00B6 00A7 00F7 00B8 00B0 00A8 00B7 00B9 00B3 00B2 25A0 00A0`),
  cp1252: hex(`
    20AC 0081 201A 0192 201E 2026 2020 2021 02C6 2030 0160 2039 0152 008D 017D 008F
    0090 2018 2019 201C 201D 2022 2013 2014 02DC 2122 0161 203A 0153 009D 017E 0178`)
    .concat(Array.from({ length: 96 }, (_, i) => 0xA0 + i)),
  /* IBM 864 (DOS Arabic): Arabic presentation forms, printed in visual order; FFFD where
     the code page defines nothing */
  cp864: hex(`
    00B0 00B7 2219 221A 2592 2500 2502 253C 2524 252C 251C 2534 2510 250C 2514 2518
    03B2 221E 03C6 00B1 00BD 00BC 2248 00AB 00BB FEF7 FEF8 FFFD FFFD FEFB FEFC FFFD
    00A0 00AD FE82 00A3 00A4 FE84 FFFD FFFD FE8E FE8F FE95 FE99 060C FE9D FEA1 FEA5
    0660 0661 0662 0663 0664 0665 0666 0667 0668 0669 FED1 061B FEB1 FEB5 FEB9 061F
    00A2 FE80 FE81 FE83 FE85 FECA FE8B FE8D FE91 FE93 FE97 FE9B FE9F FEA3 FEA7 FEA9
    FEAB FEAD FEAF FEB3 FEB7 FEBB FEBF FEC1 FEC5 FECB FECF 00A6 00AC 00F7 00D7 FEC9
    0640 FED3 FED7 FEDB FEDF FEE3 FEE7 FEEB FEED FEEF FEF3 FEBD FECC FECE FECD FEE1
    FE7D 0651 FEE5 FEE9 FEEC FEF0 FEF2 FED0 FED5 FEF5 FEF6 FEDD FED9 FEF1 25A0 FFFD`),
  /* Windows-1256 as WHATWG defines it */
  cp1256: hex(`
    20AC 067E 201A 0192 201E 2026 2020 2021 02C6 2030 0679 2039 0152 0686 0698 0688
    06AF 2018 2019 201C 201D 2022 2013 2014 06A9 2122 0691 203A 0153 200C 200D 06BA
    00A0 060C 00A2 00A3 00A4 00A5 00A6 00A7 00A8 00A9 06BE 00AB 00AC 00AD 00AE 00AF
    00B0 00B1 00B2 00B3 00B4 00B5 00B6 00B7 00B8 00B9 061B 00BB 00BC 00BD 00BE 061F
    06C1 0621 0622 0623 0624 0625 0626 0627 0628 0629 062A 062B 062C 062D 062E 062F
    0630 0631 0632 0633 0634 0635 0636 00D7 0637 0638 0639 063A 0640 0641 0642 0643
    00E0 0644 00E2 0645 0646 0647 0648 00E7 00E8 00E9 00EA 00EB 0649 064A 00EE 00EF
    064B 064C 064D 064E 00F4 064F 0650 00F7 0651 00F9 0652 00FB 00FC 200E 200F 06D2`),
};
UPPER.cp858 = UPPER.cp850.slice(); UPPER.cp858[0xD5 - 0x80] = 0x20AC;

const TABLES = {};
for (const name of Object.keys(UPPER)) {
  const t = new Array(256);
  for (let i = 0; i < 128; i++) t[i] = String.fromCharCode(i);
  UPPER[name].forEach((cp, i) => { t[128 + i] = String.fromCodePoint(cp); });
  if (name === 'cp864') t[0x25] = '٪';
  TABLES[name] = t;
}
/* code pages the platform may decode (full-ICU Node); never windows-1252, which some Node
   versions decode as latin1 */
const DECODER_LABELS = { cp866: 'ibm866', cp1250: 'windows-1250', cp1251: 'windows-1251', cp1253: 'windows-1253',
  cp1254: 'windows-1254', cp1255: 'windows-1255', cp1257: 'windows-1257', cp1258: 'windows-1258',
  'iso8859-2': 'iso-8859-2', 'iso8859-7': 'iso-8859-7', 'iso8859-15': 'iso-8859-15', utf8: 'utf-8' };

/* ESC t n, Epson numbering. Many clone printers number differently (Arabic is often 22 or
   28): the printer's self-test page lists its own table, and opts.codePages overrides. */
const ESC_T = { 0: 'cp437', 2: 'cp850', 3: 'cp860', 4: 'cp863', 5: 'cp865', 11: 'cp851', 12: 'cp853', 13: 'cp857',
  14: 'cp737', 15: 'iso8859-7', 16: 'cp1252', 17: 'cp866', 18: 'cp852', 19: 'cp858', 32: 'cp720', 34: 'cp855',
  35: 'cp861', 36: 'cp862', 37: 'cp864', 38: 'cp869', 39: 'iso8859-2', 40: 'iso8859-15', 45: 'cp1250', 46: 'cp1251',
  47: 'cp1253', 48: 'cp1254', 49: 'cp1255', 50: 'cp1256', 51: 'cp1257', 52: 'cp1258' };

const ALIASES = { 'utf-8': 'utf8', 'windows-1252': 'cp1252', 'windows-1256': 'cp1256', 'ibm864': 'cp864', 'ibm437': 'cp437',
  'pc437': 'cp437', 'pc850': 'cp850', 'pc858': 'cp858', 'pc864': 'cp864', 'wpc1252': 'cp1252', 'wpc1256': 'cp1256', 'latin1': 'cp1252' };
const canonical = (name) => { const n = String(name || '').toLowerCase().replace(/[\s_]/g, ''); return ALIASES[n] || n; };

const decoderCache = {};
function platformDecoder(name) {
  if (name in decoderCache) return decoderCache[name];
  let d = null;
  try { if (DECODER_LABELS[name]) d = new TextDecoder(DECODER_LABELS[name]); } catch (e) { d = null; }
  decoderCache[name] = d;
  return d;
}
const supported = (name) => !!TABLES[canonical(name)] || !!platformDecoder(canonical(name));

/* bytes (array or Buffer) in a code page -> string; an unknown code page decodes as CP437
   and says so */
function decode(bytes, codePage) {
  const name = canonical(codePage);
  const t = TABLES[name];
  if (t) { let s = ''; for (let i = 0; i < bytes.length; i++) s += t[bytes[i]]; return { text: s, known: true }; }
  const d = platformDecoder(name);
  if (d) return { text: d.decode(Uint8Array.from(bytes)), known: true };
  let s = ''; for (let i = 0; i < bytes.length; i++) s += TABLES.cp437[bytes[i]];
  return { text: s, known: false };
}
/* string -> bytes in a single-byte code page (for fixtures and tests); characters the
   page lacks become '?' */
function encode(text, codePage) {
  const name = canonical(codePage);
  if (name === 'utf8') return Buffer.from(text, 'utf8');
  const t = TABLES[name];
  if (!t) throw new Error('no table for ' + codePage);
  const rev = new Map();
  for (let i = 255; i >= 0; i--) if (t[i] !== '�') rev.set(t[i], i);
  if (name === 'cp864') {
    // base letters to one of their presentation forms, so logical Arabic can be encoded
    for (let i = 255; i >= 128; i--) { const base = t[i].normalize('NFKC'); if (base.length === 1 && !rev.has(base)) rev.set(base, i); }
    rev.set('%', 0x25);
  }
  return Buffer.from(Array.from(text).map((ch) => (rev.has(ch) ? rev.get(ch) : 0x3F)));
}

function freshState(opts) {
  return { align: 'left', bold: false, underline: false, width: 1, height: 1, invert: false, font: 'A',
    codePage: canonical(opts.codePage || 'cp437'), tabs: DEFAULT_TABS.slice() };
}

class StreamParser {
  constructor(opts) {
    this.opts = Object.assign({ dotsPerColumn: 12 }, opts || {});
    this.codePageMap = Object.assign({}, ESC_T);
    for (const [k, v] of Object.entries(this.opts.codePages || {})) this.codePageMap[Number(k)] = canonical(v);
    this.forced = this.opts.encoding ? canonical(this.opts.encoding) : null;
    this.buf = Buffer.alloc(0);
    this.warnings = [];
    this.bytesSeen = 0;
    this.resetJob();
  }
  resetJob() {
    this.state = freshState(this.opts);
    this.doc = { lines: [], events: [] };
    this.segments = []; this.col = 0;
    this.run = null;
  }
  warn(code, detail) { if (this.warnings.length < 200) this.warnings.push(Object.assign({ code, at: this.bytesSeen }, detail || {})); }
  event(type, data) { this.flushRun(); this.doc.events.push(Object.assign({ type, line: this.doc.lines.length }, data || {})); }

  /* text bytes accumulate in a run that keeps the attributes they were printed with */
  addText(byte) {
    const s = this.state;
    const cp = this.forced || s.codePage;
    if (!this.run || this.run.codePage !== cp) {
      this.flushRun();
      this.run = { codePage: cp, bytes: [], bold: s.bold, underline: s.underline, width: s.width, height: s.height, invert: s.invert, font: s.font };
    }
    this.run.bytes.push(byte);
  }
  flushRun() {
    const r = this.run;
    if (!r) return;
    this.run = null;
    const d = decode(r.bytes, r.codePage);
    if (!d.known) this.warn('unknown_code_page', { codePage: r.codePage });
    this.pushSegment(d.text, r);
  }
  pushSegment(text, attrs) {
    if (!text) return;
    const last = this.segments[this.segments.length - 1];
    const same = last && last.bold === attrs.bold && last.underline === attrs.underline && last.width === attrs.width &&
      last.height === attrs.height && last.invert === attrs.invert && last.codePage === attrs.codePage;
    if (same) last.text += text;
    else this.segments.push({ text, bold: attrs.bold, underline: attrs.underline, width: attrs.width, height: attrs.height,
      invert: attrs.invert, codePage: attrs.codePage });
    this.col += Array.from(text).length * (attrs.width || 1);
  }
  /* pad with spaces (in the current attributes) up to a printed column */
  padTo(column) {
    this.flushRun();
    const w = this.state.width || 1;
    const n = Math.floor((column - this.col) / w);
    if (n > 0 && n < 400) this.pushSegment(' '.repeat(n), Object.assign({}, this.state, { codePage: this.forced || this.state.codePage }));
  }
  /* LF and the print-and-feed commands end the line */
  endLine() {
    this.flushRun();
    const segs = this.segments;
    const text = segs.map((g) => g.text).join('');
    const ink = segs.filter((g) => g.text.trim());
    const line = {
      text, align: this.state.align,
      bold: ink.some((g) => g.bold), underline: ink.some((g) => g.underline), invert: ink.some((g) => g.invert),
      width: ink.reduce((m, g) => Math.max(m, g.width), 1), height: ink.reduce((m, g) => Math.max(m, g.height), 1),
      codePage: (ink[0] || segs[0] || { codePage: this.forced || this.state.codePage }).codePage,
      columns: this.col, segments: segs,
    };
    this.doc.lines.push(line);
    this.segments = []; this.col = 0;
  }
  hasPending() { return !!(this.run || this.segments.length); }
  finishDoc(cut) {
    if (this.hasPending()) this.endLine();
    const doc = this.doc;
    doc.cut = cut;
    const keep = doc.lines.some((l) => l.text.trim()) || doc.events.some((e) => e.type !== 'init' && e.type !== 'code_page' && e.type !== 'status');
    // a new document keeps the print modes (printers do), but not the lines
    this.doc = { lines: [], events: [] };
    return keep ? doc : null;
  }

  push(chunk) {
    if (chunk && chunk.length) this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    return this.process(false);
  }
  end() {
    const out = this.process(true);
    const last = this.finishDoc(false);
    if (last) out.push(last);
    this.resetJob();
    return out;
  }
  process(final) {
    const out = [], b = this.buf;
    let i = 0;
    while (i < b.length) {
      let n = this.step(b, i, out);
      if (n < 0) {
        if (!final) break;
        this.warn('truncated_command', { byte: b[i] });
        n = 1;  // resync: drop the prefix byte and read on
      }
      i += n; this.bytesSeen += n;
    }
    this.buf = b.subarray(i);
    return out;
  }

  /* one token at b[i] -> bytes consumed, or -1 when the token is not complete yet */
  step(b, i, out) {
    const c = b[i];
    if (c >= 0x20 && c !== 0x7F) { this.addText(c); return 1; }
    switch (c) {
      case 0x0A: this.endLine(); return 1;
      case 0x0D: return 1;                       // CR: printers ignore it when LF follows
      case 0x0C: this.endLine(); return 1;       // FF in standard mode: print and feed
      case 0x09: {                               // HT: next tab stop
        this.flushRun();
        const w = this.state.width || 1;
        const stop = this.state.tabs.map((t) => t * w).find((t) => t > this.col);
        if (stop !== undefined) this.padTo(stop);
        return 1;
      }
      case 0x1B: return this.esc(b, i, out);
      case 0x1D: return this.gs(b, i, out);
      case 0x1C: return this.fs(b, i);
      case 0x10: return this.dle(b, i);
      default: return 1;                         // NUL and stray control bytes
    }
  }
  need(b, i, n) { return i + n <= b.length; }
  skip(b, i, header, len, what) {
    if (len > MAX_SKIP) { this.warn('implausible_length', { command: what, length: len }); return 1; }
    return this.need(b, i, header + len) ? header + len : -1;
  }
  setCodePage(n) {
    this.flushRun();
    const name = this.codePageMap[n];
    if (!name) this.warn('unknown_code_page', { escT: n });
    else if (!supported(name)) this.warn('unsupported_code_page', { escT: n, codePage: name });
    this.state.codePage = name || ('esc-t-' + n);
    this.event('code_page', { codePage: this.state.codePage, n });
  }

  esc(b, i, out) {
    if (!this.need(b, i, 2)) return -1;
    const cmd = b[i + 1], s = this.state;
    const arg = () => b[i + 2];
    const one = (fn) => { if (!this.need(b, i, 3)) return -1; this.flushRun(); fn(arg()); return 3; };
    switch (cmd) {
      case 0x40: // ESC @ initialise
        if (this.hasPending()) this.endLine();
        this.state = Object.assign(freshState(this.opts), {});
        this.event('init');
        return 2;
      case 0x21: return one((n) => { s.font = n & 1 ? 'B' : 'A'; s.bold = !!(n & 8); s.height = n & 16 ? 2 : 1; s.width = n & 32 ? 2 : 1; s.underline = !!(n & 128); });
      case 0x45: case 0x47: return one((n) => { s.bold = !!(n & 1); });
      case 0x2D: return one((n) => { s.underline = (n & 3) !== 0 && n !== 48; });
      case 0x61: return one((n) => { const a = n >= 48 ? n - 48 : n; s.align = a === 1 ? 'center' : a === 2 ? 'right' : 'left'; });
      case 0x74: if (!this.need(b, i, 3)) return -1; this.setCodePage(arg()); return 3;
      case 0x4D: return one((n) => { s.font = (n & 1) ? 'B' : 'A'; });
      case 0x64: // ESC d n: print and feed n lines
        if (!this.need(b, i, 3)) return -1;
        this.endLine();
        for (let k = 1; k < Math.min(arg(), 20); k++) this.endLine();
        return 3;
      case 0x4A: if (!this.need(b, i, 3)) return -1; this.endLine(); return 3;  // ESC J: print and feed dots
      case 0x65: case 0x4B: if (!this.need(b, i, 3)) return -1; return 3;      // reverse feeds
      case 0x69: case 0x6D: { // ESC i / ESC m: legacy cuts
        this.event('cut', { partial: cmd === 0x6D });
        const d = this.finishDoc(true); if (d) out.push(d);
        return 2;
      }
      case 0x70: if (!this.need(b, i, 5)) return -1; this.event('drawer', { pin: b[i + 2] & 1 }); return 5;
      case 0x42: if (!this.need(b, i, 4)) return -1; this.event('beep', { times: b[i + 2] }); return 4;  // ESC B n t (clones)
      case 0x24: case 0x5C: { // ESC $ absolute, ESC \ relative position, in dots
        if (!this.need(b, i, 4)) return -1;
        this.flushRun();
        let dots = b[i + 2] + b[i + 3] * 256;
        const perCol = (this.opts.dotsPerColumn || 12) * (s.font === 'B' ? 0.75 : 1);
        if (cmd === 0x5C) { if (dots > 32767) dots -= 65536; this.padTo(this.col + Math.round(dots / perCol)); }
        else this.padTo(Math.round(dots / perCol));
        return 4;
      }
      case 0x44: { // ESC D n1 ... nk NUL: tab stops
        let j = i + 2;
        while (j < b.length && b[j] !== 0 && j - i < 35) j++;
        if (j >= b.length) return -1;
        const stops = Array.from(b.subarray(i + 2, j)).filter((v, k, a) => k === 0 || v > a[k - 1]);
        this.flushRun();
        s.tabs = stops.length ? stops : DEFAULT_TABS.slice();
        return j - i + (b[j] === 0 ? 1 : 0);
      }
      case 0x2A: { // ESC * m nL nH d: bit image
        if (!this.need(b, i, 5)) return -1;
        const m = b[i + 2], n = b[i + 3] + b[i + 4] * 256;
        if (![0, 1, 32, 33].includes(m)) { this.warn('bad_command', { command: 'ESC *' }); return 1; }
        const len = (m === 32 || m === 33) ? 3 * n : n;
        const r = this.skip(b, i, 5, len, 'ESC *');
        if (r > 1) this.event('image', { command: 'ESC *', bytes: len });
        return r;
      }
      case 0x26: { // ESC & y c1 c2 [x d1..d(y*x)] ...: user-defined characters
        if (!this.need(b, i, 5)) return -1;
        const y = b[i + 2], c1 = b[i + 3], c2 = b[i + 4];
        if (c2 < c1 || c2 - c1 > 95) { this.warn('bad_user_chars'); return 5; }
        let j = i + 5;
        for (let ch = c1; ch <= c2; ch++) { if (j >= b.length) return -1; j += 1 + y * b[j]; }
        return j > b.length ? -1 : j - i;
      }
      case 0x28: { // ESC ( fn pL pH data
        if (!this.need(b, i, 5)) return -1;
        return this.skip(b, i, 5, b[i + 3] + b[i + 4] * 256, 'ESC (');
      }
      case 0x57: return this.need(b, i, 10) ? 10 : -1;                         // ESC W page area
      case 0x63: return this.need(b, i, 4) ? 4 : -1;                           // ESC c 3|4|5 n
      case 0x32: case 0x3C: case 0x46: case 0x48: case 0x4C: case 0x53: case 0x0C: case 0x31: case 0x30: return 2;
      case 0x20: case 0x25: case 0x33: case 0x3D: case 0x3F: case 0x52: case 0x54: case 0x55: case 0x56:
      case 0x72: case 0x7B: case 0x2F: case 0x6E: case 0x75: case 0x76: case 0x71:
        return this.need(b, i, 3) ? 3 : -1;
      default:
        this.warn('unknown_esc', { cmd });
        return 2;
    }
  }

  gs(b, i, out) {
    if (!this.need(b, i, 2)) return -1;
    const cmd = b[i + 1], s = this.state;
    switch (cmd) {
      case 0x21: if (!this.need(b, i, 3)) return -1; this.flushRun(); s.width = ((b[i + 2] >> 4) & 7) + 1; s.height = (b[i + 2] & 7) + 1; return 3;
      case 0x42: if (!this.need(b, i, 3)) return -1; this.flushRun(); s.invert = !!(b[i + 2] & 1); return 3;
      case 0x56: { // GS V cut
        if (!this.need(b, i, 3)) return -1;
        const m = b[i + 2];
        const len = [65, 66, 97, 98, 103, 104].includes(m) ? 4 : 3;
        if (!this.need(b, i, len)) return -1;
        this.event('cut', { partial: m === 1 || m === 49 || m === 66 || m === 98 });
        const d = this.finishDoc(true); if (d) out.push(d);
        return len;
      }
      case 0x6B: { // GS k barcode
        if (!this.need(b, i, 3)) return -1;
        const m = b[i + 2];
        if (m <= 6) {
          let j = i + 3;
          while (j < b.length && b[j] !== 0 && j - i < 260) j++;
          if (j >= b.length) return -1;
          this.event('barcode', { system: m, data: decode(b.subarray(i + 3, j), 'cp437').text });
          return j - i + 1;
        }
        if (!this.need(b, i, 4)) return -1;
        const n = b[i + 3];
        if (!this.need(b, i, 4 + n)) return -1;
        this.event('barcode', { system: m, data: decode(b.subarray(i + 4, i + 4 + n), 'cp437').text });
        return 4 + n;
      }
      case 0x28: { // GS ( fn pL pH data: 2D codes (k), graphics (L), others
        if (!this.need(b, i, 5)) return -1;
        const fn = b[i + 2], len = b[i + 3] + b[i + 4] * 256;
        if (fn === 0x6B) {
          // a 2D-code function names its symbol (cn 48 to 53) and function (65 to 90); anything
          // else is not one, and its "length" must not swallow the ticket
          if (!this.need(b, i, 7)) return -1;
          if (len < 2 || b[i + 5] < 48 || b[i + 5] > 53 || b[i + 6] < 65 || b[i + 6] > 90) { this.warn('bad_command', { command: 'GS ( k' }); return 1; }
        }
        const r = this.skip(b, i, 5, len, 'GS (');
        if (r <= 1) return r;
        if (fn === 0x6B && len >= 3) {
          const cn = b[i + 5], f = b[i + 6];
          if (f === 80 && len >= 4) {
            const data = b.subarray(i + 8, i + 5 + len);
            this.pendingCode = { type: cn === 49 ? 'qr' : cn === 48 ? 'pdf417' : '2d', data: Buffer.from(data).toString('utf8') };
          } else if (f === 81 && this.pendingCode) { this.event(this.pendingCode.type, { data: this.pendingCode.data }); this.pendingCode = null; }
        } else if (fn === 0x4C) this.event('image', { command: 'GS ( L', bytes: len });
        return r;
      }
      case 0x38: { // GS 8 L p1 p2 p3 p4 data
        if (!this.need(b, i, 7)) return -1;
        const len = b[i + 3] + b[i + 4] * 256 + b[i + 5] * 65536 + b[i + 6] * 16777216;
        const r = this.skip(b, i, 7, len, 'GS 8 L');
        if (r > 1) this.event('image', { command: 'GS 8 L', bytes: len });
        return r;
      }
      case 0x76: { // GS v 0 m xL xH yL yH d: raster image
        if (!this.need(b, i, 8)) return -1;
        if (b[i + 2] !== 0x30 || ![0, 1, 2, 3, 48, 49, 50, 51].includes(b[i + 3])) { this.warn('bad_command', { command: 'GS v' }); return 1; }
        const len = (b[i + 4] + b[i + 5] * 256) * (b[i + 6] + b[i + 7] * 256);
        const r = this.skip(b, i, 8, len, 'GS v 0');
        if (r > 1) this.event('image', { command: 'GS v 0', bytes: len, widthBytes: b[i + 4] + b[i + 5] * 256, heightDots: b[i + 6] + b[i + 7] * 256 });
        return r;
      }
      case 0x2A: { // GS * x y d: downloaded bit image
        if (!this.need(b, i, 4)) return -1;
        return this.skip(b, i, 4, b[i + 2] * b[i + 3] * 8, 'GS *');
      }
      case 0x51: { // GS Q 0 m xL xH yL yH d (variable raster, a few models)
        if (!this.need(b, i, 9)) return -1;
        return this.skip(b, i, 9, (b[i + 4] + b[i + 5] * 256) * (b[i + 6] + b[i + 7] * 256), 'GS Q 0');
      }
      case 0x4C: case 0x57: case 0x50: case 0x24: case 0x5C: return this.need(b, i, 4) ? 4 : -1;
      case 0x5E: return this.need(b, i, 5) ? 5 : -1;
      case 0x3A: return 2;
      case 0x48: case 0x68: case 0x77: case 0x66: case 0x61: case 0x62: case 0x72: case 0x49: case 0x2F: case 0x54:
      case 0x5A: case 0x7C: case 0x45: case 0x4A:
        return this.need(b, i, 3) ? 3 : -1;
      default:
        this.warn('unknown_gs', { cmd });
        return 2;
    }
  }

  fs(b, i) {
    if (!this.need(b, i, 2)) return -1;
    const cmd = b[i + 1];
    switch (cmd) {
      case 0x26: case 0x2E: return 2;                                          // Kanji mode on/off
      case 0x21: case 0x2D: case 0x43: case 0x57: return this.need(b, i, 3) ? 3 : -1;
      case 0x53: case 0x70: return this.need(b, i, 4) ? 4 : -1;                // FS S, FS p (NV image)
      case 0x32: return this.need(b, i, 4) ? this.skip(b, i, 4, 72, 'FS 2') : -1;
      case 0x71: { // FS q n [xL xH yL yH d]...: define NV images
        if (!this.need(b, i, 3)) return -1;
        let j = i + 3;
        for (let k = 0; k < b[i + 2]; k++) {
          if (j + 4 > b.length) return -1;
          const len = (b[j] + b[j + 1] * 256) * (b[j + 2] + b[j + 3] * 256) * 8;
          if (len > MAX_SKIP) { this.warn('implausible_length', { command: 'FS q' }); return 1; }
          j += 4 + len;
        }
        return j > b.length ? -1 : j - i;
      }
      default: this.warn('unknown_fs', { cmd }); return 2;
    }
  }

  dle(b, i) {
    if (!this.need(b, i, 2)) return -1;
    const cmd = b[i + 1];
    if (cmd === 0x04 || cmd === 0x05) { if (!this.need(b, i, 3)) return -1; this.event('status', { request: b[i + 2] }); return 3; }
    if (cmd === 0x14) return this.need(b, i, 5) ? 5 : -1;
    return 1;  // a lone DLE is garbage
  }
}

/* a whole capture -> {documents, warnings} */
function parse(bytes, opts) {
  const p = new StreamParser(opts);
  const documents = p.push(bytes).concat(p.end());
  return { documents, warnings: p.warnings };
}

/* Text helpers for the ticket layer. */
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const hasArabic = (s) => ARABIC.test(s);

/* presentation forms to letters (NFKC), Arabic-Indic digits and separators to ASCII,
   tatweel, bidi marks and C1 controls removed, no-break spaces to spaces */
function normalizeText(s) {
  return String(s).normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, '.').replace(/٬/g, ',').replace(/٪/g, '%').replace(/،/g, '،')
    .replace(/[ـ​-‏‪-‮⁦-⁩﻿\u0080-\u009F�]/g, '')
    .replace(/[   ]/g, ' ');
}

/* A printer has no bidi: a POS that prints Arabic in text mode sends each line in visual
   order (left to right as it lands on paper). This turns such a line back into logical
   order: the line is reversed, then each run that reads left to right (Latin words with
   the spaces between them, a number with its separators and currency signs) is turned
   back. Mirrored brackets swap. The same function goes the other way, for fixtures. */
const LTR_RUN = /(?:[$€£%]\s?)?\d+(?:[.,:\/\-]\d+)*(?:\s?[$€£%])?|[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ0-9'&.\-]*(?:[ ]+[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ0-9'&.\-]*)*/g;
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
function visualToLogical(line) {
  const rev = Array.from(line).reverse().join('');
  let out = '', last = 0;
  rev.replace(LTR_RUN, (m, at) => {
    out += Array.from(rev.slice(last, at)).map((c) => MIRROR[c] || c).join('');
    out += Array.from(m).reverse().join('');
    last = at + m.length;
    return m;
  });
  return out + Array.from(rev.slice(last)).map((c) => MIRROR[c] || c).join('');
}

module.exports = { parse, StreamParser, decode, encode, normalizeText, visualToLogical, hasArabic, ESC_T, MAX_SKIP,
  codePages: () => Object.keys(TABLES), supported };
