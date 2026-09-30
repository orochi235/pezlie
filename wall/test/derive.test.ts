import { expect, it } from 'vitest';
import { compile } from '../src/cel';
import {
  captionOf, countStates, countTags, derive, evaluateGrouped, facetOf, glyphOf, markOf, rederive, sortColumn, stateKey,
  tagsOf, tintAt,
} from '../src/derive';
import { storeFromItems } from '../src/store';
import { rng } from './random';
import { SPEC, thing, type Thing } from './fixture';

const compiled = compile(SPEC);
const states = (facts: ReturnType<typeof derive<Thing>>) =>
  Array.from(facts.state, (_, row) => stateKey(facts, row));

it('gives each item the first state that holds, variants included', () => {
  const facts = derive(compiled, [
    thing('a', 0),
    thing('b', 1, { level: 2 }),
    thing('c', 2, { away: ['broken'] }),
    thing('d', 3, { flagged: true, err: 'x' }),
  ]);
  expect(states(facts)).toEqual(['idle', 'warn', 'brokenRemote', 'hidden']);
});

it('derives every column', () => {
  const facts = derive(compiled, [
    thing('a', 0, { level: 2, labels: ['old', 'big'], kind: 'pin', score: 5 }),
    thing('b', 1, { sha: null, score: null, group: 'south' }),
  ]);
  expect(Array.from(facts.filters.drawn!)).toEqual([1, 0]);
  expect(Array.from(facts.classes.archived!)).toEqual([0, 0]);
  const score = sortColumn(facts, 'score');
  expect([0, 1].map((r) => score.values[score.codes[r]!])).toEqual([5, null]);
  expect([tagsOf(facts, 0), tagsOf(facts, 1)]).toEqual([['old', 'big'], []]);
  expect([facetOf(facts, 'group', 0), facetOf(facts, 'group', 1)]).toEqual(['north', 'south']);
  expect(Array.from(facts.washed)).toEqual([1, 0]);
  expect([captionOf(facts, 'span', 0), captionOf(facts, 'span', 1)]).toEqual(['L2', null]);
  expect([captionOf(facts, 'id', 0), captionOf(facts, 'id', 1)]).toEqual(['a', 'b']);
  expect([glyphOf(facts, 0), glyphOf(facts, 1)]).toEqual(['P', null]);
  expect([markOf(facts, 0), markOf(facts, 1)]).toEqual(['pin', null]);
  expect([tintAt(facts, 'score', 0), tintAt(facts, 'score', 1)]).toEqual([0.5, null]);
});

it('refuses an index that repeats', () => {
  expect(() => derive(compiled, [thing('a', 0), thing('b', 0)])).toThrow(/index 0.*a.*b/);
});

it('refuses an index outside the corpus', () => {
  expect(() => derive(compiled, [thing('a', 0), thing('b', 2)])).toThrow(/index 2/);
});

it('sees an item that changed in place when its row is re-derived', () => {
  const items = [thing('a', 0), thing('b', 1)];
  const facts = derive(compiled, items);
  items[1]!.err = 'x';
  rederive(compiled, facts, items, [1]);
  expect(states(facts)).toEqual(['idle', 'broken']);
});

it('rewrites only the rows it is given, and forgets what it worked out lazily', () => {
  const items = [thing('a', 0), thing('b', 1)];
  const facts = derive(compiled, items);
  expect(tintAt(facts, 'score', 1)).toBe(0.5);
  const next = [thing('a', 0, { level: 1 }), thing('b', 1, { err: 'x', score: 9, labels: ['z'] })];
  rederive(compiled, facts, next, [1]);
  expect(states(facts)).toEqual(['idle', 'broken']);
  expect(tagsOf(facts, 1)).toEqual(['z']);
  expect(tintAt(facts, 'score', 1)).toBeCloseTo(0.9);
  expect(facts.store.get(1)).toBe(next[1]);
});

it('calls a rule once per distinct value of the fields it reads', () => {
  const items = Array.from({ length: 50 }, (_, i) => thing(`t${i}`, i, { level: i % 3 }));
  const seen: unknown[] = [];
  const rule = (item: Thing) => { seen.push(item); return item.level; };
  const { codes, results } = evaluateGrouped(storeFromItems(items), ['level'], rule);
  expect(seen).toEqual([{ level: 0 }, { level: 1 }, { level: 2 }]);
  expect(Array.from(codes, (c) => results[c])).toEqual(items.map((t) => t.level));
});

it('keeps a field an item lacks apart from one that is null', () => {
  const items = [thing('a', 0), thing('b', 1, { archived: true }), thing('c', 2)];
  const { codes, results } = evaluateGrouped(storeFromItems(items), ['archived'],
                                             (item: Thing) => ('archived' in item ? 'has' : 'lacks'));
  expect(Array.from(codes, (c) => results[c])).toEqual(['lacks', 'has', 'lacks']);
});

it('agrees with evaluating every item whole, on random corpora', () => {
  const r = rng(11);
  const pick = <V>(xs: readonly V[]) => xs[Math.floor(r() * xs.length)]!;
  const items = Array.from({ length: 400 }, (_, i) => thing(`t${i}`, i, {
    level: pick([-1, 0, 0, 1, 2]), err: pick([null, null, 'x']), flagged: r() < 0.1,
    away: pick([[], [], ['broken'], ['warn', 'broken']]), kind: pick([null, 'pin', 'bolt']),
    labels: pick([[], ['old'], ['big', 'calm'], ['small', 'loud']]),
    score: pick([null, 1, 5, 9]), group: pick(['north', 'south']),
    ...(r() < 0.2 ? { archived: r() < 0.5 } : {}),
  }));
  const facts = derive(compiled, items);
  items.forEach((item, row) => {
    const want = compiled.byPrecedence.find((s) => s.match(item))!.key;
    expect(stateKey(facts, row)).toBe(want);
    for (const [key, keep] of Object.entries(compiled.filters)) {
      expect(facts.filters[key]![row]).toBe(keep(item) ? 1 : 0);
    }
    for (const [key, member] of Object.entries(compiled.classes)) {
      expect(facts.classes[key]![row]).toBe(member(item) ? 1 : 0);
    }
    expect(tagsOf(facts, row)).toEqual(compiled.tags!(item));
    expect(facts.washed[row]).toBe(compiled.washes!(item) ? 1 : 0);
    expect(facetOf(facts, 'group', row)).toBe(compiled.facets.group!(item));
    for (const key of Object.keys(compiled.sorts)) {
      const column = sortColumn(facts, key);
      expect(column.values[column.codes[row]!]).toEqual(compiled.sorts[key]!(item));
    }
  });
});

it('works a filter out when first read, from the store the latest delta left', () => {
  const plain = [thing('a', 0), thing('b', 1, { err: 'x' })];
  const broke = [thing('a', 0, { err: 'x' }), thing('b', 1, { err: 'x' })];
  const mended = [thing('a', 0, { err: 'x' }), thing('b', 1)];
  const bits = (facts: ReturnType<typeof derive<Thing>>) => Array.from(facts.filters.broken!);

  expect(bits(derive(compiled, plain))).toEqual([0, 1]);

  const readFirst = derive(compiled, plain);
  expect(bits(readFirst)).toEqual([0, 1]);
  rederive(compiled, readFirst, broke, [0]);
  expect(bits(readFirst)).toEqual([1, 1]);

  const readAfter = derive(compiled, plain);
  rederive(compiled, readAfter, broke, [0]);
  expect(bits(readAfter)).toEqual([1, 1]);

  // A delta hands on a copy of the facts, and the next delta goes to the copy.
  const first = derive(compiled, plain);
  rederive(compiled, first, broke, [0]);
  const copy = { ...first };
  rederive(compiled, copy, mended, [1]);
  expect(bits(copy)).toEqual([1, 0]);
});

it('counts the given rows per state and per tag', () => {
  const items = [thing('a', 0), thing('b', 1, { err: 'x', labels: ['big'] }), thing('c', 2, { labels: ['big', 'old'] }),
                 thing('d', 3, { err: 'x' })];
  const facts = derive(compiled, items);
  const byKey = (counts: Uint32Array) =>
    Object.fromEntries(compiled.states.map((s, i) => [s.key, counts[i]]).filter(([, n]) => n));
  expect(byKey(countStates(facts, [0, 1, 2, 3]))).toEqual({ idle: 2, broken: 2 });
  expect(byKey(countStates(facts, Uint32Array.of(1)))).toEqual({ broken: 1 });
  expect(Object.fromEntries(countTags(facts, [0, 1, 2, 3]))).toEqual({ big: 2, old: 1 });
  expect(Object.fromEntries(countTags(facts, [2]))).toEqual({ big: 1, old: 1 });
});
