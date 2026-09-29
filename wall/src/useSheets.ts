import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_LADDER, parseLadder, type Ladder } from './levels';
import { sourceBox, type SheetImage, type SheetManifest } from './sheet';
import { shaVersion, type SlotUrls } from './urls';

/** A fetched atlas, or after a `refresh` a canvas copy with cells redrawn. */
export interface Sheet {
  image: SheetImage;
  manifest: SheetManifest;
}

/** A cell whose render changed: where it sits on every sheet, and the sha of
 *  the render to draw there. */
export interface Redraw { id: string; index: number; sha: string }

/** Every sprite-sheet level for a slot, the ladder they are rungs of, and the
 *  slot they are for.
 *
 *  A slot change keeps the old set on screen and swaps the whole new set in
 *  once it has settled: a half-swapped wall reads every cell as stale. */
export interface SheetsState { sheets: Record<number, Sheet>; ladder: Ladder; slot: string }

/** The rows of `changed` whose render moved between two stores, as cells to
 *  redraw. A row whose sha went to null has nothing new to draw. */
export function movedRenders(before: { sha(row: number): string | null },
                             after: { id(row: number): string; index(row: number): number;
                                      sha(row: number): string | null },
                             changed: readonly number[]): Redraw[] {
  const out: Redraw[] = [];
  for (const row of changed) {
    const sha = after.sha(row);
    if (sha !== null && sha !== before.sha(row)) out.push({ id: after.id(row), index: after.index(row), sha });
  }
  return out;
}

/** Canvas2D draws a sheet's cells about 4x faster from a bitmap than from the
 *  <img> it was loaded into; where one can't be made, the <img> serves. */
function bitmapOf(img: HTMLImageElement): Promise<SheetImage> {
  if (typeof createImageBitmap !== 'function') return Promise.resolve(img);
  return createImageBitmap(img).catch(() => img);
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** A copy of `sheet` with each tile drawn into its cell, and its edge pixels
 *  into the gutter as the bake does, or null where there is no 2D context.
 *  A copy rather than the sheet itself, since everything drawn from a sheet
 *  is cached against the object. */
export function redrawn(sheet: Sheet, tiles: readonly { redraw: Redraw; tile: CanvasImageSource }[]):
    Sheet | null {
  const m = sheet.manifest;
  const canvas = document.createElement('canvas');
  canvas.width = m.size;
  canvas.height = m.size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet.image, 0, 0);
  const baked = { ...m.baked };
  const put = (tile: CanvasImageSource, sx: number, sy: number, sw: number, sh: number,
               dx: number, dy: number) => {
    ctx.clearRect(dx, dy, sw, sh);
    ctx.drawImage(tile, sx, sy, sw, sh, dx, dy, sw, sh);
  };
  for (const { redraw, tile } of tiles) {
    const box = sourceBox(m, redraw.index);
    if (!box) continue;
    const { sx: x, sy: y } = box;
    const n = m.level;
    put(tile, 0, 0, n, n, x, y);
    for (let d = 1; d <= m.gutter; d++) {
      put(tile, 0, 0, n, 1, x, y - d);
      put(tile, 0, n - 1, n, 1, x, y + n + d - 1);
      put(tile, 0, 0, 1, n, x - d, y);
      put(tile, n - 1, 0, 1, n, x + n + d - 1, y);
    }
    baked[redraw.id] = redraw.sha;
  }
  return { image: canvas, manifest: { ...m, baked } };
}

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

/** `urls` is an effect dependency, so a host passes a stable object. Null
 *  loads nothing, for a layer the host does not have.
 *
 *  `refresh` redraws only the cells named, from each one's tile at every sheet
 *  level, rather than fetching the sheets again. A cell whose tile does not
 *  load keeps its old picture. */
export function useSheets(urls: SlotUrls | null, slot: string):
    SheetsState & { refresh: (cells: readonly Redraw[]) => void } {
  const [state, setState] = useState<SheetsState>({ sheets: {}, ladder: DEFAULT_LADDER, slot });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!urls) { setState({ sheets: {}, ladder: DEFAULT_LADDER, slot }); return; }
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
          img.onload = () => {
            void bitmapOf(img).then((image) => { next[level] = { image, manifest }; settle(); });
          };
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

  const refresh = useCallback((cells: readonly Redraw[]) => {
    const at = stateRef.current;
    if (!urls || cells.length === 0 || at.slot !== slot) return;
    for (const level of Object.keys(at.sheets).map(Number)) {
      void Promise.all(cells.map(async (redraw) => {
        const tile = await loadImage(urls.tile(slot, level, redraw.id, shaVersion(redraw.sha)));
        return tile ? { redraw, tile } : null;
      })).then((loaded) => {
        const tiles = loaded.filter((t) => t !== null);
        // Drawn onto whatever sheet is current by now, so two refreshes landing
        // out of order both keep their cells.
        const now = stateRef.current;
        const sheet = now.sheets[level];
        if (tiles.length === 0 || now.slot !== slot || !sheet) return;
        const next = redrawn(sheet, tiles);
        if (!next) return;
        const updated = { ...now, sheets: { ...now.sheets, [level]: next } };
        stateRef.current = updated;
        setState(updated);
      });
    }
  }, [urls, slot]);

  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
