import { fireEvent, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { compile } from '../src/cel';
import { derive } from '../src/derive';
import { cornerBadgeAt, cornerBadgesAt } from '../src/draw2d';
import { gridLayout, rectAt } from '../src/layout';
import { paintCommands, type PaintCommand } from '../src/paint';
import { defaultPalette } from '../src/palette';
import { Wall, type WallProps } from '../src/Wall';
import { SPEC, thing, type Thing } from './fixture';

const compiled = compile(SPEC);
const items = Array.from({ length: 6 }, (_, i) =>
  thing(`t${i}`, i, i === 2 ? { labels: ['star'] } : {}));
const facts = derive(compiled, items);
const order = Uint32Array.from([2, 0, 1, 3, 4, 5]);
const laid = gridLayout({ rows: order }, { cell: 120, gap: 4, cols: 3 });
const cam = { x: 0, y: 0, scale: { x: 1, y: 1 } };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0,
      toJSON() { return {}; } } as DOMRect);
});

function mount(overrides: Partial<WallProps<Thing>> = {}) {
  const props: WallProps<Thing> = {
    compiled, facts, laid, cam, sheet: null, manifest: null,
    loose: new Map(), vector: new Map(), width: 400, height: 300,
    highlight: null, highlightTag: null, explicitCaret: null,
    onExplicitCaretChange: vi.fn(), onPan: vi.fn(), onPick: vi.fn(), onOpen: vi.fn(),
    ...overrides,
  };
  const view = render(<Wall {...props} />);
  const canvas = view.container.querySelector('canvas.wall-canvas') as HTMLCanvasElement;
  return { ...props, canvas, view };
}

it('picks the row under a click, not its position in the view', () => {
  const w = mount();
  fireEvent.click(w.canvas, { clientX: 10, clientY: 10 });
  expect(w.onPick).toHaveBeenCalledWith(2, { x: 10, y: 10 }, 0, 'click');
});

it('opens the row under a double click', () => {
  const w = mount();
  fireEvent.doubleClick(w.canvas, { clientX: 130, clientY: 10 });
  expect(w.onOpen).toHaveBeenCalledWith(0);
});

it('zooms about the fingers when two pointers spread apart', () => {
  const w = mount();
  const touch = (type: 'pointerDown' | 'pointerMove', id: number, x: number) =>
    fireEvent[type](w.canvas, { pointerId: id, clientX: x, clientY: 100, button: 0 });
  touch('pointerDown', 1, 100);
  touch('pointerDown', 2, 200);
  touch('pointerMove', 2, 300);
  // The spread doubles; a first frame has no earlier midpoint, so it zooms
  // about the one it ends at and holds the world point under it.
  expect(w.onPan).toHaveBeenCalledTimes(1);
  const next = vi.mocked(w.onPan).mock.lastCall![0];
  expect(next.scale.x).toBeCloseTo(2, 5);
  expect((200 / next.scale.x) + next.x).toBeCloseTo(200, 5);
});

it('moves an explicit caret with the arrow keys and drops it on Escape', () => {
  const w = mount({ explicitCaret: 0 });
  fireEvent.keyDown(w.canvas, { key: 'ArrowRight' });
  expect(w.onExplicitCaretChange).toHaveBeenCalledWith(1);
  fireEvent.keyDown(w.canvas, { key: 'Escape' });
  expect(w.onExplicitCaretChange).toHaveBeenLastCalledWith(null);
});

it('picks the caret row on Enter, at the center of its cell', () => {
  const w = mount({ explicitCaret: 1 });
  fireEvent.keyDown(w.canvas, { key: 'Enter' });
  expect(w.onPick).toHaveBeenCalledWith(0, { x: 124 + 60, y: 60 }, 1, 'key');
});

it('follows a linked badge to its target instead of picking', () => {
  const linkTarget = vi.fn(() => 5);
  const w = mount({ linkedBadges: ['star'], linkTarget });
  const [first] = paintCommands({
    compiled, facts, order, rect: (p) => rectAt(laid, p), visible: [0], cam, manifest: null,
    palette: defaultPalette(compiled.states),
  }) as (PaintCommand & { kind: 'fill' })[];
  const { cx, cy } = cornerBadgeAt(first!.badges![0]!, first!);
  fireEvent.click(w.canvas, { clientX: cx, clientY: cy });
  expect(linkTarget).toHaveBeenCalledWith(2, 'star');
  expect(w.onExplicitCaretChange).toHaveBeenCalledWith(Array.from(order).indexOf(5));
  expect(w.onPan).toHaveBeenCalled();
  expect(w.onPick).not.toHaveBeenCalled();
});

it('follows the second badge of a corner row when that one is clicked', () => {
  const rowSpec = { ...SPEC, badges: [...SPEC.badges!, { tag: 'moon', slot: 'corner' as const,
    art: { mark: 'star', corner: 'tl' as const, field: '#222288', ink: '#ffffff' } }] };
  const rowCompiled = compile(rowSpec);
  const rowItems = items.map((t, i) => (i === 2 ? { ...t, labels: ['star', 'moon'] } : t));
  const rowFacts = derive(rowCompiled, rowItems);
  const linkTarget = vi.fn(() => 5);
  const w = mount({ compiled: rowCompiled, facts: rowFacts, linkedBadges: ['star', 'moon'],
                    linkTarget });
  const [first] = paintCommands({
    compiled: rowCompiled, facts: rowFacts, order, rect: (p) => rectAt(laid, p), visible: [0],
    cam, manifest: null, palette: defaultPalette(rowCompiled.states),
  }) as (PaintCommand & { kind: 'fill' })[];
  expect(first!.badges!.map((b) => b.tag)).toEqual(['star', 'moon']);
  const [star, moon] = cornerBadgesAt(first!.badges!, first!);
  expect(Math.hypot(moon!.cx - star!.cx, moon!.cy - star!.cy)).toBeGreaterThan(star!.radius * 2);
  fireEvent.click(w.canvas, { clientX: moon!.cx, clientY: moon!.cy });
  expect(linkTarget).toHaveBeenCalledWith(2, 'moon');
});

it('picks rather than follows when the badge is not a linked one', () => {
  const linkTarget = vi.fn(() => 5);
  const w = mount({ linkedBadges: [], linkTarget });
  fireEvent.click(w.canvas, { clientX: 10, clientY: 10 });
  expect(linkTarget).not.toHaveBeenCalled();
  expect(w.onPick).toHaveBeenCalled();
});

it('announces the row an explicit caret lands on', () => {
  const w = mount({ explicitCaret: 0, describe: (row) => `row ${row}` });
  expect(w.view.container.querySelector('.wall-caret-announce')!.textContent).toBe('row 2');
});
