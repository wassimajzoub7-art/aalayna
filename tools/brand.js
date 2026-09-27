#!/usr/bin/env node
// Builds the logo files from brand/logo.js and renders the logo motion from brand/motion.html.
//
//   node tools/brand.js svg                      rewrites brand/svg: the Kufi files, and 3layna/ and aalayna/
//   node tools/brand.js video [--piece block|kufi] [--word AALAYNA] [--size 1920x1080] [--ground cream|ink|petrol]
//                             [--fps 60] [--out file.mp4] [--audio file.wav] [--ffmpeg path] [--fonts dir]
//   node tools/brand.js stills --piece kufi --at 0.5,1,2 [--word AALAYNA] [--size 960x540] [--out dir]
//
// video and stills need Playwright (Chromium) and, for video, an ffmpeg with libx264. Like render-reel.js,
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

async function browserPage(w, h) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright'))); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const fonts = opt('fonts');
  if (fonts) {
    const dir = path.resolve(fonts);
    await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(dir, 'local.css'), 'utf8').replace(/url\(([^)]+)\)/g, (_, f) => `url(https://fonts.gstatic.com/local/${f})`) }));
    await page.route(/fonts\.gstatic\.com\/local\//, r => r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(dir, path.basename(new URL(r.request().url()).pathname))) }));
  }
  const piece = opt('piece', 'block'), ground = opt('ground', 'cream'), word = opt('word');
  await page.goto('file://' + path.join(root, 'brand/motion.html') + `?capture&piece=${piece}&w=${w}&h=${h}&ground=${ground}` + (word ? '&word=' + word : '') + (args.includes('--notag') ? '&notag' : ''));
  await page.evaluate(async () => { await document.fonts.load("500 20px 'IBM Plex Sans'"); await document.fonts.ready; });
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

module.exports = { svgContents };
if (require.main === module) {
  const run = { svg: svgFiles, video, stills }[cmd];
  if (!run) { console.error('usage: node tools/brand.js svg | video | stills  (see the header of this file)'); process.exit(1); }
  Promise.resolve(run()).catch(e => { console.error(e); process.exit(1); });
}
