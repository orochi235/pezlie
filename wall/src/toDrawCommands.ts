/** `PaintCommand[]` as weasel `DrawCommand[]`, for the scene executor.
 *
 *  Mirrors `draw2d.ts` command for command; where it cannot, `unsupported`
 *  names the feature, so a renderer is never reported quick for drawing less.
 */
import { ellipsePath, rectPath, type DrawCommand } from '@weasel-js/core';
import { CIRCLE_SCALE, DEFAULT_WASH } from './draw2d';
import { glyphBlend, type PaintCommand } from './paint';

/** Named once so the hybrid executor's residue can be checked against it at
 *  compile time: a name added here and nowhere else is a cell nothing paints. */
export const UNSUPPORTED = {
  badges: 'badges',
  strip: 'badge strip',
  captions: 'captions',
  caret: 'caret',
  mark: 'mark',
  glyph: 'glyph',
  slash: 'slash',
  image: 'loose/vector image rung',
  label: 'band label',
} as const;

export interface Mapped {
  commands: DrawCommand[];
  /** A non-empty set makes the rung incomparable, never merely approximate. */
  unsupported: Set<string>;
}

function fillRect(x: number, y: number, w: number, h: number,
                  color: string, opacity?: number): DrawCommand {
  return { kind: 'path', path: rectPath(x, y, w, h), fill: { paint: { color, opacity } } };
}

/** Inset by half the width, the same correction `strokeBorder` makes. */
function strokeRect(x: number, y: number, w: number, h: number,
                    color: string, width: number): DrawCommand {
  const i = width / 2;
  return {
    kind: 'path',
    path: rectPath(x + i, y + i, w - width, h - width),
    stroke: { paint: { color }, width },
  };
}

export type Sampling = 'nearest' | 'linear';

export function toDrawCommands(cmds: readonly PaintCommand[],
                               sheet: ImageBitmap | null,
                               sampling: Sampling = 'nearest',
                               washColor: string = DEFAULT_WASH): Mapped {
  const out: DrawCommand[] = [];
  const unsupported = new Set<string>();

  const overlays = (cmd: { badges?: readonly unknown[]; strip?: readonly unknown[];
                           captions?: readonly unknown[] }) => {
    if (cmd.badges?.length) unsupported.add(UNSUPPORTED.badges);
    if (cmd.strip?.length) unsupported.add(UNSUPPORTED.strip);
    if (cmd.captions?.length) unsupported.add(UNSUPPORTED.captions);
  };

  for (const cmd of cmds) {
    if (cmd.kind === 'sprite') {
      if (!sheet) continue;
      const alpha = cmd.alpha ?? 1;
      const body: DrawCommand[] = [
        fillRect(cmd.dx, cmd.dy, cmd.dw, cmd.dh, cmd.ground),
        { kind: 'image', image: sheet, x: cmd.dx, y: cmd.dy, width: cmd.dw, height: cmd.dh,
          source: { x: cmd.sx, y: cmd.sy, width: cmd.sw, height: cmd.sh },
          // Linear reaches half a texel past `source` and bleeds the
          // neighboring tile into the cell edge; nearest costs on a minified atlas.
          sampling },
      ];
      if (cmd.wash) {
        body.push(fillRect(cmd.dx, cmd.dy, cmd.dw, cmd.dh, washColor, cmd.wash));
      }
      // A group per cell is a state change per cell, the cost this renderer
      // exists to avoid, so only a dimmed cell gets one.
      if (alpha === 1) out.push(...body);
      else out.push({ kind: 'group', alpha, children: body });
      overlays(cmd);
      if (cmd.caret) unsupported.add(UNSUPPORTED.caret);
    } else if (cmd.kind === 'image') {
      unsupported.add(UNSUPPORTED.image);
      overlays(cmd);
    } else if (cmd.kind === 'fill') {
      if (cmd.mark) {
        unsupported.add(UNSUPPORTED.mark);
      } else if (cmd.glyph) {
        out.push(fillRect(cmd.dx, cmd.dy, cmd.dw, cmd.dh, cmd.fill,
                          glyphBlend(cmd.dw, cmd.cover).ground));
        unsupported.add(UNSUPPORTED.glyph);
      } else if (cmd.shape === 'circle') {
        const iw = cmd.dw * CIRCLE_SCALE;
        const ih = cmd.dh * CIRCLE_SCALE;
        out.push({
          kind: 'path',
          path: ellipsePath({ x: cmd.dx + (cmd.dw - iw) / 2, y: cmd.dy + (cmd.dh - ih) / 2,
                              width: iw, height: ih }),
          fill: { paint: { color: cmd.fill } },
        });
      } else {
        out.push(fillRect(cmd.dx, cmd.dy, cmd.dw, cmd.dh, cmd.fill));
      }
      if (cmd.border && cmd.borderWidth > 0) {
        out.push(strokeRect(cmd.dx, cmd.dy, cmd.dw, cmd.dh, cmd.border, cmd.borderWidth));
        if (cmd.slash) unsupported.add(UNSUPPORTED.slash);
      }
      overlays(cmd);
      if (cmd.caret) unsupported.add(UNSUPPORTED.caret);
    } else if (cmd.kind === 'label') {
      // Weasel sets text from an MSDF atlas and canvas2d through the platform
      // rasterizer; they disagree on glyphs and advances, so labels stay 2D.
      unsupported.add(UNSUPPORTED.label);
    }
  }

  return { commands: out, unsupported };
}
