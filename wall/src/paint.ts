import { viewToTransform, worldToScreen, type View } from '@weasel-js/core';
import type { CompiledSpec } from './cel';
import { captionOf, glyphOf, markOf, stateKey, tagsOf, type Facts } from './derive';
import type { Band, Rect } from './layout';
import type { CellStyle, Palette } from './palette';
import type { Badge, BadgeDef, Item, Shape } from './schema';
import { hasTile, sourceBox, type SheetManifest } from './sheet';
import { STATUS, tintFor, type RampName } from './tint';

export interface Appearance {
  thickBorderFactor: number;
  thinBorderFactor: number;
  maxBorderPx: number;
  dimAlpha: number;
  /** Off, the wall is the pictures and their state colors and nothing else. */
  showBadges: boolean;
  showCaptions: boolean;
  /** Washes the items the spec's `washes` picks out. */
  wash: boolean;
  washStrength: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  thickBorderFactor: 0.18,
  thinBorderFactor: 0.09,
  maxBorderPx: 6,
  dimAlpha: 0.25,
  showBadges: true,
  showCaptions: true,
  wash: false,
  washStrength: 0.75,
};

/** Below this drawn size a badge would cover the picture it is about. */
export const BADGE_MIN_PX = 80;
/** Captions are words, and need more room than a badge. */
export const LABEL_MIN_PX = 88;
/** Below this a glyph is a smudge. */
export const GLYPH_MIN_PX = 22;
/** Where a glyph cell has finished turning from a colored square into a
 *  character on a faint ground of that color. */
export const GLYPH_FULL_PX = 44;
/** How much of its state's color a glyph cell's ground keeps once close. */
const GLYPH_GROUND_NEAR = 0.24;

const ease = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/** How a glyph cell of `px` reads: the ground's opacity, which thins as the
 *  cell grows, and the glyph's, which rises from nothing at `GLYPH_MIN_PX`.
 *  The pixel tiles and the drawn cells both follow it, so zooming across
 *  the sizes where one takes over from the other changes nothing at once.
 *
 *  With `cover`, the share of a cell a glyph inks on average, the ground gives
 *  up what the ink adds, so a cell's mean brightness is the same at every size
 *  and a far square is no brighter than the character that replaces it. */
export function glyphBlend(px: number, cover?: number): { ground: number; ink: number } {
  const ink = ease((px - GLYPH_MIN_PX) / (GLYPH_FULL_PX - GLYPH_MIN_PX));
  if (cover === undefined) {
    return { ground: 1 - (1 - GLYPH_GROUND_NEAR) * ease((px - 8) / (GLYPH_FULL_PX - 8)), ink };
  }
  const c = Math.max(0, Math.min(0.99, cover));
  const mean = GLYPH_GROUND_NEAR + (1 - GLYPH_GROUND_NEAR) * c;
  return { ground: (mean - ink * c) / (1 - ink * c), ink };
}
/** How hard the whole wall washes while it shows the previous slot's items. */
export const STALE_WASH = 0.85;
export const DEFAULT_GROUND = '#ffffff';
/** Dark on a picture's light ground, white on a state fill. */
export const CAPTION_ON_THUMB = '#4a4a4f';
export const CAPTION_ON_FILL = '#ffffff';
/** An identifier is picked out of a grid; the rest is read once you have. */
export const WEIGHT_ID = 500;
export const WEIGHT_TEXT = 300;

// A label narrower than its own text is ink, not a word.
const MIN_LABEL_PX = 40;
// The share of the reserved header the type takes, leaving room for descenders.
const LABEL_FILL = 0.8;
const MIN_LABEL_SIZE_PX = 7;

export interface Caption {
  text: string;
  corner: 'tl' | 'tr' | 'bl';
  ink: string;
  weight?: number;
}

type Decor = { caret?: boolean; badges?: Badge[]; strip?: Badge[]; captions?: Caption[] };

export type PaintCommand =
  | ({ kind: 'sprite'; dx: number; dy: number; dw: number; dh: number;
       sx: number; sy: number; sw: number; sh: number;
       ground: string; alpha?: number; wash?: number } & Decor)
  | ({ kind: 'fill'; dx: number; dy: number; dw: number; dh: number;
       fill: string; border: string | null; borderWidth: number; shape: Shape;
       glyph?: string; cover?: number; mark?: string; slash: boolean; wash?: number } & Decor)
  | ({ kind: 'image'; dx: number; dy: number; dw: number; dh: number;
       image: CanvasImageSource; ground: string; wash?: number; alpha?: number } & Decor)
  | { kind: 'label'; text: string; count: number; dx: number; dy: number;
      size: number; depth: 0 | 1 };

export interface PaintInput<T extends Item> {
  compiled: CompiledSpec<T>;
  facts: Facts<T>;
  /** Rows of the store in view order: `order[p]` is drawn at position `p`.
   *  Defaults to every row in store order. */
  order?: ArrayLike<number>;
  /** The cell at a position. */
  rect: (position: number) => Rect | undefined;
  /** Positions in `order` to draw. */
  visible: ArrayLike<number>;
  cam: View;
  manifest: SheetManifest | null;
  palette: Palette;
  loose?: Map<string, CanvasImageSource>;
  /** Checked before `loose`: a cell only has one once it is past the loose rung. */
  vector?: Map<string, CanvasImageSource>;
  /** A legend row: cells of any other family dim. */
  highlight?: string | null;
  highlightTag?: string | null;
  /** The items on screen belong to the slot being left. */
  stale?: boolean;
  /** Position in `order` of the caret cell. */
  caret?: number | null;
  appearance?: Appearance;
  bands?: Band[];
  tint?: string;
  gradient?: RampName;
  /** What every picture is drawn on. */
  ground?: string;
  /** The drawn cell size badges appear from, for a caller replaying another
   *  wall's threshold -- a host's older painter may show them from 56px.
   *  Deliberately not a `Wall` or `WallView` prop. Defaults to `BADGE_MIN_PX`. */
  badgeMinPx?: number;
}

const NO_BADGES: Badge[] = [];
const NO_CAPTIONS: Caption[] = [];

function borderWidthFor(weight: CellStyle['weight'], px: number, a: Appearance): number {
  if (!weight) return 0;
  const factor = weight === 'thick' ? a.thickBorderFactor : a.thinBorderFactor;
  return Math.min(a.maxBorderPx, Math.max(1, px * factor));
}

/** What to draw this frame, as data: which cells, from where, in what color. */
export function paintCommands<T extends Item>(input: PaintInput<T>): PaintCommand[] {
  const {
    compiled, facts, order, rect, visible, cam, manifest, palette, loose, vector,
    highlight = null, highlightTag = null, bands, caret = null,
    appearance = DEFAULT_APPEARANCE, tint = STATUS, gradient = 'ember',
    stale = false, ground: plainGround = DEFAULT_GROUND, badgeMinPx = BADGE_MIN_PX,
  } = input;

  const states = new Map(compiled.states.map((s) => [s.key, s]));
  // The state matched last is the catch-all, and a dimmed cell wears it.
  const fallback = compiled.byPrecedence[compiled.byPrecedence.length - 1]!.key;
  const defs = new Map((compiled.spec.badges ?? []).map((b) => [b.tag, b]));
  const captionDefs = compiled.spec.captions ?? [];

  const captionsFor = (row: number, px: number, ink: string): Caption[] => {
    if (px < LABEL_MIN_PX) return [];
    const out: Caption[] = [];
    for (const def of captionDefs) {
      const text = captionOf(facts, def.key, row);
      if (text) {
        out.push({ text, corner: def.corner, ink,
                   weight: def.weight === 'id' ? WEIGHT_ID : WEIGHT_TEXT });
      }
    }
    return out;
  };
  const badgesOf = (row: number, slot: BadgeDef['slot']) => tagsOf(facts, row)
    .map((tag) => defs.get(tag))
    .filter((d): d is BadgeDef => d !== undefined && d.slot === slot);
  const badge = (d: BadgeDef): Badge => ({ tag: d.tag, ...d.art });
  const cornerBadges = (row: number, px: number, labelMinPx: number): Badge[] => {
    if (px < badgeMinPx) return [];
    return badgesOf(row, 'corner')
      .filter((d) => !(d.yieldsTo && px >= labelMinPx && captionOf(facts, d.yieldsTo, row)))
      .map(badge);
  };
  const stripBadges = (row: number, px: number): Badge[] =>
    px < badgeMinPx ? [] : badgesOf(row, 'strip').map(badge);

  const out: PaintCommand[] = [];
  const transform = viewToTransform(cam);
  for (let k = 0; k < visible.length; k++) {
    const i = visible[k]!;
    const row = order ? order[i] : i;
    const cell = rect(i);
    if (row === undefined || cell === undefined || row >= facts.store.length) continue;
    const [dx, dy] = worldToScreen(cell.x, cell.y, transform);
    const dw = cell.w * cam.scale.x;
    const dh = cell.h * cam.scale.y;
    const isCaret = caret !== null && i === caret ? true : undefined;
    const key = stateKey(facts, row);
    const state = states.get(key)!;
    const dimmed = (highlight !== null && state.family !== highlight)
      || (highlightTag !== null && !tagsOf(facts, row).includes(highlightTag));
    const alpha = dimmed ? appearance.dimAlpha : undefined;
    // A drawn cell carries its state in the ground, having every pixel around
    // its ink to spare; an undrawn one carries it in the ring.
    const style = dimmed ? palette.states[fallback]! : tintFor(facts, row, tint, palette, gradient);
    const border = style.border;
    const borderWidth = borderWidthFor(style.weight, dw, appearance);
    const ground = tint === STATUS ? border ?? plainGround : style.fill;
    const badges = appearance.showBadges
      ? cornerBadges(row, dw, appearance.showCaptions ? LABEL_MIN_PX : Infinity)
      : NO_BADGES;
    const strip = appearance.showBadges ? stripBadges(row, dw) : NO_BADGES;
    const captions = appearance.showCaptions
      ? captionsFor(row, dw, CAPTION_ON_THUMB) : NO_CAPTIONS;
    const wash = stale ? Math.max(STALE_WASH, appearance.washStrength)
      : appearance.wash && facts.washed[row] ? appearance.washStrength
      : undefined;

    // Decoding an id is the costly read on a column store, so only when used.
    const id = vector?.size || loose?.size || manifest ? facts.store.id(row) : '';
    const image = vector?.get(id) ?? loose?.get(id);
    if (image) {
      out.push({ kind: 'image', dx, dy, dw, dh, image, ground,
                 alpha, caret: isCaret, badges, strip, captions, wash });
      continue;
    }
    // Drawn whenever the sheet has a tile, stale or not: freshness decides
    // whether to fetch a better one, never whether to show a picture.
    const box = manifest && hasTile(manifest, { id }) ? sourceBox(manifest, facts.store.index(row)) : null;
    if (box) {
      out.push({ kind: 'sprite', dx, dy, dw, dh, ...box, ground,
                 alpha, caret: isCaret, badges, strip, captions, wash });
      continue;
    }
    const quiet = state.quiet === true;
    const mark = quiet ? markOf(facts, row) ?? undefined : undefined;
    out.push({
      kind: 'fill', dx, dy, dw, dh, fill: style.fill, border, borderWidth,
      shape: state.shape,
      glyph: quiet && dw >= GLYPH_MIN_PX && !mark
        ? glyphOf(facts, row) ?? undefined : undefined,
      cover: quiet ? compiled.spec.glyph?.cover : undefined,
      mark,
      captions: quiet ? undefined
        : appearance.showCaptions ? captionsFor(row, dw, CAPTION_ON_FILL) : NO_CAPTIONS,
      badges: quiet ? undefined : badges,
      strip: quiet ? undefined : strip,
      slash: border !== null, caret: isCaret, wash,
    });
  }
  for (const b of bands ?? []) {
    const w = b.rect.w * cam.scale.x;
    if (w < MIN_LABEL_PX) continue;
    const size = b.header * cam.scale.y * LABEL_FILL;
    if (size < MIN_LABEL_SIZE_PX) continue;
    const [dx, dy] = worldToScreen(b.rect.x, b.rect.y, transform);
    out.push({ kind: 'label', text: b.label, count: b.count,
               dx, dy: dy + size, size, depth: b.depth });
  }
  return out;
}

/** How many items are in each state, zeros included. */
export function tally<T extends Item>(compiled: CompiledSpec<T>,
                                      facts: Facts<T>): Record<string, number> {
  const out = Object.fromEntries(compiled.states.map((s) => [s.key, 0]));
  const counts = new Uint32Array(compiled.states.length);
  for (const s of facts.state) counts[s]!++;
  compiled.states.forEach((s, i) => { out[s.key] = counts[i]!; });
  return out;
}
