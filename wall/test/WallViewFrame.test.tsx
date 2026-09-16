import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CARD_DETAILS, CARD_PAD } from '../src/ItemCard';
import { defaultUrls } from '../src/urls';
import { WallView, type WallHeader } from '../src/WallView';
import { SPEC, thing, type Thing } from './fixture';

// The camera glide is the thing under test, and a tween that runs on
// requestAnimationFrame says nothing in a synchronous assertion.
const { animate } = vi.hoisted(() => ({ animate: vi.fn() }));
vi.mock('@weasel-js/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weasel-js/core')>();
  return {
    ...actual,
    useViewAnimation: () => ({
      animate, animateToBounds: () => {}, stop: () => {}, isAnimating: () => false,
      target: () => null, stopIfExternal: () => {},
    }),
  };
});

const urls = defaultUrls('/api');
const STAGE = { width: 800, height: 600 };
const CELL = 32;
const PITCH = 36;
const LOOSE = 128;

const stageRect = {
  left: 0, top: 0, right: STAGE.width, bottom: STAGE.height,
  width: STAGE.width, height: STAGE.height, x: 0, y: 0, toJSON() { return {}; },
} as DOMRect;

beforeEach(() => {
  animate.mockClear();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // jsdom measures nothing, and a 0x0 stage never gets a camera.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(stageRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Four cells: a full 2x2 grid, so any point on the wall lands on one. */
const few = [thing('a', 0), thing('b', 1, { level: 2 }), thing('c', 2, { err: 'x' }),
             thing('d', 3)];
const many = Array.from({ length: 400 }, (_, i) => thing(`t${i}`, i, { level: i % 3 }));

async function mount(items: Thing[]) {
  let wall: WallHeader | undefined;
  const { container } = render(
    <WallView title="things" spec={SPEC} urls={urls} defaultSlot="north"
              fetchItems={vi.fn(() => Promise.resolve({ items, version: 'v1' }))}
              fetchSlots={vi.fn(() => Promise.resolve([{ slot: 'north', n: items.length }]))}
              storageKey="test.frame"
              renderCard={(item) => <span>card {item.id}</span>}
              header={(w) => { wall = w; return null; }} />);
  await screen.findByText('warning');
  const canvas = await waitFor(() => {
    const el = container.querySelector('canvas.wall-canvas');
    if (!el) throw new Error('the wall has no camera yet');
    return el;
  });
  return { container, canvas, reveal: (id: string) => { act(() => { wall!.reveal(id); }); } };
}

const num = (el: HTMLElement, prop: string) => parseFloat(el.style.getPropertyValue(prop));

/** The card, once its host has opened one, and how tall its opening is. */
async function openedCard() {
  await screen.findByText(/^card /);
  return screen.getByRole('dialog');
}

it('frames the revealed cell, with an opening the size of the cell on screen', async () => {
  const { reveal } = await mount(many);
  reveal('t7');
  const card = await openedCard();
  expect(card.className).toContain('wall-card--framed');
  expect(card.querySelector('.wall-card__opening')).toBeTruthy();
  // 400 cells lay out 20 to a row: the wall is 20*36-4 world units wide and
  // fills the stage's width, so a 32-unit cell draws at 800*32/716.
  const open = num(card, '--open-w');
  expect(open).toBeCloseTo((STAGE.width * CELL) / (20 * PITCH - (PITCH - CELL)), 3);
  expect(num(card, '--open-h')).toBeCloseTo(open, 5);
  expect(num(card, '--card-w')).toBeCloseTo(open + CARD_DETAILS + 3 * CARD_PAD, 5);
  expect(num(card, '--card-h')).toBeCloseTo(open + 2 * CARD_PAD, 5);
});

it('glides the camera in when the clicked cell is under the loose rung', async () => {
  const { canvas } = await mount(many);
  fireEvent.click(canvas, { clientX: 100, clientY: 100 });
  expect(num(await openedCard(), '--open-h')).toBeLessThan(LOOSE);
  expect(animate).toHaveBeenCalledTimes(1);
  // 128 screen pixels of a 32-unit cell: four pixels to the unit.
  expect(animate.mock.lastCall![0].scale.y).toBeCloseTo(LOOSE / CELL, 5);
});

it('leaves the camera where it is when the clicked cell is already that big', async () => {
  const { canvas } = await mount(few);
  fireEvent.click(canvas, { clientX: 100, clientY: 100 });
  expect(num(await openedCard(), '--open-h')).toBeGreaterThanOrEqual(LOOSE);
  expect(animate).not.toHaveBeenCalled();
});
