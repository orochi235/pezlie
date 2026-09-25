import { expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { fetchRender } from '../src/svgRaster';
import {
  MAX_TARGET_PX, PIXEL_BUDGET, needsRerender, residentCap, splitWork, targetPxFor,
  useVectorThumbs, vectorUrl, wantedVector,
} from '../src/useVectorThumbs';
import { VECTOR_LEVEL } from '../src/levels';
import { defaultUrls } from '../src/urls';
import type { Item } from '../src/schema';

vi.mock('../src/svgRaster', () => ({
  fetchRender: vi.fn(() => Promise.resolve(
    new Blob(['<svg/>'], { type: 'image/svg+xml' }))),
  rasterize: vi.fn(() => Promise.resolve({} as CanvasImageSource)),
}));

const item = (id: string, sha: string | null): Item => ({ id, index: 0, sha });
const urls = defaultUrls('/api');

it('names the slot and cache-busts on the render sha', () => {
  expect(vectorUrl(urls, item('a1', 'deadbeefcafe'), 'naive'))
    .toBe('/api/corpus/render/naive/a1.svg?v=deadbeef');
});

it('wants nothing below the vector level', () => {
  expect(wantedVector([item('a', 'x')], [0], 128)).toEqual([]);
});

it('wants only visible items that have a render', () => {
  const items = [item('a', 'x'), item('b', null)];
  expect(wantedVector(items, [0, 1], VECTOR_LEVEL).map((c) => c.id)).toEqual(['a']);
});

it('keeps a screenful of small cells, where the budget holds them', () => {
  const many = Array.from({ length: 400 }, (_, i) => item(`p${i}`, 'x'));
  const all = many.map((_, i) => i);
  expect(wantedVector(many, all, VECTOR_LEVEL, 256).length).toBe(400);
});

it('drops back to a few cells once each raster is a big one', () => {
  const many = Array.from({ length: 400 }, (_, i) => item(`p${i}`, 'x'));
  const all = many.map((_, i) => i);
  expect(wantedVector(many, all, VECTOR_LEVEL, 1024).length)
    .toBe(Math.floor(PIXEL_BUDGET / (1024 * 1024)));
});

it('sizes a raster in device pixels, capped', () => {
  expect(targetPxFor(300, 2)).toBe(600);
  expect(targetPxFor(300, 1)).toBe(300);
  expect(targetPxFor(4000, 2)).toBe(MAX_TARGET_PX);
});

it('spends the same budget on many small rasters or few big ones', () => {
  expect(residentCap(256)).toBeGreaterThan(residentCap(1024));
  expect(residentCap(256) * 256 * 256).toBeLessThanOrEqual(PIXEL_BUDGET);
});

it('treats a never-rastered cell as needing one', () => {
  expect(needsRerender(null, 400)).toBe(true);
});

it('holds a raster whose size is still close enough to the target', () => {
  expect(needsRerender(400, 450)).toBe(false);
  expect(needsRerender(400, 500)).toBe(false);
});

it('reraster once the drawn size drifts past the threshold', () => {
  expect(needsRerender(400, 501)).toBe(true);
  expect(needsRerender(400, 299)).toBe(true);
});

it('rasterizes a cell with nothing to draw immediately', () => {
  const want = [item('a', 'x'), item('b', 'x')];
  const { now, onSettle } = splitWork(want, new Map([['a', { px: 400 }]]), 400);
  expect(now.map((c) => c.id)).toEqual(['b']);
  expect(onSettle).toEqual([]);
});

it('makes a merely-wrong-sized raster wait for the camera to stop', () => {
  const want = [item('a', 'x')];
  const { now, onSettle } = splitWork(want, new Map([['a', { px: 200 }]]), 800);
  expect(now).toEqual([]);
  expect(onSettle.map((c) => c.id)).toEqual(['a']);
});

// A parked camera is the point: the drawn size is identical either side of the
// switch, so every cell looks like it already has a raster the right size.
it('rasterizes the new slot after a slot change, with the camera parked', async () => {
  const items = [item('a', 'x'), item('b', 'y')];
  // Stable, as the wall's memoized `visible` is: a fresh array each render
  // re-runs the effect for free and hides the bug.
  const visible = [0, 1];
  const { result, rerender } = renderHook(
    ({ slot }) => useVectorThumbs(items, visible, VECTOR_LEVEL, slot, urls, 256),
    { initialProps: { slot: 'outline-first' } });

  await waitFor(() => expect(result.current.size).toBe(2));
  vi.mocked(fetchRender).mockClear();

  rerender({ slot: 'outline-second' });
  await waitFor(() => expect(vi.mocked(fetchRender).mock.calls.map((c) => c[0]))
    .toEqual(expect.arrayContaining([
      expect.stringContaining('/outline-second/a.svg'),
      expect.stringContaining('/outline-second/b.svg'),
    ])));
  await waitFor(() => expect(result.current.size).toBe(2));
});

it('fetches renders from the urls it is given', async () => {
  vi.mocked(fetchRender).mockClear();
  const custom = { ...urls, render: (slot: string, id: string) => `/elsewhere/${slot}/${id}` };
  const items = [item('a', 'x')];
  const visible = [0];
  renderHook(() => useVectorThumbs(items, visible, VECTOR_LEVEL, 's', custom, 256));
  await waitFor(() => expect(vi.mocked(fetchRender)).toHaveBeenCalledWith('/elsewhere/s/a'));
});

it('rasterizes only the ids a layer holds when it is told which', () => {
  const items = [item('a', 'x'), item('b', 'x')];
  expect(wantedVector(items, [0, 1], VECTOR_LEVEL, 256, new Set(['a'])).map((c) => c.id))
    .toEqual(['a']);
});
