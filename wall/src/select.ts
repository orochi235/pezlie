import type { CompiledSpec } from './cel';
import { rowsByIndex, sortColumn, type Facts } from './derive';
import { naturalKey } from './natural';
import type { Item, TagAxis } from './schema';

/** Which items are on the wall, and in what order. */
export interface Selection {
  sort: string;
  filter: string;
  /** Per class; a class not named takes the spec's `shown`. */
  shown: Record<string, boolean>;
  /** Facet values to leave off, per facet. */
  exclude?: Record<string, readonly string[]>;
  tags?: readonly string[];
}

/** The picked tags, grouped by the axis each belongs to. A tag no axis claims
 *  gets an axis of its own, so it narrows rather than being dropped. */
export function byAxis(axes: readonly TagAxis[], picked: readonly string[]): string[][] {
  const out = axes
    .map((axis) => picked.filter((tag) => axis.tags.includes(tag)))
    .filter((group) => group.length > 0);
  const claimed = new Set(axes.flatMap((a) => a.tags));
  for (const tag of picked) if (!claimed.has(tag)) out.push([tag]);
  return out;
}

const none = (v: unknown) => v === null || v === undefined;

/** Every row in a sort's order, worked out once per sort and kept.
 *
 *  No answer sorts last whichever way the sort runs, strings compare
 *  naturally, and a tie keeps index order. */
export function sortOrder<T extends Item>(facts: Facts<T>, key: string): Uint32Array {
  return primeSort(facts, key, () => false)!;
}

/** Works `key`'s order out a step at a time until `stop` says to, and returns
 *  it once it is done, else null; the next call, or `sortOrder`, carries on
 *  from there. */
export function primeSort<T extends Item>(facts: Facts<T>, key: string,
                                          stop: () => boolean): Uint32Array | null {
  const def = facts.compiled.spec.sorts.find((s) => s.key === key);
  if (!def) throw new Error(`no sort named ${key}`);
  // Held, not re-read: a delta swaps the cache, and an order begun before it
  // must not land in the new one.
  const cache = facts.cache;
  const done = cache.orders.get(key);
  if (done) return done;
  let steps = cache.pending.get(key);
  if (!steps) cache.pending.set(key, steps = sortSteps(facts, key, def.desc));
  for (;;) {
    const step = steps.next();
    if (step.done) {
      cache.pending.delete(key);
      cache.orders.set(key, step.value);
      return step.value;
    }
    if (stop()) return null;
  }
}

/** Rows handled between checks of the clock: each batch is a millisecond or two. */
const BATCH = 100_000;

function* sortSteps<T extends Item>(facts: Facts<T>, key: string,
                                    desc: boolean): Generator<void, Uint32Array> {
  const { codes, values } = sortColumn(facts, key);
  yield;
  const { rank, ranks } = values.every((v) => none(v) || typeof v === 'number')
    ? rankNumbers(values as (number | null)[], desc)
    : values.every((v) => none(v) || typeof v === 'string')
      ? yield* rankStrings(values as (string | null)[], desc)
      : rankValues(values, desc);
  yield;

  const n = facts.store.length;
  const starts = new Uint32Array(ranks + 2);
  for (let row = 0; row < n; row++) {
    starts[rank[codes[row]!]! + 1]!++;
    if (row % BATCH === BATCH - 1) yield;
  }
  for (let r = 1; r < starts.length; r++) starts[r]! += starts[r - 1]!;
  const order = new Uint32Array(n);
  const byIndex = rowsByIndex(facts);
  yield;
  for (let i = 0; i < n; i++) {
    const row = byIndex[i]!;
    order[starts[rank[codes[row]!]!]!++] = row;
    if (i % BATCH === BATCH - 1) yield;
  }
  return order;
}

/** Works out every filter's and class's flags and every sort's order in the
 *  browser's idle time, so a click finds them ready. Returns what stops it. */
export function prime<T extends Item>(facts: Facts<T>): () => void {
  const flagged = [...Object.keys(facts.filters).map((key) => () => facts.filters[key]),
                   ...Object.keys(facts.classes).map((key) => () => facts.classes[key])];
  const sorts = facts.compiled.spec.sorts.map((s) => s.key);
  let handle: number | null = null;
  const idle = typeof requestIdleCallback === 'function';
  const run = (deadline?: IdleDeadline) => {
    handle = null;
    const start = performance.now();
    const stop = deadline ? () => deadline.timeRemaining() < 1 : () => performance.now() - start > 8;
    // A flag is a few milliseconds of work at a million rows, so one at a time.
    while (flagged.length > 0) {
      flagged.shift()!();
      if (stop()) { next(); return; }
    }
    for (const key of sorts) {
      if (primeSort(facts, key, stop) === null) { next(); return; }
    }
  };
  const next = () => {
    handle = idle ? requestIdleCallback(run) : window.setTimeout(run, 50);
  };
  next();
  return () => {
    if (handle === null) return;
    if (idle) cancelIdleCallback(handle); else window.clearTimeout(handle);
  };
}

/** Ranks by a native numeric sort, which a comparator over a million
 *  distinct values is several times slower than. Nulls rank last. */
function rankNumbers(values: readonly (number | null)[], desc: boolean): { rank: Int32Array; ranks: number } {
  // A column already in order, like a code point, needs no sort at all. A bare
  // field's column ends in a null for rows without it, so nulls are skipped.
  let rising = true;
  let present = 0;
  let last = -Infinity;
  for (let i = 0; i < values.length && rising; i++) {
    const v = values[i];
    if (none(v)) continue;
    rising = v! > last;
    last = v!;
    present++;
  }
  if (rising) {
    const rank = new Int32Array(values.length);
    let at = 0;
    for (let i = 0; i < values.length; i++) {
      rank[i] = none(values[i]) ? present : desc ? present - 1 - at++ : at++;
    }
    return { rank, ranks: present + 1 };
  }
  const sorted = Float64Array.from(values.filter((v): v is number => !none(v)));
  sorted.sort();
  let distinct = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[distinct++] = sorted[i]!;
  }
  const rank = new Int32Array(values.length);
  values.forEach((v, code) => {
    if (none(v)) { rank[code] = distinct; return; }
    let lo = 0;
    let hi = distinct - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < v!) lo = mid + 1; else hi = mid;
    }
    rank[code] = desc ? distinct - 1 - lo : lo;
  });
  return { rank, ranks: distinct };
}

/** Strings rank by one flat natural key each, compared as plain strings. */
function* rankStrings(values: readonly (string | null)[],
                      desc: boolean): Generator<void, { rank: Int32Array; ranks: number }> {
  const keys: (string | null)[] = new Array(values.length);
  for (let code = 0; code < values.length; code++) {
    keys[code] = none(values[code]) ? null : naturalKey(values[code]!);
    // Keys cost far more a value than a counting pass does a row.
    if (code % (BATCH / 10) === BATCH / 10 - 1) yield;
  }
  const present = Array.from(values.keys()).filter((code) => keys[code] !== null);
  yield;
  const dir = desc ? -1 : 1;
  present.sort((a, b) => {
    const x = keys[a]!;
    const y = keys[b]!;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  yield;
  const rank = new Int32Array(values.length);
  let ranks = 0;
  present.forEach((code, i) => {
    if (i > 0 && keys[code] !== keys[present[i - 1]!]) ranks++;
    rank[code] = ranks;
  });
  const last = present.length ? ranks + 1 : 0;
  values.forEach((_, code) => { if (keys[code] === null) rank[code] = last; });
  return { rank, ranks: last + 1 };
}

function rankValues(values: readonly unknown[], desc: boolean): { rank: Int32Array; ranks: number } {
  const dir = desc ? -1 : 1;
  // One flat key per value: re-splitting both strings on every comparison was
  // most of the cost of sorting names.
  const keys = values.map((v) => (typeof v === 'string' ? naturalKey(v) : ''));
  const byValue = Array.from(values.keys()).sort((a, b) => {
    const ka = values[a];
    const kb = values[b];
    if (none(ka)) return none(kb) ? 0 : 1;
    if (none(kb)) return -1;
    if (ka === kb) return 0;
    if (typeof ka === 'string' && typeof kb === 'string') {
      const x = keys[a]!;
      const y = keys[b]!;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    }
    return ((ka as number) < (kb as number) ? -1 : 1) * dir;
  });
  const rank = new Int32Array(values.length);
  let ranks = 0;
  byValue.forEach((code, i) => {
    const prev = byValue[i - 1];
    const same = prev !== undefined && (values[prev] === values[code]
      || (none(values[prev]) && none(values[code])));
    if (i > 0 && !same) ranks++;
    rank[code] = ranks;
  });
  return { rank, ranks: ranks + 1 };
}

/** The rows on the wall, in view order. */
export function applySelection<T extends Item>(c: CompiledSpec<T>, facts: Facts<T>,
                                               selection: Selection): Uint32Array {
  const keep = facts.filters[selection.filter];
  if (!keep) throw new Error(`no filter named ${selection.filter}`);
  const order = sortOrder(facts, selection.sort);

  const hidden = c.spec.classes
    .filter((cls) => !(selection.shown[cls.key] ?? cls.shown))
    .map((cls) => facts.classes[cls.key]!);
  const axes = byAxis(c.spec.tagAxes ?? [], selection.tags ?? []);
  const tagOk = axes.length === 0 ? null : Uint8Array.from(
    facts.tags.values as string[][],
    (tags) => (axes.every((group) => group.some((t) => tags.includes(t))) ? 1 : 0));
  const excluded = Object.entries(selection.exclude ?? {})
    .filter(([key, values]) => values.length > 0 && facts.facets[key])
    .map(([key, values]) => {
      const column = facts.facets[key]!;
      const off = new Set(values);
      return [column.codes, Uint8Array.from(column.values,
                                            (v) => (off.has((v as string | null) ?? '') ? 1 : 0))] as const;
    });

  const tagCodes = facts.tags.codes;
  const out = new Uint32Array(order.length);
  let count = 0;
  outer: for (let i = 0; i < order.length; i++) {
    const row = order[i]!;
    if (!keep[row]) continue;
    for (const member of hidden) if (member[row]) continue outer;
    if (tagOk && !tagOk[tagCodes[row]!]) continue;
    for (const [codes, off] of excluded) if (off[codes[row]!]) continue outer;
    out[count++] = row;
  }
  return out.slice(0, count);
}
