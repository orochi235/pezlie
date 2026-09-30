import type { View } from '@weasel-js/core';

/** What a momentum pan is started with, in world units per ms. */
export interface Fling {
  velocity: { vx: number; vy: number };
  friction?: number;
  minSpeed?: number;
}

/** `useDecayLoop`'s defaults, which it does not export. */
const FRICTION = 0.92;
const MIN_SPEED = 0.01;
const FRAME_MS = 1000 / 60;

/** Where a momentum pan from `at` comes to rest, before any clamp.
 *
 *  Steps weasel's decay loop at 60 Hz: each frame scales the velocity by
 *  `friction`, stops once it is under `minSpeed`, and otherwise moves by it.
 *  At another frame rate it lands within a fraction of a frame's travel. */
export function landing(at: View, { velocity, friction = FRICTION, minSpeed = MIN_SPEED }: Fling): View {
  const k = friction ** (FRAME_MS / 16.67);
  let { vx, vy } = velocity;
  let x = at.x;
  let y = at.y;
  if (Math.hypot(vx, vy) < minSpeed || !(k < 1)) return at;
  for (;;) {
    vx *= k;
    vy *= k;
    if (Math.hypot(vx, vy) < minSpeed) return { ...at, x, y };
    x += vx * FRAME_MS;
    y += vy * FRAME_MS;
  }
}
