// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { thumbUrl, useLooseThumbs, wanted } from '../src/useLooseThumbs';
import { defaultUrls, imageKey } from '../src/urls';
import type { Item } from '../src/schema';

const item = (id: string, index: number, sha: string | null): Item => ({ id, index, sha });
const urls = defaultUrls('/api');

it('names the slot and cache-busts on the render sha', () => {
  expect(thumbUrl(urls, item('a1', 0, 'deadbeefcafe'), 'naive'))
    .toBe('/api/thumbs/naive/128/a1.webp?v=deadbeef');
});

it('wants nothing below the loose level', () => {
  expect(wanted([item('a', 0, 'x')], [0], 32)).toEqual([]);
});

it('fetches at the loose level the slot was baked at', () => {
  expect(wanted([item('a', 0, 'x')], [0], 128, new Set(), 256)).toEqual([]);
  expect(thumbUrl(urls, item('a1', 0, 'deadbeefcafe'), 'naive', 256))
    .toBe('/api/thumbs/naive/256/a1.webp?v=deadbeef');
});

it('wants only visible items that have a render', () => {
  const items = [item('a', 0, 'x'), item('b', 1, null)];
  expect(wanted(items, [0, 1], 128).map((c) => c.id)).toEqual(['a']);
});

it('caps how many it asks for at once', () => {
  const many = Array.from({ length: 300 }, (_, i) => item(`p${i}`, i, 'x'));
  expect(wanted(many, many.map((_, i) => i), 128).length).toBe(200);
});

it('keeps asking for items behind the cap once the front of the view is in hand', () => {
  // Counting items already in hand toward the cap starved everything behind
  // them, for good, since the requested set only grows.
  const many = Array.from({ length: 500 }, (_, i) => item(`c${i}`, i, `sha${i}`));
  const all = many.map((_, i) => i);
  const have = new Set(many.slice(0, 200).map(imageKey));
  const next = wanted(many, all, 128, have);
  expect(next.length).toBe(200);
  expect(next[0]!.id).toBe('c200');
});

it('keeps the fields a host added to its items', () => {
  const rich = [{ ...item('a', 0, 'x'), title: 'A' }];
  expect(wanted(rich, [0], 128)[0]!.title).toBe('A');
});

it('wants only the ids a layer holds when it is told which', () => {
  const items = [item('a', 0, 'x'), item('b', 1, 'x')];
  expect(wanted(items, [0, 1], 128, new Set(), 128, new Set(['b'])).map((c) => c.id))
    .toEqual(['b']);
});

it('wants an item in hand again once its render moves', () => {
  const have = new Set([imageKey(item('a', 0, 'old'))]);
  expect(wanted([item('a', 0, 'old')], [0], 128, have)).toEqual([]);
  expect(wanted([item('a', 0, 'new')], [0], 128, have).map((c) => c.sha)).toEqual(['new']);
});

afterEach(() => { vi.unstubAllGlobals(); });

it('refetches only the tile of the item whose sha moved', () => {
  const asked: string[] = [];
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    set src(value: string) { asked.push(value); }
  });
  const before = [item('a', 0, 'aaaaaaaa1'), item('b', 1, 'bbbbbbbb1')];
  const { rerender } = renderHook(({ items }) => useLooseThumbs(items, [0, 1], 128, 'naive', urls),
                                  { initialProps: { items: before } });
  expect(asked).toHaveLength(2);
  rerender({ items: [before[0]!, item('b', 1, 'cccccccc2')] });
  expect(asked.slice(2)).toEqual(['/api/thumbs/naive/128/b.webp?v=cccccccc']);
});

it('takes a frame of arrivals in one update, not one per image', () => {
  const images: { onload: (() => void) | null }[] = [];
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    constructor() { images.push(this); }
    set src(_: string) {}
  });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const many = Array.from({ length: 50 }, (_, i) => item(`m${i}`, i, `sha${i}`));
  let renders = 0;
  const { result } = renderHook(() => { renders++; return useLooseThumbs(many, many.map((_, i) => i), 128, 'naive', urls); });
  const before = renders;
  act(() => { for (const img of images) img.onload!(); });
  expect(result.current.size).toBe(0);
  act(() => { for (const cb of frames.splice(0)) cb(0); });
  expect(result.current.size).toBe(50);
  expect(renders - before).toBe(1);
});
