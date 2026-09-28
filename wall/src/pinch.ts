import { zoomAt, type View } from '@weasel-js/core';

export interface Midpoint { x: number; y: number }

/** One frame of a two-finger gesture, in canvas-local pixels.
 *
 *  `factor` is the frame's scale ratio and `previous` the midpoint it was
 *  measured from, so the zoom is anchored where the fingers were and the
 *  translation carries that world point to where they are now. Together
 *  those pin the content under the midpoint as the midpoint travels, which
 *  is what makes one gesture both zoom and pan. */
export function pinchStep(view: View, midpoint: Midpoint,
                          previous: Midpoint | null, factor: number): View {
  if (!previous) return zoomAt(view, midpoint, factor);
  const zoomed = zoomAt(view, previous, factor);
  return {
    ...zoomed,
    x: zoomed.x - (midpoint.x - previous.x) / zoomed.scale.x,
    y: zoomed.y - (midpoint.y - previous.y) / zoomed.scale.y,
  };
}

/** The first two held pointers by when they went down, as a midpoint and the
 *  distance between them; null with fewer than two held. */
export function pinchPair(held: ReadonlyMap<number, Midpoint>):
  { midpoint: Midpoint; spread: number } | null {
  const it = held.values();
  const a = it.next().value;
  const b = it.next().value;
  if (!a || !b) return null;
  return { midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, spread: Math.hypot(b.x - a.x, b.y - a.y) };
}
