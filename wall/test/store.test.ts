import { describe, expect, it } from 'vitest';
import { tableFromArrays, tableFromIPC, tableToIPC, vectorFromArray, Dictionary, Int32, Utf8,
         makeTable } from 'apache-arrow';
import { ABSENT, storeFromArrow, storeFromItems, type ItemStore } from '../src/store';
import type { Item } from '../src/schema';

interface Thing extends Item { kind: string; n: number | null; tags: string[]; extra?: boolean }

const items: Thing[] = [
  { id: 'a', index: 0, sha: 'x', kind: 'p', n: 1, tags: ['t'] },
  { id: 'b', index: 1, sha: null, kind: 'q', n: null, tags: [] },
  { id: 'c', index: 2, sha: null, kind: 'p', n: 1, tags: ['t'], extra: true },
];

const valuesOf = <T extends Item>(store: ItemStore<T>, field: string) => {
  const { codes, values } = store.column(field);
  return Array.from(codes, (c) => (c === ABSENT ? 'ABSENT' : values[c]));
};

describe('storeFromItems', () => {
  const store = storeFromItems(items);

  it('codes equal values alike, lists by contents', () => {
    expect(store.column('kind').codes).toEqual(new Int32Array([0, 1, 0]));
    expect(store.column('tags').codes[0]).toBe(store.column('tags').codes[2]);
    expect(valuesOf(store, 'n')).toEqual([1, null, 1]);
  });

  it('never codes a string like the list it spells, and codes maps by contents', () => {
    interface Odd extends Item { v: unknown }
    const odd = storeFromItems<Odd>([
      { id: 'a', index: 0, sha: null, v: ['t'] },
      { id: 'b', index: 1, sha: null, v: '\0["t"]' },
      { id: 'c', index: 2, sha: null, v: { x: 1, y: 2 } },
      { id: 'd', index: 3, sha: null, v: { y: 2, x: 1 } },
    ]);
    const { codes } = odd.column('v');
    expect(codes[0]).not.toBe(codes[1]);
    expect(codes[2]).toBe(codes[3]);
    expect(valuesOf(odd, 'v')).toEqual([['t'], '\0["t"]', { x: 1, y: 2 }, { x: 1, y: 2 }]);
  });

  it('keeps absent apart from null', () => {
    expect(valuesOf(store, 'extra')).toEqual(['ABSENT', 'ABSENT', true]);
    expect(valuesOf(store, 'nothing')).toEqual(['ABSENT', 'ABSENT', 'ABSENT']);
  });

  it('patches by index and leaves the receiver alone', () => {
    const { store: next, changed } = store.patch([{ ...items[1]!, kind: 'r', sha: 'y' }]);
    expect(changed).toEqual([1]);
    expect(valuesOf(next, 'kind')).toEqual(['p', 'r', 'p']);
    expect(next.sha(1)).toBe('y');
    expect(valuesOf(store, 'kind')).toEqual(['p', 'q', 'p']);
    const again = next.patch([{ ...items[0]!, kind: 'q' }]).store;
    expect(valuesOf(again, 'kind')).toEqual(['q', 'r', 'p']);
  });

  it('finds a row by index when rows are not in index order', () => {
    const shuffled = storeFromItems([items[2]!, items[0]!, items[1]!]);
    const { store: next, changed } = shuffled.patch([{ ...items[0]!, kind: 'z' }]);
    expect(changed).toEqual([1]);
    expect(next.get(1).kind).toBe('z');
  });
});

describe('storeFromArrow', () => {
  const kind = vectorFromArray(['p', 'q', 'p'], new Dictionary(new Utf8(), new Int32()));
  const table = tableFromIPC(tableToIPC(makeTable({
    id: vectorFromArray(['a', 'b', 'c'], new Utf8()).data[0]!,
    index: vectorFromArray([0, 1, 2], new Int32()).data[0]!,
    sha: vectorFromArray(['x', null, null], new Utf8()).data[0]!,
    kind: kind.data[0]!,
  } as never) as never));
  const store = storeFromArrow<Thing>(table as never);

  it('reads rows and dictionary codes', () => {
    expect(store.length).toBe(3);
    expect([store.id(1), store.sha(0), store.sha(1), store.index(2)]).toEqual(['b', 'x', null, 2]);
    expect(valuesOf(store, 'kind')).toEqual(['p', 'q', 'p']);
    expect(store.get(2)).toEqual({ id: 'c', index: 2, sha: null, kind: 'p' });
  });

  it('agrees with the same items as objects', () => {
    const objects = storeFromItems(items.map(({ id, index, sha, kind: k }) => ({ id, index, sha, kind: k })));
    for (const field of ['id', 'index', 'sha', 'kind', 'missing']) {
      expect(valuesOf(store, field)).toEqual(valuesOf(objects, field));
    }
  });

  it('reads nulls and numbers from plain columns', () => {
    const t = tableFromArrays({ id: ['a', 'b'], index: Int32Array.from([0, 1]),
                                sha: ['s', 't'], n: Float64Array.from([2.5, 2.5]) });
    const s = storeFromArrow(t as never);
    expect(valuesOf(s, 'n')).toEqual([2.5, 2.5]);
    expect(s.column('n').codes).toEqual(new Int32Array([0, 0]));
  });

  it('codes a rising numeric column one row to a code, and a repeating one by value', () => {
    const t = tableFromArrays({ id: ['a', 'b', 'c'], index: Int32Array.from([0, 1, 2]), sha: ['s', 't', 'u'],
                                cp: Int32Array.from([5, 9, 40]), plane: Int8Array.from([0, 0, 1]) });
    const s = storeFromArrow(t as never);
    expect(s.column('cp')).toEqual({ codes: new Int32Array([0, 1, 2]), values: [5, 9, 40] });
    expect(s.column('plane')).toEqual({ codes: new Int32Array([0, 0, 1]), values: [0, 1] });
  });

  it('refuses a feed out of index order', () => {
    const t = tableFromArrays({ id: ['a', 'b'], index: Int32Array.from([1, 0]), sha: ['s', 't'] });
    expect(() => storeFromArrow(t as never)).toThrow(/index order/);
  });
});

describe('storeFromArrow over several batches', () => {
  it('reads dictionary columns whose batches carry different dictionaries', async () => {
    const part = (ids: string[], first: number, kinds: string[]) => tableFromIPC(tableToIPC(makeTable({
      id: vectorFromArray(ids, new Utf8()).data[0]!,
      index: vectorFromArray(ids.map((_, i) => first + i), new Int32()).data[0]!,
      sha: vectorFromArray(ids.map(() => null), new Utf8()).data[0]!,
      kind: vectorFromArray(kinds, new Dictionary(new Utf8(), new Int32())).data[0]!,
    } as never) as never));
    const store = storeFromArrow([part(['a', 'b'], 0, ['p', 'q']), part(['c'], 2, ['r'])] as never);
    expect(store.length).toBe(3);
    expect(valuesOf(store, 'kind')).toEqual(['p', 'q', 'r']);
    expect([store.id(2), store.index(2), store.id(1)]).toEqual(['c', 2, 'b']);
    expect(store.get(2)).toEqual({ id: 'c', index: 2, sha: null, kind: 'r' });
    expect(store.column('index')).toEqual({ codes: new Int32Array([0, 1, 2]), values: [0, 1, 2] });
  });
});
