/** What the wall's load path costs over the whole Unicode feed, stage by stage,
 *  paired against another ref.
 *
 *    npx vite-node bench/load.ts [--against main] [--runs 9]      # in hosts/unicode/
 *
 *  Every stage runs on fresh derived facts, alternating between that ref's
 *  `wall/src` (unpacked into `bench/.ab/`, removed on the way out) and this
 *  tree's, so both see the same load. Without `--against` it times this tree.
 *  `bench/scale.ts` shows how each stage grows with the item count.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableFromIPC } from 'apache-arrow';
import { UNICODE, type CodePoint } from '../src/spec';
// @ts-expect-error -- a plain Node module, shared with the other benches.
import { compareLines, summarize } from '../../../wall/bench/compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const AGAINST = arg('against');
const RUNS = Number(arg('runs') ?? 9);
const table = tableFromIPC(readFileSync(join(here, '../out/codepoints.arrow')));

const planeKey = { reads: ['plane'], of: (c: CodePoint) => String(c.plane).padStart(2, '0') };
const blockKey = {
  reads: ['block_start', 'block'],
  of: (c: CodePoint) => `${String(c.block_start ?? 0x10ffff).padStart(7, '0')} ${c.block}`,
};

async function stagesFor(src: string) {
  const [cel, derive, grouped, select, store] = await Promise.all(
    ['cel', 'derive', 'grouped', 'select', 'store'].map((m) => import(join(src, `${m}.ts`))));
  const compiled = cel.compile(UNICODE);
  const fresh = () => derive.derive(compiled, store.storeFromArrow(table));
  const all = (facts: unknown) => select.applySelection(compiled, facts, { sort: 'cp', filter: 'all', shown: {} });
  const opts = (rows: Uint32Array) => ({ cell: 32, gap: 4, cols: Math.ceil(Math.sqrt(rows.length)) });
  // Each stage gets what it needs made beforehand and times only itself.
  return [
    { name: 'store', prep: () => null, run: () => store.storeFromArrow(table) },
    { name: 'derive', prep: () => store.storeFromArrow(table), run: (s: unknown) => derive.derive(compiled, s) },
    { name: 'sort by code point', prep: fresh, run: (f: unknown) => select.sortOrder(f, 'cp') },
    { name: 'sort by age', prep: fresh, run: (f: unknown) => select.sortOrder(f, 'age') },
    { name: 'sort by name', prep: fresh, run: (f: unknown) => select.sortOrder(f, 'name') },
    { name: 'select everything', prep: () => { const f = fresh(); select.sortOrder(f, 'cp'); return f; }, run: all },
    { name: 'group by plane', prep: () => { const f = fresh(); return [f, all(f)]; },
      run: ([f, rows]: [unknown, Uint32Array]) => grouped.blockLayout(planeKey, [])({ rows, facts: f }, opts(rows)) },
    { name: 'band by plane and block', prep: () => { const f = fresh(); return [f, all(f)]; },
      run: ([f, rows]: [unknown, Uint32Array]) =>
        grouped.bandedLayout(planeKey, blockKey, false)({ rows, facts: f }, opts(rows)) },
  ] as { name: string; prep: () => unknown; run: (input: never) => unknown }[];
}

const abDir = join(here, '.ab');
rmSync(abDir, { recursive: true, force: true });
try {
  const sides: { label: string; stages: Awaited<ReturnType<typeof stagesFor>> }[] = [];
  if (AGAINST) {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', AGAINST], { encoding: 'utf8' }).trim();
    const dir = join(abDir, sha);
    mkdirSync(dir, { recursive: true });
    execFileSync('sh', ['-c', `git -C "${root}" archive "${sha}" wall/src | tar -x -C "${dir}"`]);
    sides.push({ label: sha, stages: await stagesFor(join(dir, 'wall/src')) });
  }
  sides.push({ label: AGAINST ? 'this tree' : 'ms', stages: await stagesFor(join(here, '../../../wall/src')) });
  console.log(`${table.numRows.toLocaleString()} items, ${RUNS} runs a stage`
    + `${AGAINST ? `, alternating ${sides[0]!.label} and this tree` : ''}`);

  const results = sides.map(() => [] as ReturnType<typeof summarize>[]);
  const total = sides[0]!.stages.length;
  for (let s = 0; s < total; s++) {
    const runs = sides.map(() => [] as number[]);
    const once = (side: number) => {
      const stage = sides[side]!.stages[s]!;
      const input = stage.prep();
      const t0 = performance.now();
      stage.run(input as never);
      return performance.now() - t0;
    };
    for (let side = 0; side < sides.length; side++) once(side);
    for (let r = 0; r < RUNS; r++) {
      const turn = r % 2 ? [...sides.keys()].reverse() : [...sides.keys()];
      for (const side of turn) runs[side]!.push(once(side));
    }
    const name = sides[0]!.stages[s]!.name;
    const summaries = runs.map((rs) => summarize(name, rs));
    summaries.forEach((sum, side) => results[side]!.push(sum));
    const cells = summaries.map((sum, side) => `${sides.length > 1 ? `${sides[side]!.label} ` : ''}`
      + `median ${sum.median.toFixed(1).padStart(7)} ms`);
    console.log(`${String(s + 1).padStart(2)}/${total}  ${name.padEnd(24)} ${cells.join('   ')}`);
  }
  if (AGAINST) {
    console.log('');
    for (const line of compareLines(results[0]!, results[1]!, [sides[0]!.label, 'this tree'], true)) console.log(line);
  }
} finally {
  rmSync(abDir, { recursive: true, force: true });
}
