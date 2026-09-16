import { useEffect, useState } from 'react';
import { DEFAULT_LADDER, parseLadder, type Ladder } from './levels';
import type { SheetManifest } from './sheet';
import type { SlotUrls } from './urls';

export interface Sheet {
  image: HTMLImageElement;
  manifest: SheetManifest;
}

/** Every sprite-sheet level for a slot, the ladder they are rungs of, and the
 *  slot they are for.
 *
 *  A slot change keeps the old set on screen and swaps the whole new set in
 *  once it has settled: a half-swapped wall reads every cell as stale. */
export interface SheetsState { sheets: Record<number, Sheet>; ladder: Ladder; slot: string }

async function fetchManifest(url: string): Promise<SheetManifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json() as Promise<SheetManifest>;
}

/** The slot's ladder, or the default for a slot baked before it had one. */
async function fetchLadder(urls: SlotUrls, slot: string): Promise<Ladder> {
  if (!urls.levels) return DEFAULT_LADDER;
  const url = urls.levels(slot);
  try {
    const response = await fetch(url);
    if (!response.ok) return DEFAULT_LADDER;
    const ladder = parseLadder(await response.json());
    if (!ladder) console.warn(`[wall] ${url} is not a ladder; assuming the default levels.`);
    return ladder ?? DEFAULT_LADDER;
  } catch {
    return DEFAULT_LADDER;
  }
}

/** `urls` is an effect dependency, so a host passes a stable object. */
export function useSheets(urls: SlotUrls, slot: string): SheetsState {
  const [state, setState] = useState<SheetsState>({ sheets: {}, ladder: DEFAULT_LADDER, slot });

  useEffect(() => {
    let live = true;
    void fetchLadder(urls, slot).then((ladder) => {
      if (!live) return;
      const next: Record<number, Sheet> = {};
      let pending = ladder.sheets.length;
      const settle = () => {
        if (--pending > 0 || !live) return;
        setState({ sheets: next, ladder, slot });
      };
      for (const level of ladder.sheets) {
        void fetchManifest(urls.manifest(slot, level)).then((manifest) => {
          if (!live) return settle();
          const img = new Image();
          img.onload = () => { next[level] = { image: img, manifest }; settle(); };
          // A slot with no sheet baked settles too, or the wall would hold the
          // previous slot's drawings for the rest of the session.
          img.onerror = () => settle();
          // Every bake rewrites the atlas at this URL; a cached image against a
          // fresh manifest reads every tile at the wrong offset.
          img.src = urls.sheet(slot, level, manifest.version);
        }).catch(settle);
      }
    });
    return () => { live = false; };
  }, [urls, slot]);

  return state;
}
