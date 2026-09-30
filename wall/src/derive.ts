import { unbind, type CompiledSpec } from './cel';
import type { Item } from './schema';
import { ABSENT, storeFromItems, type Column, type ItemStore } from './store';

/** A projection evaluated over every row: per row, a code into `results`. */
export interface Grouped {
  codes: Int32Array;
  results: unknown[];
}

// Past this many combinations a dense lookup table costs more than a map.
const DENSE_KEYS = 1 << 22;

/** `fn` over every row of `store`, called once per distinct combination of
 *  the values of `reads` with an object holding only those fields. With
 *  `reads` null, once per row with the whole item. */
export function evaluateGrouped<T extends Item>(store: ItemStore<T>,
                                                reads: readonly string[] | null,
                                                fn: (item: T) => unknown): Grouped {
  const n = store.length;
  const codes = new Int32Array(n);
  const results: unknown[] = [];
  if (reads === null) {
    for (let row = 0; row < n; row++) {
      codes[row] = row;
      results.push(fn(store.get(row)));
    }
    return { codes, results };
  }
  if (reads.length === 0) {
    if (n > 0) results.push(fn({} as T));
    return { codes, results };
  }
  // A bare read of one field is that column, with absence read as null.
  const field = (fn as { field?: string }).field;
  if (field !== undefined && reads.length === 1 && reads[0] === field) {
    const column = store.column(field);
    const none = column.values.length;
    for (let row = 0; row < n; row++) {
      const code = column.codes[row]!;
      codes[row] = code === ABSENT ? none : code;
    }
    // One copy, not a map and then a spread: a code point column is a million values.
    const results: unknown[] = new Array(none + 1);
    for (let i = 0; i < none; i++) results[i] = column.values[i] ?? null;
    results[none] = null;
    return { codes, results };
  }
  // One field read: its column's codes already are the groups.
  if (reads.length === 1) {
    const one = perValue(store, reads[0]!, fn);
    for (let row = 0; row < n; row++) codes[row] = one.codeOf(row);
    return { codes, results: one.results };
  }
  const columns = reads.map((field) => store.column(field));
  const bases = columns.map((c) => c.values.length + 1);
  const product = bases.reduce((a, b) => a * b, 1);
  const representative = (row: number): T => {
    const out: Record<string, unknown> = {};
    for (let k = 0; k < columns.length; k++) {
      const code = columns[k]!.codes[row]!;
      if (code !== ABSENT) out[reads[k]!] = columns[k]!.values[code];
    }
    return out as T;
  };

  const numeric = product <= Number.MAX_SAFE_INTEGER;
  const dense = product <= DENSE_KEYS ? new Int32Array(product).fill(-1) : null;
  const sparse = dense ? null : new Map<number | string, number>();
  for (let row = 0; row < n; row++) {
    let key: number | string = 0;
    if (numeric) {
      let mult = 1;
      for (let k = 0; k < columns.length; k++) {
        key += (columns[k]!.codes[row]! + 1) * mult;
        mult *= bases[k]!;
      }
    } else {
      key = columns.map((c) => c.codes[row]).join(',');
    }
    let group = dense ? dense[key as number]! : sparse!.get(key) ?? -1;
    if (group < 0) {
      group = results.length;
      results.push(fn(representative(row)));
      if (dense) dense[key as number] = group;
      else sparse!.set(key, group);
    }
    codes[row] = group;
  }
  return { codes, results };
}

interface Cache {
  sorts: Map<string, Column>;
  tints: Map<string, Float32Array>;
  rows: Map<string, Map<number, string | null>>;
  orders: Map<string, Uint32Array>;
  /** Sort orders partway worked out, resumed by whoever asks next. */
  pending: Map<string, Iterator<void, Uint32Array>>;
  groups: WeakMap<object, Column>;
  /** Per sheet manifest and row: 0 not yet asked, 1 no picture, 2 a picture. */
  baked: WeakMap<object, Uint8Array>;
  rowOfId: Map<string, number> | null;
  byIndex: Uint32Array | null;
}

const newCache = (): Cache => ({
  sorts: new Map(), tints: new Map(), rows: new Map(), orders: new Map(), pending: new Map(),
  groups: new WeakMap(), baked: new WeakMap(), rowOfId: null, byIndex: null,
});

/** Everything the wall reads about the items, as columns parallel to the
 *  store's rows. CEL runs here, once per distinct value of the fields each rule
 *  reads; selection and paint read columns. Sorts, tints and captions are
 *  worked out the first time something asks for them. */
export interface Facts<T extends Item> {
  compiled: CompiledSpec<T>;
  store: ItemStore<T>;
  /** Per row, its state's position in `compiled.states`. */
  state: Uint8Array;
  filters: Record<string, Uint8Array>;
  classes: Record<string, Uint8Array>;
  /** Values are string lists. */
  tags: Column;
  /** Values are strings or null. */
  facets: Record<string, Column>;
  washed: Uint8Array;
  cache: Cache;
}

const text = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : String(v);

/** An item's sheet cell is its index, so the indices must be exactly
 *  `0..n-1`: one repeated or skipped puts sprites in the wrong cells, which
 *  reads as a rendering fault rather than a data fault. */
function assertIndices<T extends Item>(store: ItemStore<T>): void {
  const holder = new Int32Array(store.length).fill(-1);
  for (let row = 0; row < store.length; row++) {
    const i = store.index(row);
    if (!Number.isInteger(i) || i < 0 || i >= store.length) {
      throw new Error(`item ${store.id(row)} has index ${i}, outside 0..${store.length - 1}`);
    }
    const held = holder[i]!;
    if (held >= 0) throw new Error(`index ${i} is held by both ${store.id(held)} and ${store.id(row)}`);
    holder[i] = row;
  }
}

function stateRule<T extends Item>(c: CompiledSpec<T>) {
  if (c.states.length > 255) throw new Error(`${c.states.length} states; the wall holds 255`);
  const position = new Map(c.states.map((s, i) => [s.key, i]));
  const fallback = position.get(c.byPrecedence[c.byPrecedence.length - 1]!.key)!;
  const matchers = c.byPrecedence.map((s) => [s.match, position.get(s.key)!] as const);
  const reads = c.byPrecedence.some((s) => s.match.reads === null) ? null
    : [...new Set(c.byPrecedence.flatMap((s) => s.match.reads!))].sort();
  // With no catch-all state in the spec, the last state in match order is it.
  const fn = (item: T) => {
    for (const [match, at] of matchers) if (match(item)) return at;
    return fallback;
  };
  return { reads, fn };
}

/** `fn` once per value of one field's column, and each row's code into the
 *  results: its column code, or one more result for rows without the field. */
function perValue<T extends Item>(store: ItemStore<T>, read: string, fn: (item: T) => unknown) {
  const column = store.column(read);
  const results = column.values.map((v) => fn({ [read]: v } as unknown as T));
  let absent = -1;
  const codeOf = (row: number) => {
    const code = column.codes[row]!;
    if (code !== ABSENT) return code;
    if (absent < 0) { absent = results.length; results.push(fn({} as T)); }
    return absent;
  };
  return { column, results, codeOf };
}

function flags<T extends Item>(store: ItemStore<T>, rule: ((item: T) => unknown)
                               & { reads: string[] | null }): Uint8Array {
  const out = new Uint8Array(store.length);
  // One field read: straight from its codes, with no grouped codes in between.
  if (rule.reads?.length === 1) {
    const { column, results, codeOf } = perValue(store, rule.reads[0]!, rule);
    const bits = Uint8Array.from(results, (r) => (r ? 1 : 0));
    for (let row = 0; row < out.length; row++) {
      const code = column.codes[row]!;
      out[row] = code !== ABSENT ? bits[code]! : results[codeOf(row)] ? 1 : 0;
    }
    return out;
  }
  const { codes, results } = evaluateGrouped(store, rule.reads, rule);
  const bits = results.map((r) => (r ? 1 : 0));
  for (let row = 0; row < out.length; row++) out[row] = bits[codes[row]!]!;
  return out;
}

const asColumn = ({ codes, results }: Grouped, shape: (v: unknown) => unknown): Column =>
  ({ codes, values: results.map(shape) });

const asTags = (v: unknown) => (Array.isArray(v) ? v as string[] : []);

export function derive<T extends Item>(c: CompiledSpec<T>,
                                       items: readonly T[] | ItemStore<T>): Facts<T> {
  const store = Array.isArray(items) ? storeFromItems(items as readonly T[]) : items as ItemStore<T>;
  assertIndices(store);
  const n = store.length;
  const rule = stateRule(c);
  const states = evaluateGrouped(store, rule.reads, rule.fn);
  const state = new Uint8Array(n);
  for (let row = 0; row < n; row++) state[row] = states.results[states.codes[row]!] as number;
  const table = (rules: Record<string, Parameters<typeof flags<T>>[1]>) =>
    Object.fromEntries(Object.entries(rules).map(([k, r]) => [k, flags(store, r)]));
  return {
    compiled: c,
    store,
    state,
    filters: table(c.filters),
    classes: table(c.classes),
    tags: c.tags ? asColumn(evaluateGrouped(store, c.tags.reads, c.tags), asTags)
      : { codes: new Int32Array(n), values: [[]] },
    facets: Object.fromEntries(Object.entries(c.facets).map(
      ([k, of]) => [k, asColumn(evaluateGrouped(store, of.reads, of), text)])),
    washed: c.washes ? flags(store, c.washes) : new Uint8Array(n),
    cache: newCache(),
  };
}

/** Re-derives the rows a delta touched, against the new store. */
export function rederive<T extends Item>(c: CompiledSpec<T>, facts: Facts<T>,
                                         items: readonly T[] | ItemStore<T>,
                                         rows: Iterable<number>): void {
  const store = Array.isArray(items) ? storeFromItems(items as readonly T[]) : items as ItemStore<T>;
  if (store.length !== facts.store.length) {
    throw new Error(`rederive over ${store.length} items, derived over ${facts.store.length}`);
  }
  assertIndices(store);
  facts.store = store;
  const rule = stateRule(c);
  for (const row of rows) {
    const item = store.get(row);
    unbind(item);
    facts.state[row] = rule.fn(item);
    for (const [key, keep] of Object.entries(c.filters)) facts.filters[key]![row] = keep(item) ? 1 : 0;
    for (const [key, member] of Object.entries(c.classes)) facts.classes[key]![row] = member(item) ? 1 : 0;
    if (c.tags) {
      facts.tags.codes[row] = facts.tags.values.length;
      (facts.tags.values as unknown[]).push(c.tags(item));
    }
    for (const [key, of] of Object.entries(c.facets)) {
      const column = facts.facets[key]!;
      column.codes[row] = column.values.length;
      (column.values as unknown[]).push(text(of(item)));
    }
    facts.washed[row] = c.washes?.(item) ? 1 : 0;
  }
  facts.cache = newCache();
}

export const stateKey = <T extends Item>(facts: Facts<T>, row: number): string =>
  facts.compiled.states[facts.state[row]!]!.key;

export const tagsOf = <T extends Item>(facts: Facts<T>, row: number): string[] =>
  facts.tags.values[facts.tags.codes[row]!] as string[];

export const facetOf = <T extends Item>(facts: Facts<T>, key: string, row: number): string | null => {
  const column = facts.facets[key];
  return column ? column.values[column.codes[row]!] as string | null : null;
};

export function sortColumn<T extends Item>(facts: Facts<T>, key: string): Column {
  let column = facts.cache.sorts.get(key);
  if (!column) {
    const rule = facts.compiled.sorts[key];
    if (!rule) throw new Error(`no sort named ${key}`);
    column = asColumn(evaluateGrouped(facts.store, rule.reads, rule), (v) => v ?? null);
    facts.cache.sorts.set(key, column);
  }
  return column;
}

/** A tint's position on its ramp per row, NaN where it has none. */
export function tintColumn<T extends Item>(facts: Facts<T>, key: string): Float32Array {
  let column = facts.cache.tints.get(key);
  if (!column) {
    const def = facts.compiled.spec.tints?.find((t) => t.key === key);
    if (!def) throw new Error(`no tint named ${key}`);
    const { codes, results } = evaluateGrouped(facts.store, def.reads, (item) => def.t(item));
    const at = results.map((v) => (v === null || v === undefined ? NaN : v as number));
    column = new Float32Array(facts.store.length);
    for (let row = 0; row < column.length; row++) column[row] = at[codes[row]!]!;
    facts.cache.tints.set(key, column);
  }
  return column;
}

export function tintAt<T extends Item>(facts: Facts<T>, key: string, row: number): number | null {
  const t = tintColumn(facts, key)[row]!;
  return Number.isNaN(t) ? null : t;
}

function perRow<T extends Item>(facts: Facts<T>, name: string, row: number,
                                rule: ((item: T) => unknown) | null | undefined): string | null {
  if (!rule) return null;
  let held = facts.cache.rows.get(name);
  if (!held) facts.cache.rows.set(name, held = new Map());
  if (held.has(row)) return held.get(row)!;
  const out = text(rule(facts.store.get(row)));
  held.set(row, out);
  return out;
}

/** Captions, glyphs and marks are only ever wanted for cells on screen, so
 *  they are worked out per row on demand. */
export const captionOf = <T extends Item>(facts: Facts<T>, key: string, row: number) =>
  perRow(facts, `caption:${key}`, row, facts.compiled.captions[key]);
export const glyphOf = <T extends Item>(facts: Facts<T>, row: number) =>
  perRow(facts, 'glyph', row, facts.compiled.glyph);
export const markOf = <T extends Item>(facts: Facts<T>, row: number) =>
  perRow(facts, 'mark', row, facts.compiled.mark);

/** A projection over every row, cached for as long as these facts stand. */
export function projectColumn<T extends Item>(facts: Facts<T>, key: object,
                                              reads: readonly string[] | null,
                                              fn: (item: T) => unknown): Column {
  let column = facts.cache.groups.get(key);
  if (!column) {
    column = asColumn(evaluateGrouped(facts.store, reads, fn), text);
    facts.cache.groups.set(key, column);
  }
  return column;
}

export function rowOfId<T extends Item>(facts: Facts<T>, id: string): number | undefined {
  if (!facts.cache.rowOfId) {
    const map = new Map<string, number>();
    for (let row = 0; row < facts.store.length; row++) map.set(facts.store.id(row), row);
    facts.cache.rowOfId = map;
  }
  return facts.cache.rowOfId.get(id);
}

/** Rows in index order: `out[i]` is the row whose index is `i`. */
export function rowsByIndex<T extends Item>(facts: Facts<T>): Uint32Array {
  if (!facts.cache.byIndex) {
    const out = new Uint32Array(facts.store.length);
    for (let row = 0; row < out.length; row++) out[facts.store.index(row)] = row;
    facts.cache.byIndex = out;
  }
  return facts.cache.byIndex;
}
