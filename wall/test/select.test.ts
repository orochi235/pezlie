import { expect, it } from 'vitest';
import { compile } from '../src/cel';
import { derive } from '../src/derive';
import { naturalCompare } from '../src/natural';
import { applySelection, byAxis, primeSort, sortOrder, type Selection } from '../src/select';
import { rng } from './random';
import { SPEC, thing, type Thing } from './fixture';

const compiled = compile(SPEC);
const ALL: Selection = { sort: 'id', filter: 'all', shown: { hidden: true, archived: true } };

function ids(items: Thing[], selection: Selection): string[] {
  const facts = derive(compiled, items);
  return Array.from(applySelection(compiled, facts, selection), (row) => items[row]!.id);
}

it('keeps what the filter keeps', () => {
  const items = [thing('a', 0), thing('b', 1, { err: 'x' })];
  expect(ids(items, { ...ALL, filter: 'broken' })).toEqual(['b']);
});

it('drops a hidden class', () => {
  const items = [thing('a', 0), thing('b', 1, { flagged: true })];
  expect(ids(items, { ...ALL, shown: { hidden: false, archived: true } })).toEqual(['a']);
});

it('takes the spec default for a class the selection does not mention', () => {
  const items = [thing('a', 0), thing('b', 1, { archived: true })];
  expect(ids(items, { ...ALL, shown: {} })).toEqual(['a']);
});

it('drops an excluded facet value', () => {
  const items = [thing('a', 0), thing('b', 1, { group: 'south' })];
  expect(ids(items, { ...ALL, exclude: { group: ['north'] } })).toEqual(['b']);
});

it('reads picked tags as alternatives within an axis and narrowing across', () => {
  const items = [
    thing('a', 0, { labels: ['big', 'calm'] }),
    thing('b', 1, { labels: ['small', 'calm'] }),
    thing('c', 2, { labels: ['big', 'loud'] }),
    thing('d', 3, { labels: ['calm'] }),
  ];
  expect(ids(items, { ...ALL, tags: ['big', 'small'] })).toEqual(['a', 'b', 'c']);
  expect(ids(items, { ...ALL, tags: ['big', 'small', 'calm'] })).toEqual(['a', 'b']);
});

it('gives a tag no axis claims an axis of its own', () => {
  expect(byAxis(SPEC.tagAxes!, ['loud', 'odd', 'big'])).toEqual([['big'], ['loud'], ['odd']]);
});

it('sorts nulls last in both directions', () => {
  const items = [thing('a', 0, { score: null }), thing('b', 1, { score: 1 }),
                 thing('c', 2, { score: 9 })];
  expect(ids(items, { ...ALL, sort: 'score' })).toEqual(['c', 'b', 'a']);
  expect(ids(items, { ...ALL, sort: 'kind' })).toEqual(['a', 'b', 'c']);
});

it('breaks a tie by index order, and compares strings naturally', () => {
  const tied = [thing('x10', 2), thing('x9', 0), thing('x9b', 1)];
  expect(ids(tied, { ...ALL, sort: 'score' })).toEqual(['x9', 'x9b', 'x10']);
  const kinds = [thing('a', 0, { kind: 'k10' }), thing('b', 1, { kind: 'k2' })];
  expect(ids(kinds, { ...ALL, sort: 'kind' })).toEqual(['b', 'a']);
});

it('orders as a comparator over every item would, on random corpora', () => {
  const r = rng(5);
  const pick = <V>(xs: readonly V[]) => xs[Math.floor(r() * xs.length)]!;
  const items = Array.from({ length: 300 }, (_, i) => thing(`t${i}`, i, {
    score: pick([null, 1, 2, 2, 7]), kind: pick([null, 'k2', 'k10', 'a']), err: pick([null, 'x']),
  }));
  const facts = derive(compiled, items);
  for (const def of SPEC.sorts) {
    const rule = compiled.sorts[def.key]!;
    const dir = def.desc ? -1 : 1;
    const want = items.map((_, row) => row).sort((a, b) => {
      const ka = rule(items[a]!);
      const kb = rule(items[b]!);
      if (ka === null) return kb === null ? a - b : 1;
      if (kb === null) return -1;
      if (ka === kb) return items[a]!.index - items[b]!.index;
      if (typeof ka === 'string' && typeof kb === 'string') return naturalCompare(ka, kb) * dir;
      return ((ka as number) < (kb as number) ? -1 : 1) * dir;
    });
    expect(Array.from(sortOrder(facts, def.key)), def.key).toEqual(want);
  }
});

it('orders a rising column without sorting, in both directions', () => {
  const items = [thing('a', 0, { score: 1 }), thing('b', 1, { score: 4 }), thing('c', 2, { score: 9 })];
  const facts = derive(compiled, items);
  expect(Array.from(sortOrder(facts, 'score'))).toEqual([2, 1, 0]);
  const asc = derive(compile({ ...SPEC, sorts: [{ key: 'score', label: 's', value: 'item.score', desc: false }] }), items);
  expect(Array.from(sortOrder(asc, 'score'))).toEqual([0, 1, 2]);
});

it('sorts once per sort, whatever else the selection changes', () => {
  const items = Array.from({ length: 20 }, (_, i) => thing(`t${i}`, i, { score: i % 4 }));
  const facts = derive(compiled, items);
  const first = sortOrder(facts, 'score');
  applySelection(compiled, facts, { ...ALL, sort: 'score', filter: 'broken' });
  applySelection(compiled, facts, { ...ALL, sort: 'score', exclude: { group: ['north'] } });
  expect(sortOrder(facts, 'score')).toBe(first);
});

it('works a sort out a step at a time to the order sortOrder gives, and a click finishes it', () => {
  const items = Array.from({ length: 300 }, (_, i) => thing(`n${(i * 7919) % 300}`, i));
  const whole = sortOrder(derive(compiled, items), 'id');
  const facts = derive(compiled, items);
  let steps = 0;
  while (primeSort(facts, 'id', () => true) === null) steps++;
  expect(steps).toBeGreaterThan(2);
  expect(Array.from(primeSort(facts, 'id', () => true)!)).toEqual(Array.from(whole));

  const clicked = derive(compiled, items);
  expect(primeSort(clicked, 'id', () => true)).toBeNull();
  const pending = clicked.cache.pending.get('id');
  expect(Array.from(sortOrder(clicked, 'id'))).toEqual(Array.from(whole));
  expect(clicked.cache.pending.size).toBe(0);
  expect(pending!.next().done).toBe(true);
});

it('drops an order begun before the cache was replaced', () => {
  const items = [thing('b', 0), thing('a', 1)];
  const facts = derive(compiled, items);
  expect(primeSort(facts, 'id', () => true)).toBeNull();
  const fresh = derive(compiled, items).cache;
  facts.cache = fresh;
  expect(fresh.pending.size).toBe(0);
  expect(Array.from(sortOrder(facts, 'id'))).toEqual([1, 0]);
});

it('orders a rising number column with gaps as it stands, gaps last, either way', () => {
  const items = [thing('a', 0, { score: 1 }), thing('b', 1, { score: null }), thing('c', 2, { score: 3 }),
                 thing('d', 3, { score: 7 })];
  // `score` sorts descending.
  expect(ids(items, { ...ALL, sort: 'score' })).toEqual(['d', 'c', 'a', 'b']);
  const falling = [thing('a', 0, { score: 7 }), thing('b', 1, { score: null }), thing('c', 2, { score: 3 })];
  expect(ids(falling, { ...ALL, sort: 'score' })).toEqual(['a', 'c', 'b']);
});
