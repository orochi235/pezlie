import { describe, expect, it } from 'vitest';
import {
  cellOf, gridLayout, indexAt, positionAt, rectAt, squareSide, visibleCount, visiblePositions,
  type Laid, type Rect,
} from '../src/layout';

const rows = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);
const grid = (n: number, cols = 2, cell = 10, gap = 2) => gridLayout({ rows: rows(n) }, { cell, gap, cols });
const rects = (laid: Laid) => Array.from(laid.order, (_, p) => rectAt(laid, p)!);

describe('gridLayout', () => {
  it('fills row-major at the given pitch', () => {
    const r = rects(grid(4));
    expect(r[0]).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(r[1]).toEqual({ x: 12, y: 0, w: 10, h: 10 });
    expect(r[2]).toEqual({ x: 0, y: 12, w: 10, h: 10 });
  });

  it('reports bounds that contain every rect', () => {
    expect(grid(4).bounds).toEqual({ w: 22, h: 22 });
  });

  it('lays out the rows in the order given', () => {
    const laid = gridLayout({ rows: Uint32Array.from([3, 1, 2]) }, { cell: 10, gap: 2, cols: 2 });
    expect(Array.from(laid.order)).toEqual([3, 1, 2]);
  });

  it('lays out nothing without dividing by zero', () => {
    const laid = grid(0);
    expect([laid.blocks, laid.bands, laid.bounds]).toEqual([[], [], { w: 0, h: 0 }]);
    expect(rectAt(laid, 0)).toBeUndefined();
  });
});

const view = (x: number, y: number, s = 1) => ({ x, y, scale: { x: s, y: s } });

function bruteVisible(all: Rect[], v: ReturnType<typeof view>, vp: { width: number; height: number; x?: number; y?: number }) {
  const x0 = (vp.x ?? 0) / v.scale.x + v.x;
  const y0 = (vp.y ?? 0) / v.scale.y + v.y;
  const x1 = x0 + vp.width / v.scale.x;
  const y1 = y0 + vp.height / v.scale.y;
  return all.flatMap((r, i) => (r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0 ? [i] : []));
}

describe('visiblePositions', () => {
  const laid = grid(23, 5);
  const all = rects(laid);

  it('agrees with a scan of every rect, across cameras and slices', () => {
    for (const [x, y, s] of [[0, 0, 1], [5, 0, 1], [-20, -7, 2], [30, 40, 0.5], [500, 500, 1]] as const) {
      for (const vp of [{ width: 15, height: 15 }, { width: 40, height: 25 },
                        { x: 18, y: 3, width: 14, height: 14 }]) {
        const want = bruteVisible(all, view(x, y, s), vp);
        expect(visiblePositions(laid, view(x, y, s), vp)!.sort((a, b) => a - b), `${x},${y},${s}`).toEqual(want);
        expect(visibleCount(laid, view(x, y, s), vp)).toBe(want.length);
      }
    }
  });

  it('declines to list more than the limit', () => {
    expect(visiblePositions(laid, view(0, 0), { width: 100, height: 100 }, 5)).toBeNull();
  });
});

describe('positionAt', () => {
  const laid = grid(5, 2);

  it('finds the cell under a world point, counts a gap with the cell before it, and nothing past the end', () => {
    expect(positionAt(laid, 3, 3)).toBe(0);
    expect(positionAt(laid, 13, 14)).toBe(3);
    expect(positionAt(laid, 11, 3)).toBe(0);
    expect(positionAt(laid, 13, 26)).toBeNull();
    expect(positionAt(laid, -1, 3)).toBeNull();
    expect(positionAt(laid, 25, 3)).toBeNull();
  });
});

describe('square fills', () => {
  for (const fill of ['spiral', 'corner'] as const) {
    it(`puts every ${fill} index on its own cell inside the square, and finds it again`, () => {
      for (const n of [1, 2, 3, 4, 5, 9, 10, 16, 17, 24, 25, 26, 99, 100, 101]) {
        const block = { x: 0, y: 0, cols: squareSide(n), start: 0, count: n, fill };
        const seen = new Set<string>();
        for (let i = 0; i < n; i++) {
          const [c, r] = cellOf(block, i);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThan(block.cols);
          expect(r).toBeLessThan(block.cols);
          seen.add(`${c},${r}`);
          expect(indexAt(block, c, r)).toBe(i);
        }
        expect(seen.size).toBe(n);
      }
    });
  }

  it('starts a spiral at the center and walks its first ring around it', () => {
    const block = { x: 0, y: 0, cols: 3, start: 0, count: 9, fill: 'spiral' as const };
    expect(cellOf(block, 0)).toEqual([1, 1]);
    const ring = Array.from({ length: 8 }, (_, i) => cellOf(block, i + 1));
    for (const [c, r] of ring) expect(Math.max(Math.abs(c - 1), Math.abs(r - 1))).toBe(1);
  });

  it('grows corner shells from the top-left, a column down and then a row back', () => {
    const block = { x: 0, y: 0, cols: 3, start: 0, count: 9, fill: 'corner' as const };
    expect(Array.from({ length: 9 }, (_, i) => cellOf(block, i))).toEqual([
      [0, 0], [1, 0], [1, 1], [0, 1], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2]]);
  });

  it('lays, hits and lists a spiral wall through the same paths', () => {
    const rows = Uint32Array.from({ length: 10 }, (_, i) => i);
    const laid = gridLayout({ rows }, { cell: 10, gap: 0, cols: 99, fill: 'spiral' });
    expect(laid.bounds).toEqual({ w: 40, h: 40 });
    for (let p = 0; p < 10; p++) {
      const r = rectAt(laid, p)!;
      expect(positionAt(laid, r.x + 5, r.y + 5)).toBe(p);
    }
    const all = visiblePositions(laid, { x: 0, y: 0, scale: { x: 1, y: 1 } }, { width: 40, height: 40 })!;
    expect([...all].sort((a, b) => a - b)).toEqual([...rows]);
  });
});
