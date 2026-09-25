/** The wall's hybrid executor: weasel draws the cell bodies, and a transparent
 *  2D canvas stacked over it draws every feature `toDrawCommands` declines.
 */
import { createScene, renderSceneToCanvas, type View } from '@weasel-js/core';
import {
  CIRCLE_SCALE, drawCellMark, drawGlyph, drawOverlays, drawPaintCommand,
  strokeCaret, strokeSlash, type DrawOptions,
} from './draw2d';
import { glyphBlend, type PaintCommand } from './paint';
import type { Palette } from './palette';
import type { SheetImage } from './sheet';
import { UNSUPPORTED, toDrawCommands, type Sampling } from './toDrawCommands';

export interface Frame { width: number; height: number; dpr: number }

/** `paintCommands` emits screen space, so the scene applies no camera. */
const IDENTITY: View = { x: 0, y: 0, scale: { x: 1, y: 1 } };

/** Everything `toDrawCommands` left for canvas2d, for one command. Mirrors
 *  `drawPaintCommand` branch for branch minus the bodies, so each is painted once. */
export function drawResidue(ctx: CanvasRenderingContext2D, cmd: PaintCommand,
                            sheet: SheetImage | null, palette: Palette,
                            options: DrawOptions) {
  const offset = options.offset ?? { x: 0, y: 0 };
  const dx = cmd.dx + offset.x;
  const dy = cmd.dy + offset.y;

  if (cmd.kind === 'sprite') {
    const box = { dx, dy, dw: cmd.dw, dh: cmd.dh };
    // Under the cell's own alpha, so a dimmed cell's badges dim with it.
    ctx.save();
    ctx.globalAlpha = cmd.alpha ?? 1;
    drawOverlays(ctx, cmd, box, options);
    ctx.restore();
    if (cmd.caret) strokeCaret(ctx, box, palette);
  } else if (cmd.kind === 'image') {
    // Never reached the mapping: this branch is the whole command.
    drawPaintCommand(ctx, cmd, sheet, palette, options);
  } else if (cmd.kind === 'fill') {
    const box = { dx, dy, dw: cmd.dw, dh: cmd.dh };
    if (cmd.mark) {
      ctx.save();
      ctx.fillStyle = cmd.fill;
      drawCellMark(ctx, cmd.mark, dx + cmd.dw / 2, dy + cmd.dh / 2,
                   cmd.dw * CIRCLE_SCALE / 2, options);
      ctx.restore();
    } else if (cmd.glyph) {
      // Weasel drew the ground; the glyph fades in over it as `draw2d` fades it.
      const { ink } = glyphBlend(cmd.dw, cmd.cover);
      if (ink > 0) {
        ctx.save();
        ctx.globalAlpha *= ink;
        ctx.fillStyle = cmd.fill;
        drawGlyph(ctx, cmd.glyph, box);
        ctx.restore();
      }
    }
    // The border rect is weasel's; only the diagonal is left.
    if (cmd.slash) strokeSlash(ctx, { ...box, border: cmd.border, borderWidth: cmd.borderWidth });
    drawOverlays(ctx, cmd, box, options);
    if (cmd.caret) strokeCaret(ctx, box, palette);
  } else if (cmd.kind === 'label') {
    drawPaintCommand(ctx, cmd, sheet, palette, options);
  }
}

/** The 2D half of a hybrid paint: fit the layer, clear it, draw the residue.
 *  Needs no WebGL context, which is what makes it testable. */
export function paintOverlay(ctx: CanvasRenderingContext2D,
                             cmds: readonly PaintCommand[], frame: Frame,
                             sheet: SheetImage | null, palette: Palette,
                             options: DrawOptions) {
  const { canvas } = ctx;
  const w = Math.round(frame.width * frame.dpr);
  const h = Math.round(frame.height * frame.dpr);
  // Assigning `width` reallocates and zeroes the surface: a full-frame clear
  // on top of `clearRect` that the Canvas2D path never pays.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = `${frame.width}px`;
  canvas.style.height = `${frame.height}px`;

  ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
  ctx.clearRect(0, 0, frame.width, frame.height);
  ctx.imageSmoothingEnabled = true;
  // Without the reallocation, a helper that forgets `restore` would smear
  // state into the next frame.
  ctx.save();
  for (const cmd of cmds) drawResidue(ctx, cmd, sheet, palette, options);
  ctx.restore();
}

export interface Sheets {
  /** For weasel: the atlas as a texture source. */
  bitmap: ImageBitmap | null;
  /** For the 2D half: the same atlas. */
  img: SheetImage | null;
}

export interface SceneWallPainter {
  /** The features neither half drew. Empty is the invariant. */
  readonly unpainted: ReadonlySet<string>;
  paint(cmds: readonly PaintCommand[], frame: Frame, sheets: Sheets,
        palette: Palette, options: DrawOptions, sampling?: Sampling): void;
}

/** Typed against the mapping's own keys, so a feature added there and not here
 *  fails the build rather than going undrawn. */
const RESIDUE_DRAWS: Record<keyof typeof UNSUPPORTED, boolean> = {
  badges: true,
  strip: true,
  captions: true,
  caret: true,
  mark: true,
  glyph: true,
  slash: true,
  image: true,
  label: true,
};

const RESIDUE_COVERS: ReadonlySet<string> = new Set(
  (Object.keys(RESIDUE_DRAWS) as (keyof typeof UNSUPPORTED)[])
    .filter((k) => RESIDUE_DRAWS[k]).map((k) => UNSUPPORTED[k]));

/** Paints a `PaintCommand[]` across two stacked canvases: `gl` carries the
 *  bodies, `overlay` the rest. Only the scene is held between paints. */
export function scenePainter(gl: HTMLCanvasElement,
                             overlay: HTMLCanvasElement): SceneWallPainter {
  const scene = createScene<unknown, 'main'>({ systemLayers: [{ id: 'main' }] });
  const ctx = overlay.getContext('2d');
  if (!ctx) throw new Error('no 2d context for the overlay layer');
  let unpainted: ReadonlySet<string> = new Set();

  return {
    get unpainted() { return unpainted; },
    paint(cmds, frame, sheets, palette, options, sampling = 'nearest') {
      const mapped = toDrawCommands(cmds, sheets.bitmap, sampling, options.washColor);
      unpainted = new Set([...mapped.unsupported].filter((f) => !RESIDUE_COVERS.has(f)));

      renderSceneToCanvas({
        canvas: gl,
        scene,
        view: IDENTITY,
        width: frame.width,
        height: frame.height,
        dpr: frame.dpr,
        drawOne: () => [],
        extraCommands: mapped.commands,
      });

      paintOverlay(ctx, cmds, frame, sheets.img, palette, options);
    },
  };
}
