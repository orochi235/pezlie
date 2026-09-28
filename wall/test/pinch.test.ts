import { describe, expect, it } from 'vitest';
import { viewToTransform, worldToScreen } from '@weasel-js/core';
import { pinchPair, pinchStep } from '../src/pinch';

const VIEW = { x: 40, y: 25, scale: { x: 2, y: 2 } };

/** Where a world point lands on the canvas under `view`. */
const screen = (view: typeof VIEW, wx: number, wy: number) =>
  worldToScreen(wx, wy, viewToTransform(view));

describe('pinchStep', () => {
  it('holds the world point under a still midpoint', () => {
    const at = { x: 120, y: 90 };
    const [wx, wy] = [at.x / VIEW.scale.x + VIEW.x, at.y / VIEW.scale.y + VIEW.y];
    const out = pinchStep(VIEW, at, at, 1.5);
    expect(out.scale.x).toBeCloseTo(3);
    const [sx, sy] = screen(out, wx, wy);
    expect(sx).toBeCloseTo(at.x);
    expect(sy).toBeCloseTo(at.y);
  });

  it('pans by the midpoint delta when the spread does not change', () => {
    const out = pinchStep(VIEW, { x: 130, y: 95 }, { x: 120, y: 90 }, 1);
    expect(out.scale.x).toBeCloseTo(VIEW.scale.x);
    expect(out.x).toBeCloseTo(VIEW.x - 10 / VIEW.scale.x);
    expect(out.y).toBeCloseTo(VIEW.y - 5 / VIEW.scale.y);
  });

  it('carries the pinched point to where the fingers moved it', () => {
    const from = { x: 120, y: 90 };
    const to = { x: 150, y: 60 };
    const [wx, wy] = [from.x / VIEW.scale.x + VIEW.x, from.y / VIEW.scale.y + VIEW.y];
    const out = pinchStep(VIEW, to, from, 1.5);
    const [sx, sy] = screen(out, wx, wy);
    expect(sx).toBeCloseTo(to.x);
    expect(sy).toBeCloseTo(to.y);
  });

  it('anchors on the midpoint itself for the first frame', () => {
    const at = { x: 120, y: 90 };
    const [wx, wy] = [at.x / VIEW.scale.x + VIEW.x, at.y / VIEW.scale.y + VIEW.y];
    const out = pinchStep(VIEW, at, null, 0.5);
    expect(out.scale.x).toBeCloseTo(1);
    const [sx] = screen(out, wx, wy);
    expect(sx).toBeCloseTo(at.x);
  });
});

describe('pinchPair', () => {
  it('measures the first two pointers down and ignores a third', () => {
    const held = new Map([[7, { x: 0, y: 0 }], [3, { x: 6, y: 8 }], [9, { x: 500, y: 500 }]]);
    expect(pinchPair(held)).toEqual({ midpoint: { x: 3, y: 4 }, spread: 10 });
  });

  it('is null with one pointer held', () => {
    expect(pinchPair(new Map([[1, { x: 0, y: 0 }]]))).toBeNull();
  });
});
