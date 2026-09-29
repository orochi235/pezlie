/** What the wall's drawing costs, case by case, over a synthetic corpus.
 *
 *    npm run bench -- [--runs 7|15] [--items 250000] [--out run.json] [--against <ref>]
 *
 *  Run from `wall/`. It draws into a context whose calls do nothing, so a case
 *  times the JavaScript that decides and issues the draws, not the browser's
 *  rasterizing; `hosts/unicode/bench/browser.mjs` measures that end to end.
 *
 *  With `--against`, that ref's `wall/src` is unpacked into `bench/.ab/` and
 *  every case alternates between it and this tree, so both see the same load.
 *  `bench/.ab/` is removed on the way out.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Bool, Dictionary, Field, Int32, List, makeTable, tableFromIPC, tableToIPC, Utf8, vectorFromArray,
} from 'apache-arrow';
import type { SheetImage } from '../src/sheet';
import type { TileScene } from '../src/tiles';
import { SPEC, thing, type Thing } from '../test/fixture';
// @ts-expect-error -- a plain Node module, shared with the browser bench.
import { compareLines, summarize, writeRun } from './compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const AGAINST = arg('against');
// Paired runs need enough rounds for a sign test to call anything.
const RUNS = Number(arg('runs') ?? (AGAINST ? 15 : 7));
const N = Number(arg('items') ?? 250_000);
const OUT = arg('out');
const VIEW = { width: 1600, height: 1000 };
/** World units per cell; tile level z draws it at 16 * 2^z pixels. */
const CELL = 16;

async function load(src: string) {
  const [cel, derive, draw2d, layout, paint, palette, store, tiles] = await Promise.all([
    import(join(src, 'cel.ts')) as Promise<typeof import('../src/cel')>,
    import(join(src, 'derive.ts')) as Promise<typeof import('../src/derive')>,
    import(join(src, 'draw2d.ts')) as Promise<typeof import('../src/draw2d')>,
    import(join(src, 'layout.ts')) as Promise<typeof import('../src/layout')>,
    import(join(src, 'paint.ts')) as Promise<typeof import('../src/paint')>,
    import(join(src, 'palette.ts')) as Promise<typeof import('../src/palette')>,
    import(join(src, 'store.ts')) as Promise<typeof import('../src/store')>,
    import(join(src, 'tiles.ts')) as Promise<typeof import('../src/tiles')>,
  ]);
  return { cel, derive, draw2d, layout, paint, palette, store, tiles };
}
type Mods = Awaited<ReturnType<typeof load>>;

/** Every state, both variants, tags, washes, null scores and glyphs, in proportions
 *  that repeat with the index. */
function corpus(n: number) {
  const items = Array.from({ length: n }, (_, i) => thing(`item-${i}`, i, {
    level: i % 7 === 0 ? 1 : i % 11 === 0 ? -1 : 0, err: i % 13 === 0 ? 'x' : null,
    flagged: i % 17 === 0, away: i % 5 === 0 ? ['r'] : [], kind: ['pin', 'box', null][i % 3]!,
    labels: [['big'], ['old', 'star'], []][i % 3]!, score: i % 9 === 0 ? null : i % 10,
    group: i % 2 ? 'north' : 'south',
  }));
  const col = (key: keyof Thing, type: unknown) =>
    vectorFromArray(items.map((it) => it[key]), type as never).data[0]!;
  const strings = () => new List(new Field('item', new Utf8(), true));
  const words = () => new Dictionary(new Utf8(), new Int32());
  // Through IPC, as the wall receives a feed.
  return tableFromIPC(tableToIPC(makeTable({
    id: col('id', new Utf8()), index: col('index', new Int32()), sha: col('sha', new Utf8()),
    level: col('level', new Int32()), err: col('err', new Utf8()), flagged: col('flagged', new Bool()),
    away: col('away', strings()), kind: col('kind', words()), labels: col('labels', strings()),
    score: col('score', new Int32()), group: col('group', words()),
  } as never) as never));
}

/** A 2D context that does nothing but hand back real pixel buffers and text widths. */
function inertContext(): CanvasRenderingContext2D {
  const noop = () => {};
  const ctx: Record<string, unknown> = {
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
    textBaseline: 'alphabetic', textAlign: 'start', lineJoin: 'miter', lineCap: 'butt',
    imageSmoothingEnabled: true, globalCompositeOperation: 'source-over',
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    measureText: (s: string) => ({ width: s.length * 6, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  for (const name of ['save', 'restore', 'drawImage', 'beginPath', 'arc', 'fill', 'fillText', 'fillRect',
    'stroke', 'translate', 'strokeRect', 'scale', 'clearRect', 'transform', 'setTransform', 'setLineDash',
    'putImageData', 'moveTo', 'lineTo', 'ellipse', 'closePath', 'clip', 'rect']) ctx[name] = noop;
  return ctx as unknown as CanvasRenderingContext2D;
}

interface Case { name: string; run: () => void }

/** The cases, built against one copy of `wall/src`. */
function casesFor(m: Mods, table: ReturnType<typeof corpus>): Case[] {
  const compiled = m.cel.compile(SPEC);
  const store = m.store.storeFromArrow<Thing>(table as never);
  const facts = m.derive.derive(compiled, store);
  const laid = m.layout.gridLayout({ rows: Uint32Array.from({ length: N }, (_, i) => i) },
                                   { cell: CELL, gap: 2, cols: Math.ceil(Math.sqrt(N)) });
  const palette = m.palette.defaultPalette(compiled.states);
  const baked: Record<string, string> = {};
  for (let i = 0; i < N; i++) baked[`item-${i}`] = `sha-item-${i}`;
  const manifest = { level: 8, gutter: 0, pitch: 8, cols: 1024, rows: Math.ceil(N / 1024), count: N,
                     size: 8192, baked };
  const scene: TileScene<Thing> = {
    compiled, facts, laid, manifest: null, sheet: null, palette,
    options: { marks: {}, washColor: m.draw2d.DEFAULT_WASH }, highlight: null, highlightTag: null,
    appearance: m.paint.DEFAULT_APPEARANCE, tint: 'status', gradient: 'ember', stale: false,
    ground: '#ffffff',
  };
  const ctx = inertContext();
  const camAt = (scale: number) => ({
    x: laid.bounds.w / 2 - VIEW.width / scale / 2, y: laid.bounds.h / 2 - VIEW.height / scale / 2,
    scale: { x: scale, y: scale },
  });
  const tiles = (px: number, what: string, over: Partial<TileScene<Thing>> = {}): Case => {
    const covering = m.tiles.coveringTiles(camAt(px / CELL), VIEW, 1);
    const s = { ...scene, ...over };
    return { name: `tiles ${String(px).padStart(2)}px, ${what}`,
             run: () => { for (const t of covering) m.tiles.renderTile(s, ctx, t); } };
  };
  const frames = (px: number, frameCount: number): Case => {
    const cam = camAt(px / CELL);
    const visible = m.layout.visiblePositions(laid, cam, VIEW) ?? [];
    return {
      name: `frames ${px}px, badges and captions x${frameCount}`,
      run: () => {
        for (let f = 0; f < frameCount; f++) {
          const cmds = m.paint.paintCommands({
            compiled, facts, order: laid.order, rect: (p) => m.layout.rectAt(laid, p), visible, cam,
            manifest, palette, highlight: null, highlightTag: null, caret: null, tint: 'status',
            gradient: 'ember', stale: false, ground: '#ffffff', appearance: m.paint.DEFAULT_APPEARANCE,
          });
          for (const cmd of cmds) m.draw2d.drawPaintCommand(ctx, cmd, null, palette, scene.options);
        }
      },
    };
  };
  const washed = { ...m.paint.DEFAULT_APPEARANCE, wash: true };
  return [
    tiles(1, 'status'),
    tiles(1, 'legend hover', { highlight: 'warn' }),
    tiles(1, 'tag hover', { highlightTag: 'big' }),
    tiles(1, 'washed', { appearance: washed }),
    tiles(1, 'stale', { stale: true }),
    tiles(1, 'tint', { tint: 'score' }),
    tiles(8, 'status'),
    tiles(8, 'legend hover', { highlight: 'warn' }),
    tiles(8, 'tint', { tint: 'score' }),
    tiles(16, 'sheet', { manifest, sheet: {} as SheetImage }),
    tiles(32, 'glyphs'),
    frames(96, 20),
  ];
}

/** Collects before each run where Node allows it, so no run pays for another's garbage. */
const collect = (globalThis as { gc?: () => void }).gc ?? (() => {});

function timed(run: () => void): number {
  collect();
  const t0 = performance.now();
  run();
  return performance.now() - t0;
}

const table = corpus(N);
const sides: { label: string; cases: Case[] }[] = [];
const abDir = join(here, '.ab');
rmSync(abDir, { recursive: true, force: true });
try {
  if (AGAINST) {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', AGAINST], { encoding: 'utf8' }).trim();
    const dir = join(abDir, sha);
    mkdirSync(dir, { recursive: true });
    execFileSync('sh', ['-c', `git -C "${root}" archive "${sha}" wall/src | tar -x -C "${dir}"`]);
    sides.push({ label: sha, cases: casesFor(await load(join(dir, 'wall/src')), table) });
  }
  sides.push({ label: AGAINST ? 'this tree' : 'ms', cases: casesFor(await load(join(here, '../src')), table) });
  if (!('gc' in globalThis)) console.log('no --expose-gc: runs will pay for each other\'s garbage');
  console.log(`${N.toLocaleString()} items, ${RUNS} runs a case${AGAINST ? `, alternating ${sides[0]!.label} and this tree` : ''}`);

  const results = sides.map(() => [] as ReturnType<typeof summarize>[]);
  const total = sides[0]!.cases.length;
  for (let c = 0; c < total; c++) {
    const runs = sides.map(() => [] as number[]);
    for (const side of sides) side.cases[c]!.run();
    // Alternating who goes first, so neither side always runs in the other's garbage.
    for (let r = 0; r < RUNS; r++) {
      const turn = r % 2 ? [...sides.keys()].reverse() : [...sides.keys()];
      for (const s of turn) runs[s]!.push(timed(sides[s]!.cases[c]!.run));
    }
    const name = sides[0]!.cases[c]!.name;
    const summaries = runs.map((rs) => summarize(name, rs));
    summaries.forEach((sum, s) => results[s]!.push(sum));
    const cells = summaries.map((sum, s) => `${sides.length > 1 ? `${sides[s]!.label} ` : ''}`
      + `min ${sum.min.toFixed(1).padStart(7)}  median ${sum.median.toFixed(1).padStart(7)} ms`);
    console.log(`${String(c + 1).padStart(2)}/${total}  ${name.padEnd(36)} ${cells.join('   ')}`);
  }
  if (AGAINST) {
    console.log('');
    for (const line of compareLines(results[0]!, results[1]!, [sides[0]!.label, 'this tree'], true)) console.log(line);
  }
  if (OUT) {
    writeRun(OUT, 'render', results.at(-1)!, { items: N, runs: RUNS });
    console.log(`wrote ${OUT}`);
  }
} finally {
  rmSync(abDir, { recursive: true, force: true });
}
