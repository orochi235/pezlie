import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  CARD_DETAILS, CARD_HEIGHT, CARD_MARGIN, CARD_OFFSET, CARD_PAD, CARD_WIDTH, ItemCard, frameCard,
  placeCard, type ItemCardBase,
} from '../src/ItemCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEWPORT = { width: 1000, height: 800 };

/** Everything but the anchor, which each helper below pins itself: the props
 *  are a union, so `at` and `cell` cannot travel together. Partial, so a
 *  helper can be called bare, and derived, so a new prop arrives here too. */
type Extra = Partial<Omit<ItemCardBase, 'children'>> & { children?: ReactNode };

const card = ({ at = { x: 100, y: 100 }, viewport = VIEWPORT, onClose = () => {}, children,
                ...rest }: Extra & { at?: { x: number; y: number } } = {}) => (
  <ItemCard at={at} viewport={viewport} onClose={onClose} {...rest}>
    {children ?? <p>item seven</p>}
  </ItemCard>
);

const pos = (el: HTMLElement) => ({
  x: parseInt(el.style.getPropertyValue('--card-x'), 10),
  y: parseInt(el.style.getPropertyValue('--card-y'), 10),
});

it('shows the body its host gives it, as a dialog', () => {
  render(card({ label: 'item seven card' }));
  expect(screen.getByText('item seven')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'item seven card' })).toBeTruthy();
});

it('sits past the clicked point, so it never covers what was clicked', () => {
  const { container } = render(card());
  const el = container.querySelector('.wall-card') as HTMLElement;
  expect(pos(el)).toEqual({ x: 100 + CARD_OFFSET, y: 100 + CARD_OFFSET });
});

it('stays inside the viewport when clicked near the right edge', () => {
  const { container } = render(card({ at: { x: 990, y: 790 } }));
  const el = container.querySelector('.wall-card') as HTMLElement;
  const { x, y } = pos(el);
  expect(x).toBeLessThan(990);
  expect(x + CARD_WIDTH).toBeLessThanOrEqual(VIEWPORT.width - CARD_MARGIN);
  expect(y + CARD_HEIGHT).toBeLessThanOrEqual(VIEWPORT.height - CARD_MARGIN);
});

it('flips to the far side of the point rather than sliding over it', () => {
  // Room on the left: the card goes there whole, clear of the point.
  expect(placeCard({ x: 900, y: 700 }, VIEWPORT, { width: CARD_WIDTH, height: CARD_HEIGHT }))
    .toEqual({ x: 900 - CARD_OFFSET - CARD_WIDTH, y: 700 - CARD_OFFSET - CARD_HEIGHT });
});

it('clamps where neither side has room', () => {
  const small = { width: 300, height: 200 };
  expect(placeCard({ x: 150, y: 100 }, small, { width: CARD_WIDTH, height: CARD_HEIGHT }))
    .toEqual({ x: CARD_MARGIN, y: CARD_MARGIN });
});

it('closes on Escape', () => {
  const onClose = vi.fn();
  render(card({ onClose }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

it('closes on a press outside it, and not on one inside', () => {
  const onClose = vi.fn();
  render(card({ onClose, children: <button type="button">act</button> }));
  fireEvent.pointerDown(screen.getByRole('button', { name: 'act' }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('reports the pointer entering and leaving, so a zoom can spare the card being read', () => {
  const onHoverChange = vi.fn();
  const { container } = render(card({ onHoverChange }));
  const el = container.querySelector('.wall-card')!;
  fireEvent.pointerEnter(el);
  expect(onHoverChange).toHaveBeenLastCalledWith(true);
  fireEvent.pointerLeave(el);
  expect(onHoverChange).toHaveBeenLastCalledWith(false);
});

it('stops listening once it is gone', () => {
  const onClose = vi.fn();
  const { unmount } = render(card({ onClose }));
  unmount();
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.pointerDown(document.body);
  expect(onClose).not.toHaveBeenCalled();
});

const CELL = { x: 300, y: 200, w: 128, h: 128 };
const COLUMN = CARD_DETAILS + 2 * CARD_PAD;

it('opens on the cell it frames, whichever side the details take', () => {
  for (const viewport of [VIEWPORT, { width: 520, height: 800 }]) {
    expect(frameCard(CELL, viewport).opening)
      .toEqual({ x: CELL.x, y: CELL.y, width: CELL.w, height: CELL.h });
  }
});

it('frames the cell with a pad on every side and the details past one of them', () => {
  const frame = frameCard(CELL, VIEWPORT);
  expect(frame.side).toBe('right');
  expect(frame).toMatchObject({
    x: CELL.x - CARD_PAD, y: CELL.y - CARD_PAD,
    width: CELL.w + COLUMN + CARD_PAD, height: CELL.h + 2 * CARD_PAD,
  });
  // The details column sits between the opening and the frame's right edge.
  expect(frame.x + frame.width - (CELL.x + CELL.w)).toBe(COLUMN);
});

it('puts the details left of a cell with no room to its right', () => {
  // The frame would need to reach 428 + 224 = 652, past this viewport.
  const frame = frameCard(CELL, { width: 600, height: 800 });
  expect(frame.side).toBe('left');
  expect(frame.x).toBe(CELL.x - COLUMN);
  expect(frame.opening.x).toBe(CELL.x);
});

it('keeps the details right when neither side has room, rather than sliding off the cell', () => {
  // Too near the left edge for the column, in a viewport too narrow for it on the right.
  expect(frameCard({ ...CELL, x: 100 }, { width: 400, height: 800 }).side).toBe('right');
});

it('grows the frame down to hold details taller than the cell', () => {
  const frame = frameCard(CELL, VIEWPORT, CELL.h + 100);
  expect(frame).toMatchObject({ y: CELL.y - CARD_PAD, above: CARD_PAD, below: CARD_PAD + 100,
                                height: CELL.h + 2 * CARD_PAD + 100 });
  expect(frame.opening.y).toBe(CELL.y);
});

it('grows the frame up once the viewport has no room below', () => {
  // 40px of room under the frame's bottom pad; the other 60 go above.
  const viewport = { width: VIEWPORT.width,
                     height: CELL.y + CELL.h + CARD_PAD + 40 + CARD_MARGIN };
  const frame = frameCard(CELL, viewport, CELL.h + 100);
  expect(frame).toMatchObject({ above: CARD_PAD + 60, below: CARD_PAD + 40,
                                y: CELL.y - CARD_PAD - 60 });
});

const framed = ({ cell = CELL, viewport = VIEWPORT, onClose = () => {}, children,
                  ...rest }: Extra & { cell?: typeof CELL } = {}) => (
  <ItemCard cell={cell} viewport={viewport} onClose={onClose} {...rest}>
    {children ?? <p>item seven</p>}
  </ItemCard>
);

const CELL_RECT = {
  left: CELL.x, top: CELL.y, right: CELL.x + CELL.w, bottom: CELL.y + CELL.h,
  width: CELL.w, height: CELL.h, x: CELL.x, y: CELL.y, toJSON() { return {}; },
} as DOMRect;

/** The card measures its opening as it mounts and jsdom lays nothing out, so
 *  the measurement is pinned before it renders. The canvas comes with it: what
 *  shows through the opening is the wall, and only events on it count as the
 *  cell's. */
function renderFramed(props: Extra = {}) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(CELL_RECT);
  const view = render(framed(props));
  const canvas = document.createElement('canvas');
  view.container.append(canvas);
  return { ...view, canvas };
}

const inOpening = { clientX: CELL.x + 10, clientY: CELL.y + 10 };

it('draws an opening the size of the cell, with the details beside it', () => {
  const { container } = render(framed());
  const el = container.querySelector('.wall-card') as HTMLElement;
  expect(el.className).toContain('wall-card--framed');
  expect(pos(el)).toEqual({ x: CELL.x - CARD_PAD, y: CELL.y - CARD_PAD });
  expect(el.style.getPropertyValue('--open-w')).toBe(`${CELL.w}px`);
  expect(el.style.getPropertyValue('--open-h')).toBe(`${CELL.h}px`);
  expect(el.style.getPropertyValue('--card-w')).toBe(`${CELL.w + COLUMN + CARD_PAD}px`);
  expect(el.style.getPropertyValue('--card-h')).toBe(`${CELL.h + 2 * CARD_PAD}px`);
  expect(container.querySelector('.wall-card__details')!.textContent).toBe('item seven');
});

it('counts a press in the opening as a press on itself, so the cell stays framed', () => {
  const onClose = vi.fn();
  const { canvas } = renderFramed({ onClose });
  fireEvent.pointerDown(canvas, inOpening);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(canvas, { clientX: CELL.x - 40, clientY: CELL.y + 10 });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('closes on a press over the opening that landed on a panel instead of the wall', () => {
  const onClose = vi.fn();
  const { container } = renderFramed({ onClose });
  const panel = document.createElement('div');
  container.append(panel);
  fireEvent.pointerDown(panel, inOpening);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('reads the pointer over the opening as over itself, so a zoom spares it', () => {
  const onHoverChange = vi.fn();
  const { canvas } = renderFramed({ onHoverChange });
  // Over the cell the frame surrounds: the card is the one being read.
  fireEvent.pointerMove(canvas, inOpening);
  expect(onHoverChange).toHaveBeenLastCalledWith(true);
  fireEvent.pointerMove(canvas, { clientX: CELL.x - 60, clientY: CELL.y + 10 });
  expect(onHoverChange).toHaveBeenLastCalledWith(false);
});

it('stops watching the opening once it is gone', () => {
  const onHoverChange = vi.fn();
  const onClose = vi.fn();
  const { canvas, unmount } = renderFramed({ onHoverChange, onClose });
  fireEvent.pointerMove(canvas, inOpening);
  expect(onHoverChange).toHaveBeenLastCalledWith(true);
  unmount();
  // Hovered on the way out: whatever a host hung on it must not stay armed.
  expect(onHoverChange).toHaveBeenLastCalledWith(false);
  fireEvent.pointerMove(canvas, inOpening);
  fireEvent.pointerDown(canvas, inOpening);
  expect(onHoverChange).toHaveBeenCalledTimes(2);
  expect(onClose).not.toHaveBeenCalled();
});
