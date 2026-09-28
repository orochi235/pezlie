import { describe, expect, it } from 'vitest';
import { compile } from '../src/cel';
import { derive } from '../src/derive';
import { bandedLayout, blockLayout, flowBlocks, type GroupKey } from '../src/grouped';
import { rectAt, type Laid } from '../src/layout';
import type { CorpusSpec, Item } from '../src/schema';

const opts = { cell: 10, gap: 0, cols: 10 };   // pitch 10, 100 wide

describe('flowBlocks', () => {
  it('places a group\'s cells row-major under its own header', () => {
    const out = flowBlocks([{ key: 'a', count: 4 }], opts, 0, 1);
    // 4 items -> ceil(sqrt(4 * 1.35)) = 3 columns
    expect(out.blocks).toEqual([{ x: 0, y: 10, cols: 3, start: 0, count: 4 }]);
  });

  it('reserves the header rows above each block, and says how much', () => {
    const out = flowBlocks([{ key: 'a', count: 1 }], opts, 0, 2);
    expect(out.blocks[0]!.y).toBe(20);
    expect(out.bands[0]!.header).toBe(20);
  });

  it('wraps to a new row when the next block would overrun', () => {
    const out = flowBlocks([{ key: 'w', count: 64 }, { key: 'n', count: 1 }], opts, 0, 1);
    const band = out.bands.find((b) => b.key === 'n')!;
    expect(band.rect.x).toBe(0);
    expect(band.rect.y).toBeGreaterThan(0);
  });

  it('never gives a block more columns than the width allows', () => {
    expect(flowBlocks([{ key: 'a', count: 400 }], opts, 0, 1).blocks[0]!.cols).toBe(10);
  });

  it('numbers positions on from where it starts', () => {
    const out = flowBlocks([{ key: 'a', count: 2 }, { key: 'b', count: 3 }], opts, 0, 1, 1, 7);
    expect(out.blocks.map((b) => [b.start, b.count])).toEqual([[7, 2], [9, 3]]);
    expect(out.bands.map((b) => [b.key, b.count, b.depth])).toEqual([['a', 2, 1], ['b', 3, 1]]);
  });

  it('is empty for no groups, and reports no height', () => {
    const out = flowBlocks([], opts, 0, 1);
    expect(out.blocks).toEqual([]);
    expect(out.height).toBe(0);
  });
});

interface Row extends Item { year: number | null }
const SPEC: CorpusSpec<Row> = {
  states: [{ key: 'ok', label: 'ok', fill: '#000000', border: null, weight: null,
             shape: 'square', precedence: 1, match: 'true' }],
  filters: [{ key: 'all', label: 'all', keep: 'true' }], classes: [],
  sorts: [{ key: 'id', label: 'id', value: 'item.id', desc: false }],
};
const compiled = compile(SPEC);
const r = (id: string, index: number, over: Partial<Row> = {}): Row =>
  ({ id, index, sha: null, year: null, ...over });

function lay(items: Row[], layout: ReturnType<typeof blockLayout<Row>>): Laid {
  const facts = derive(compiled, items);
  return layout({ rows: Uint32Array.from(items, (_, i) => i), facts }, opts);
}
const idsAt = (items: Row[], laid: Laid) => Array.from(laid.order, (row) => items[row]!.id);

describe('blockLayout', () => {
  const drawnOrNot: GroupKey<Row> = { reads: ['sha'], of: (x) => (x.sha ? 'drawn' : 'untried') };

  it('gathers each group\'s rows together, keeping their order within it', () => {
    const items = [r('a', 0, { sha: 'x' }), r('b', 1), r('d', 2, { sha: 'x' })];
    const laid = lay(items, blockLayout(drawnOrNot, ['drawn', 'untried']));
    expect(idsAt(items, laid)).toEqual(['a', 'd', 'b']);
    expect(laid.bands.map((b) => [b.key, b.count])).toEqual([['drawn', 2], ['untried', 1]]);
    expect(rectAt(laid, 2)!.x + rectAt(laid, 2)!.y).toBeGreaterThan(rectAt(laid, 0)!.x);
  });

  it('keeps a named group nothing falls into, in its place', () => {
    // A group that vanished when it hit zero would reflow every block after
    // it, moving items across the screen for no reason of their own.
    const laid = lay([r('a', 0)], blockLayout({ reads: [], of: () => 'drawn' }, ['drawn', 'untried']));
    expect(laid.bands.map((b) => [b.key, b.count])).toEqual([['drawn', 1], ['untried', 0]]);
  });

  it('leaves an unnamed group out when it is empty, having no place to keep', () => {
    const laid = lay([r('a', 0)], blockLayout(drawnOrNot, []));
    expect(laid.bands.map((b) => b.key)).toEqual(['untried']);
  });
});

describe('bandedLayout', () => {
  const byDecade: GroupKey<Row> = {
    reads: ['year'], of: (x) => (x.year ? `${Math.floor(x.year / 10) * 10}s` : 'unknown'),
  };
  const byYear: GroupKey<Row> = { reads: ['year'], of: (x) => (x.year ? String(x.year) : 'unknown') };

  it('stacks the outer groups and puts the newest first when descending', () => {
    const items = [r('a', 0, { year: 1974 }), r('b', 1, { year: 2011 })];
    const laid = lay(items, bandedLayout(byDecade, byYear, true));
    const outer = laid.bands.filter((b) => b.depth === 0);
    expect(outer.map((b) => b.key)).toEqual(['2010s', '1970s']);
    expect(outer[0]!.rect.y).toBeLessThan(outer[1]!.rect.y);
    expect(idsAt(items, laid)).toEqual(['b', 'a']);
  });

  it('runs oldest first when ascending', () => {
    const items = [r('a', 0, { year: 1974 }), r('b', 1, { year: 2011 })];
    const laid = lay(items, bandedLayout(byDecade, byYear, false));
    expect(laid.bands.filter((b) => b.depth === 0).map((b) => b.key)).toEqual(['1970s', '2010s']);
  });

  it('sorts the undated band last whichever way the rest runs', () => {
    const items = [r('a', 0, { year: 1974 }), r('b', 1)];
    for (const desc of [true, false]) {
      const outer = lay(items, bandedLayout(byDecade, byYear, desc)).bands.filter((b) => b.depth === 0);
      expect(outer[outer.length - 1]!.key).toBe('unknown');
    }
  });

  it('breaks a band into its inner groups at depth 1, each cell inside its block', () => {
    const items = [r('a', 0, { year: 1974 }), r('b', 1, { year: 1978 }), r('c', 2, { year: 1974 })];
    const laid = lay(items, bandedLayout(byDecade, byYear, true));
    expect(laid.bands.filter((b) => b.depth === 1).map((b) => [b.key, b.count]))
      .toEqual([['1978', 1], ['1974', 2]]);
    expect(idsAt(items, laid)).toEqual(['b', 'a', 'c']);
    laid.blocks.forEach((block, i) => {
      const band = laid.bands.filter((b) => b.depth === 1)[i]!;
      for (let p = block.start; p < block.start + block.count; p++) {
        const cell = rectAt(laid, p)!;
        expect(cell.x).toBeGreaterThanOrEqual(band.rect.x);
        expect(cell.y + cell.h).toBeLessThanOrEqual(band.rect.y + band.rect.h);
      }
    });
  });

  it('bounds the whole wall, not just the last band', () => {
    const items = [r('a', 0, { year: 1974 }), r('b', 1, { year: 2011 })];
    const laid = lay(items, bandedLayout(byDecade, byYear, true));
    const lowest = Math.max(...Array.from(laid.order, (_, p) => rectAt(laid, p)!.y + 10));
    expect(laid.bounds.h).toBeGreaterThanOrEqual(lowest);
  });
});

describe('group labels', () => {
  it('sorts by the key and says the label', () => {
    const items = [r('a', 0, { year: 2011 }), r('b', 1, { year: 1974 })];
    const key: GroupKey<Row> = { reads: ['year'], of: (x) => String(x.year), label: (k) => `year ${k}` };
    const laid = lay(items, blockLayout(key, []));
    expect(laid.bands.map((b) => [b.key, b.label])).toEqual([['1974', 'year 1974'], ['2011', 'year 2011']]);
  });
});

it('makes each group a square block under a square fill, unless the square is wider than the wall', () => {
  const groups = [{ key: 'a', count: 10 }, { key: 'b', count: 200 }];
  const { blocks } = flowBlocks(groups, { cell: 10, gap: 0, cols: 12, fill: 'corner' }, 0, 1);
  expect(blocks[0]).toMatchObject({ cols: 4, fill: 'corner' });
  expect(blocks[1]!.fill).toBeUndefined();
});
