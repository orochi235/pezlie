import { expect, it } from 'vitest';
import { thumbUrl, wanted } from '../src/useLooseThumbs';
import { defaultUrls } from '../src/urls';
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
  const have = new Set(many.slice(0, 200).map((c) => c.id));
  const next = wanted(many, all, 128, have);
  expect(next.length).toBe(200);
  expect(next[0]!.id).toBe('c200');
});

it('keeps the fields a host added to its items', () => {
  const rich = [{ ...item('a', 0, 'x'), title: 'A' }];
  expect(wanted(rich, [0], 128)[0]!.title).toBe('A');
});
