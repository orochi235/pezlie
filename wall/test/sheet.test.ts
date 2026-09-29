import { describe, expect, it } from 'vitest';
import { compile } from '../src/cel';
import { derive } from '../src/derive';
import { bakedAt, isStale, sameLayout, sourceBox, staleCount, type SheetManifest } from '../src/sheet';
import { SPEC, thing } from './fixture';

const manifest: SheetManifest = {
  level: 32, gutter: 2, pitch: 36, cols: 2, rows: 2, count: 4, size: 72,
  baked: { a: 'sha-a', b: 'sha-b' },
};

it('finds a cell row-major inside its gutter', () => {
  expect(sourceBox(manifest, 0)).toEqual({ sx: 2, sy: 2, sw: 32, sh: 32 });
  expect(sourceBox(manifest, 1)).toEqual({ sx: 38, sy: 2, sw: 32, sh: 32 });
  expect(sourceBox(manifest, 2)).toEqual({ sx: 2, sy: 38, sw: 32, sh: 32 });
});

it('has no box for an index outside the sheet', () => {
  expect(sourceBox(manifest, 4)).toBeNull();
  expect(sourceBox(manifest, -1)).toBeNull();
});

it('calls an item stale when the store has moved past the bake', () => {
  expect(isStale(manifest, { id: 'a', sha: 'sha-a' })).toBe(false);
  expect(isStale(manifest, { id: 'a', sha: 'sha-new' })).toBe(true);
  expect(isStale(manifest, { id: 'c', sha: 'sha-c' })).toBe(true);
});

it('counts a tile missing only for an item that has a picture to bake', () => {
  const items = [
    { id: 'a', sha: 'sha-a' },
    { id: 'b', sha: 'sha-newer' },
    { id: 'c', sha: 'sha-c' },
    { id: 'd', sha: null },
  ];
  expect(staleCount(manifest, items)).toEqual({ stale: 1, missing: 1, total: 4 });
});

it('does not call an item with no picture stale', () => {
  expect(isStale(manifest, { id: 'c', sha: null })).toBe(false);
});

describe('sameLayout', () => {
  const m = { level: 32, gutter: 2, pitch: 36, cols: 10, rows: 10, count: 100, size: 360, baked: {} };
  it('holds for two sheets of one geometry whatever they baked', () => {
    expect(sameLayout(m, { ...m, baked: { a: 'x' }, version: 'v2' })).toBe(true);
  });
  it('fails when a cell would land elsewhere', () => {
    expect(sameLayout(m, { ...m, count: 101 })).toBe(false);
    expect(sameLayout(m, { ...m, cols: 9 })).toBe(false);
  });
});

describe('bakedAt', () => {
  it('answers per manifest, so a new sheet is read afresh', () => {
    const facts = derive(compile(SPEC), [thing('a', 0), thing('b', 1)]);
    const first = { ...manifest, baked: { a: 'sha-a' } };
    expect([bakedAt(facts, first, 0), bakedAt(facts, first, 1)]).toEqual([true, false]);
    expect(bakedAt(facts, first, 1)).toBe(false);
    const next = { ...manifest, baked: { a: 'sha-a', b: 'sha-b' } };
    expect([bakedAt(facts, next, 0), bakedAt(facts, next, 1)]).toEqual([true, true]);
  });
});
