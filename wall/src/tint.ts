import { stateKey, tintAt, type Facts } from './derive';
import type { CellStyle, Palette } from './palette';
import type { Item } from './schema';

/** Quantized, so two items a little apart share a swatch and a band of the
 *  ramp reads as a band rather than as noise. */
export const STEPS = 8;

/** Sequential ramps only: these encode magnitude, and a diverging or rainbow
 *  scale invents a midpoint the data has no opinion about. */
export const RAMPS = {
  ember: ['#3a3a3f', '#e8c478'],
  ice: ['#12233a', '#a9e2f3'],
  moss: ['#16281c', '#b7e07a'],
  viridis: ['#440154', '#472d7b', '#3b528b', '#2c728e',
            '#21918c', '#28ae80', '#5ec962', '#addc30'],
  magma: ['#000004', '#1c1044', '#4f127b', '#812581',
          '#b5367a', '#e55964', '#fb8761', '#fec287'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d',
            '#a52c60', '#cf4446', '#ed6925', '#fcffa4'],
  ironbow: ['#00000a', '#1a0a52', '#4a0a7a', '#8a1a6a',
            '#c43e2f', '#e8721a', '#f9b70a', '#ffffe0'],
  whitehot: ['#000000', '#ffffff'],
} as const;

export type RampName = keyof typeof RAMPS;
export const RAMP_NAMES = Object.keys(RAMPS) as RampName[];

/** The tint that colors by state rather than by a measure. */
export const STATUS = 'status';

function hex(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)!;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** Each ramp's STEPS swatches, worked out the first time the ramp is asked for. */
const swatches = new Map<RampName, { css: string[]; styles: CellStyle[] }>();

function swatchesOf(name: RampName) {
  let held = swatches.get(name);
  if (!held) {
    const stops = RAMPS[name].map(hex);
    const css = Array.from({ length: STEPS }, (_, s) => {
      const at = (s / (STEPS - 1)) * (stops.length - 1);
      const low = Math.floor(at);
      const high = Math.min(low + 1, stops.length - 1);
      const f = at - low;
      return `rgb(${stops[low]!.map((v, i) => Math.round(v + (stops[high]![i]! - v) * f)).join(',')})`;
    });
    held = { css, styles: css.map((fill) => ({ fill, border: null, weight: null })) };
    swatches.set(name, held);
  }
  return held;
}

const stepOf = (t: number) => Math.round(Math.max(0, Math.min(1, t)) * (STEPS - 1));

/** A ramp sampled at `t`, quantized to `STEPS` swatches, interpolating between
 *  the two stops the step falls between. */
export function ramp(t: number, name: RampName = 'ember'): string {
  return swatchesOf(name).css[stepOf(t)]!;
}

/** A row's style under a tint: its state's under `status`, a ramp swatch under
 *  a measure, and `unmatched` where the measure has no value. The swatch styles
 *  are shared, so callers must not change them. */
export function tintFor<T extends Item>(facts: Facts<T>, row: number, mode: string,
                                        palette: Palette,
                                        gradient: RampName = 'ember'): CellStyle {
  if (mode === STATUS) return palette.states[stateKey(facts, row)]!;
  const t = tintAt(facts, mode, row);
  if (t === null) return palette.unmatched;
  return swatchesOf(gradient).styles[stepOf(t)]!;
}
