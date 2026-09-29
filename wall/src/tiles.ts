import type { View } from '@weasel-js/core';
import type { CompiledSpec } from './cel';
import { tintColumn, type Facts } from './derive';
import { drawPaintCommand, type DrawOptions } from './draw2d';
import { indexAt, rectAt, visiblePositions, visibleSpans, type Laid } from './layout';
import { GLYPH_MIN_PX, glyphBlend, paintCommands, STALE_WASH, type Appearance } from './paint';
import type { Palette } from './palette';
import type { Item } from './schema';
import type { SheetImage, SheetManifest } from './sheet';
import { ramp, STATUS, STEPS, type RampName } from './tint';

/** A tile's edge in pixels. */
export const TILE_PX = 512;
/** Below this many tile pixels a cell is written as a run of pixels in its
 *  color: a picture that small is noise, and a draw call per cell is not. */
export const PIXEL_CELL_PX = 4;
export const MAX_TILES = 128;
const LEVELS = { min: -20, max: 12 };
/** How far down the pyramid a missing tile looks for something to stand in. */
const FALLBACK_DEPTH = 8;
/** How long a new tile takes to fade in over what stood in for it. */
export const FADE_MS = 160;
/** The coarsest level keeps the whole wall in at most this many tiles a side,
 *  and is never evicted: whatever else is missing, it can stand in. */
const FLOOR_TILES = 2;

/** Everything that decides a tile's pixels except where it is. A new scene is
 *  a new cache: tiles are never patched. */
export interface TileScene<T extends Item> {
  compiled: CompiledSpec<T>;
  facts: Facts<T>;
  laid: Laid;
  manifest: SheetManifest | null;
  sheet: SheetImage | null;
  palette: Palette;
  options: DrawOptions;
  highlight: string | null;
  highlightTag: string | null;
  appearance: Appearance;
  tint: string;
  gradient: RampName;
  stale: boolean;
  ground: string;
}

export interface TileSurface {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
  /** When it was rendered, for its fade. Absent: no fade. */
  bornAt?: number;
}

/** What a frame of tiles came to. `complete`: every tile drawn was this
 *  scene's own. `animating`: a tile is still fading in, so draw again.
 *  `pending`: tiles just off screen are still unrendered, worth idle time. */
export interface TileFrame { complete: boolean; animating: boolean; pending: boolean }

/** How many tiles past the screen to render ahead: more when a screen needs few. */
const overscanFor = (onScreen: number) => (onScreen <= 24 ? 2 : 1);
/** How far ahead of a pan, in frames of the same motion, the overscan leans. */
const LEAD_FRAMES = 12;
export type MakeSurface = (px: number) => TileSurface;

export interface TileRef { z: number; tx: number; ty: number; key: string; x: number; y: number; size: number }

export const tileKey = (z: number, tx: number, ty: number) => `${z}/${tx}/${ty}`;

/** The pyramid level whose tiles are at least as sharp as the screen:
 *  `2^z` tile pixels per world unit. */
export function tileLevel(scale: number, dpr: number): number {
  const z = Math.ceil(Math.log2(scale * dpr) - 1e-9);
  return Math.min(LEVELS.max, Math.max(LEVELS.min, z)) + 0;
}

function ref(z: number, tx: number, ty: number): TileRef {
  const size = TILE_PX / 2 ** z;
  return { z, tx, ty, key: tileKey(z, tx, ty), x: tx * size, y: ty * size, size };
}

/** The tiles covering the viewport, in rows. */
export function coveringTiles(cam: View, viewport: { width: number; height: number },
                              dpr: number, level?: number): TileRef[] {
  const z = level ?? tileLevel(cam.scale.x, dpr);
  const size = TILE_PX / 2 ** z;
  const x1 = cam.x + viewport.width / cam.scale.x;
  const y1 = cam.y + viewport.height / cam.scale.y;
  const out: TileRef[] = [];
  for (let ty = Math.floor(cam.y / size); ty * size < y1; ty++) {
    for (let tx = Math.floor(cam.x / size); tx * size < x1; tx++) out.push(ref(z, tx, ty));
  }
  return out;
}

/** Where a world square lands on screen, edges on device pixels: Safari and
 *  Firefox antialias image edges, so tiles meeting mid-pixel leave a hairline. */
function placed(x: number, y: number, size: number, cam: View, dpr: number) {
  const at = (w: number, origin: number, scale: number) => Math.round((w - origin) * scale * dpr) / dpr;
  const dx = at(x, cam.x, cam.scale.x);
  const dy = at(y, cam.y, cam.scale.y);
  return { dx, dy, dw: at(x + size, cam.x, cam.scale.x) - dx, dh: at(y + size, cam.y, cam.scale.y) - dy };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** One pixel tile's worth of ImageData per context, reused: putImageData
 *  copies it out, so the next tile can write over it. */
const scratch = new WeakMap<CanvasRenderingContext2D, ImageData>();
function scratchFor(ctx: CanvasRenderingContext2D): ImageData {
  let img = scratch.get(ctx);
  if (!img) scratch.set(ctx, img = ctx.createImageData(TILE_PX, TILE_PX));
  return img;
}

function parseColor(css: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css.trim());
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.replace(/./g, '$&$&') : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(css.trim());
  if (fn) {
    const [r = 128, g = 128, b = 128] = fn[1]!.split(/[\s,/]+/).map(Number);
    return [r, g, b];
  }
  return [128, 128, 128];
}

/** Every cell in the tile as a run of its color: its state's border where it
 *  has one, else its fill, dimmed and washed as `paint` would. */
function pixelTile<T extends Item>(scene: TileScene<T>, ctx: CanvasRenderingContext2D, view: View) {
  const { compiled, facts, laid, palette, tint, gradient, highlight, highlightTag, appearance,
          stale, options } = scene;
  const img = scratchFor(ctx);
  const data = new Uint32Array(img.data.buffer, img.data.byteOffset, TILE_PX * TILE_PX);
  data.fill(0);
  const scale = view.scale.x;
  const side = Math.max(1, Math.round(laid.cell * scale));
  const fallback = compiled.states.findIndex(
    (s) => s.key === compiled.byPrecedence[compiled.byPrecedence.length - 1]!.key);
  const wash = parseColor(options.washColor);
  // Packed as ImageData lays a pixel out in memory, so one store writes it.
  const colorOf = (css: string, washBy: number, alpha: number) => {
    const c = parseColor(css);
    const [r, g, b] = [0, 1, 2].map((i) => Math.round(c[i]! + (wash[i]! - c[i]!) * washBy)) as
      [number, number, number];
    const a = Math.round(alpha * 255);
    return LITTLE_ENDIAN ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  };
  const plain = highlight === null && highlightTag === null && !stale && !appearance.wash;
  // A quiet cell wears a glyph once close, so far off it is the ground the
  // glyph will sit on, not a solid square that the glyph then replaces.
  const glyphGround = compiled.spec.glyph
    ? glyphBlend(laid.cell * scale, compiled.spec.glyph.cover).ground : 1;
  const opacityOf = (quiet: boolean | undefined) => (quiet ? glyphGround : 1);
  // A cell's color depends only on where its style comes from and whether it
  // is dimmed, washed or quiet, so each mix is worked out once.
  const n = compiled.states.length;
  const DIMMED = n, SWATCH = n + 1, UNMATCHED = n + 1 + STEPS;
  const cssOf = (source: number) => {
    const style = source < n ? palette.states[compiled.states[source]!.key]!
      : source === DIMMED ? palette.states[compiled.states[fallback]!.key]!
      : source === UNMATCHED ? palette.unmatched
      : { fill: ramp((source - SWATCH) / (STEPS - 1), gradient), border: null };
    return tint === STATUS ? style.border ?? style.fill : style.fill;
  };
  const washStrength = stale ? Math.max(STALE_WASH, appearance.washStrength) : appearance.washStrength;
  const mixes: (number | undefined)[] = [];
  const mixOf = (source: number, dimmed: boolean, washed: boolean, quiet: boolean) => {
    const at = source * 8 + (dimmed ? 4 : 0) + (washed ? 2 : 0) + (quiet ? 1 : 0);
    return mixes[at] ??= colorOf(cssOf(source), washed ? washStrength : 0,
                                 (dimmed ? appearance.dimAlpha : 1) * opacityOf(quiet));
  };
  const quiet = compiled.states.map((s) => s.quiet === true);
  const familyDim = compiled.states.map((s) => highlight !== null && s.family !== highlight);
  const tagDim = highlightTag === null ? null
    : facts.tags.values.map((tags) => !(tags as string[]).includes(highlightTag));
  // A ramp has STEPS swatches, so a measure is a lookup, as `tintFor` would draw it.
  const column = tint !== STATUS ? tintColumn(facts, tint) : null;
  const plainBySource = Array.from({ length: UNMATCHED + 1 },
                                   (_, src) => mixOf(src, false, false, src < n && !column && quiet[src]!));
  const sourceOfTint = (t: number) =>
    Number.isNaN(t) ? UNMATCHED : SWATCH + Math.round(Math.max(0, Math.min(1, t)) * (STEPS - 1));

  for (const { block, c0, c1, r0, r1 } of visibleSpans(laid, view, { width: TILE_PX, height: TILE_PX })) {
    for (let r = r0; r <= r1; r++) {
      const py0 = Math.floor((block.y + r * laid.pitch - view.y) * scale);
      for (let c = c0; c <= c1; c++) {
        const i = indexAt(block, c, r);
        if (i === null) continue;
        const row = laid.order[block.start + i]!;
        const s = facts.state[row]!;
        let color: number;
        if (plain) {
          color = column ? plainBySource[sourceOfTint(column[row]!)]! : plainBySource[s]!;
        } else {
          const dimmed = familyDim[s]! || (tagDim !== null && tagDim[facts.tags.codes[row]!]!);
          color = mixOf(dimmed ? DIMMED : column ? sourceOfTint(column[row]!) : s, dimmed,
                        stale || (appearance.wash && facts.washed[row] !== 0), quiet[s]!);
        }
        const px0 = Math.floor((block.x + c * laid.pitch - view.x) * scale);
        const x0 = Math.max(0, px0);
        const x1 = Math.min(TILE_PX, px0 + side);
        const y0 = Math.max(0, py0);
        const y1 = Math.min(TILE_PX, py0 + side);
        for (let y = y0; y < y1; y++) {
          const line = y * TILE_PX;
          for (let x = x0; x < x1; x++) data[line + x] = color;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Whether a tile at this scale can be written as pixels without losing
 *  anything `paint` would draw: tiny cells always; larger ones only when no
 *  cell could have a picture, a border, a round shape or a glyph. */
function drawnAsPixels<T extends Item>(scene: TileScene<T>, scale: number): boolean {
  const px = scene.laid.cell * scale;
  if (px < PIXEL_CELL_PX) return true;
  return px < GLYPH_MIN_PX && !scene.manifest && !scene.sheet
    && scene.compiled.states.every((s) => s.border === null && s.shape === 'square');
}

export function renderTile<T extends Item>(scene: TileScene<T>, ctx: CanvasRenderingContext2D,
                                           tile: TileRef): void {
  const scale = 2 ** tile.z;
  const view: View = { x: tile.x, y: tile.y, scale: { x: scale, y: scale } };
  ctx.clearRect(0, 0, TILE_PX, TILE_PX);
  if (drawnAsPixels(scene, scale)) {
    pixelTile(scene, ctx, view);
    return;
  }
  const { compiled, facts, laid, manifest, palette, highlight, highlightTag, tint, gradient,
          stale, ground, sheet, options } = scene;
  const cmds = paintCommands({
    compiled, facts, order: laid.order, rect: (p) => rectAt(laid, p),
    visible: visiblePositions(laid, view, { width: TILE_PX, height: TILE_PX }) ?? [],
    cam: view, manifest, palette, highlight, highlightTag, caret: null, tint, gradient, stale,
    ground,
    // Below the size tiles are drawn at, the wall shows neither.
    appearance: { ...scene.appearance, showBadges: false, showCaptions: false },
  });
  ctx.imageSmoothingEnabled = true;
  for (const cmd of cmds) drawPaintCommand(ctx, cmd, sheet, palette, options);
}

/** The wall below badge size, as square tiles at power-of-two zoom levels,
 *  rendered on demand and kept least recently used first out. */
/** Surfaces of evicted and released tiles, per surface maker, for the next
 *  render to draw over: a new 512px canvas costs about four times a reused one. */
const spares = new WeakMap<MakeSurface, TileSurface[]>();
const sparesOf = (make: MakeSurface) => {
  let held = spares.get(make);
  if (!held) spares.set(make, held = []);
  return held;
};
const spare = (make: MakeSurface, surface: TileSurface) => {
  const held = sparesOf(make);
  if (held.length < MAX_TILES) held.push(surface);
};

export class TileCache<T extends Item> {
  readonly #tiles = new Map<string, TileSurface>();
  #previous: TileCache<T> | null;
  #lastCenter: { x: number; y: number } | null = null;
  /** The level on screen, and since when; the one it replaced fades out under it. */
  #layer: { z: number; since: number } | null = null;
  #fading: { z: number; until: number } | null = null;
  #lead = { x: 0, y: 0 };
  #room: number;

  /** `previous` stands in for tiles this scene has not rendered yet, so a
   *  filter change redraws in place instead of blanking. */
  constructor(readonly scene: TileScene<T>, readonly make: MakeSurface,
              previous: TileCache<T> | null = null, readonly max = MAX_TILES) {
    this.#previous = previous;
    this.#room = max;
    previous?.forget();
  }

  get size() { return this.#tiles.size; }

  has(key: string) { return this.#tiles.has(key); }

  /** Lets go of the scene before, once there is no call to stand in for it. */
  forget() { this.#previous = null; }

  peek(key: string): TileSurface | undefined { return this.#tiles.get(key); }

  #use(key: string): TileSurface | undefined {
    const hit = this.#tiles.get(key);
    if (hit) { this.#tiles.delete(key); this.#tiles.set(key, hit); }
    return hit;
  }

  render(tile: TileRef, bornAt?: number): TileSurface {
    const surface = sparesOf(this.make).pop() ?? this.make(TILE_PX);
    renderTile(this.scene, surface.ctx, tile);
    surface.bornAt = bornAt;
    this.#tiles.set(tile.key, surface);
    for (const [key, evicted] of this.#tiles) {
      if (this.#tiles.size <= this.#room) break;
      if (!key.startsWith(`${this.#floor}/`)) { this.#tiles.delete(key); spare(this.make, evicted); }
    }
    return surface;
  }

  /** The scene this one stands in for until its own tiles are in. */
  get previous(): TileCache<T> | null { return this.#previous; }

  /** Hands every tile's surface to the next render. Only for a cache nothing
   *  draws from any more, as the current scene or as another's stand-in. */
  release() {
    for (const surface of this.#tiles.values()) spare(this.make, surface);
    this.#tiles.clear();
    this.#previous = null;
  }

  /** The level whose tiles hold the whole wall, `FLOOR_TILES` a side at most. */
  get #floor(): number {
    const { w, h } = this.scene.laid.bounds;
    const span = Math.max(w, h, 1);
    return Math.max(-20, Math.floor(Math.log2((TILE_PX * FLOOR_TILES) / span)));
  }

  /** Draws the tiles covering the view onto `ctx`, in CSS pixels.
   *
   *  Renders within `budgetMs` (always at least one tile): first the floor
   *  tiles under the view, so something can always stand in; then the missing
   *  tiles nearest the center; then, with time left, the ring just off screen,
   *  so a pan finds them ready. A tile not yet rendered is stood in for by the
   *  previous scene's, by the finer tiles already held, or by a coarser one;
   *  a new tile fades in over its stand-in. */
  draw(ctx: CanvasRenderingContext2D, cam: View, viewport: { width: number; height: number },
       dpr: number, budgetMs = 8, now: () => number = () => performance.now()): TileFrame {
    const start = now();
    const tiles = coveringTiles(cam, viewport, dpr);
    const z = tiles[0]?.z ?? 0;
    const cx = cam.x + viewport.width / cam.scale.x / 2;
    const cy = cam.y + viewport.height / cam.scale.y / 2;
    const byCenter = (a: TileRef, b: TileRef) =>
      Math.hypot(a.x + a.size / 2 - cx, a.y + a.size / 2 - cy)
      - Math.hypot(b.x + b.size / 2 - cx, b.y + b.size / 2 - cy);
    // Lean the overscan the way the view last moved.
    if (this.#lastCenter) {
      this.#lead = { x: (cx - this.#lastCenter.x) * LEAD_FRAMES, y: (cy - this.#lastCenter.y) * LEAD_FRAMES };
    }
    this.#lastCenter = { x: cx, y: cy };
    const ahead = { x: cx + this.#lead.x, y: cy + this.#lead.y };
    const byLead = (a: TileRef, b: TileRef) =>
      Math.hypot(a.x + a.size / 2 - ahead.x, a.y + a.size / 2 - ahead.y)
      - Math.hypot(b.x + b.size / 2 - ahead.x, b.y + b.size / 2 - ahead.y);

    const floor = this.#floor;
    const wanted: TileRef[] = [];
    if (z > floor) {
      const under = new Set<string>();
      for (const t of tiles) {
        const step = 2 ** (z - floor);
        const f = ref(floor, Math.floor(t.tx / step), Math.floor(t.ty / step));
        if (!under.has(f.key)) { under.add(f.key); wanted.push(f); }
      }
    }
    wanted.push(...[...tiles].sort(byCenter));
    const first = tiles.length > 0 ? tiles[0]! : null;
    const last = tiles.length > 0 ? tiles[tiles.length - 1]! : null;
    // Off screen: the level a zoom out lands on, then a margin at this level.
    const extra: TileRef[] = [];
    if (first && last) {
      const seen = new Set(wanted.map((t) => t.key));
      for (const t of tiles) {
        const up = ref(z - 1, Math.floor(t.tx / 2), Math.floor(t.ty / 2));
        if (!seen.has(up.key)) { seen.add(up.key); extra.push(up); }
      }
      const margin = overscanFor(tiles.length);
      const ring: TileRef[] = [];
      for (let ty = first.ty - margin; ty <= last.ty + margin; ty++) {
        for (let tx = first.tx - margin; tx <= last.tx + margin; tx++) {
          if (ty < first.ty || ty > last.ty || tx < first.tx || tx > last.tx) ring.push(ref(z, tx, ty));
        }
      }
      extra.push(...ring.sort(byLead));
      // Room for the screen, its margin and the level above, twice over.
      this.#room = Math.max(this.max, 2 * (wanted.length + extra.length));
    }

    let rendered = 0;
    const fresh = this.#tiles.size > 0 || this.#previous !== null;
    const onScreenDone = () => wanted.every((t) => this.#tiles.has(t.key));
    for (const tile of wanted) {
      if (this.#tiles.has(tile.key)) continue;
      if (rendered > 0 && now() - start >= budgetMs) break;
      this.render(tile, fresh || rendered > 0 ? now() : undefined);
      rendered++;
    }
    // Off screen only with time a frame has left over.
    if (onScreenDone()) {
      for (const tile of extra) {
        if (this.#tiles.has(tile.key)) continue;
        if (now() - start >= budgetMs) break;
        this.render(tile, now());
      }
    }
    const pending = extra.some((t) => !this.#tiles.has(t.key));

    // Show one level for the whole screen: the wanted one once every tile of it
    // is in, else the last level that covered the screen, else whatever is
    // held. A level change crossfades the whole view instead of tile by tile.
    const t = now();
    const covered = (level: number) =>
      coveringTiles(cam, viewport, dpr, level).every((tile) => this.#held(tile.key));
    let shown = z;
    if (!covered(z) && this.#layer && this.#layer.z !== z && Math.abs(this.#layer.z - z) <= 2
        && covered(this.#layer.z)) {
      shown = this.#layer.z;
    }
    if (!this.#layer || this.#layer.z !== shown) {
      if (this.#layer && this.#tiles.size > 0) this.#fading = { z: this.#layer.z, until: t + FADE_MS };
      this.#layer = { z: shown, since: t };
    }
    let animating = false;
    ctx.imageSmoothingEnabled = true;
    const fading = this.#fading && this.#fading.until > t ? this.#fading : null;
    if (fading) {
      animating = true;
      this.#drawLevel(ctx, cam, viewport, dpr, fading.z, t, null);
    }
    const alpha = ctx.globalAlpha;
    if (fading) ctx.globalAlpha = alpha * (1 - (fading.until - t) / FADE_MS);
    const drawn = this.#drawLevel(ctx, cam, viewport, dpr, shown, t, this.#layer.since);
    ctx.globalAlpha = alpha;
    return { complete: drawn.complete && shown === z, animating: animating || drawn.animating,
             pending: pending || shown !== z };
  }

  /** Draws `level`'s tiles covering the view. A tile rendered after `since`
   *  fades in over its stand-in; with `since` null nothing fades. */
  #drawLevel(ctx: CanvasRenderingContext2D, cam: View, viewport: { width: number; height: number },
             dpr: number, level: number, t: number, since: number | null) {
    let complete = true;
    let animating = false;
    for (const tile of coveringTiles(cam, viewport, dpr, level)) {
      const { dx, dy, dw, dh } = placed(tile.x, tile.y, tile.size, cam, dpr);
      const own = this.#use(tile.key);
      if (!own) complete = false;
      const hit = own ?? this.#previous?.peek(tile.key);
      if (!hit) {
        this.#standIn(ctx, tile, cam, dpr);
        continue;
      }
      const age = since === null || hit.bornAt === undefined || hit.bornAt < since
        ? FADE_MS : t - hit.bornAt;
      if (age >= FADE_MS) { ctx.drawImage(hit.canvas, dx, dy, dw, dh); continue; }
      animating = true;
      this.#standIn(ctx, tile, cam, dpr);
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * Math.max(0, age / FADE_MS);
      ctx.drawImage(hit.canvas, dx, dy, dw, dh);
      ctx.globalAlpha = alpha;
    }
    return { complete, animating };
  }

  #held(key: string): TileSurface | undefined {
    return this.#tiles.get(key) ?? this.#previous?.peek(key);
  }

  #standIn(ctx: CanvasRenderingContext2D, tile: TileRef, cam: View, dpr: number) {
    const { dx, dy, dw, dh } = placed(tile.x, tile.y, tile.size, cam, dpr);
    const before = this.#previous?.peek(tile.key);
    if (before) { ctx.drawImage(before.canvas, dx, dy, dw, dh); return; }
    // Coarser first as the base, then any finer tiles over it: a zoom out
    // holds the level below, a zoom in the level above.
    for (let k = 1; k <= FALLBACK_DEPTH; k++) {
      const step = 2 ** k;
      const px = Math.floor(tile.tx / step);
      const py = Math.floor(tile.ty / step);
      const parent = this.#held(tileKey(tile.z - k, px, py));
      if (!parent) continue;
      const sub = TILE_PX / step;
      ctx.drawImage(parent.canvas, (tile.tx - px * step) * sub, (tile.ty - py * step) * sub,
                    sub, sub, dx, dy, dw, dh);
      break;
    }
    for (let i = 0; i < 4; i++) {
      const sub = ref(tile.z + 1, tile.tx * 2 + (i % 2), tile.ty * 2 + (i >> 1));
      const child = this.#held(sub.key);
      if (!child) continue;
      const box = placed(sub.x, sub.y, sub.size, cam, dpr);
      ctx.drawImage(child.canvas, box.dx, box.dy, box.dw, box.dh);
    }
  }
}

/** A tile surface on an offscreen canvas where there is one. */
export const offscreenSurface: MakeSurface = (px) => {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(px, px)
    : Object.assign(document.createElement('canvas'), { width: px, height: px });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  return { canvas: canvas as CanvasImageSource, ctx };
};

/** The cache drawing the scene now, and the one for the same scene unhovered,
 *  held through a hover so leaving it shows those tiles again. */
export interface SceneTiles<T extends Item> {
  tiles: TileCache<T> | null;
  unhovered: TileCache<T> | null;
}

export function nextTiles<T extends Item>(held: SceneTiles<T>, scene: TileScene<T>,
                                          unhovered: TileScene<T>, make: MakeSurface): SceneTiles<T> {
  if (held.tiles?.scene === scene) return held;
  const before = [held.tiles, held.tiles?.previous, held.unhovered];
  const tiles = held.unhovered?.scene === scene ? held.unhovered
    : new TileCache(scene, make, held.tiles);
  const next = { tiles, unhovered: scene === unhovered ? tiles
    : held.unhovered?.scene === unhovered ? held.unhovered : null };
  const kept = new Set([next.tiles, next.tiles.previous, next.unhovered]);
  for (const cache of new Set(before)) if (cache && !kept.has(cache)) cache.release();
  return next;
}
