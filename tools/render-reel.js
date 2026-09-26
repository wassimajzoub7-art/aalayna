#!/usr/bin/env node
// Renders reel.html frame by frame to video. Each frame calls the page's __render(t), so the output is exact
// at any frame rate and never drops frames. Needs Playwright (Chromium) and an ffmpeg with libx264.
//
//   node tools/render-reel.js --out images/reel.mp4 [--fps 60] [--scale 1] [--audio reel.wav]
//                             [--ffmpeg /path/to/ffmpeg] [--fonts dir-with-local.css] [--stills 0,2.2,5]
//
// --fonts serves the Google Fonts request from a local folder (a local.css whose url()s point at files beside it),
// for machines where the headless browser cannot reach fonts.googleapis.com.
// --stills writes PNGs at the given seconds instead of a video, for reviewing the choreography.
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const root = path.resolve(__dirname, '..');
const out = path.resolve(opt('out', path.join(root, 'images/reel.mp4')));
const fps = Number(opt('fps', 60));
const scale = Number(opt('scale', 1));
const audio = opt('audio');
const ffmpeg = opt('ffmpeg', 'ffmpeg');
const fonts = opt('fonts');
const stills = opt('stills');

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright'))); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
  if (fonts) {
    const dir = path.resolve(fonts);
    await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(dir, 'local.css'), 'utf8').replace(/url\(([^)]+)\)/g, (_, f) => `url(https://fonts.gstatic.com/local/${f})`) }));
    await page.route(/fonts\.gstatic\.com\/local\//, r => r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(dir, path.basename(new URL(r.request().url()).pathname))) }));
  }
  await page.goto('file://' + path.join(root, 'reel.html') + '?capture');
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); });
  const dur = await page.evaluate(() => window.__duration);

  if (stills) {
    fs.mkdirSync(out, { recursive: true });
    for (const s of stills.split(',').map(Number)) {
      await page.evaluate(t => window.__render(t), s);
      await page.screenshot({ path: path.join(out, `t${s.toFixed(2).padStart(5, '0')}.png`) });
    }
    await browser.close();
    return;
  }

  const enc = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-'];
  if (audio) enc.push('-i', path.resolve(audio), '-c:a', 'aac', '-b:a', '192k', '-shortest');
  enc.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  const ff = spawn(ffmpeg, enc, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, bad) => ff.on('close', c => c ? bad(new Error('ffmpeg exited ' + c)) : ok()));

  const frames = Math.round(dur * fps);
  for (let f = 0; f < frames; f++) {
    await page.evaluate(t => window.__render(t), f / fps);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % fps === 0) process.stderr.write(`\rframe ${f}/${frames}`);
  }
  ff.stdin.end();
  await done;
  await browser.close();
  process.stderr.write(`\nwrote ${out}\n`);
})().catch(e => { console.error(e); process.exit(1); });
