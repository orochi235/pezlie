import { projectColumn } from './derive';
import { rowsOf, squareSide, type Band, type Block, type Layout, type LayoutInput,
  type LayoutOptions, type Rect } from './layout';
import type { Item } from './schema';

/** The key an item with no value for a grouping falls under. */
export const UNKNOWN_GROUP = 'unknown';

/** What a grouping groups by. `of` is called once per distinct combination of
 *  the values of `reads`, with an object holding only those fields. */
export interface GroupKey<T> {
  reads: readonly string[];
  of: (item: T) => string;
  /** What a group's band says, where the key is shaped for sorting. */
  label?: (key: string) => string;
}

export interface Group { key: string; label?: string; count: number }
export interface Flowed { blocks: Block[]; bands: Band[]; height: number }

// A block a little wider than tall reads as a block rather than a column, and
// packs more groups per row than a square would.
const BLOCK_ASPECT = 1.35;
// Blocks are separated by two pitches; less and two groups read as one.
const BLOCK_GAP_PITCHES = 2;

// Wide enough that an empty block is a named space rather than a gap: with
// one column its heading is narrower than its own word and `paint` drops it.
const EMPTY_BLOCK_COLS = 4;

export function blockCols(n: number, cols: number): number {
  if (n === 0) return Math.min(cols, EMPTY_BLOCK_COLS);
  return Math.min(cols, Math.max(1, Math.ceil(Math.sqrt(n * BLOCK_ASPECT))));
}

/** Pack `groups` as blocks flowed across `cols` cells, starting at `top`, the
 *  first group's cells at position `start`.
 *
 *  `headerRows` rows of pitch are reserved above every block for its label.
 *
 *  `depth` is how the label is set, not how deep the call is: a grouping with
 *  one level has no outer band for its blocks to defer to, so they are the
 *  outer band and read like it. */
export function flowBlocks(groups: Group[], opts: LayoutOptions, top: number,
                           headerRows: number, depth: 0 | 1 = 1, start = 0): Flowed {
  const pitch = opts.cell + opts.gap;
  const width = opts.cols * pitch;
  const gutter = BLOCK_GAP_PITCHES * pitch;
  const blocks: Block[] = [];
  const bands: Band[] = [];
  let x = 0;
  let y = top;
  let rowHeight = 0;
  let at = start;

  for (const group of groups) {
    const n = group.count;
    // A square fill wider than the wall falls back to rows.
    const side = squareSide(n);
    const fill = opts.fill && opts.fill !== 'rows' && side <= opts.cols ? opts.fill : undefined;
    const block: Block = fill ? { x, y: 0, cols: side, start: at, count: n, fill }
      : { x, y: 0, cols: blockCols(n, opts.cols), start: at, count: n };
    const rows = rowsOf(block);
    const w = block.cols * pitch;
    if (x > 0 && x + w > width) {
      x = 0;
      y += rowHeight + gutter;
      rowHeight = 0;
    }
    blocks.push({ ...block, x, y: y + headerRows * pitch });
    at += n;
    const h = headerRows * pitch + rows * pitch - opts.gap;
    bands.push({ key: group.key, label: group.label ?? group.key, count: n,
                 rect: { x, y, w: w - opts.gap, h }, depth,
                 header: headerRows * pitch });
    rowHeight = Math.max(rowHeight, h);
    x += w + gutter;
  }

  return { blocks, bands, height: groups.length ? y + rowHeight - top : 0 };
}

const OUTER_HEADER_ROWS = 2;
const INNER_HEADER_ROWS = 1;
// Between two outer bands. Wider than the gap between blocks inside one, or
// the levels stop reading as levels.
const BAND_GAP_PITCHES = 3;

function boundsOf(blocks: Block[], bands: Band[], opts: LayoutOptions): { w: number; h: number } {
  const pitch = opts.cell + opts.gap;
  let w = 0;
  let h = 0;
  const grow = (r: Rect) => { w = Math.max(w, r.x + r.w); h = Math.max(h, r.y + r.h); };
  for (const b of blocks) {
    if (b.count === 0) continue;
    grow({ x: b.x, y: b.y, w: Math.min(b.count, b.cols) * pitch - opts.gap,
           h: rowsOf(b) * pitch - opts.gap });
  }
  for (const band of bands) grow(band.rect);
  return { w, h };
}

/** Each row's group key along `rows`, and the distinct keys in first-seen order. */
function keysAlong<T extends Item>(input: LayoutInput<T>, key: GroupKey<T>) {
  if (!input.facts) throw new Error('a grouped layout needs the facts');
  const column = projectColumn(input.facts, key, key.reads, (item) => key.of(item));
  // Distinct results can name the same group; fold them onto one id.
  const ids = new Map<string, number>();
  const codeToId = Int32Array.from(column.values, (v) => {
    const k = (v as string | null) ?? UNKNOWN_GROUP;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, id = ids.size);
    return id;
  });
  const along = new Int32Array(input.rows.length);
  input.rows.forEach((row, p) => { along[p] = codeToId[column.codes[row]!]!; });
  return { along, names: [...ids.keys()] };
}

/** Rows regrouped: `rank[id]` is each key's place, stable within a key. */
function regroup(rows: Uint32Array, along: Int32Array, rank: Int32Array, ranks: number) {
  const starts = new Uint32Array(ranks + 1);
  for (let p = 0; p < rows.length; p++) starts[rank[along[p]!]! + 1]!++;
  const counts = starts.slice(1);
  for (let r = 1; r < starts.length; r++) starts[r]! += starts[r - 1]!;
  const order = new Uint32Array(rows.length);
  for (let p = 0; p < rows.length; p++) order[starts[rank[along[p]!]!]!++] = rows[p]!;
  return { order, counts };
}

/** One level of grouping, blocks flowed and wrapped. `order` fixes which block
 *  comes first; a key it does not name sorts after the ones it does. */
export function blockLayout<T extends Item>(key: GroupKey<T>, order: string[]): Layout<T> {
  return (input, opts) => {
    const { along, names } = keysAlong(input, key);
    // Every named group keeps its place whether or not it has any items: one
    // that vanished at zero would reflow every block after it, moving items
    // across the screen for a reason that had nothing to do with them.
    const all = [...new Set([...order, ...names])];
    const place = new Map(order.map((k, i) => [k, i]));
    all.sort((a, b) => (place.get(a) ?? order.length) - (place.get(b) ?? order.length)
                    || a.localeCompare(b));
    const rankOf = new Map(all.map((k, i) => [k, i]));
    const rank = Int32Array.from(names, (k) => rankOf.get(k)!);
    const { order: laid, counts } = regroup(input.rows, along, rank, all.length);
    const groups = all.map((k, i) => ({ key: k, label: key.label?.(k), count: counts[i]! }));
    const { blocks, bands } = flowBlocks(groups, opts, 0, OUTER_HEADER_ROWS, 0);
    return { order: laid, blocks, bands, bounds: boundsOf(blocks, bands, opts),
             cell: opts.cell, pitch: opts.cell + opts.gap };
  };
}

// `UNKNOWN_GROUP` is always last, in both directions: it is an absence, not
// an extreme, and sorting it to one end would read as a value.
function keyOrder(desc: boolean) {
  return (a: string, b: string) => {
    if ((a === UNKNOWN_GROUP) !== (b === UNKNOWN_GROUP)) return a === UNKNOWN_GROUP ? 1 : -1;
    return a.localeCompare(b, undefined, { numeric: true }) * (desc ? -1 : 1);
  };
}

/** Two levels: outer groups stack as bands, inner groups flow inside one. */
export function bandedLayout<T extends Item>(outer: GroupKey<T>, inner: GroupKey<T>,
                                             desc: boolean): Layout<T> {
  return (input, opts) => {
    const pitch = opts.cell + opts.gap;
    const cmp = keyOrder(desc);
    const o = keysAlong(input, outer);
    const i = keysAlong(input, inner);
    const outerNames = [...o.names].sort(cmp);
    const innerNames = [...i.names].sort(cmp);
    const outerRank = new Map(outerNames.map((k, r) => [k, r]));
    const innerRank = new Map(innerNames.map((k, r) => [k, r]));
    const oRank = Int32Array.from(o.names, (k) => outerRank.get(k)!);
    const iRank = Int32Array.from(i.names, (k) => innerRank.get(k)!);

    // One combined key per (outer, inner) pair, dense over the pairs present.
    const pairs = new Map<number, number>();
    const combined = new Int32Array(input.rows.length);
    for (let p = 0; p < combined.length; p++) {
      const k = oRank[o.along[p]!]! * innerNames.length + iRank[i.along[p]!]!;
      let id = pairs.get(k);
      if (id === undefined) pairs.set(k, id = pairs.size);
      combined[p] = id;
    }
    const sortedPairs = [...pairs.entries()].sort((a, b) => a[0] - b[0]);
    const rank = new Int32Array(pairs.size);
    sortedPairs.forEach(([, id], r) => { rank[id] = r; });
    const { order, counts } = regroup(input.rows, combined, rank, pairs.size);

    const blocks: Block[] = [];
    const bands: Band[] = [];
    let y = 0;
    let start = 0;
    let at = 0;
    while (at < sortedPairs.length) {
      const outerAt = Math.floor(sortedPairs[at]![0] / innerNames.length);
      const inside: Group[] = [];
      while (at < sortedPairs.length
             && Math.floor(sortedPairs[at]![0] / innerNames.length) === outerAt) {
        const name = innerNames[sortedPairs[at]![0] % innerNames.length]!;
        inside.push({ key: name, label: inner.label?.(name), count: counts[at]! });
        at++;
      }
      const total = inside.reduce((sum, g) => sum + g.count, 0);
      const top = y + OUTER_HEADER_ROWS * pitch;
      const flowed = flowBlocks(inside, opts, top, INNER_HEADER_ROWS, 1, start);
      const h = OUTER_HEADER_ROWS * pitch + flowed.height;
      const key = outerNames[outerAt]!;
      bands.push({ key, label: outer.label?.(key) ?? key, count: total,
                   rect: { x: 0, y, w: opts.cols * pitch - opts.gap, h },
                   depth: 0, header: OUTER_HEADER_ROWS * pitch });
      bands.push(...flowed.bands);
      blocks.push(...flowed.blocks);
      start += total;
      y += h + BAND_GAP_PITCHES * pitch;
    }

    return { order, blocks, bands, bounds: boundsOf(blocks, bands, opts),
             cell: opts.cell, pitch };
  };
}
