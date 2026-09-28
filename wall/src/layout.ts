import { screenToWorld, viewToTransform, type View } from '@weasel-js/core';
import type { Facts } from './derive';
import type { Item } from './schema';

export interface Rect { x: number; y: number; w: number; h: number }

/** The path a block's cells take through it, in order: across its rows; in a
 *  square spiral out from its center; or out from its top-left corner in
 *  L-shaped shells, each a column down and then a row back to the left. */
export type Fill = 'rows' | 'spiral' | 'corner';

export interface LayoutOptions {
  /** Edge of one cell in world units. */
  cell: number;
  /** Space between cells in world units. */
  gap: number;
  cols: number;
  /** A spiral or corner fill makes each block square, whatever `cols` says. */
  fill?: Fill;
}

/** A group header a layout wants drawn. `depth` 0 is the outer band, 1 an
 *  inner block inside it -- so paint styles the two without a second field,
 *  and a third level costs the type nothing. */
export interface Band {
  key: string;
  label: string;
  count: number;
  rect: Rect;
  depth: 0 | 1;
  /** World space the layout kept clear above the block's first cell row. The
   *  label is set to fit this, so the two cannot disagree about how much room
   *  the text has. */
  header: number;
}

/** A rectangle of cells: positions `start..start+count` of the laid order,
 *  `cols` to a row, its top-left at (`x`, `y`), laid along `fill` (rows when
 *  absent). A spiral or corner block is `cols` square. */
export interface Block {
  x: number; y: number; cols: number; start: number; count: number; fill?: Fill;
}

/** How many cells a side a square fill of `n` needs. */
export function squareSide(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/** How many rows of cells the block spans. */
export function rowsOf(b: Block): number {
  return !b.fill || b.fill === 'rows' ? Math.ceil(b.count / b.cols) : b.cols;
}

// The spiral steps right 1, down 1, left 2, up 2, right 3, ...; its first m*m
// cells are always an m-by-m square. Pair p is the two legs of length p+1 that
// start at index p(p+1), from (s(p), s(p)) relative to the center.
const pairStart = (p: number) => (p % 2 === 0 ? -p / 2 : (p + 1) / 2);
const pairSign = (p: number) => (p % 2 === 0 ? 1 : -1);

function spiralAt(i: number): [number, number] {
  const p = Math.floor((Math.sqrt(4 * i + 1) - 1) / 2);
  const len = p + 1;
  const s = pairStart(p);
  const sign = pairSign(p);
  const r = i - p * (p + 1);
  return r <= len ? [s + sign * r, s] : [s + sign * len, s + sign * (r - len)];
}

function spiralIndex(x: number, y: number): number {
  // The horizontal leg on row y, then the vertical leg on column x.
  const ph = y > 0 ? 2 * y - 1 : -2 * y;
  const rh = pairSign(ph) * (x - pairStart(ph));
  if (rh >= 0 && rh <= ph + 1) return ph * (ph + 1) + rh;
  const pv = x > 0 ? 2 * x - 2 : -2 * x - 1;
  const rv = pairSign(pv) * (y - pairStart(pv));
  return pv * (pv + 1) + pv + 1 + rv;
}

const centers = new Map<number, [number, number]>();
/** Where the spiral's center sits in a square of `side`: the first side*side
 *  cells span one, and the extremes lie at the ends of the pairs' legs. */
function spiralCenter(side: number): [number, number] {
  let at = centers.get(side);
  if (!at) {
    const last = side * side - 1;
    let minX = 0;
    let minY = 0;
    for (let p = 0; p * (p + 1) <= last; p++) {
      for (const i of [p * (p + 1), p * (p + 1) + p + 1, p * (p + 1) + 2 * p + 1]) {
        const [x, y] = spiralAt(Math.min(i, last));
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
      }
    }
    at = [-minX, -minY];
    centers.set(side, at);
  }
  return at;
}

/** The column and row of the block's `i`th cell. */
export function cellOf(b: Block, i: number): [number, number] {
  if (b.fill === 'spiral') {
    const [cx, cy] = spiralCenter(b.cols);
    const [x, y] = spiralAt(i);
    return [cx + x, cy + y];
  }
  if (b.fill === 'corner') {
    const n = Math.floor(Math.sqrt(i));
    const k = i - n * n;
    return k <= n ? [n, k] : [2 * n - k, n];
  }
  return [i % b.cols, Math.floor(i / b.cols)];
}

/** Which of the block's cells sits at column `c`, row `r`, or null for none. */
export function indexAt(b: Block, c: number, r: number): number | null {
  if (c < 0 || r < 0 || c >= b.cols) return null;
  let i: number;
  if (b.fill === 'spiral') {
    if (r >= b.cols) return null;
    const [cx, cy] = spiralCenter(b.cols);
    i = spiralIndex(c - cx, r - cy);
  } else if (b.fill === 'corner') {
    if (r >= b.cols) return null;
    const n = Math.max(c, r);
    i = c === n ? n * n + r : n * n + 2 * n - c;
  } else {
    i = r * b.cols + c;
  }
  return i < b.count ? i : null;
}

/** Where every cell sits, as blocks rather than a rect per item. `order[p]`
 *  is the row drawn at position `p`. */
export interface Laid {
  order: Uint32Array;
  blocks: Block[];
  bands: Band[];
  bounds: { w: number; h: number };
  cell: number;
  pitch: number;
}

export interface LayoutInput<T extends Item> {
  /** The selection, in view order. */
  rows: Uint32Array;
  facts?: Facts<T>;
}

/** A layout answers where each item's cell sits, and nothing else. It never
 *  touches the atlas, so re-sorting or regrouping the wall rebakes nothing. */
export type Layout<T extends Item = Item> = (input: LayoutInput<T>, opts: LayoutOptions) => Laid;

export const gridLayout: Layout = ({ rows }, { cell, gap, cols, fill = 'rows' }) => {
  const pitch = cell + gap;
  const n = rows.length;
  const block: Block = fill === 'rows' ? { x: 0, y: 0, cols, start: 0, count: n }
    : { x: 0, y: 0, cols: squareSide(n), start: 0, count: n, fill };
  return {
    order: rows,
    blocks: n ? [block] : [],
    bands: [],
    bounds: n ? { w: Math.min(n, block.cols) * pitch - gap, h: rowsOf(block) * pitch - gap }
      : { w: 0, h: 0 },
    cell,
    pitch,
  };
};

function blockOf(laid: Laid, position: number): Block | undefined {
  const { blocks } = laid;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid]!;
    if (position < b.start) hi = mid - 1;
    else if (position >= b.start + b.count) lo = mid + 1;
    else return b;
  }
  return undefined;
}

export function rectAt(laid: Laid, position: number): Rect | undefined {
  const b = blockOf(laid, position);
  if (!b) return undefined;
  const [c, r] = cellOf(b, position - b.start);
  return { x: b.x + c * laid.pitch, y: b.y + r * laid.pitch, w: laid.cell, h: laid.cell };
}

/** The position whose cell holds the world point. A gap belongs to the cell
 *  before it: at a few pixels a cell, the gaps are much of what gets clicked. */
export function positionAt(laid: Laid, x: number, y: number): number | null {
  for (const b of laid.blocks) {
    const col = Math.floor((x - b.x) / laid.pitch);
    const row = Math.floor((y - b.y) / laid.pitch);
    const i = indexAt(b, col, row);
    if (i !== null) return b.start + i;
  }
  return null;
}

export interface Viewport { width: number; height: number; x?: number; y?: number }

/** Per block, the column and row span of cells touching the viewport. */
export function visibleSpans(laid: Laid, view: View, viewport: Viewport):
    { block: Block; c0: number; c1: number; r0: number; r1: number }[] {
  const transform = viewToTransform(view);
  const x0 = viewport.x ?? 0;
  const y0 = viewport.y ?? 0;
  const [tlX, tlY] = screenToWorld(x0, y0, transform);
  const [brX, brY] = screenToWorld(x0 + viewport.width, y0 + viewport.height, transform);
  const { pitch, cell } = laid;
  const out = [];
  for (const block of laid.blocks) {
    if (block.count === 0) continue;
    const rows = rowsOf(block);
    // A cell at column c spans [x + c*pitch, x + c*pitch + cell).
    const c0 = Math.max(0, Math.floor((tlX - block.x - cell) / pitch) + 1);
    const c1 = Math.min(block.cols - 1, Math.ceil((brX - block.x) / pitch) - 1);
    const r0 = Math.max(0, Math.floor((tlY - block.y - cell) / pitch) + 1);
    const r1 = Math.min(rows - 1, Math.ceil((brY - block.y) / pitch) - 1);
    if (c0 > c1 || r0 > r1) continue;
    out.push({ block, c0, c1, r0, r1 });
  }
  return out;
}

/** Positions of the cells touching the viewport, or null when there are more
 *  than `limit` of them.
 *
 *  `viewport` may carry an origin, in the same CSS pixels as its size and
 *  measured from the canvas's own top-left. A pinch leaves only part of the
 *  canvas on screen, and that part is not at its corner; without the origin
 *  the range covers the whole canvas, which is how a pinched wall would fetch
 *  a sharper tile for every cell including the ones nobody can see. */
export function visiblePositions(laid: Laid, view: View, viewport: Viewport,
                                 limit = Infinity): number[] | null {
  const spans = visibleSpans(laid, view, viewport);
  let total = 0;
  for (const s of spans) total += (s.c1 - s.c0 + 1) * (s.r1 - s.r0 + 1);
  if (total > limit) return null;
  const out: number[] = [];
  for (const { block, c0, c1, r0, r1 } of spans) {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = indexAt(block, c, r);
        if (i !== null) out.push(block.start + i);
      }
    }
  }
  return out;
}

/** How many cells touch the viewport, without listing them. */
export function visibleCount(laid: Laid, view: View, viewport: Viewport): number {
  let total = 0;
  for (const s of visibleSpans(laid, view, viewport)) {
    const lastRowCells = s.block.count - s.r1 * s.block.cols;
    total += (s.c1 - s.c0 + 1) * (s.r1 - s.r0)
      + Math.max(0, Math.min(s.c1 + 1, lastRowCells) - s.c0);
  }
  return total;
}
