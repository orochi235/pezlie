import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { fetchRender, rasterize } from './svgRaster';
import { VECTOR_LEVEL } from './levels';
import type { Item } from './schema';
import { shaVersion } from './urls';
import type { SlotUrls } from './urls';

/** Rasterized area kept resident, in device pixels (~190MB of RGBA). A count
 *  cap cannot express this: the same 96 cells cost 25MB or 400MB by zoom. */
export const PIXEL_BUDGET = 48e6;

/** Past this a cell is drawn from a raster smaller than its box, rather than
 *  a 16MB bitmap for one cell. */
export const MAX_TARGET_PX = 1024;

/** How far the drawn size can drift from a cached raster before it is redone,
 *  either way, so a continuous zoom rerasters a handful of times. */
export const RERASTER_THRESHOLD = 0.25;

/** How long the camera holds still before a merely-wrong-sized raster is
 *  redone. A cell with no raster never waits for this. */
export const SETTLE_MS = 120;

/** Rasters decoded at once; the whole screen at once starves the frame that
 *  would show the finished ones. */
export const CONCURRENCY = 8;

/** The raster size `wantedVector` budgets for when the caller names none. */
export const VECTOR_TARGET_PX = 512;

export function vectorUrl(urls: SlotUrls, item: Item, slot: string): string {
  return urls.render(slot, item.id, shaVersion(item.sha));
}

/** The device-pixel size a cell drawn at `cellPx` wants its raster at. */
export function targetPxFor(cellPx: number, dpr: number): number {
  return Math.max(1, Math.min(MAX_TARGET_PX, Math.round(cellPx * dpr)));
}

/** How many rasters of `targetPx` square the budget holds. */
export function residentCap(targetPx: number): number {
  return Math.max(1, Math.floor(PIXEL_BUDGET / Math.max(1, targetPx * targetPx)));
}

/** Visible items worth rasterizing: only at the vector rung, only items with
 *  a render, and only as many as the pixel budget holds. */
export function wantedVector<T extends Item>(items: readonly T[], visible: readonly number[],
                                             level: number, targetPx = VECTOR_TARGET_PX): T[] {
  if (level < VECTOR_LEVEL) return [];
  const cap = residentCap(targetPx);
  const out: T[] = [];
  for (const i of visible) {
    const item = items[i];
    if (!item || !item.sha) continue;
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** Whether a raster cached at `cachedPx` should be redone at `targetPx`;
 *  null means never rasterized. */
export function needsRerender(cachedPx: number | null, targetPx: number,
                              threshold = RERASTER_THRESHOLD): boolean {
  return cachedPx == null || Math.abs(targetPx - cachedPx) > cachedPx * threshold;
}

/** What to rasterize now, and what can wait for the camera to stop.
 *
 *  A cell with no raster is showing a blurry loose tile, so it is drawn at
 *  whatever size the camera is passing through. Redoing merely-wrong-sized
 *  rasters mid-gesture spends the budget on sizes the camera has left. */
export function splitWork<T extends Item>(want: readonly T[], have: Map<string, { px: number }>,
                                          targetPx: number): { now: T[]; onSettle: T[] } {
  const now: T[] = [];
  const onSettle: T[] = [];
  for (const item of want) {
    const cached = have.get(item.id);
    if (!cached) now.push(item);
    else if (needsRerender(cached.px, targetPx)) onSettle.push(item);
  }
  return { now, onSettle };
}

interface RasterEntry { image: CanvasImageSource; px: number }

/** Read-and-reset for this rung, for a cache report.
 *
 *  A failed fetch or rasterize is swallowed on purpose, so a rung broken for
 *  every item looks idle from outside; these counts tell the two apart.
 *  `reset` clears an id stuck in `inFlight`, which is never enqueued again. */
export interface VectorHandle {
  stats(): { resident: number; inFlight: number; queued: number;
             bytesCached: number; rasterPx: number[] };
  reset(): void;
}

/** The vector rung's rasterized cells, keyed by item id.
 *
 *  A raster is kept only while its cell is wanted, so panning away never
 *  grows this without bound. Work outlives the camera move that asked for it:
 *  canceling on every new `visible` threw away every raster in flight. */
export function useVectorThumbs<T extends Item>(items: readonly T[], visible: readonly number[],
                                                level: number, slot: string, urls: SlotUrls,
                                                cellPx: number,
                                                handle?: MutableRefObject<VectorHandle | null>):
    Map<string, CanvasImageSource> {
  const [raster, setRaster] = useState<Map<string, RasterEntry>>(new Map());
  const rasterRef = useRef(raster);
  rasterRef.current = raster;

  const mounted = useRef(true);
  const inFlight = useRef<Set<string>>(new Set());
  const queue = useRef<{ item: T; px: number }[]>([]);
  const running = useRef(0);
  const wantedIds = useRef<Set<string>>(new Set());
  const bytes = useRef<Map<string, Blob>>(new Map());
  // Arrivals merge once a frame: one state update per screenful.
  const arrived = useRef<Map<string, RasterEntry>>(new Map());
  const flush = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const cold = () => {
    inFlight.current = new Set();
    queue.current = [];
    bytes.current = new Map();
    arrived.current = new Map();
    // The ref lags the state by a commit and the effect below reads it; left
    // stale, a parked camera keeps the previous slot's rasters forever.
    rasterRef.current = new Map();
    setRaster(new Map());
  };

  useEffect(cold, [slot]);

  useEffect(() => {
    if (!handle) return;
    handle.current = {
      stats: () => ({
        resident: raster.size,
        inFlight: inFlight.current.size,
        queued: queue.current.length,
        bytesCached: bytes.current.size,
        rasterPx: [...new Set([...raster.values()].map((e) => e.px))].sort(
          (a, b) => a - b),
      }),
      reset: cold,
    };
    return () => { handle.current = null; };
  }, [handle, raster]);

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const targetPx = targetPxFor(cellPx, dpr);
    const want = wantedVector(items, visible, level, targetPx);
    wantedIds.current = new Set(want.map((c) => c.id));

    // Residency runs even when nothing new needs fetching, and the byte cache
    // follows the rasters out.
    setRaster((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!wantedIds.current.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
    for (const id of bytes.current.keys()) {
      if (!wantedIds.current.has(id)) bytes.current.delete(id);
    }

    const scheduleFlush = () => {
      if (flush.current !== null) return;
      flush.current = requestAnimationFrame(() => {
        flush.current = null;
        if (!mounted.current || arrived.current.size === 0) return;
        const batch = arrived.current;
        arrived.current = new Map();
        setRaster((prev) => {
          const next = new Map(prev);
          for (const [id, entry] of batch) {
            if (wantedIds.current.has(id)) next.set(id, entry);
          }
          return next;
        });
      });
    };

    const drain = () => {
      while (running.current < CONCURRENCY && queue.current.length > 0) {
        const job = queue.current.shift()!;
        if (!wantedIds.current.has(job.item.id)) {
          inFlight.current.delete(job.item.id);
          continue;
        }
        running.current += 1;
        void rasterOne(job.item, job.px)
          .finally(() => {
            running.current -= 1;
            inFlight.current.delete(job.item.id);
            drain();
          });
      }
    };

    const rasterOne = async (item: T, px: number) => {
      try {
        let render = bytes.current.get(item.id);
        if (render === undefined) {
          render = await fetchRender(vectorUrl(urls, item, slot));
          if (!mounted.current) return;
          bytes.current.set(item.id, render);
        }
        const image = await rasterize(render, px, px);
        if (!mounted.current || !wantedIds.current.has(item.id)) return;
        arrived.current.set(item.id, { image, px });
        scheduleFlush();
      } catch {
        /* the loose tile stays the fallback */
      }
    };

    const enqueue = (batch: T[]) => {
      for (const item of batch) {
        if (inFlight.current.has(item.id)) continue;
        inFlight.current.add(item.id);
        queue.current.push({ item, px: targetPx });
      }
      drain();
    };

    const { now, onSettle } = splitWork(want, rasterRef.current, targetPx);
    enqueue(now);
    if (onSettle.length === 0) return;
    const settle = setTimeout(() => enqueue(onSettle), SETTLE_MS);
    return () => clearTimeout(settle);
  }, [items, visible, level, slot, urls, cellPx]);

  return useMemo(
    () => new Map([...raster].map(([id, entry]) => [id, entry.image])),
    [raster]);
}
