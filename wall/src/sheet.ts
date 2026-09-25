export interface SheetManifest {
  level: number;
  gutter: number;
  pitch: number;
  cols: number;
  rows: number;
  count: number;
  size: number;
  baked: Record<string, string>;
  /** Stamped by the server from the atlas image's mtime, so a rewritten sheet
   *  is not served from cache against a fresh manifest. Absent on a manifest
   *  read straight off disk. */
  version?: string;
}

export interface SourceBox { sx: number; sy: number; sw: number; sh: number }

export function sourceBox(m: SheetManifest, index: number): SourceBox | null {
  if (index < 0 || index >= m.cols * m.rows) return null;
  return {
    sx: (index % m.cols) * m.pitch + m.gutter,
    sy: Math.floor(index / m.cols) * m.pitch + m.gutter,
    sw: m.level,
    sh: m.level,
  };
}

/** Whether the sheet holds a tile for this item at all.
 *
 *  This, and not `isStale`, is what decides whether a sprite is drawn: a
 *  stale picture is worth drawing and an empty box never is. Gating the draw
 *  on freshness let one re-encode turn the whole wall into blank squares,
 *  silently, because every tile was "stale" and nothing said so. */
export function hasTile(m: SheetManifest,
                        item: { id: string }): boolean {
  return m.baked[item.id] !== undefined;
}

/** Whether the sheet's picture of this item is behind the store's.
 *
 *  An item with no picture yet (`sha` null) is not stale -- it is a
 *  placeholder, which is the common case on a wall still being filled.
 *
 *  Use this to decide whether to FETCH a fresher tile, never whether to draw
 *  one. */
export function isStale(m: SheetManifest,
                        item: { id: string; sha: string | null }): boolean {
  if (item.sha === null) return false;
  return m.baked[item.id] !== item.sha;
}

/** How many of `items` the sheet's picture is behind on.
 *
 *  Every item going stale at once is a bake that did not finish or a
 *  re-encode that changed every sha. It is worth saying out loud: the wall
 *  itself cannot tell the difference between that and a set with no pictures. */
export function staleCount(m: SheetManifest,
                           items: readonly { id: string; sha: string | null }[]):
                           { stale: number; missing: number; total: number } {
  return staleCountOf(m, items.length, (i) => items[i]!);
}

/** `staleCount` over `count` items read one at a time. */
export function staleCountOf(m: SheetManifest, count: number,
                             at: (i: number) => { id: string; sha: string | null }):
                             { stale: number; missing: number; total: number } {
  let stale = 0;
  let missing = 0;
  for (let i = 0; i < count; i++) {
    const item = at(i);
    // An item with no picture has nothing to bake, so no tile is not missing.
    if (!hasTile(m, item)) { if (item.sha !== null) missing++; }
    else if (isStale(m, item)) stale++;
  }
  return { stale, missing, total: count };
}

/** A sheet as the painters draw it: the fetched atlas, or a filtered copy. */
export type SheetImage = HTMLImageElement | HTMLCanvasElement;
