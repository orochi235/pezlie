/** Where the wall fetches a slot's pictures. `bakery`'s routes answer
 *  `defaultUrls('/api')`; a host with other paths supplies its own. */
export interface SlotUrls {
  /** The levels a slot was baked at. Without it every slot is `DEFAULT_LADDER`. */
  levels?(slot: string): string;
  /** The JSON manifest beside a sheet. */
  manifest(slot: string, level: number): string;
  /** The sheet image, versioned so a rebake is not served from cache. */
  sheet(slot: string, level: number, version?: string): string;
  /** One item's loose tile; `version` busts the cache when its render changes. */
  tile(slot: string, level: number, id: string, version?: string): string;
  /** One item's full render, for the vector rung. */
  render(slot: string, id: string, version?: string): string;
}

/** The cache-buster for an item's render: a prefix of its sha. */
export function shaVersion(sha: string | null): string | undefined {
  return sha ? sha.slice(0, 8) : undefined;
}

export function defaultUrls(base = '/api'): SlotUrls {
  const q = encodeURIComponent;
  const v = (version?: string) => (version ? `?v=${q(version)}` : '');
  return {
    levels: (slot) => `${base}/thumbs/${q(slot)}/levels.json`,
    manifest: (slot, level) => `${base}/thumbs/${q(slot)}/sheet-${level}.json`,
    sheet: (slot, level, version) =>
      `${base}/thumbs/${q(slot)}/sheet-${level}.webp${v(version)}`,
    tile: (slot, level, id, version) =>
      `${base}/thumbs/${q(slot)}/${level}/${q(id)}.webp${v(version)}`,
    render: (slot, id, version) =>
      `${base}/corpus/render/${q(slot)}/${q(id)}.svg${v(version)}`,
  };
}
