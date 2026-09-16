import { expect, it } from 'vitest';
import {
  DEFAULT_HYSTERESIS, DEFAULT_LADDER, levelFor, parseLadder, pickLevel, sheetFor, VECTOR_LEVEL,
} from '../src/levels';

const WIDE = { sheets: [16, 64], loose: 256 };

it('picks the coarsest level that covers the on-screen cell size', () => {
  expect(levelFor(4)).toBe(8);
  expect(levelFor(20)).toBe(32);
  expect(levelFor(100)).toBe(128);
  expect(levelFor(128)).toBe(128);   // the last raster rung owns its own size
  expect(levelFor(200)).toBe(VECTOR_LEVEL);
});

it('holds the 128/vector dead zone the same way as every other boundary', () => {
  // The 128 boundary's dead zone is [128*0.67, 128*1.5] = [85.8, 192].
  expect(pickLevel(128, 150)).toBe(128);           // wants vector, not past 192 yet
  expect(pickLevel(VECTOR_LEVEL, 100)).toBe(VECTOR_LEVEL); // wants 128, not below 85.8 yet
  expect(pickLevel(128, 250)).toBe(VECTOR_LEVEL);
});

it('holds the current level across the whole hysteresis dead zone', () => {
  // The 8/32 boundary is 16px, so the dead zone is [16*0.67, 16*1.5] = [10.7, 24].
  // Inside it the level in hand wins, whichever one that is -- which is the
  // entire point: a zoom parked on 16px would otherwise re-upload every frame.
  expect(pickLevel(8, 20)).toBe(8);    // wants 32, not past 24 yet
  expect(pickLevel(32, 12)).toBe(32);  // wants 8, not below 10.7 yet
});

it('swaps once the zoom is clearly past the dead zone', () => {
  expect(pickLevel(8, 30)).toBe(32);
  expect(pickLevel(32, 5)).toBe(8);
});

it('leaves the level alone when it is already the right one', () => {
  expect(pickLevel(8, 10)).toBe(8);
  expect(pickLevel(32, 40)).toBe(32);
});

it('honors a caller-supplied hysteresis', () => {
  // Same 16px boundary, but a tighter up-factor of 1.1 -- 20/1.1 = 18.2,
  // already past 16, so it swaps where the default 1.5 factor would hold.
  expect(pickLevel(8, 20, 1.1, 0.67)).toBe(32);
  expect(pickLevel(8, 20)).toBe(8);
});

it('defaults to the tuned hysteresis factors', () => {
  expect(DEFAULT_HYSTERESIS).toEqual({ up: 1.5, down: 0.67 });
});

it('reads its bands off the ladder it is given', () => {
  expect(levelFor(20, WIDE)).toBe(16);    // a sheet covers up to twice its size
  expect(levelFor(40, WIDE)).toBe(64);
  expect(levelFor(200, WIDE)).toBe(256);
  expect(levelFor(256, WIDE)).toBe(256);
  expect(levelFor(300, WIDE)).toBe(VECTOR_LEVEL);
});

it('ends a sheet band at the next level when that comes before twice its size', () => {
  const close = { sheets: [8, 12], loose: 128 };
  expect(levelFor(11, close)).toBe(8);
  expect(levelFor(12, close)).toBe(12);
});

it('drops a level that is not on the ladder rather than holding it', () => {
  expect(pickLevel(32, 20, 1.5, 0.67, WIDE)).toBe(16);
});

it('parses a ladder, and refuses one out of order', () => {
  expect(parseLadder(WIDE)).toEqual(WIDE);
  expect(parseLadder({ sheets: [64, 16], loose: 256 })).toBeNull();
  expect(parseLadder({ sheets: [8, 32], loose: 32 })).toBeNull();
  expect(parseLadder({ sheets: [], loose: 128 })).toBeNull();
  expect(parseLadder({ sheets: [8, 32] })).toBeNull();
  expect(parseLadder('nope')).toBeNull();
});

it('draws the loose and vector rungs over the finest sheet', () => {
  expect(sheetFor(8, DEFAULT_LADDER)).toBe(8);
  expect(sheetFor(32, DEFAULT_LADDER)).toBe(32);
  expect(sheetFor(128, DEFAULT_LADDER)).toBe(32);
  expect(sheetFor(VECTOR_LEVEL, WIDE)).toBe(64);
});
