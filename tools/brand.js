#!/usr/bin/env node
// Builds the logo files from brand/logo.js and renders the logo motion from brand/motion.html.
//
//   node tools/brand.js svg                      rewrites brand/svg: the Kufi files, and 3layna/ and aalayna/
//   node tools/brand.js site                     redraws the logo inside <a class="logo"> on the site's pages
//   node tools/brand.js images [--fonts dir]     renders the share image (images/og-image.*) and the favicons
//   node tools/brand.js video [--piece block|kufi] [--word AALAYNA] [--size 1920x1080] [--ground cream|ink|petrol]
//                             [--fps 60] [--out file.mp4] [--audio file.wav] [--ffmpeg path] [--fonts dir]
//   node tools/brand.js stills --piece kufi --at 0.5,1,2 [--word AALAYNA] [--size 960x540] [--out dir]
//
// images, video and stills need Playwright (Chromium) and, for video, an ffmpeg with libx264. Like render-reel.js,
// every frame calls the page's __render(t), so the output is exact at any frame rate. --fonts serves the
// Google Fonts request from a folder holding local.css and the font files it names.
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const Logo = require(path.join(root, 'brand/logo.js'));

// Every logo file, as { 'path/name.svg': contents }: the Kufi files (the same for every spelling) at the
// top, and each spelling's Block, one-line name, lockups and icon in a folder of its own.
function svgContents() {
  const C = Logo.COLORS;
  const dark = { ink: C.cream, red: C.red }, petrol = { ink: C.cream, red: C.peach }, mono = c => ({ ink: c, red: c });
  const files = {
    'kufi.svg': [Logo.kufi(), {}, 'علينا'],
    'kufi-cream.svg': [Logo.kufi(), dark, 'علينا'],
    'kufi-petrol.svg': [Logo.kufi(), petrol, 'علينا'],
    'kufi-ink.svg': [Logo.kufi(), mono(C.ink), 'علينا'],
    'icon-kufi.svg': [Logo.iconKufi(), { tile: C.ink, ink: C.cream, red: C.red }, 'علينا'],
  };
  for (const word of Logo.SPELLINGS) {
    const dir = word.toLowerCase() + '/', name = word[0] + word.slice(1).toLowerCase();
    Object.assign(files, {
      [dir + 'block.svg']: [Logo.block(word), {}, name],
      [dir + 'block-cream.svg']: [Logo.block(word), dark, name],
      [dir + 'block-petrol.svg']: [Logo.block(word), petrol, name],
      [dir + 'block-ink.svg']: [Logo.block(word), mono(C.ink), name],
      [dir + 'line.svg']: [Logo.line(word), {}, name],
      [dir + 'line-cream.svg']: [Logo.line(word), dark, name],
      [dir + 'lockup.svg']: [Logo.lockup(word), {}, 'علينا ' + name],
      [dir + 'lockup-cream.svg']: [Logo.lockup(word), dark, 'علينا ' + name],
      [dir + 'lockup-latin.svg']: [Logo.lockupLatin(word), {}, name + ' علينا'],
      [dir + 'icon.svg']: [Logo.iconBlock(word), Logo.iconBlockColors(word), name],
    });
  }
  const out = {};
  for (const [file, [mark, colors, title]] of Object.entries(files)) out[file] = Logo.svg(mark, colors, 0, Logo.U, title) + '\n';
  return out;
}
function svgFiles() {
  const out = path.join(root, 'brand/svg'), files = svgContents();
  fs.rmSync(out, { recursive: true, force: true });   // generated: nothing else lives here
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true }); fs.writeFileSync(path.join(out, file), text); }
  console.log('wrote ' + Object.keys(files).length + ' files to brand/svg');
}

// The logo in the site's pages: the Block in the header, the Kufi lockup in the footer. Inline, so they cost no
// request and take the page's colours (.logo-ink follows the text colour); the link around each names it.
const SITE_PAGES = ['index.html', 'fr/index.html', 'ar/index.html', 'book.html', 'numbers.html'];
function siteLogo(mark) {
  const p = (cls, d) => (d ? '<path class="' + cls + '" d="' + d + '"/>' : '');
  return '<svg viewBox="0 0 ' + mark.w + ' ' + mark.h + '" aria-hidden="true" focusable="false">' + p('logo-ink', mark.ink) + p('logo-red', mark.red) + '</svg>';
}
// Every site page as it should read, as { file: html }: only what sits inside <a class="logo"> changes.
// The Arabic page carries the Kufi mark, علينا, in its header; every other page the Block.
function sitePages() {
  const block = siteLogo(Logo.block()), kufi = siteLogo(Logo.kufi()), footer = siteLogo(Logo.lockup()), out = {};
  for (const f of SITE_PAGES) {
    const header = f.startsWith('ar/') ? kufi : block;
    out[f] = fs.readFileSync(path.join(root, f), 'utf8')
      .replace(/(<header[\s\S]*?<a class="logo"[^>]*>)[\s\S]*?(<\/a>)/, (_, a, b) => a + header + b)
      .replace(/(<footer[^>]*>\s*<a class="logo"[^>]*>)[\s\S]*?(<\/a>)/, (_, a, b) => a + footer + b);
  }
  return out;
}
function siteFiles() {
  for (const [f, html] of Object.entries(sitePages())) fs.writeFileSync(path.join(root, f), html);
  console.log('wrote the logo into ' + SITE_PAGES.join(', '));
}

async function launch() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright'))); }
  return chromium.launch();
}
async function routeFonts(page) {
  const fonts = opt('fonts');
  if (!fonts) return;
  const dir = path.resolve(fonts);
  await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(dir, 'local.css'), 'utf8').replace(/url\(([^)]+)\)/g, (_, f) => `url(https://fonts.gstatic.com/local/${f})`) }));
  await page.route(/fonts\.gstatic\.com\/local\//, r => r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(dir, path.basename(new URL(r.request().url()).pathname))) }));
}

async function browserPage(w, h) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await routeFonts(page);
  const piece = opt('piece', 'block'), ground = opt('ground', 'cream'), word = opt('word');
  await page.goto('file://' + path.join(root, 'brand/motion.html') + `?capture&piece=${piece}&w=${w}&h=${h}&ground=${ground}` + (word ? '&word=' + word : '') + (args.includes('--notag') ? '&notag' : ''));
  await page.evaluate(async () => { await document.fonts.load("40px 'Aalayna Block'"); await document.fonts.ready; });
  return { browser, page };
}

async function video() {
  const [w, h] = opt('size', '1920x1080').split('x').map(Number);
  const fps = Number(opt('fps', 60)), piece = opt('piece', 'block'), ground = opt('ground', 'cream'), word = opt('word', Logo.NAME);
  const tag = (word === Logo.NAME ? '' : '-' + word.toLowerCase()) + (ground === 'cream' ? '' : '-' + ground);
  const out = path.resolve(opt('out', path.join(root, `brand/video/${piece}-${w}x${h}${tag}.mp4`)));
  const audio = opt('audio');
  const { browser, page } = await browserPage(w, h);
  const dur = await page.evaluate(() => window.__duration);
  const enc = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-'];
  if (audio) enc.push('-i', path.resolve(audio), '-c:a', 'aac', '-b:a', '192k', '-shortest');
  enc.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  const ff = spawn(opt('ffmpeg', 'ffmpeg'), enc, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, bad) => ff.on('close', c => (c ? bad(new Error('ffmpeg exited ' + c)) : ok())));
  const frames = Math.round(dur * fps) + 1;
  for (let f = 0; f < frames; f++) {
    await page.evaluate(t => window.__render(t), Math.min(dur, f / fps));
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % fps === 0) process.stderr.write(`\rframe ${f}/${frames}`);
  }
  ff.stdin.end();
  await done;
  await browser.close();
  process.stderr.write(`\nwrote ${path.relative(root, out)}\n`);
}

async function stills() {
  const [w, h] = opt('size', '960x540').split('x').map(Number);
  const out = path.resolve(opt('out', 'stills'));
  fs.mkdirSync(out, { recursive: true });
  const { browser, page } = await browserPage(w, h);
  for (const s of opt('at', '0,1,2,3,4,5').split(',').map(Number)) {
    await page.evaluate(t => window.__render(t), s);
    await page.screenshot({ path: path.join(out, `${opt('piece', 'block')}-t${s.toFixed(2).padStart(5, '0')}.png`) });
  }
  await browser.close();
}

// The site's raster images: the share image (images/og-image.png and .webp, 1200 x 630) and the favicons
// (brand/icons/icon-32.png, and icon-180.png for iOS). The share image is the hero in small: the eyebrow over
// THE BILL. THE SPLIT. 3LAYNA., drawn by the glyph engine itself, beside the payment screen on a phone.
function typeLine(text, u, x, y) {
  let ink = '', red = '';
  for (const ch of text.toUpperCase()) {
    const d = Logo.typeGlyph(ch, x, y, u);
    if (Logo.RED.includes(ch)) red += d; else ink += d;
    x += Logo.typeWidth(ch) * u;
  }
  return { ink, red };
}
function shareHtml() {
  const C = Logo.COLORS, u = 12, pitch = 8 * u, lines = ['The bill.', 'The split.', Logo.NAME + '.'];
  let ink = '', red = '';
  lines.forEach((t, i) => { const l = typeLine(t, u, 0, i * pitch); ink += l.ink; red += l.red; });
  const h = 2 * pitch + 5 * u, file = f => 'file://' + path.join(root, f);
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@600&display=block" rel="stylesheet">
<style>
html,body{margin:0}
body{position:relative;width:1200px;height:630px;overflow:hidden;background:${C.cream}}
.copy{position:absolute;left:90px;top:50%;transform:translateY(-50%)}
.eyebrow{margin:0 0 34px;font:600 22px/1 'Kode Mono',monospace;letter-spacing:.06em;text-transform:uppercase;color:#B3363F}
.copy svg{display:block}
.phone{position:absolute;left:804px;top:38px;width:264px;height:552px;padding:10px;border-radius:42px;background:${C.ink};box-shadow:18px 18px 0 rgba(33,27,22,.08)}
.phone img{display:block;width:100%;height:100%;border-radius:32px;object-fit:cover;object-position:50% 0}
</style></head><body>
<div class="copy"><p class="eyebrow">For restaurants in Lebanon</p>
<svg width="${num(typeWidthOf(lines[1]) * u)}" height="${num(h)}" viewBox="0 0 ${num(typeWidthOf(lines[1]) * u)} ${num(h)}"><path fill="${C.ink}" d="${ink}"/><path fill="${C.red}" d="${red}"/></svg></div>
<div class="phone"><img src="${file('images/guest-pay.png')}" alt=""></div>
</body></html>`;
}
const num = v => String(Math.round(v * 100) / 100);
const typeWidthOf = t => [...t.toUpperCase()].reduce((a, ch) => a + Logo.typeWidth(ch), 0) - 1;

async function images() {
  const browser = await launch(), tmp = path.join(require('os').tmpdir(), 'aalayna-share.html');
  fs.writeFileSync(tmp, shareHtml());
  let page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await routeFonts(page);
  await page.goto('file://' + tmp);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); });
  const png = await page.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(root, 'images/og-image.png'), png);
  // WebP from the same pixels, encoded by the browser.
  const webp = await page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', 0.9).split(',')[1];
  }, png.toString('base64'));
  fs.writeFileSync(path.join(root, 'images/og-image.webp'), Buffer.from(webp, 'base64'));
  await page.close();
  fs.mkdirSync(path.join(root, 'brand/icons'), { recursive: true });
  // 180 px is the icon SVG (18 px modules). At 32 px its 3.2 px modules blur, so the tab icon is drawn on whole
  // pixels instead: 4 px modules, square rows, 6 px of tile around the letter.
  const col = Logo.iconBlockColors(), ch = Logo.NAME[0], bits = Logo.TYPE[ch].bits;
  const pixel = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges"><path fill="' + col.tile + '" d="M0 0H32V32H0Z"/><path fill="' + (Logo.RED.includes(ch) ? col.red : col.ink) + '" d="' +
    bits.map((r, y) => [...r].map((c, x) => (c === '#' ? 'M' + (6 + 4 * x) + ' ' + (6 + 4 * y) + 'h4v4h-4z' : '')).join('')).join('') + '"/></svg>';
  const icons = { 32: pixel, 180: fs.readFileSync(path.join(root, 'brand/svg', Logo.NAME.toLowerCase(), 'icon.svg'), 'utf8') };
  for (const s of [32, 180]) {
    page = await browser.newPage({ viewport: { width: s, height: s } });
    await page.setContent('<style>html,body{margin:0}svg{display:block;width:' + s + 'px;height:' + s + 'px}</style>' + icons[s]);
    fs.writeFileSync(path.join(root, `brand/icons/icon-${s}.png`), await page.screenshot({ type: 'png', omitBackground: true }));
    await page.close();
  }
  await browser.close();
  fs.rmSync(tmp, { force: true });
  console.log('wrote images/og-image.png, images/og-image.webp, brand/icons/icon-32.png and icon-180.png');
}

module.exports = { svgContents, sitePages, SITE_PAGES };
if (require.main === module) {
  const run = { svg: svgFiles, site: siteFiles, images, video, stills }[cmd];
  if (!run) { console.error('usage: node tools/brand.js svg | site | images | video | stills  (see the header of this file)'); process.exit(1); }
  Promise.resolve(run()).catch(e => { console.error(e); process.exit(1); });
}
