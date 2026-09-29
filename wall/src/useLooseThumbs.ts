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

export const MAX_IN_FLIGHT = 200;

export function thumbUrl(urls: SlotUrls, item: Item, slot: string,
                         loose = DEFAULT_LADDER.loose): string {
  return urls.tile(slot, loose, item.id, shaVersion(item.sha));
}

/** Visible items worth a loose fetch: only at the loose rung, only items with
 *  a render, and capped so a big viewport never fires hundreds at once.
 *
 *  `have` holds `imageKey`s, so an item whose sha moved is wanted again. It
 *  is skipped BEFORE the cap. Counting it toward the cap starved every
 *  un-fetched item behind the ones in hand, permanently. */
export function wanted<T extends Item>(items: readonly T[], visible: readonly number[],
                                       level: number,
                                       have: ReadonlySet<string> = new Set(),
                                       loose = DEFAULT_LADDER.loose,
                                       only: ReadonlySet<string> | null = null): T[] {
  if (level < loose) return [];
  const out: T[] = [];
  for (const i of visible) {
    const item = items[i];
    if (!item || !item.sha || have.has(imageKey(item)) || (only && !only.has(item.id))) continue;
    out.push(item);
    if (out.length >= MAX_IN_FLIGHT) break;
  }
  return out;
}

/** The loose tiles currently loaded, keyed by item id.
 *
 *  An item already requested (loaded or in flight) at its current sha is never
 *  requested again for the same slot, so a new `visible` array each frame
 *  re-issues nothing. A new sha fetches the new tile, and the old one stays
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

  const cold = () => {
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

  useEffect(() => {
    if (!urls) return;
    for (const item of wanted(items, visible, level, requested.current, looseLevel, only)) {
      const key = imageKey(item);
      requested.current.add(key);
      latest.current.set(item.id, key);
      const img = new Image();
      img.onload = () => {
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
  }, [items, visible, level, slot, urls, looseLevel, only]);

  return loose;
}
