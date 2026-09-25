// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeFilters, filterCache, filterMap, inkFilter, type ImageFilter } from '../src/filter';

let calls: string[];

beforeEach(() => {
  calls = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const ctx = {
      set globalCompositeOperation(op: string) { calls.push(`op:${op}`); },
      set fillStyle(style: string) { calls.push(`fill:${style}`); },
      drawImage: () => calls.push('draw'),
      fillRect: () => calls.push('rect'),
    };
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);
});
afterEach(() => vi.restoreAllMocks());

function source(w = 4, h = 4): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function counting(key: string): ImageFilter & { runs: number } {
  const f = { key, runs: 0, apply() { f.runs += 1; } };
  return f;
}

describe('inkFilter', () => {
  it('screens the ink over the drawing, then restores its alpha', () => {
    filterCache()(source(), inkFilter('#c03'));
    expect(calls).toEqual(['draw', 'op:screen', 'fill:#c03', 'rect', 'op:destination-in', 'draw']);
  });
});

describe('filterCache', () => {
  it('filters a source once per key, at the source size', () => {
    const cached = filterCache();
    const f = counting('a');
    const src = source(7, 3);
    const out = cached(src, f);
    expect(cached(src, f)).toBe(out);
    expect(cached(src, { ...counting('a') })).toBe(out);
    expect(f.runs).toBe(1);
    expect([out.width, out.height]).toEqual([7, 3]);
  });

  it('re-filters when the key changes', () => {
    const cached = filterCache();
    const src = source();
    const first = cached(src, counting('a'));
    const b = counting('b');
    expect(cached(src, b)).not.toBe(first);
    expect(b.runs).toBe(1);
  });

  it('skips an empty source rather than drawing into nothing', () => {
    const f = counting('a');
    filterCache()(source(0, 0), f);
    expect(f.runs).toBe(0);
  });
});

describe('composeFilters', () => {
  it('joins the keys and runs each filter in order', () => {
    const order: string[] = [];
    const step = (key: string): ImageFilter => ({ key, apply: () => { order.push(key); } });
    const both = composeFilters(step('a'), step('b'), step('c'));
    expect(both.key).toBe('a|b|c');
    filterCache()(source(), both);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('filterMap', () => {
  it('hands back the same map with no filter', () => {
    const images = new Map<string, CanvasImageSource>([['x', source()]]);
    expect(filterMap(images, null, filterCache())).toBe(images);
  });

  it('filters every value and keeps the keys', () => {
    const images = new Map<string, CanvasImageSource>([['x', source()], ['y', source()]]);
    const out = filterMap(images, counting('a'), filterCache());
    expect([...out.keys()]).toEqual(['x', 'y']);
    expect(out.get('x')).not.toBe(images.get('x'));
  });
});
