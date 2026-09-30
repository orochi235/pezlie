import { describe, expect, it } from 'vitest';
import { landing } from '../src/fling';

const VIEW = { x: 100, y: 200, scale: { x: 2, y: 2 } };

/** Weasel's decay loop at a steady 60 Hz: what `useDecayLoop` does per tick. */
function simulate(vx: number, vy: number, friction = 0.92, minSpeed = 0.01) {
  let x = 0;
  let y = 0;
  const step = 1000 / 60;
  for (;;) {
    const k = friction ** (step / 16.67);
    vx *= k;
    vy *= k;
    if (Math.hypot(vx, vy) < minSpeed) return { x, y };
    x += vx * step;
    y += vy * step;
  }
}

describe('landing', () => {
  it('lands where the decay loop stops', () => {
    const out = landing(VIEW, { velocity: { vx: 0.5, vy: -2 } });
    const moved = simulate(0.5, -2);
    expect(out.x).toBeCloseTo(VIEW.x + moved.x, 0);
    expect(out.y).toBeCloseTo(VIEW.y + moved.y, 0);
    expect(out.scale).toEqual(VIEW.scale);
  });

  it('follows the friction and stopping speed it is given', () => {
    const out = landing(VIEW, { velocity: { vx: 0, vy: 3 }, friction: 0.8, minSpeed: 0.1 });
    expect(out.y).toBeCloseTo(VIEW.y + simulate(0, 3, 0.8, 0.1).y, 0);
  });

  it('stays put below the stopping speed', () => {
    expect(landing(VIEW, { velocity: { vx: 0.001, vy: 0 } })).toEqual(VIEW);
  });
});
