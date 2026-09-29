// Two bench runs side by side, and the result file every bench writes.
//
//   node wall/bench/compare.mjs before.json after.json
//
// A run file is { bench, meta, cases: [{ name, unit, runs }] }, written by
// `bench/render.ts --out` and `hosts/unicode/bench/browser.mjs --out`. Two files
// cannot be paired, so their calls carry a `?`: identical code measured at load
// 76 and then 196 showed five of twelve cases "changed", one by +199%. A change
// to the render path is proved with `render.ts --against`, which pairs its runs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname, loadavg } from 'node:os';
import { pathToFileURL } from 'node:url';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A case's runs with the two numbers every report reads. */
export function summarize(name, runs, unit = 'ms') {
  return { name, unit, runs, min: Math.min(...runs), median: median(runs) };
}

/** Which tree a run measured and under what load. */
export function meta(extra = {}) {
  const git = (...args) => {
    try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return null; }
  };
  return {
    commit: git('rev-parse', '--short', 'HEAD'), dirty: Boolean(git('status', '--porcelain')),
    date: new Date().toISOString(), host: hostname(), node: process.version,
    load: Number(loadavg()[0].toFixed(1)), ...extra,
  };
}

export function writeRun(path, bench, cases, extra = {}) {
  writeFileSync(path, `${JSON.stringify({ bench, meta: meta(extra), cases }, null, 2)}\n`);
}

/** Two-sided sign test: how likely `k` of `n` pairs going one way is by chance. */
function signP(k, n) {
  const tail = Math.min(k, n - k);
  let p = 0;
  let choose = 1;
  for (let i = 0; i <= tail; i++) {
    p += choose;
    choose = (choose * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * p) / 2 ** n);
}

/** A change smaller than this is not called, however consistent. */
const MIN_EFFECT = 0.05;
const MAX_P = 0.01;

/** How `after` compares with `before`: its change as a fraction, and whether
 *  that is faster, slower or noise. Paired runs, taken side by side, are
 *  compared round by round, which cancels the machine's load drifting. */
export function verdict(before, after, paired = false) {
  if (paired && before.runs.length === after.runs.length && before.runs.length >= 5) {
    const ratios = after.runs.map((a, i) => a / before.runs[i]);
    const faster = ratios.filter((r) => r < 1).length;
    const change = median(ratios) - 1;
    const called = signP(faster, ratios.length) < MAX_P && Math.abs(change) >= MIN_EFFECT;
    return { change, call: called ? (change < 0 ? 'faster' : 'slower') : '~ noise' };
  }
  const change = after.median / before.median - 1;
  if (before.runs.length < 3 || after.runs.length < 3) return { change, call: 'one run' };
  if (after.median < before.min) return { change, call: 'faster?' };
  if (after.min > before.median) return { change, call: 'slower?' };
  return { change, call: '~ noise' };
}

/** The comparison as aligned lines: medians, the change, and the verdict. */
export function compareLines(before, after, labels = ['before', 'after'], paired = false) {
  const byName = new Map(after.map((c) => [c.name, c]));
  const width = Math.max(4, ...before.map((c) => c.name.length));
  const num = (v) => (v === undefined ? '-' : v.toFixed(1)).padStart(9);
  const lines = [`${'case'.padEnd(width)}  ${labels[0].padStart(9)}  ${labels[1].padStart(9)}     change  verdict`];
  for (const b of before) {
    const a = byName.get(b.name);
    if (!a) { lines.push(`${b.name.padEnd(width)}  ${num(b.median)}  ${num()}          -  gone`); continue; }
    const { change, call } = verdict(b, a, paired);
    const pct = change * 100;
    lines.push(`${b.name.padEnd(width)}  ${num(b.median)}  ${num(a.median)}  `
      + `${`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`.padStart(9)}  ${call}`);
  }
  for (const a of after) {
    if (!before.some((b) => b.name === a.name)) lines.push(`${a.name.padEnd(width)}  ${num()}  ${num(a.median)}          -  new`);
  }
  return lines;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('usage: node wall/bench/compare.mjs before.json after.json');
    process.exit(2);
  }
  const [before, after] = [beforePath, afterPath].map((p) => JSON.parse(readFileSync(p, 'utf8')));
  if (before.bench !== after.bench) console.log(`comparing a ${before.bench} run with a ${after.bench} run`);
  for (const [label, run] of [['before', before], ['after', after]]) {
    const m = run.meta;
    console.log(`${label.padEnd(6)}  ${m.commit}${m.dirty ? '+dirty' : ''}  ${m.date}  ${m.host}  load ${m.load}`);
  }
  const [lo, hi] = [before.meta.load, after.meta.load].sort((a, b) => a - b);
  if (hi > 1.5 * lo + 2) console.log(`the two runs saw load ${lo} and ${hi}: read every change below as noise`);
  console.log(`medians in ${before.cases[0]?.unit ?? 'ms'}\n`);
  for (const line of compareLines(before.cases, after.cases)) console.log(line);
}
