import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSheets } from '../src/useSheets';
import { DEFAULT_LADDER } from '../src/levels';
import { defaultUrls } from '../src/urls';
import type { SheetManifest } from '../src/sheet';

const urls = defaultUrls('/api');
const SHEET_LEVELS = DEFAULT_LADDER.sheets;
const manifest = (level: number, version?: string): SheetManifest => ({
  level, gutter: 1, pitch: level + 2, cols: 4, rows: 4, count: 16, size: 64,
  baked: { a: 'x' }, version,
});

const loaded: string[] = [];
let failing = new Set<string>();

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  #src = '';
  get src() { return this.#src; }
  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => {
      if (failing.has(value)) this.onerror?.();
      else { loaded.push(value); this.onload?.(); }
    });
  }
}

beforeEach(() => {
  loaded.length = 0;
  failing = new Set();
  vi.stubGlobal('Image', FakeImage);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Answers manifests for every slot, and `levels.json` only for the slots in `ladders`. */
function serve(pending: Set<string> = new Set(), ladders: Record<string, unknown> = {}) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url);
    const lv = /\/thumbs\/([^/]+)\/levels\.json$/.exec(url);
    if (lv) {
      const ladder = ladders[lv[1]!];
      return ladder ? new Response(JSON.stringify(ladder)) : new Response('', { status: 404 });
    }
    const m = /\/thumbs\/([^/]+)\/sheet-(\d+)\.json$/.exec(url);
    if (!m) return new Response('', { status: 404 });
    if (pending.has(m[1]!)) return new Promise<Response>(() => {});
    return new Response(JSON.stringify(manifest(Number(m[2]), 'v7')));
  }));
  return asked;
}

it('loads every sheet level for the slot, versioning the image off its manifest', async () => {
  const asked = serve();
  const { result } = renderHook(() => useSheets(urls, 'first'));
  await waitFor(() => expect(Object.keys(result.current.sheets)).toHaveLength(SHEET_LEVELS.length));
  expect(asked).toEqual(['/api/thumbs/first/levels.json',
                         ...SHEET_LEVELS.map((l) => `/api/thumbs/first/sheet-${l}.json`)]);
  expect(loaded.sort()).toEqual(SHEET_LEVELS.map((l) => `/api/thumbs/first/sheet-${l}.webp?v=v7`).sort());
  expect(result.current.slot).toBe('first');
  expect(result.current.ladder).toBe(DEFAULT_LADDER);
  expect(result.current.sheets[SHEET_LEVELS[0]!]!.manifest.level).toBe(SHEET_LEVELS[0]);
});

it('loads the sheets the slot says it was baked at', async () => {
  const asked = serve(new Set(), { first: { sheets: [16, 64], loose: 256 } });
  const { result } = renderHook(() => useSheets(urls, 'first'));
  await waitFor(() => expect(Object.keys(result.current.sheets)).toHaveLength(2));
  expect(asked.slice(1)).toEqual(['/api/thumbs/first/sheet-16.json', '/api/thumbs/first/sheet-64.json']);
  expect(result.current.ladder).toEqual({ sheets: [16, 64], loose: 256 });
});

it('says so and takes the default levels when the ladder is malformed', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  serve(new Set(), { first: { sheets: [64, 16], loose: 256 } });
  const { result } = renderHook(() => useSheets(urls, 'first'));
  await waitFor(() => expect(Object.keys(result.current.sheets)).toHaveLength(SHEET_LEVELS.length));
  expect(result.current.ladder).toBe(DEFAULT_LADDER);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('levels.json is not a ladder'));
});

it('settles a slot with a sheet missing, rather than holding the old slot', async () => {
  serve();
  failing = new Set([`/api/thumbs/second/sheet-${SHEET_LEVELS[1]}.webp?v=v7`]);
  const { result, rerender } = renderHook(({ slot }) => useSheets(urls, slot),
                                          { initialProps: { slot: 'first' } });
  await waitFor(() => expect(Object.keys(result.current.sheets)).toHaveLength(2));
  rerender({ slot: 'second' });
  await waitFor(() => expect(result.current.slot).toBe('second'));
  expect(Object.keys(result.current.sheets).map(Number)).toEqual([SHEET_LEVELS[0]]);
});

it('keeps the old slot whole until the new one has settled', async () => {
  serve(new Set(['second']));
  const { result, rerender } = renderHook(({ slot }) => useSheets(urls, slot),
                                          { initialProps: { slot: 'first' } });
  await waitFor(() => expect(Object.keys(result.current.sheets)).toHaveLength(2));
  const before = result.current.sheets;
  rerender({ slot: 'second' });
  await new Promise((r) => setTimeout(r, 10));
  expect(result.current.slot).toBe('first');
  expect(result.current.sheets).toBe(before);
});
