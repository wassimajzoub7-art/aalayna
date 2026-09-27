#!/usr/bin/env node
// Renders reel.html frame by frame to video. Each frame calls the page's __render(t), so the output is exact at any
// frame rate and never drops frames. Frames are split across workers (one headless page each), encoded as segments
// and joined without re-encoding. Needs Playwright (Chromium) and an ffmpeg with libx264.
//
//   node tools/render-reel.js --out film.mp4 [--lang en|fr] [--format landscape|portrait] [--fps 60] [--workers 3]
//                             [--audio reel.wav] [--ffmpeg /path/to/ffmpeg] [--fonts dir-with-local.css] [--stills 1,5.2,11]
//
// --fonts serves the Google Fonts request from a local folder (a local.css whose url()s point at files beside it),
// for machines where the headless browser cannot reach fonts.googleapis.com.
// --stills writes PNGs at the given seconds into the --out folder instead of a video, for reviewing the choreography.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const root = path.resolve(__dirname, '..');
const out = path.resolve(opt('out', 'film.mp4'));
const lang = opt('lang', 'en');
const format = opt('format', 'landscape');
const fps = Number(opt('fps', 60));
const workers = Math.max(1, Number(opt('workers', Math.max(1, os.cpus().length - 1))));
const audio = opt('audio');
const ffmpeg = opt('ffmpeg', 'ffmpeg');
const fonts = opt('fonts');
const stills = opt('stills');
const [W, H] = format === 'portrait' ? [1080, 1920] : [1920, 1080];

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright'))); }

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  if (fonts) {
    const dir = path.resolve(fonts);
    await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(dir, 'local.css'), 'utf8').replace(/url\(([^)]+)\)/g, (_, f) => `url(https://fonts.gstatic.com/local/${f})`) }));
    await page.route(/fonts\.gstatic\.com\/local\//, r => r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(dir, path.basename(new URL(r.request().url()).pathname))) }));
  }
  await page.goto(`file://${path.join(root, 'reel.html')}?capture&lang=${lang}&format=${format}`);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); });
  const cdp = await page.context().newCDPSession(page);
  const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })).data, 'base64');
  return { page, shot, dur: await page.evaluate(() => window.__duration) };
}

const run = (argv, stdin) => new Promise((ok, bad) => {
  const p = spawn(ffmpeg, argv, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', d => { err = (err + d).slice(-4000); });
  p.on('close', c => c ? bad(new Error('ffmpeg exited ' + c + '\n' + err)) : ok());
  if (stdin) stdin(p);
});

(async () => {
  const browser = await chromium.launch();
  if (stills) {
    fs.mkdirSync(out, { recursive: true });
    const { page, shot } = await openPage(browser);
    for (const s of stills.split(',').map(Number)) {
      await page.evaluate(t => window.__render(t), s);
      fs.writeFileSync(path.join(out, `${lang}-${format}-t${s.toFixed(2).padStart(5, '0')}.png`), await shot());
    }
    await browser.close();
    return;
  }

  const probe = await openPage(browser);
  const frames = Math.round(probe.dur * fps);
  await probe.page.close();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  const per = Math.ceil(frames / workers);
  let done = 0;
  const started = Date.now();
  const tick = setInterval(() => process.stderr.write(`\r${lang} ${format}: frame ${done}/${frames}, ${(done / ((Date.now() - started) / 1000)).toFixed(1)} fps   `), 2000);

  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const a = w * per, b = Math.min(frames, a + per);
    if (a >= b) return;
    const { page, shot } = await openPage(browser);
    await run(['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
      '-pix_fmt', 'yuv420p', '-threads', '2', path.join(tmp, `seg${w}.mp4`)], async ff => {
      for (let f = a; f < b; f++) {
        await page.evaluate(t => window.__render(t), f / fps);
        const buf = await shot();
        if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
        done++;
      }
      ff.stdin.end();
    });
    await page.close();
  }));
  clearInterval(tick);
  await browser.close();

  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, Array.from({ length: workers }, (_, w) => w).filter(w => fs.existsSync(path.join(tmp, `seg${w}.mp4`))).map(w => `file '${path.join(tmp, `seg${w}.mp4`)}'`).join('\n'));
  const mux = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
  if (audio) mux.push('-i', path.resolve(audio), '-c:a', 'aac', '-b:a', '192k', '-shortest');
  mux.push('-c:v', 'copy', '-movflags', '+faststart', out);
  await run(mux);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.stderr.write(`\nwrote ${out} (${frames} frames in ${((Date.now() - started) / 1000).toFixed(0)} s)\n`);
})().catch(e => { console.error(e); process.exit(1); });
