// How long a fling's landing screen takes to fill in with loose and vector
// thumbnails, in headless Chromium, paired against another ref.
//
//   node hosts/emoji/bench/fling.mjs [--against main | --tune NAME=VALUE] [--runs 5]
//                                    [--rung loose|vector] [--latency 50] [--connections 6]
//                                    [--out run.json]
//
// No host serves renders yet, so this one fakes them: the emoji feed is given
// shas, and every loose tile (a magenta square) and vector render (a cyan one)
// comes from a simulated HTTP/1.1 server, `--connections` requests at a time,
// each taking `--latency` ms; a request the page cancels leaves its queue.
// Each run opens a fresh page, zooms in until the wall asks for the rung, waits
// for the server to go idle, flicks the wall up, and samples the canvas until
// the server is idle again. "filled" is the time from release until the screen
// holds as much of the rung's color as it finally will; "unfilled" adds up the
// screen missing it over that time, in ms of a whole screen, so a fling that
// only half empties it counts half.
// With --against, that ref's `wall/src` (unpacked into `bench/.ab/`, removed on
// the way out) is built beside this tree's and the runs alternate. --tune does
// the same with this tree's `wall/src` given `const NAME = VALUE` instead.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { compareLines, summarize, writeRun } from '../../../wall/bench/compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const AGAINST = arg('against');
const TUNE = arg('tune');
if (AGAINST && TUNE) throw new Error('--against and --tune each name the other side; pass one');
const RUNS = Number(arg('runs') ?? 5);
const LATENCY_MS = Number(arg('latency') ?? 50);
const CONNECTIONS = Number(arg('connections') ?? 6);
const OUT = arg('out');
const VIEWPORT = { width: 1600, height: 1000 };
const MARK = 'pezlie:complete';
/** Screen pixels per pointer move: a flick of four moves ~10 ms apart. */
const FLINGS = { short: 30, long: 100 };
const RUNGS = {
  loose: { url: /\/api\/thumbs\/emoji\/128\//, color: [255, 0, 255] },
  vector: { url: /\/api\/corpus\/render\/emoji\//, color: [0, 255, 255] },
};
const CASES = Object.keys(RUNGS).filter((r) => !arg('rung') || r === arg('rung')).flatMap((rung) => Object.keys(FLINGS).map((fling) => ({ rung, fling })));

function png(size, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
                        chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))),
                        chunk('IEND', Buffer.alloc(0))]);
}
const LOOSE = png(128, RUNGS.loose.color);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
  + '<rect width="16" height="16" fill="#00ffff"/></svg>');

/** A server that answers `CONNECTIONS` requests at a time, in arrival order. */
function server() {
  const queue = [];
  let active = 0;
  let lastBusy = performance.now();
  const log = [];
  const pump = () => {
    while (active < CONNECTIONS && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      setTimeout(() => {
        active -= 1;
        lastBusy = performance.now();
        log.push({ kind: job.kind, at: performance.now() });
        job.answer().catch(() => {}).finally(pump);
      }, LATENCY_MS);
    }
  };
  return {
    log,
    serve(kind, request, answer) { queue.push({ kind, request, answer }); pump(); },
    /** A request the page gave up on before it was answered leaves the queue. */
    cancel(request) {
      const i = queue.findIndex((j) => j.request === request);
      if (i >= 0) queue.splice(i, 1);
    },
    idleFor: () => (active > 0 || queue.length > 0 ? 0 : performance.now() - lastBusy),
    asked: (kind) => log.filter((l) => l.kind === kind).length + queue.filter((j) => j.kind === kind).length,
  };
}

async function waitUntil(test, timeoutMs, what) {
  const t0 = performance.now();
  while (!(await test())) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function run(browser, base, { rung, fling }) {
  const srv = server();
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.route('**/emoji.json', async (route) => {
    const feed = await (await route.fetch()).json();
    feed.items.forEach((item, i) => { item.sha = i.toString(16).padStart(40, '0'); });
    await route.fulfill({ json: feed });
  });
  await context.route('**/api/**', (route) => {
    const url = route.request().url();
    if (RUNGS.loose.url.test(url)) {
      srv.serve('loose', route.request(), () => route.fulfill({ body: LOOSE, contentType: 'image/png' }));
    } else if (RUNGS.vector.url.test(url)) {
      srv.serve('vector', route.request(), () => route.fulfill({ body: SVG, contentType: 'image/svg+xml' }));
    } else {
      void route.fulfill({ status: 404 });
    }
  });
  context.on('requestfailed', (request) => srv.cancel(request));
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
    await page.goto(base);
    await page.waitForFunction((mark) => performance.getEntriesByName(mark).length > 0, MARK,
                               { timeout: 60_000, polling: 50 });
    const cx = VIEWPORT.width / 2;
    const cy = VIEWPORT.height / 2;
    // Near the top of the wall, so the fling has somewhere to go.
    await page.mouse.move(cx, 120);
    for (let i = 0; i < 80 && srv.asked(rung) === 0; i++) {
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(80);
    }
    if (srv.asked(rung) === 0) throw new Error(`never reached the ${rung} rung`);
    await waitUntil(() => srv.idleFor() > 800, 120_000, 'the zoom to fill in');

    await page.evaluate((color) => {
      const canvas = document.querySelector('canvas.wall-canvas');
      const ctx = canvas.getContext('2d');
      const [r, g, b] = color;
      window.__fill = [];
      window.__release = null;
      window.addEventListener('pointerup', (e) => { window.__release = e.timeStamp; }, { capture: true, once: true });
      const sample = () => {
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let hit = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4 * 7) {
          n += 1;
          if (Math.abs(data[i] - r) < 24 && Math.abs(data[i + 1] - g) < 24 && Math.abs(data[i + 2] - b) < 24) hit += 1;
        }
        window.__fill.push([performance.now(), hit / n]);
      };
      window.__sampler = setInterval(sample, 25);
    }, RUNGS[rung].color);
    const asked0 = srv.log.length;
    await page.mouse.move(cx, cy + 300);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(cx, cy + 300 - i * FLINGS[fling]);
      await page.waitForTimeout(10);
    }
    await page.mouse.up();
    const releasedAt = performance.now();
    await waitUntil(() => srv.idleFor() > 800 && performance.now() - releasedAt > 3000, 120_000,
                    'the landing to fill in');
    const { fill, release } = await page.evaluate(() => {
      clearInterval(window.__sampler);
      return { fill: window.__fill, release: window.__release };
    });
    const final = fill.slice(-3).reduce((s, [, f]) => s + f, 0) / 3;
    if (final < 0.2) throw new Error(`the landing only ever filled ${(final * 100).toFixed(0)}%`);
    // The first sample after the last one short of the mark.
    let at = fill.length - 1;
    for (let i = fill.length - 1; i >= 0 && fill[i][1] >= 0.995 * final; i--) at = i;
    const fillMs = fill[at][0] - release;
    // Screen-time spent without the rung, in ms of a whole screen missing it.
    let unfilled = 0;
    for (let i = 1; i < fill.length; i++) {
      if (fill[i][0] <= release) continue;
      unfilled += Math.max(0, 1 - fill[i][1] / final) * (fill[i][0] - Math.max(release, fill[i - 1][0]));
    }
    return { fillMs, unfilledMs: unfilled, served: srv.log.length - asked0 };
  } finally {
    await context.close();
  }
}

const abDir = join(here, '.ab');
rmSync(abDir, { recursive: true, force: true });
let browser;
const servers = [];
try {
  const sides = [];
  const buildSide = async (label, wall, outDir) => {
    await build({
      root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn',
      resolve: { alias: { '@pezlie/wall': wall } },
      build: { outDir, emptyOutDir: true },
    });
    const server = await preview({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn',
                                   build: { outDir }, preview: { port: 5397, strictPort: false } });
    servers.push(server);
    sides.push({ label, base: server.resolvedUrls.local[0] });
  };
  if (AGAINST) {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', AGAINST], { encoding: 'utf8' }).trim();
    const dir = join(abDir, sha);
    mkdirSync(dir, { recursive: true });
    execFileSync('sh', ['-c', `git -C "${top}" archive "${sha}" wall/src | tar -x -C "${dir}"`]);
    await buildSide(sha, join(dir, 'wall'), join(abDir, `${sha}-dist`));
  }
  await buildSide(AGAINST || TUNE ? 'this tree' : 'ms', join(root, '../../wall'), join(abDir, 'here-dist'));
  if (TUNE) {
    const [name, value] = TUNE.split('=');
    const dir = join(abDir, 'tuned');
    cpSync(join(root, '../../wall/src'), join(dir, 'wall/src'), { recursive: true });
    const decl = new RegExp(`^((?:export )?const ${name} = )[^;]+;`, 'm');
    const hits = readdirSync(join(dir, 'wall/src')).filter((f) => /\.tsx?$/.test(f)).filter((f) => {
      const path = join(dir, 'wall/src', f);
      const text = readFileSync(path, 'utf8');
      if (!decl.test(text)) return false;
      writeFileSync(path, text.replace(decl, `$1${value};`));
      return true;
    });
    if (hits.length !== 1) throw new Error(`--tune: ${name} is declared in ${hits.length} files of wall/src`);
    await buildSide(TUNE, join(dir, 'wall'), join(abDir, 'tuned-dist'));
  }
  console.log(`${CONNECTIONS} connections, ${LATENCY_MS} ms a request, ${RUNS} runs a case`
    + `${sides.length > 1 ? `, alternating ${sides[0].label} and ${sides[1].label}` : ''}`);

  browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
  const results = sides.map(() => []);
  let step = 0;
  for (const c of CASES) {
    const runs = sides.map(() => ({ fillMs: [], unfilledMs: [], served: [] }));
    for (let r = 0; r < RUNS; r++) {
      const turn = r % 2 ? [...sides.keys()].reverse() : [...sides.keys()];
      for (const side of turn) {
        const got = await run(browser, sides[side].base, c);
        for (const k of Object.keys(got)) runs[side][k].push(got[k]);
        console.log(`${String(++step).padStart(3)}/${CASES.length * RUNS * sides.length}  `
          + `${`${c.rung}, ${c.fling} fling`.padEnd(20)} ${sides[side].label.padEnd(Math.max(...sides.map((x) => x.label.length)))} `
          + `filled ${got.fillMs.toFixed(0).padStart(5)} ms, unfilled ${got.unfilledMs.toFixed(0).padStart(5)} ms, `
          + `${String(got.served).padStart(4)} served`);
      }
    }
    runs.forEach((rs, side) => {
      const name = `${c.rung}, ${c.fling} fling`;
      results[side].push(summarize(`${name}, filled`, rs.fillMs), summarize(`${name}, unfilled`, rs.unfilledMs),
                         summarize(`${name}, served`, rs.served, 'requests'));
    });
  }
  console.log('');
  for (const [side, cases] of results.entries()) {
    for (const c of cases) {
      const width = Math.max(...sides.map((x) => x.label.length)) + 1;
      console.log(`${sides.length > 1 ? `${sides[side].label.padEnd(width)}` : ''}${c.name.padEnd(30)} `
        + `median ${c.median.toFixed(0).padStart(6)} ${c.unit}`);
    }
  }
  if (sides.length > 1) {
    console.log('');
    for (const line of compareLines(results[0], results[1], [sides[0].label, sides[1].label], true)) console.log(line);
  }
  // Each case under its side's label when there are two.
  const cases = results.flatMap((rs, side) => (sides.length > 1
    ? rs.map((c) => ({ ...c, name: `${sides[side].label}: ${c.name}` })) : rs));
  if (OUT) writeRun(OUT, 'fling', cases, { latencyMs: LATENCY_MS, connections: CONNECTIONS, tune: TUNE ?? null });
} finally {
  await browser?.close();
  for (const s of servers) await s.close();
  rmSync(abDir, { recursive: true, force: true });
}
