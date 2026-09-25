/** The wall's Canvas2D executor: a `PaintCommand` list drawn into a context.
 *
 *  `paint.ts` decides what to draw; this decides nothing, so a second executor
 *  can be measured against it over the identical command list.
 */
import { THUMB_FACE, drawBadge, drawMarkShapes } from './badgeDraw';
import type { Marks } from './marks';
import { glyphBlend, WEIGHT_ID, WEIGHT_TEXT, type Caption, type PaintCommand } from './paint';
import type { Palette } from './palette';
import type { SheetImage } from './sheet';
import type { BadgeArt } from './schema';

export interface DrawOptions {
  marks: Marks;
  /** Draws a quiet cell's mark; without it the mark is drawn from `marks`. */
  drawMark?: (ctx: CanvasRenderingContext2D, name: string, cx: number, cy: number,
              r: number) => void;
  /** What a washed cell is washed toward. */
  washColor: string;
  offset?: { x: number; y: number };
}

export const DEFAULT_WASH = '#d8d8d8';

type Box = { dx: number; dy: number; dw: number; dh: number };

/** The type size a caption is set at. */
export function captionSize(cellPx: number): number {
  return Math.max(10, Math.min(18, cellPx * 0.1));
}

/** A fraction of the cell, not of the mark: badge and caption stop scaling at
 *  their floors, and a margin measured off them crowds a small cell's corner. */
export function cornerPad(cellPx: number, size: number): number {
  return Math.max(size * 0.35, cellPx * 0.06);
}

/** A badge's radius, and its disc's clearance from the cell's edges, as
 *  fractions of the cell: a badge keeps its proportion at every zoom. */
export const BADGE_RADIUS = 0.063;
export const BADGE_INSET = 0.06;

/** How big a badge is drawn on a cell this wide and how far its center sits in
 *  from the edge. A hit test places discs with `cornerBadgesAt`, which is built
 *  on this, or a click misses the disc. */
export function badgeGeometry(cellPx: number) {
  const radius = BADGE_RADIUS * cellPx;
  // The type size a disc's letter is set at, in step with the disc.
  const size = radius / 0.63;
  const pad = BADGE_INSET * cellPx;
  const gap = radius * 0.5;
  return { size, radius, pad, gap, inset: radius + pad, rise: radius + pad, fall: radius + pad };
}

// A stroke straddles its path, so inset by half the width or it eats into
// the neighboring cells.
export function strokeBorder(ctx: CanvasRenderingContext2D,
                             cmd: Box & { border: string | null; borderWidth: number;
                                          slash?: boolean }) {
  if (!cmd.border || cmd.borderWidth <= 0) return;
  const inset = cmd.borderWidth / 2;
  ctx.save();
  ctx.strokeStyle = cmd.border;
  ctx.lineWidth = cmd.borderWidth;
  ctx.strokeRect(cmd.dx + inset, cmd.dy + inset,
                 cmd.dw - cmd.borderWidth, cmd.dh - cmd.borderWidth);
  ctx.restore();
  if (cmd.slash) strokeSlash(ctx, cmd);
}

// Separate from the border so the hybrid executor can draw it alone:
// re-stroking a rect weasel already drew hardens that edge.
export function strokeSlash(ctx: CanvasRenderingContext2D,
                            cmd: Box & { border: string | null; borderWidth: number }) {
  if (!cmd.border || cmd.borderWidth <= 0) return;
  const inset = cmd.borderWidth / 2;
  ctx.save();
  ctx.strokeStyle = cmd.border;
  ctx.lineWidth = cmd.borderWidth;
  ctx.beginPath();
  ctx.moveTo(cmd.dx + inset, cmd.dy + inset);
  ctx.lineTo(cmd.dx + cmd.dw - inset, cmd.dy + cmd.dh - inset);
  ctx.stroke();
  ctx.restore();
}

// Outside the cell, so it never collides with an inset border.
export function strokeCaret(ctx: CanvasRenderingContext2D, cmd: Box, palette: Palette) {
  ctx.save();
  ctx.strokeStyle = palette.caret;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 2]);
  ctx.strokeRect(cmd.dx - 1, cmd.dy - 1, cmd.dw + 2, cmd.dh + 2);
  ctx.restore();
}

/** A quiet cell's mark, in the current `fillStyle`: handed to `drawMark` when
 *  given, else the named shapes filled in a unit box scaled to `r`. */
export function drawCellMark(ctx: CanvasRenderingContext2D, name: string,
                             cx: number, cy: number, r: number, options: DrawOptions) {
  if (options.drawMark) {
    options.drawMark(ctx, name, cx, cy, r);
    return;
  }
  const shapes = options.marks[name];
  if (!shapes) return;
  const fill = String(ctx.fillStyle);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(r, r);
  // No field is drawn behind a quiet cell's mark, so field pieces stay unpainted.
  drawMarkShapes(ctx, shapes, (paint) => paint === 'none' || paint === 'field' ? null
    : paint === 'ink' || paint === 'accent' ? fill : paint);
  ctx.restore();
}

/** A quiet cell's glyph, in the current `fillStyle`, sized to the cell and
 *  centered on its ink. */
export function drawGlyph(ctx: CanvasRenderingContext2D, glyph: string, box: Box) {
  ctx.save();
  ctx.font = `${WEIGHT_ID} ${box.dh * GLYPH_SCALE}px ${THUMB_FACE}`;
  ctx.textAlign = 'center';
  // Not `middle`: WebKit and Blink place it differently, and an emoji from a
  // fallback font landed a tenth of the cell low on a phone.
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(glyph);
  const half = (a: number, b: number) => (Number.isFinite(a - b) ? (a - b) / 2 : 0);
  ctx.fillText(glyph,
               box.dx + box.dw / 2 + half(m.actualBoundingBoxLeft, m.actualBoundingBoxRight),
               box.dy + box.dh / 2 + half(m.actualBoundingBoxAscent, m.actualBoundingBoxDescent));
  ctx.restore();
}

/** How wide a row of `count` badges runs on a cell this wide. */
function rowWidth(cellPx: number, count: number): number {
  // Not `count <= 0`: that lets NaN through, and every later width is NaN.
  if (!(count > 0)) return 0;
  const { radius, gap } = badgeGeometry(cellPx);
  return count * radius * 2 + (count - 1) * gap;
}

/** Where a corner badge's disc sits, `index` places along the row its corner's
 *  badges form inward from that corner. `cornerBadgesAt` places a whole cell's
 *  badges, and is what the hit test uses. */
export function cornerBadgeAt(badge: BadgeArt, cmd: Box, index = 0) {
  const { size, radius, gap, inset, rise, fall } = badgeGeometry(cmd.dw);
  const right = badge.corner === 'br' || badge.corner === 'tr';
  const bottom = badge.corner === 'br';
  const along = index * (radius * 2 + gap);
  return {
    cx: right ? cmd.dx + cmd.dw - inset - along : cmd.dx + inset + along,
    cy: bottom ? cmd.dy + cmd.dh - fall : cmd.dy + rise,
    size, radius,
  };
}

/** Every corner badge's disc, in the order given, each placed in its corner's
 *  row. A row longer than its half of the cell stacks the rest on its last
 *  place rather than running past the middle, and a hit test over a stack
 *  finds only the first badge of it. */
export function cornerBadgesAt(badges: readonly BadgeArt[], cmd: Box) {
  const { radius, gap, inset } = badgeGeometry(cmd.dw);
  // A radius of headroom: the rows from facing corners must not meet.
  const last = Math.max(0, Math.floor((cmd.dw / 2 - inset - radius) / (radius * 2 + gap)));
  const seen: Record<string, number> = {};
  return badges.map((badge) => {
    const corner = badge.corner ?? 'tl';
    const index = seen[corner] ?? 0;
    seen[corner] = index + 1;
    return cornerBadgeAt(badge, cmd, Math.min(index, last));
  });
}

// Starts where the bottom-left caption ended but rides the badge row's own
// height, so a strip disc and a bottom-right one line up; stops short of the
// bottom-right corner row, leaving room for one badge there even when empty.
function drawStrip(ctx: CanvasRenderingContext2D, strip: readonly BadgeArt[], cmd: Box,
                   startX: number, bottomRight: number, marks: Marks) {
  if (strip.length === 0) return;
  const { size, radius, pad, gap, fall } = badgeGeometry(cmd.dw);
  const limit = cmd.dx + cmd.dw - pad - rowWidth(cmd.dw, Math.max(1, bottomRight)) - gap;
  const cy = cmd.dy + cmd.dh - fall;
  let cx = startX + radius;
  for (const badge of strip) {
    if (cx + radius > limit) return;
    drawBadge(ctx, badge, { cx, cy, size, radius }, marks);
    cx += radius * 2 + gap;
  }
}

/** Returns the x the caption's text ends at. `clear` is how far in from its
 *  side edge the caption must start, past any badges sharing its corner. */
function drawCaption(ctx: CanvasRenderingContext2D, caption: Caption, cmd: Box,
                     clear = 0): number {
  const size = captionSize(cmd.dw);
  const right = caption.corner === 'tr';
  const top = caption.corner[0] === 't';
  ctx.save();
  ctx.font = `${caption.weight ?? WEIGHT_TEXT} ${size}px ${THUMB_FACE}`;
  ctx.textAlign = right ? 'right' : 'left';
  ctx.textBaseline = 'middle';
  const pad = cornerPad(cmd.dw, size);
  ctx.fillStyle = caption.ink;
  const from = Math.min(Math.max(pad, clear), cmd.dw / 2);
  const x = right ? cmd.dx + cmd.dw - from : cmd.dx + from;
  ctx.fillText(caption.text, x,
               top ? cmd.dy + pad + size * 0.5 : cmd.dy + cmd.dh - pad - size * 0.5);
  const width = ctx.measureText(caption.text).width;
  ctx.restore();
  return right ? x - width : x + width;
}

/** How much of its cell a round cell fills across, and how tall a glyph stands. */
export const CIRCLE_SCALE = 0.6;
export const GLYPH_SCALE = 0.62;

// Over the drawing rather than baked under it, so the shade is the viewer's.
function washCell(ctx: CanvasRenderingContext2D, wash: number, cmd: Box, color: string) {
  ctx.save();
  ctx.globalAlpha = (ctx.globalAlpha || 1) * wash;
  ctx.fillStyle = color;
  ctx.fillRect(cmd.dx, cmd.dy, cmd.dw, cmd.dh);
  ctx.restore();
}

/** The captions, corner badges and strip a cell wears. The strip starts where
 *  the bottom-left caption ended, so it runs after the captions. */
export function drawOverlays(ctx: CanvasRenderingContext2D,
                             cmd: { captions?: readonly Caption[];
                                    badges?: readonly BadgeArt[];
                                    strip?: readonly BadgeArt[] },
                             box: Box, options: DrawOptions) {
  const { radius, pad } = badgeGeometry(box.dw);
  const badges = cmd.badges ?? [];
  let stripX = box.dx + pad;
  const count: Record<string, number> = {};
  for (const b of badges) {
    const corner = b.corner ?? 'tl';
    count[corner] = (count[corner] ?? 0) + 1;
  }
  const clear = (n: number) => (n === 0 ? 0 : pad + rowWidth(box.dw, n) + radius * 0.6);
  for (const caption of cmd.captions ?? []) {
    const end = drawCaption(ctx, caption, box,
                            caption.corner === 'bl' ? 0 : clear(count[caption.corner] ?? 0));
    if (caption.corner === 'bl') stripX = end + radius * 0.6;
  }
  const at = cornerBadgesAt(badges, box);
  badges.forEach((badge, i) => drawBadge(ctx, badge, at[i]!, options.marks));
  drawStrip(ctx, cmd.strip ?? [], box, stripX, count.br ?? 0, options.marks);
}

/** One paint command, shifted by `options.offset` -- how a loupe redraws the
 *  same commands recentered in its own canvas. */
export function drawPaintCommand(ctx: CanvasRenderingContext2D, cmd: PaintCommand,
                                 sheet: SheetImage | null, palette: Palette,
                                 options: DrawOptions) {
  const offset = options.offset ?? { x: 0, y: 0 };
  const dx = cmd.dx + offset.x;
  const dy = cmd.dy + offset.y;
  if (cmd.kind === 'sprite' && sheet) {
    const box = { dx, dy, dw: cmd.dw, dh: cmd.dh };
    ctx.save();
    ctx.globalAlpha = cmd.alpha ?? 1;
    ctx.fillStyle = cmd.ground;
    ctx.fillRect(dx, dy, cmd.dw, cmd.dh);
    ctx.drawImage(sheet, cmd.sx, cmd.sy, cmd.sw, cmd.sh, dx, dy, cmd.dw, cmd.dh);
    if (cmd.wash) washCell(ctx, cmd.wash, box, options.washColor);
    drawOverlays(ctx, cmd, box, options);
    ctx.restore();
    if (cmd.caret) strokeCaret(ctx, box, palette);
  } else if (cmd.kind === 'image') {
    const box = { dx, dy, dw: cmd.dw, dh: cmd.dh };
    ctx.save();
    // Under the image's alpha, so a dimmed cell fades whole.
    ctx.globalAlpha = cmd.alpha ?? 1;
    ctx.fillStyle = cmd.ground;
    ctx.fillRect(dx, dy, cmd.dw, cmd.dh);
    ctx.drawImage(cmd.image, dx, dy, cmd.dw, cmd.dh);
    if (cmd.wash) washCell(ctx, cmd.wash, box, options.washColor);
    drawOverlays(ctx, cmd, box, options);
    ctx.restore();
    if (cmd.caret) strokeCaret(ctx, box, palette);
  } else if (cmd.kind === 'fill') {
    const box = { dx, dy, dw: cmd.dw, dh: cmd.dh };
    ctx.fillStyle = cmd.fill;
    if (cmd.mark) {
      drawCellMark(ctx, cmd.mark, dx + cmd.dw / 2, dy + cmd.dh / 2,
                   cmd.dw * CIRCLE_SCALE / 2, options);
    } else if (cmd.glyph) {
      const { ground, ink } = glyphBlend(cmd.dw, cmd.cover);
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * ground;
      ctx.fillRect(dx, dy, cmd.dw, cmd.dh);
      if (ink > 0) {
        ctx.globalAlpha = alpha * ink;
        drawGlyph(ctx, cmd.glyph, box);
      }
      ctx.globalAlpha = alpha;
    } else if (cmd.shape === 'circle') {
      ctx.beginPath();
      ctx.ellipse(dx + cmd.dw / 2, dy + cmd.dh / 2,
                  cmd.dw * CIRCLE_SCALE / 2, cmd.dh * CIRCLE_SCALE / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(dx, dy, cmd.dw, cmd.dh);
    }
    strokeBorder(ctx, { ...cmd, ...box });
    if (cmd.wash) washCell(ctx, cmd.wash, box, options.washColor);
    drawOverlays(ctx, cmd, box, options);
    if (cmd.caret) strokeCaret(ctx, box, palette);
  } else if (cmd.kind === 'label') {
    ctx.save();
    ctx.fillStyle = cmd.depth === 0 ? palette.label.fill : palette.sublabel.fill;
    ctx.font = `${cmd.depth === 0 ? 700 : 600} ${cmd.size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(cmd.depth === 0 ? `${cmd.text}  ${cmd.count.toLocaleString()}`
                                 : cmd.text, dx, dy);
    ctx.restore();
  }
}
