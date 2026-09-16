/** Hysteresis factors `pickLevel` uses when the caller supplies none. */
export const DEFAULT_HYSTERESIS = { up: 1.5, down: 0.67 };

/** The raster sizes a slot was baked at: one sprite sheet per `sheets` level,
 *  ascending, and one file per item at `loose`. `bakery` writes it beside the
 *  sheets as `levels.json`. */
export interface Ladder {
  sheets: readonly number[];
  loose: number;
}

/** The levels of a slot baked before `levels.json` existed. */
export const DEFAULT_LADDER: Ladder = { sheets: [8, 32], loose: 128 };

/** Not a raster size -- the rung past the loose level, where a cell draws a
 *  vector instead of upscaling a raster. Above every ladder. */
export const VECTOR_LEVEL = Number.POSITIVE_INFINITY;

/** `json` as a ladder, or null where it is not one: positive whole sizes
 *  ascending, sheets then loose. */
export function parseLadder(json: unknown): Ladder | null {
  if (typeof json !== 'object' || json === null) return null;
  const { sheets, loose } = json as { sheets?: unknown; loose?: unknown };
  if (!Array.isArray(sheets) || sheets.length === 0) return null;
  const sizes: unknown[] = [...sheets, loose];
  for (let i = 0; i < sizes.length; i++) {
    const n = sizes[i];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return null;
    if (i > 0 && n <= (sizes[i - 1] as number)) return null;
  }
  return { sheets: sheets as number[], loose: loose as number };
}

/** The on-screen cell size each baked level covers: a sheet up to twice its
 *  size or the next level, whichever is first; the loose level up to its own
 *  size. Past it a cell wants the vector instead of a bigger bake, so the
 *  vector is the fall-through rather than a band of its own -- which is what
 *  lets the last rung's top be inclusive. */
function bandsOf(ladder: Ladder): [number, number][] {
  const levels = [...ladder.sheets, ladder.loose];
  return levels.map((level, i) =>
    [level, i === levels.length - 1 ? level : Math.min(2 * level, levels[i + 1]!)]);
}

/** The level a cell of `px` on screen wants, ignoring what is loaded.
 *
 *  The last raster rung owns its own size: a strict `<` there sent a cell of
 *  exactly 128px to the vector rung and skipped the 128px bake entirely. */
export function levelFor(px: number, ladder: Ladder = DEFAULT_LADDER): number {
  const bands = bandsOf(ladder);
  const last = bands.length - 1;
  for (let i = 0; i < bands.length; i++) {
    const [level, top] = bands[i]!;
    if (i === last ? px <= top : px < top) return level;
  }
  return VECTOR_LEVEL;
}

const onLadder = (level: number, ladder: Ladder) =>
  level === VECTOR_LEVEL || level === ladder.loose || ladder.sheets.includes(level);

/** The level to actually use, given the one in hand.
 *
 *  Straight thresholds re-upload every frame when a zoom parks on a boundary,
 *  so a level is kept until the cell size is half again past its band. */
export function pickLevel(current: number, px: number,
                          upFactor = DEFAULT_HYSTERESIS.up,
                          downFactor = DEFAULT_HYSTERESIS.down,
                          ladder: Ladder = DEFAULT_LADDER): number {
  const wanted = levelFor(px, ladder);
  if (wanted === current) return current;
  // A level from another slot's ladder has no band here to be held inside.
  if (!onLadder(current, ladder)) return wanted;
  return wanted > current
    ? (levelFor(px / upFactor, ladder) > current ? wanted : current)
    : (levelFor(px / downFactor, ladder) < current ? wanted : current);
}

/** The sheet a rung draws from: its own, or for the loose and vector rungs
 *  the finest sheet, which stands in under a picture not yet in. */
export function sheetFor(level: number, ladder: Ladder = DEFAULT_LADDER): number {
  let out = ladder.sheets[0]!;
  for (const sheet of ladder.sheets) if (sheet <= level) out = sheet;
  return out;
}
