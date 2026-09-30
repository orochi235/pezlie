import { useMemo, type CSSProperties } from 'react';
import { FloatingPanel } from '@weasel-js/labkit';
import { BadgeSwatch } from './BadgeSwatch';
import type { CompiledSpec } from './cel';
import { countStates, countTags, type Facts } from './derive';
import type { Badge, Item } from './schema';
import { conditionKeys, cssVarTable, familyTable } from './states';
import { TintScale } from './TintScale';
import { STATUS, type RampName } from './tint';
import './Legend.css';

export interface LegendProps<T extends Item = Item> {
  compiled: CompiledSpec<T>;
  facts: Facts<T>;
  /** The wall in view order: what the state rows count. */
  rows: ArrayLike<number> & Iterable<number>;
  /** What the tag rows count: the wall narrowed by everything but the tag
   *  picks, so picking one tag does not read every other as 0. */
  tagRows?: ArrayLike<number> & Iterable<number>;
  highlight: string | null;
  onHighlight: (state: string | null) => void;
  /** Picked tags: alternatives within an axis, narrowing across axes. An
   *  updater, so two clicks read from one render both land. */
  tags: string[];
  onTags: (update: (prev: string[]) => string[]) => void;
  highlightTag: string | null;
  onHighlightTag: (tag: string | null) => void;
  /** Dismissal is the owner's, so there is a way back. */
  onClose: () => void;
  /** A measured tint puts its scale where the state rows are. */
  tint?: string;
  gradient?: RampName;
  /** The custom property root the palette reads. */
  root?: string;
  storageKey?: string;
}

/** The wall's conditions with a swatch, a name and a count, then its tags.
 *  Hovering or focusing a row raises a highlight; the wall dims the rest. */
export function Legend<T extends Item>({
  compiled, facts, rows, tagRows, highlight, onHighlight, tags, onTags,
  highlightTag, onHighlightTag, onClose, tint = STATUS, gradient = 'ember',
  root = '--wall', storageKey = 'wall-legend',
}: LegendProps<T>) {
  const { spec, states } = compiled;
  const keys = useMemo(() => conditionKeys(states), [states]);
  const byKey = useMemo(() => new Map(states.map((s) => [s.key, s])), [states]);
  const vars = useMemo(() => cssVarTable(states, root), [states, root]);
  const axes = spec.tagAxes ?? [];
  const art = useMemo(() => new Map((spec.badges ?? []).map(
    (b): [string, Badge] => [b.tag, { tag: b.tag, ...b.art }])), [spec.badges]);
  const measured = tint === STATUS ? undefined : spec.tints?.find((t) => t.key === tint);

  // A row stands for its variants too, so the rows still add up to the wall.
  const counts = useMemo(() => {
    const family = familyTable(states);
    const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    countStates(facts, rows).forEach((count, code) => {
      const f = family[facts.compiled.states[code]!.key];
      if (f !== undefined) out[f] = (out[f] ?? 0) + count;
    });
    return out;
  }, [states, keys, facts, rows]);

  const forTags = tagRows ?? rows;
  const tagCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const axis of spec.tagAxes ?? []) for (const tag of axis.tags) out[tag] = 0;
    for (const [tag, count] of countTags(facts, forTags)) if (tag in out) out[tag] = count;
    return out;
  }, [spec.tagAxes, facts, forTags]);

  const toggle = (tag: string) => {
    onTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  return (
    <FloatingPanel anchor="top-right" persist={storageKey} className="wall-legend">
      <div className="wall-legend-head">
        <strong>Legend</strong>
        <button type="button" aria-label="Close legend" onClick={onClose}>x</button>
      </div>
      {measured ? (
        <TintScale tint={measured} gradient={gradient} />
      ) : (
        <ul className="wall-legend-list">
          {keys.map((key) => {
            const state = byKey.get(key)!;
            const prop = vars[key]!;
            const n = counts[key] ?? 0;
            // `var(...)` rather than a literal, so live param tuning reaches the swatch.
            const swatch = {
              '--swatch-fill': `var(${prop.fill})`,
              '--swatch-line': prop.border === null ? 'transparent' : `var(${prop.border})`,
            } as CSSProperties;
            return (
              <li key={key} className="wall-legend-item">
                <div className="wall-legend-row" data-state={key}
                     data-struck={state.border !== null} data-shape={state.shape}
                     data-weight={state.weight ?? 'none'} style={swatch}
                     data-highlighted={highlight === key} tabIndex={0}
                     aria-label={`${state.label}, ${n.toLocaleString()} items`}
                     onMouseEnter={() => onHighlight(key)}
                     onMouseLeave={() => onHighlight(null)}
                     onFocus={() => onHighlight(key)}
                     onBlur={() => onHighlight(null)}>
                  <span className="wall-legend-swatch" aria-hidden="true" />
                  <span className="wall-legend-name">{state.label}</span>
                  <span className="wall-legend-count">{n.toLocaleString()}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {axes.length > 0 && (
        <div className="wall-legend-head wall-legend-subhead">
          <strong>Tags</strong>
          {tags.length > 0 && (
            <button type="button" onClick={() => onTags(() => [])}>clear</button>
          )}
        </div>
      )}
      {axes.map((axis) => (
        <section key={axis.key} className="wall-legend-axis" aria-label={axis.label}>
          <ul className="wall-legend-list">
            {axis.tags.map((tag) => {
              const badge = art.get(tag);
              const n = tagCounts[tag] ?? 0;
              return (
                <li key={tag} className="wall-legend-item">
                  <button type="button" className="wall-legend-row wall-legend-badge-row"
                          aria-pressed={tags.includes(tag)}
                          data-picked={tags.includes(tag)}
                          data-highlighted={highlightTag === tag}
                          aria-label={`${tag}, ${n.toLocaleString()} items`}
                          onClick={() => toggle(tag)}
                          onMouseEnter={() => onHighlightTag(tag)}
                          onMouseLeave={() => onHighlightTag(null)}
                          onFocus={() => onHighlightTag(tag)}
                          onBlur={() => onHighlightTag(null)}>
                    {badge
                      ? <BadgeSwatch badge={badge} marks={spec.marks ?? {}}
                                     className="wall-legend-badge" />
                      : <span className="wall-legend-swatch" aria-hidden="true" />}
                    <span className="wall-legend-name">{tag}</span>
                    <span className="wall-legend-count">{n.toLocaleString()}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </FloatingPanel>
  );
}
