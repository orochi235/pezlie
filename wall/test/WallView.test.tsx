import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultUrls } from '../src/urls';
import { WallView, type RevealResult, type WallHeader } from '../src/WallView';
import { SPEC, thing, type Thing } from './fixture';

const urls = defaultUrls('/api');
const items = [thing('a', 0), thing('b', 1, { level: 2 }), thing('c', 2, { err: 'x' })];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount(overrides: Partial<Parameters<typeof WallView<Thing>>[0]> = {}) {
  const fetchItems = vi.fn(() => Promise.resolve({ items, version: 'v1' }));
  const fetchSlots = vi.fn(() => Promise.resolve([{ slot: 'north', n: 3 }]));
  const onChange = vi.fn();
  render(<WallView title="things" spec={SPEC} urls={urls} fetchItems={fetchItems}
                   fetchSlots={fetchSlots} storageKey="test.params" onChange={onChange}
                   {...overrides} />);
  return { fetchItems, fetchSlots, onChange };
}

it('opens the first slot the host lists when none is chosen', async () => {
  const { fetchItems } = mount();
  await waitFor(() => expect(fetchItems).toHaveBeenCalledWith('north', undefined));
});

it('opens the chosen slot without waiting for the list', async () => {
  const { fetchItems } = mount({ defaultSlot: 'south' });
  await waitFor(() => expect(fetchItems).toHaveBeenCalledWith('south', undefined));
  expect(fetchItems).not.toHaveBeenCalledWith('north', undefined);
});

it('shows the legend for the spec once items arrive', async () => {
  mount({ defaultSlot: 'north' });
  await screen.findByText('warning');
  expect(screen.getByText('noted')).toBeTruthy();
});

it('reports its state, with the selection the host started it on', async () => {
  const { onChange } = mount({
    defaultSlot: 'north', initial: { selection: { sort: 'score' } },
  });
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(onChange.mock.lastCall![0]).toMatchObject(
    { slot: 'north', opened: null, selection: { sort: 'score', filter: 'all', tint: 'status' } });
});

it('lists every problem in a bad spec instead of drawing the wall', () => {
  const bad = {
    ...SPEC,
    states: SPEC.states.map((s) => (s.key === 'warn' ? { ...s, match: 'item.level >' } : s)),
    filters: SPEC.filters.map((f) => (f.key === 'drawn' ? { ...f, keep: '(' } : f)),
  };
  mount({ spec: bad });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('2 problems');
  expect(alert.textContent).toContain('states.warn');
  expect(alert.textContent).toContain('filters.drawn');
});

it('hands a header function the slots, and lets it change the slot', async () => {
  let wall: WallHeader | undefined;
  const { fetchItems } = mount({
    defaultSlot: 'north',
    fetchSlots: vi.fn(() => Promise.resolve([{ slot: 'north', n: 3 }, { slot: 'south', n: 1 }])),
    header: (w) => { wall = w; return <span>on {w.slot} of {w.slots.length}</span>; },
  });
  await screen.findByText('on north of 2');
  act(() => wall!.setSlot('south'));
  await screen.findByText('on south of 2');
  await waitFor(() => expect(fetchItems).toHaveBeenCalledWith('south', undefined));
});

it('keeps a host-picked slot when the first slots poll lands after it', async () => {
  let wall: WallHeader | undefined;
  let resolveSlots!: (v: { slot: string; n: number }[]) => void;
  const slotsPromise = new Promise<{ slot: string; n: number }[]>((resolve) => { resolveSlots = resolve; });
  const { fetchItems } = mount({
    fetchSlots: vi.fn(() => slotsPromise),
    header: (w) => { wall = w; return <span>header</span>; },
  });
  act(() => wall!.setSlot('south'));
  await waitFor(() => expect(fetchItems).toHaveBeenCalledWith('south', undefined));
  await act(async () => { resolveSlots([{ slot: 'north', n: 3 }, { slot: 'south', n: 1 }]); await slotsPromise; });
  expect(fetchItems).not.toHaveBeenCalledWith('north', undefined);
});

it('still renders a plain header node', async () => {
  mount({ defaultSlot: 'north', header: <span>extra</span> });
  expect(await screen.findByText('extra')).toBeTruthy();
});

// By class: the label's text also holds every option's, so no label query matches it.
it('draws its own slot picker by default', async () => {
  mount({ defaultSlot: 'north' });
  await waitFor(() => expect(document.querySelector('.wall-slot select')).toBeTruthy());
});

it('draws no slot picker when the host takes it over', async () => {
  mount({
    defaultSlot: 'north', slotPicker: false,
    header: (w) => <span>{w.slots.length} slots</span>,
  });
  await screen.findByText('1 slots');
  expect(document.querySelector('.wall-slot')).toBeNull();
});

async function mountRevealing(overrides: Partial<Parameters<typeof WallView<Thing>>[0]> = {}) {
  let wall: WallHeader | undefined;
  const out = mount({
    defaultSlot: 'north',
    renderCard: (item) => <span>card {item.id}</span>,
    header: (w) => { wall = w; return null; },
    ...overrides,
  });
  await screen.findByText('warning');
  return { ...out, reveal: (id: string) => {
    let r: RevealResult | undefined; act(() => { r = wall!.reveal(id); }); return r;
  } };
}

it('reveals a drawn item and opens its card', async () => {
  const { reveal } = await mountRevealing();
  expect(reveal('b')).toBe('shown');
  expect(await screen.findByText('card b')).toBeTruthy();
});

it('says an id is absent when the drawn slot has no such item', async () => {
  const { reveal } = await mountRevealing();
  expect(reveal('nope')).toBe('absent');
  expect(screen.queryByText(/^card /)).toBeNull();
});

it('says an item is filtered when the selection hides it', async () => {
  const withUndrawn = [...items, thing('d', 3, { sha: null })];
  const { reveal } = await mountRevealing({
    fetchItems: vi.fn(() => Promise.resolve({ items: withUndrawn, version: 'v1' })),
    initial: { selection: { filter: 'drawn' } },
  });
  expect(reveal('d')).toBe('filtered');
  expect(reveal('a')).toBe('shown');
});

it('closes an open detail view before opening the revealed card', async () => {
  const { reveal } = await mountRevealing({
    renderDetail: (item) => <div>detail {item.id}</div>,
    initial: { opened: 'c' },
  });
  await screen.findByText('detail c');
  expect(reveal('b')).toBe('shown');
  expect(await screen.findByText('card b')).toBeTruthy();
  expect(screen.queryByText('detail c')).toBeNull();
});

it('reveals by row, not by draw position, under a sort', async () => {
  const { reveal } = await mountRevealing({
    initial: { selection: { sort: 'score' } },
    fetchItems: vi.fn(() => Promise.resolve({
      items: [thing('a', 0, { score: 1 }), thing('b', 1, { score: 9 }), thing('c', 2, { score: 5 })],
      version: 'v1',
    })),
  });
  expect(reveal('a')).toBe('shown');
  expect(await screen.findByText('card a')).toBeTruthy();
});

it('asks the feed for changes since its version when the header polls', async () => {
  let wall: WallHeader | undefined;
  const { fetchItems } = mount({
    defaultSlot: 'north',
    header: (w) => { wall = w; return <span>polling {w.slot}</span>; },
  });
  await screen.findByText('polling north');
  await waitFor(() => expect(fetchItems).toHaveBeenCalledWith('north', undefined));
  await act(async () => { await Promise.resolve(); });
  act(() => wall!.poll());
  await waitFor(() => expect(fetchItems).toHaveBeenCalledWith('north', 'v1'));
});
