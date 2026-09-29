// The wall at a million items, measured in headless Chromium against its gates.
//
//   node hosts/unicode/bench/browser.mjs [--dpr 2] [--dev] [--shot wall.png] [--out run.json]
//
// Starts the feed server and serves a production build of the page (or the
// Vite dev server, with --dev), loads the page once to warm both, then times on
// a fresh page: first paint of every code point, frame
// intervals over a scripted pan and zoom with the whole wall on screen, plain
// and colored by age, the time from hovering and leaving each legend row to the
// wall settling, and the time from each selection change to the next complete
// frame. Prints each measurement as it lands and exits nonzero on a miss;
// --out writes them for `wall/bench/compare.mjs`.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build, createServer, preview } from 'vite';
import { summarize, writeRun } from '../../../wall/bench/compare.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dprArg = process.argv.indexOf('--dpr');
const DPR = dprArg > 0 ? Number(process.argv[dprArg + 1]) : 1;
const DEV = process.argv.includes('--dev');
const shotArg = process.argv.indexOf('--shot');
const SHOT = shotArg > 0 ? process.argv[shotArg + 1] : null;
// WebGL cell bodies instead of Canvas2D; they only differ once cells are past tile size.
const SCENE = process.argv.includes('--scene');
// A fast machine draws either renderer inside a vsync; throttling shows which costs more.
const throttleArg = process.argv.indexOf('--throttle');
const THROTTLE = throttleArg > 0 ? Number(process.argv[throttleArg + 1]) || 1 : 1;
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
/** Legend rows hovered, each a run of the hover and leave cases. */
const HOVERS = 6;
const API_PORT = 8797;
const VIEWPORT = { width: 1600, height: 1000 };
const MARK = 'pezlie:complete';
const GATES = { firstPaintMs: 3000, firstPaintTargetMs: 1000, medianFrameMs: 17.5, p95FrameMs: 34, changeMs: 250 };

const CHANGES = [
  ['Show', 'assigned'], ['Show', 'all'], ['Order', 'age'], ['Order', 'name'], ['Order', 'cp'],
  ['Color', 'age'], ['Color', 'status'], ['Show', 'unassigned'], ['Show', 'all'],
];
const TOTAL = 9 + CHANGES.length;
let step = 0;
const misses = [];
const cases = [];
function report(name, ms, gate, note = '') {
  const ok = gate === null || ms <= gate;
  if (!ok) misses.push(name);
  console.log(`${String(++step).padStart(2)}/${TOTAL}  ${ok ? 'PASS' : 'MISS'}  ${name.padEnd(42)} `
    + `${ms.toFixed(1).padStart(8)} ms${gate === null ? '' : `  (gate ${gate} ms)`}${note}`);
}

async function waitFor(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never answered`);
}

const api = spawn(`${root}.venv/bin/python`, [
  '-m', 'uvicorn', '--factory', 'server:app_from_env', '--app-dir', root,
  '--port', String(API_PORT), '--log-level', 'warning',
], { stdio: 'inherit' });
let vite;
let browser;
try {
  await waitFor(`http://127.0.0.1:${API_PORT}/api/codepoints/slots`);
  // The server gzips a feed on first request; a warm server has done that.
  for (const c of ['codepoints', 'assigned']) {
    await (await fetch(`http://127.0.0.1:${API_PORT}/api/${c}/items/ucd`, { headers: { 'accept-encoding': 'gzip' } })).arrayBuffer();
  }
  const proxy = { '/api': `http://127.0.0.1:${API_PORT}` };
  const configFile = `${root}vite.config.ts`;
  if (DEV) {
    vite = await createServer({ root, configFile, logLevel: 'warn', server: { port: 5297, strictPort: false, proxy } });
    await vite.listen();
  } else {
    await build({ root, configFile, logLevel: 'warn', build: { outDir: `${root}dist`, emptyOutDir: true } });
    vite = await preview({ root, configFile, logLevel: 'warn',
                           build: { outDir: `${root}dist` }, preview: { port: 5297, strictPort: false, proxy } });
  }
  const base = vite.resolvedUrls.local[0];
  console.log(`serving ${DEV ? 'the dev server' : 'a production build'} at ${base}, dpr ${DPR}`);

  // Headless Chromium otherwise draws WebGL in SwiftShader, on the CPU.
  browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
  const open = async () => {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
    await page.goto(`${base}#codepoints`);
    await page.waitForFunction((mark) => performance.getEntriesByName(mark).length > 0, MARK,
                               { timeout: 120_000, polling: 50 });
    return { context, page };
  };

  const warm = await open();
  await warm.context.close();

  const { page } = await open();
  const firstPaint = await page.evaluate((mark) => performance.getEntriesByName(mark)[0].startTime, MARK);
  cases.push(summarize('first paint', [firstPaint]));
  report('first paint, every code point', firstPaint, GATES.firstPaintMs,
         firstPaint <= GATES.firstPaintTargetMs ? '' : `  target ${GATES.firstPaintTargetMs} ms not met`);
  const t = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const feed = performance.getEntriesByType('resource').find((r) => r.name.includes('/items/'));
    return { scripts: nav.domContentLoadedEventEnd, asked: feed?.startTime ?? NaN, got: feed?.responseEnd ?? NaN,
             wire: feed?.encodedBodySize ?? NaN, body: feed?.decodedBodySize ?? NaN };
  });
  if (SHOT) await page.screenshot({ path: SHOT });
  const mb = (bytes) => (bytes / 1e6).toFixed(1);
  console.log(`        scripts loaded ${t.scripts.toFixed(0)} ms, feed asked ${t.asked.toFixed(0)} ms, `
    + `received ${t.got.toFixed(0)} ms (${mb(t.wire)} MB sent, ${mb(t.body)} MB unpacked), `
    + `drawn ${(firstPaint - t.got).toFixed(0)} ms after`);

  // Out far enough that the whole wall is on screen.
  const cx = VIEWPORT.width / 2;
  const cy = VIEWPORT.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(30); }
  await page.waitForFunction((mark) => {
    const marks = performance.getEntriesByName(mark);
    return marks.length > 0 && performance.now() - marks.at(-1).startTime > 300;
  }, MARK, { timeout: 30_000, polling: 100 }).catch(() => {});

  const settle = () => page.waitForFunction((mark) => {
    const marks = performance.getEntriesByName(mark);
    return marks.length > 0 && performance.now() - marks.at(-1).startTime > 300;
  }, MARK, { timeout: 30_000, polling: 100 }).catch(() => {});
  const cdp = await page.context().newCDPSession(page);
  if (SCENE) {
    await page.getByLabel('WebGL cell bodies').first().check({ force: true });
    await settle();
    const gpu = await page.evaluate(() => {
      const gl = document.querySelector('.wall-canvas-gl')?.getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    console.log(`        WebGL cell bodies on ${gpu}`);
  }
  console.log(`        ${SCENE ? 'WebGL' : 'Canvas2D'} bodies, CPU throttled ${THROTTLE}x for the frames`);

  const panAndZoom = async (where) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      window.__recording = true;
      const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__recording) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await page.mouse.down();
    await page.mouse.move(cx - 400, cy - 250, { steps: 90 });
    await page.mouse.move(cx + 300, cy + 200, { steps: 90 });
    await page.mouse.up();
    for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, i % 12 < 6 ? -100 : 100); await page.waitForTimeout(40); }
    const frames = await page.evaluate(() => { window.__recording = false; return window.__frames.slice(1); });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    frames.sort((a, b) => a - b);
    const at = (q) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))];
    cases.push(summarize(`frame, ${where}`, frames), summarize(`frame p95, ${where}`, [at(0.95)]));
    report(`median frame, ${where}`, at(0.5), GATES.medianFrameMs, `  ${frames.length} frames`);
    report(`95th percentile frame, ${where}`, at(0.95), GATES.p95FrameMs, `  worst ${frames.at(-1).toFixed(1)} ms`);
  };
  await panAndZoom('whole wall');

  // From an action to the last complete frame before the wall goes quiet: a
  // hover can also clear the hovered cell, whose frame lands first.
  const untilQuiet = async (act) => {
    const before = await page.evaluate((mark) => {
      window.__t0 = performance.now();
      return performance.getEntriesByName(mark).length;
    }, MARK);
    await act();
    return page.evaluate(([mark, before]) => new Promise((resolve, reject) => {
      const check = () => {
        const marks = performance.getEntriesByName(mark);
        const now = performance.now();
        if (marks.length > before && now - marks.at(-1).startTime > 300) resolve(marks.at(-1).startTime - window.__t0);
        else if (now - window.__t0 > 60_000) reject(new Error('the wall never settled'));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }), [MARK, before]);
  };
  const hovers = [];
  const leaves = [];
  for (const row of (await page.locator('.wall-legend-row').all()).slice(0, HOVERS)) {
    hovers.push(await untilQuiet(() => row.hover()));
    leaves.push(await untilQuiet(() => page.mouse.move(cx, cy)));
  }
  for (const [name, runs] of [['legend hover', hovers], ['legend leave', leaves]]) {
    const c = summarize(`${name}, whole wall`, runs);
    cases.push(c);
    report(`${name}, whole wall, median`, c.median, GATES.changeMs, `  ${runs.length} rows, worst ${Math.max(...runs).toFixed(1)} ms`);
  }

  await choose(page, 'Color', 'age');
  await settle();
  await panAndZoom('whole wall, by age');
  await choose(page, 'Color', 'status');
  await settle();
  // In until cells are past tile size, where each renderer draws every cell itself.
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(30); }
  await settle();
  await panAndZoom('close');

  for (const [label, value] of CHANGES) {
    const ms = await choose(page, label, value);
    cases.push(summarize(`${label.toLowerCase()} ${value}`, [ms]));
    report(`${label.toLowerCase()} ${value}`, ms, GATES.changeMs);
  }
} finally {
  await browser?.close();
  await vite?.close();
  api.kill();
}
if (OUT) {
  writeRun(OUT, 'browser', cases, { dpr: DPR, dev: DEV, scene: SCENE, throttle: THROTTLE });
  console.log(`wrote ${OUT}`);
}
console.log(misses.length ? `MISSED ${misses.length}: ${misses.join(', ')}` : 'every gate passed');
process.exitCode = misses.length ? 1 : 0;

/** Picks `value` in the sidebar's `label` select and resolves with the time to the next complete frame. */
function choose(page, label, value) {
  return page.evaluate(([label, value, mark]) => new Promise((resolve, reject) => {
    const row = [...document.querySelectorAll('label.wall-side__row')]
      .find((l) => l.firstChild?.textContent?.trim() === label);
    const select = row?.querySelector('select');
    if (!select) { reject(new Error(`no ${label} select`)); return; }
    const before = performance.getEntriesByName(mark).length;
    const t0 = performance.now();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const check = () => {
      const marks = performance.getEntriesByName(mark);
      if (marks.length > before) resolve(marks.at(-1).startTime - t0);
      else if (performance.now() - t0 > 60_000) reject(new Error(`${label} ${value} never finished`));
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }), [label, value, MARK]);
}
