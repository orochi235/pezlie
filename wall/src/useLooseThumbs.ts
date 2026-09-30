import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { DEFAULT_LADDER } from './levels';
import type { Item } from './schema';
import { imageKey, shaVersion } from './urls';
import type { SlotUrls } from './urls';

/** Read-and-reset for this rung, for a cache report.
 *
 *  Every failure here is silent by design -- an image that errors leaves the
 *  sheet tile on screen -- so something has to ask how many were asked for
 *  against how many arrived. `reset` returns to a cold start: `requested`
 *  only grows, so ids whose loads failed would never be asked for again. */
export interface LooseHandle {
  stats(): { loaded: number; requested: number };
  reset(): void;
}

/** Loads outstanding at once. Few, so each next one is chosen from the view
 *  as it is when a slot frees: sent 200 at a time, they queued in the order of
 *  the view that asked, and a fling's landing waited behind them. */
export const MAX_IN_FLIGHT = 24;

export function thumbUrl(urls: SlotUrls, item: Item, slot: string,
                         loose = DEFAULT_LADDER.loose): string {
  return urls.tile(slot, loose, item.id, shaVersion(item.sha));
}

/** Visible items worth a loose fetch: only at the loose rung, only items with
 *  a render, and at most `cap` of them, in view order.
 *
 *  `have` holds `imageKey`s, so an item whose sha moved is wanted again. It
 *  is skipped BEFORE the cap. Counting it toward the cap starved every
 *  un-fetched item behind the ones in hand, permanently. */
export function wanted<T extends Item>(items: readonly T[], visible: readonly number[],
                                       level: number,
                                       have: ReadonlySet<string> = new Set(),
                                       loose = DEFAULT_LADDER.loose,
                                       only: ReadonlySet<string> | null = null,
                                       cap = MAX_IN_FLIGHT): T[] {
  if (level < loose || cap <= 0) return [];
  const out: T[] = [];
  for (const i of visible) {
    const item = items[i];
    if (!item || !item.sha || have.has(imageKey(item)) || (only && !only.has(item.id))) continue;
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** The loose tiles currently loaded, keyed by item id.
 *
 *  An item already requested (loaded or in flight) at its current sha is never
 *  requested again for the same slot, so a new `visible` array each frame
 *  re-issues nothing. `MAX_IN_FLIGHT` load at once, and each one landing asks
 *  for the next in the order of the latest `visible`; a load still in flight
 *  when its cell leaves `visible` is dropped. A new sha fetches the new tile, and the old one stays
 *  on screen until it lands.
 *  Null `urls` loads nothing; `only` limits the fetches to the ids a layer
 *  actually holds. */
export function useLooseThumbs<T extends Item>(items: readonly T[], visible: readonly number[],
                                               level: number, slot: string, urls: SlotUrls | null,
                                               handle?: MutableRefObject<LooseHandle | null>,
                                               looseLevel = DEFAULT_LADDER.loose,
                                               only: ReadonlySet<string> | null = null):
                                               Map<string, HTMLImageElement> {
  const [loose, setLoose] = useState<Map<string, HTMLImageElement>>(new Map());
  const requested = useRef<Set<string>>(new Set());
  // The newest key asked for per id: an older render landing late is dropped.
  const latest = useRef<Map<string, string>>(new Map());
  // In flight, by `imageKey`.
  const loading = useRef<Map<string, HTMLImageElement>>(new Map());
  // Only unmounting stops an image landing. Keyed to the effect instead, an
  // image finishing after the next camera move was dropped and never re-asked.
  const mounted = useRef(true);
  // Arrivals merge once a frame: one state update per screenful.
  const arrived = useRef<Map<string, HTMLImageElement>>(new Map());
  const flush = useRef<number | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (flush.current !== null) cancelAnimationFrame(flush.current);
      flush.current = null;
    };
  }, []);

  const drop = (key: string) => {
    const img = loading.current.get(key)!;
    loading.current.delete(key);
    requested.current.delete(key);
    img.onload = null;
    img.onerror = null;
    img.src = '';
  };

  const cold = () => {
    for (const key of [...loading.current.keys()]) drop(key);
    requested.current = new Set();
    latest.current = new Map();
    arrived.current = new Map();
    setLoose(new Map());
  };

  useEffect(cold, [slot, looseLevel]);

  useEffect(() => {
    if (!handle) return;
    handle.current = {
      stats: () => ({ loaded: loose.size, requested: requested.current.size }),
      reset: cold,
    };
    return () => { handle.current = null; };
  }, [handle, loose]);

  // What the next load is chosen from: the latest render's, read as a load lands.
  const args = useRef({ items, visible, level, slot, urls, looseLevel, only });
  args.current = { items, visible, level, slot, urls, looseLevel, only };

  const pump = () => {
    const { items, visible, level, slot, urls, looseLevel, only } = args.current;
    if (!urls || !mounted.current) return;
    for (const item of wanted(items, visible, level, requested.current, looseLevel, only,
                              MAX_IN_FLIGHT - loading.current.size)) {
      const key = imageKey(item);
      requested.current.add(key);
      latest.current.set(item.id, key);
      const img = new Image();
      loading.current.set(key, img);
      img.onerror = () => { loading.current.delete(key); pump(); };
      img.onload = () => {
        loading.current.delete(key);
        pump();
        if (!mounted.current || latest.current.get(item.id) !== key) return;
        arrived.current.set(item.id, img);
        if (flush.current !== null) return;
        flush.current = requestAnimationFrame(() => {
          flush.current = null;
          if (!mounted.current || arrived.current.size === 0) return;
          const batch = arrived.current;
          arrived.current = new Map();
          setLoose((prev) => {
            const next = new Map(prev);
            for (const [id, landed] of batch) next.set(id, landed);
            return next;
          });
        });
      };
      img.src = thumbUrl(urls, item, slot, looseLevel);
    }
  };

  useEffect(() => {
    if (!urls) return;
    if (loading.current.size > 0) {
      const shown = new Set<string>();
      for (const i of visible) {
        const item = items[i];
        if (item?.sha) shown.add(imageKey(item));
      }
      for (const key of [...loading.current.keys()]) if (!shown.has(key)) drop(key);
    }
    pump();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, visible, level, slot, urls, looseLevel, only]);

  return loose;
}
