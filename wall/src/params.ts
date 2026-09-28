import type { ConfigField } from '@weasel-js/labkit';
import type { Fill } from './layout';
import { cssVarTable, kebabKey, paramKeys, type StateSpec } from './states';

/** The wall's view parameters: every tuning constant that governs layout,
 *  color or feel. Color params are generated per state; these are not. */
export interface FixedParams {
  cell: number;
  gap: number;
  /** 0 means auto: `ceil(sqrt(n))`. */
  cols: number;
  /** The path the sorted cells take: across rows, a spiral out from the
   *  center, or L-shaped shells out from the top-left corner. */
  fill: Fill;

  showBadges: boolean;
  showCaptions: boolean;
  /** Washes the items the spec's `washes` picks out. */
  wash: boolean;

  thickBorderFactor: number;
  thinBorderFactor: number;
  maxBorderPx: number;
  dimAlpha: number;
  washStrength: number;

  dragThresholdPx: number;
  /** Paint cell bodies with weasel's WebGL2 renderer instead of Canvas2D. */
  sceneRenderer: boolean;
  levelUpHysteresis: number;
  levelDownHysteresis: number;
  pollMs: number;
}

export type ParamValue = string | number | boolean;

/** The fixed fields stay a strict interface, so `params.cell` keeps its
 *  `number`; the generated color keys are strings. */
export type Params = FixedParams & Record<string, ParamValue>;

export interface ParamGroup { label: string; fields: ConfigField[] }

export interface ParamSchema {
  defaults: Params;
  groups: ParamGroup[];
  /** Params written as CSS custom properties rather than passed as props. */
  colorKeys: string[];
  /** The unit a numeric row shows after its value. */
  units: Record<string, string>;
  fields: ConfigField[];
  /** What the color rows were generated from, for `paramCssVars`. */
  states: readonly StateSpec[];
}

const CARET = 'caretColor';

const FIXED_DEFAULTS: FixedParams = {
  cell: 32,
  gap: 4,
  cols: 0,
  fill: 'rows',
  showBadges: true,
  showCaptions: true,
  wash: false,
  thickBorderFactor: 0.18,
  thinBorderFactor: 0.09,
  maxBorderPx: 6,
  dimAlpha: 0.25,
  washStrength: 0.75,
  dragThresholdPx: 4,
  sceneRenderer: false,
  levelUpHysteresis: 1.5,
  levelDownHysteresis: 0.67,
  pollMs: 10_000,
};

const UNITS: Record<string, string> = {
  cell: 'px',
  gap: 'px',
  maxBorderPx: 'px',
  dragThresholdPx: 'px',
  pollMs: 'ms',
};

interface ColorRow { key: string; label: string; color: string }

/** Every color of every state, in legend order, fill before border. */
function colorRows(states: readonly StateSpec[]): ColorRow[] {
  const rows = states.flatMap((s) => {
    const param = paramKeys(s);
    const name = kebabKey(s.key);
    const title = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    const out: ColorRow[] = [{ key: param.fill, label: `${title} fill`, color: s.fill }];
    if (param.border !== null && s.border !== null) {
      out.push({ key: param.border, label: `${title} border`, color: s.border });
    }
    return out;
  });
  rows.push({ key: CARET, label: 'Caret color', color: '#ffffff' });
  return rows;
}

export function paramSchema(states: readonly StateSpec[]): ParamSchema {
  const colors = colorRows(states);
  const d = FIXED_DEFAULTS;
  const defaults = {
    cell: d.cell, gap: d.gap, cols: d.cols, fill: d.fill,
    ...Object.fromEntries(colors.map((row) => [row.key, row.color])),
    showBadges: d.showBadges, showCaptions: d.showCaptions, wash: d.wash,
    thickBorderFactor: d.thickBorderFactor, thinBorderFactor: d.thinBorderFactor,
    maxBorderPx: d.maxBorderPx, dimAlpha: d.dimAlpha, washStrength: d.washStrength,
    dragThresholdPx: d.dragThresholdPx, sceneRenderer: d.sceneRenderer,
    levelUpHysteresis: d.levelUpHysteresis, levelDownHysteresis: d.levelDownHysteresis,
    pollMs: d.pollMs,
  } as Params;

  const groups: ParamGroup[] = [
    { label: 'Layout', fields: [
      { key: 'cell', label: 'Cell size', type: 'slider', default: d.cell, min: 8, max: 128, step: 4 },
      { key: 'gap', label: 'Gap', type: 'slider', default: d.gap, min: 0, max: 32, step: 1 },
      { key: 'cols', label: 'Columns (0 = auto)', type: 'number',
        default: d.cols, min: 0, max: 64, step: 1 },
      { key: 'fill', label: 'Fill', type: 'select', default: d.fill, options: [
        { value: 'rows', label: 'Rows' },
        { value: 'spiral', label: 'Spiral from the center' },
        { value: 'corner', label: 'Shells from a corner' },
      ] },
    ] },
    { label: 'Cell', fields: [
      { key: 'showBadges', label: 'Badges', type: 'checkbox', default: d.showBadges },
      { key: 'showCaptions', label: 'Captions', type: 'checkbox', default: d.showCaptions },
      { key: 'wash', label: 'Wash', type: 'checkbox', default: d.wash },
    ] },
    { label: 'Appearance', fields: [
      ...colors.map((row): ConfigField =>
        ({ key: row.key, label: row.label, type: 'color', default: row.color })),
      { key: 'thickBorderFactor', label: 'Thick border factor', type: 'slider',
        default: d.thickBorderFactor, min: 0, max: 0.5, step: 0.01 },
      { key: 'thinBorderFactor', label: 'Thin border factor', type: 'slider',
        default: d.thinBorderFactor, min: 0, max: 0.5, step: 0.01 },
      { key: 'maxBorderPx', label: 'Max border', type: 'slider',
        default: d.maxBorderPx, min: 1, max: 20, step: 1 },
      { key: 'dimAlpha', label: 'Dim alpha', type: 'slider',
        default: d.dimAlpha, min: 0, max: 1, step: 0.05 },
      { key: 'washStrength', label: 'Wash strength', type: 'slider',
        default: d.washStrength, min: 0, max: 1, step: 0.05 },
    ] },
    { label: 'Feel', fields: [
      { key: 'dragThresholdPx', label: 'Drag threshold', type: 'slider',
        default: d.dragThresholdPx, min: 0, max: 20, step: 1 },
      { key: 'sceneRenderer', label: 'WebGL cell bodies', type: 'checkbox',
        default: d.sceneRenderer },
      { key: 'levelUpHysteresis', label: 'Level-up hysteresis', type: 'slider',
        default: d.levelUpHysteresis, min: 1, max: 3, step: 0.05 },
      { key: 'levelDownHysteresis', label: 'Level-down hysteresis', type: 'slider',
        default: d.levelDownHysteresis, min: 0.3, max: 1, step: 0.01 },
      { key: 'pollMs', label: 'Poll interval', type: 'number',
        default: d.pollMs, min: 1000, max: 60_000, step: 1000 },
    ] },
  ];

  return {
    defaults,
    groups,
    colorKeys: colors.map((row) => row.key),
    units: { ...UNITS },
    fields: groups.flatMap((g) => g.fields),
    states,
  };
}

/** The custom property each color param writes, under the host's root. */
export function paramCssVars(states: readonly StateSpec[], root: string): Record<string, string> {
  const vars = cssVarTable(states, root);
  const out: Record<string, string> = {};
  for (const s of states) {
    const param = paramKeys(s);
    const prop = vars[s.key]!;
    out[param.fill] = prop.fill;
    if (param.border !== null && prop.border !== null) out[param.border] = prop.border;
  }
  out[CARET] = `${root}-caret-color`;
  return out;
}
