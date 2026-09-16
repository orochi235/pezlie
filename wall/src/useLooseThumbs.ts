import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { DEFAULT_LADDER } from './levels';
import type { Item } from './schema';
import { shaVersion } from './urls';
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
 *  `have` is skipped BEFORE the cap. Counting it toward the cap starved every
 *  un-fetched item behind the ones in hand, permanently. */
export function wanted<T extends Item>(items: readonly T[], visible: readonly number[],
                                       level: number,
                                       have: ReadonlySet<string> = new Set(),
                                       loose = DEFAULT_LADDER.loose): T[] {
  if (level < loose) return [];
  const out: T[] = [];
  for (const i of visible) {
    const item = items[i];
    if (!item || !item.sha || have.has(item.id)) continue;
    out.push(item);
    if (out.length >= MAX_IN_FLIGHT) break;
  }
  return out;
}

/** The loose tiles currently loaded, keyed by item id.
 *
 *  An item already requested (loaded or in flight) is never requested again
 *  for the same slot, so a new `visible` array each frame re-issues nothing. */
export function useLooseThumbs<T extends Item>(items: readonly T[], visible: readonly number[],
                                               level: number, slot: string, urls: SlotUrls,
                                               handle?: MutableRefObject<LooseHandle | null>,
                                               looseLevel = DEFAULT_LADDER.loose):
                                               Map<string, HTMLImageElement> {
  const [loose, setLoose] = useState<Map<string, HTMLImageElement>>(new Map());
  const requested = useRef<Set<string>>(new Set());
  // Only unmounting stops an image landing. Keyed to the effect instead, an
  // image finishing after the next camera move was dropped and never re-asked.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    requested.current = new Set();
    setLoose(new Map());
  }, [slot, looseLevel]);

  useEffect(() => {
    if (!handle) return;
    handle.current = {
      stats: () => ({ loaded: loose.size, requested: requested.current.size }),
      reset: () => { requested.current = new Set(); setLoose(new Map()); },
    };
    return () => { handle.current = null; };
  }, [handle, loose]);

  useEffect(() => {
    for (const item of wanted(items, visible, level, requested.current, looseLevel)) {
      requested.current.add(item.id);
      const img = new Image();
      img.onload = () => {
        if (!mounted.current) return;
        setLoose((prev) => new Map(prev).set(item.id, img));
      };
      img.src = thumbUrl(urls, item, slot, looseLevel);
    }
  }, [items, visible, level, slot, urls, looseLevel]);

  return loose;
}
