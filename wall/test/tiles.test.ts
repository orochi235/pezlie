import { describe, expect, it } from 'vitest';
import { compile } from '../src/cel';
import { derive } from '../src/derive';
import { DEFAULT_WASH } from '../src/draw2d';
import { gridLayout } from '../src/layout';
import { DEFAULT_APPEARANCE, STALE_WASH } from '../src/paint';
import { defaultPalette } from '../src/palette';
import {
  coveringTiles, FADE_MS, nextTiles, TILE_PX, TileCache, tileKey, tileLevel, type TileScene, type TileSurface,
} from '../src/tiles';
import { ramp, STATUS } from '../src/tint';
import { SPEC, thing, type Thing } from './fixture';

const compiled = compile(SPEC);

/** A context that records every call and hands back real pixel buffers. */
function fakeContext() {
  const calls: [string, unknown[]][] = [];
  const target: Record<string, unknown> = {
    calls,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img: unknown) => { target.image = img; },
  };
  return new Proxy(target, {
    get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => { calls.push([p, args]); }),
    set: (t, p: string, v) => { t[p] = v; return true; },
  }) as unknown as CanvasRenderingContext2D & { calls: typeof calls; image?: ImageData };
}

function scene(items: Thing[], cell: number, cols = 4): TileScene<Thing> {
  const facts = derive(compiled, items);
  return {
    compiled, facts, manifest: null, sheet: null,
    laid: gridLayout({ rows: Uint32Array.from(items, (_, i) => i) }, { cell, gap: 0, cols }),
    palette: defaultPalette(compiled.states),
    options: { marks: {}, washColor: DEFAULT_WASH },
    highlight: null, highlightTag: null, appearance: DEFAULT_APPEARANCE, tint: STATUS,
    gradient: 'ember', stale: false, ground: '#ffffff',
  };
}

const surfaces = () => {
  const made: TileSurface[] = [];
  const make = () => {
    const ctx = fakeContext();
    const s = { canvas: { id: made.length } as unknown as CanvasImageSource, ctx };
    made.push(s);
    return s;
  };
  return { made, make };
};

const cam = (x: number, y: number, s: number) => ({ x, y, scale: { x: s, y: s } });
const at = (z: number, tx: number, ty: number) => {
  const size = TILE_PX / 2 ** z;
  return { z, tx, ty, key: tileKey(z, tx, ty), x: tx * size, y: ty * size, size };
};

describe('coveringTiles', () => {
  it('picks the level at least as sharp as the screen', () => {
    expect(tileLevel(1, 1)).toBe(0);
    expect(tileLevel(0.25, 1)).toBe(-2);
    expect(tileLevel(0.3, 2)).toBe(0);
    expect(tileLevel(3, 1)).toBe(2);
  });

  it('covers the viewport, negative tiles included', () => {
    expect(coveringTiles(cam(0, 0, 1), { width: 1024, height: 512 }, 1).map((t) => t.key))
      .toEqual(['0/0/0', '0/1/0']);
    expect(coveringTiles(cam(-10, 0, 1), { width: 600, height: 100 }, 1).map((t) => t.key))
      .toEqual(['0/-1/0', '0/0/0', '0/1/0']);
    const far = coveringTiles(cam(0, 0, 0.125), { width: 512, height: 512 }, 1);
    expect(far.map((t) => [t.key, t.size])).toEqual([['-3/0/0', 4096]]);
  });
});

describe('TileCache', () => {
  const items = Array.from({ length: 64 }, (_, i) => thing(`t${i}`, i, i % 5 === 0 ? { err: 'x' } : {}));

  it('renders nearest the center first, and stops at the budget', () => {
    const { made, make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make);
    let t = 0;
    const done = cache.draw(fakeContext(), cam(-512, -512, 1), { width: 1536, height: 1536 }, 1, 10, () => (t += 6));
    expect(done.complete).toBe(false);
    expect(made.length).toBe(2);
    expect(cache.has(tileKey(0, 0, 0))).toBe(true);
  });

  it('says it is complete once every tile is its own, and renders nothing more', () => {
    const { made, make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make);
    const view = cam(0, 0, 1);
    expect(cache.draw(fakeContext(), view, { width: 512, height: 512 }, 1, 1000).complete).toBe(true);
    const before = made.length;
    expect(cache.draw(fakeContext(), view, { width: 512, height: 512 }, 1, 1000).complete).toBe(true);
    expect(made.length).toBe(before);
  });

  it('keeps showing the level that covers the screen until the next one is whole', () => {
    const { make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make);
    cache.draw(fakeContext(), cam(0, 0, 0.5), { width: 512, height: 512 }, 1, 1000);
    const coarse = cache.peek(tileKey(-1, 0, 0))!;
    const ctx = fakeContext();
    let t = 0;
    const frame = cache.draw(ctx, cam(0, 0, 1), { width: 1024, height: 512 }, 1, 0, () => (t += 1));
    expect(frame).toMatchObject({ complete: false, pending: true });
    const drawn = ctx.calls.filter(([name]) => name === 'drawImage');
    // The whole screen is the coarse level, drawn at twice its size; no patchwork of the two.
    expect(drawn.map(([, args]) => args[0])).toEqual([coarse.canvas]);
    expect(drawn[0]![1].slice(1)).toEqual([0, 0, TILE_PX * 2, TILE_PX * 2]);
  });

  it('puts every tile edge on a device pixel, shared with its neighbor', () => {
    const { make } = surfaces();
    const dpr = 2;
    const view = cam(1.37, 0.61, 0.7137);
    const screen = { width: 1500, height: 800 };
    // A drawImage's destination box is its last four arguments.
    const boxes = (ctx: ReturnType<typeof fakeContext>) => ctx.calls
      .filter(([name]) => name === 'drawImage').map(([, args]) => (args as number[]).slice(-4));
    const onPixels = ([dx, dy, dw, dh]: number[]) =>
      [dx!, dy!, dx! + dw!, dy! + dh!].every((v) => Number.isInteger(v * dpr));

    const cache = new TileCache(scene(items, 1, 8), make);
    cache.draw(fakeContext(), view, screen, dpr, 1000);
    const settled = fakeContext();
    cache.draw(settled, view, screen, dpr, 1000);
    const drawn = boxes(settled);
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn.every(onPixels)).toBe(true);
    const rights = new Set(drawn.map(([dx, , dw]) => dx! + dw!));
    expect(drawn.map(([dx]) => dx!).filter((dx) => dx > 0).every((dx) => rights.has(dx))).toBe(true);

    // Mid-render, a coarser tile and a finer one stand in.
    const fresh = new TileCache(scene(items, 1, 8), make);
    fresh.render(at(0, 0, 0));
    fresh.render(at(2, 1, 1));
    const partial = fakeContext();
    let t = 0;
    fresh.draw(partial, view, screen, dpr, 0, () => (t += 1));
    const sources = partial.calls.filter(([name]) => name === 'drawImage');
    expect(sources.some(([, args]) => args[0] === fresh.peek(tileKey(0, 0, 0))!.canvas && args.length === 9)).toBe(true);
    expect(sources.some(([, args]) => args[0] === fresh.peek(tileKey(2, 1, 1))!.canvas)).toBe(true);
    expect(boxes(partial).every(onPixels)).toBe(true);
  });

  it('stands in for a missing tile with the part of a coarser one it covers', () => {
    const { make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make);
    cache.render(at(-1, 0, 0));
    const ctx = fakeContext();
    let t = 0;
    cache.draw(ctx, cam(0, 0, 1), { width: 1024, height: 512 }, 1, 0, () => (t += 1));
    const quarter = ctx.calls.filter(([name, args]) => name === 'drawImage' && args.length === 9);
    expect(quarter.map(([, args]) => args.slice(1, 5))).toContainEqual([TILE_PX / 2, 0, TILE_PX / 2, TILE_PX / 2]);
  });

  it('stands in with the scene before while this one renders', () => {
    const { make } = surfaces();
    const old = new TileCache(scene(items, 1, 8), make);
    old.draw(fakeContext(), cam(0, 0, 1), { width: 1024, height: 512 }, 1, 1000);
    const next = new TileCache(scene(items, 1, 8), make, old);
    const ctx = fakeContext();
    let t = 0;
    expect(next.draw(ctx, cam(0, 0, 1), { width: 1024, height: 512 }, 1, 0, () => (t += 1)).complete).toBe(false);
    const drawn = ctx.calls.filter(([name]) => name === 'drawImage').map(([, args]) => args[0]);
    expect(drawn).toContain(old.peek(tileKey(0, 1, 0))!.canvas);
  });

  it('lets the least recently used tile go past its limit', () => {
    const { make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make, null, 2);
    cache.render(at(0, 0, 0));
    cache.render(at(0, 1, 0));
    cache.render(at(0, 2, 0));
    expect(cache.size).toBe(2);
    expect(cache.has(tileKey(0, 0, 0))).toBe(false);
    expect(cache.has(tileKey(0, 2, 0))).toBe(true);
  });

  it('writes small cells as pixels in their state color', () => {
    const s = scene(items, 2, 8);
    const { made, make } = surfaces();
    new TileCache(s, make).draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000);
    const image = (made[0]!.ctx as ReturnType<typeof fakeContext>).image!;
    const px = (x: number, y: number) => Array.from(image.data.slice((y * TILE_PX + x) * 4, (y * TILE_PX + x) * 4 + 4));
    const broken = s.palette.states.broken!;
    const idle = s.palette.states.idle!;
    const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    expect(px(0, 0)).toEqual([...hex(broken.border!), 255]);
    expect(px(3, 1)).toEqual([...hex(idle.fill), 255]);
    expect(px(100, 100)[3]).toBe(0);
  });

  it('writes a measured tint as its ramp swatch, and no value as unmatched', () => {
    const tinted = [thing('a', 0, { score: 10 }), thing('b', 1, { score: null })];
    const s = { ...scene(tinted, 2, 8), tint: 'score' };
    const { made, make } = surfaces();
    new TileCache(s, make).draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000);
    const image = (made[0]!.ctx as ReturnType<typeof fakeContext>).image!;
    const px = (x: number) => Array.from(image.data.slice(x * 4, x * 4 + 3));
    const rgb = (css: string) => css.match(/\d+/g)!.map(Number);
    const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    expect(px(0)).toEqual(rgb(ramp(1)));
    expect(px(2)).toEqual(hex(s.palette.unmatched.fill));
  });

  it('dims, washes and tints pixel cells as paint would', () => {
    const cells = [thing('w', 0, { level: 1, labels: ['big'] }), thing('b', 1, { err: 'x', labels: ['big', 'old'] }),
                   thing('i', 2, { score: 10 }), thing('o', 3, { labels: ['old'], score: null })];
    const base = scene(cells, 2, 8);
    const pixels = (over: Partial<TileScene<Thing>>) => {
      const { made, make } = surfaces();
      new TileCache({ ...base, ...over }, make).draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000);
      const data = (made[0]!.ctx as ReturnType<typeof fakeContext>).image!.data;
      return cells.map((_, c) => Array.from(data.slice(c * 8, c * 8 + 4)));
    };
    const rgb = (css: string) => (css.startsWith('#') ? [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16))
      : css.match(/\d+/g)!.map(Number));
    const washTo = rgb(DEFAULT_WASH);
    const mix = (css: string, by = 0, alpha = 1) =>
      [...rgb(css).map((v, i) => Math.round(v + (washTo[i]! - v) * by)), Math.round(alpha * 255)];
    const st = base.palette.states;
    const [warn, broken, idle, dim] = [st.warn!.border!, st.broken!.border!, st.idle!.fill, st.idle!.fill];
    const { dimAlpha, washStrength } = DEFAULT_APPEARANCE;

    expect(pixels({ highlight: 'warn' }))
      .toEqual([mix(warn), mix(dim, 0, dimAlpha), mix(dim, 0, dimAlpha), mix(dim, 0, dimAlpha)]);
    expect(pixels({ highlightTag: 'big' }))
      .toEqual([mix(warn), mix(broken), mix(dim, 0, dimAlpha), mix(dim, 0, dimAlpha)]);
    expect(pixels({ appearance: { ...DEFAULT_APPEARANCE, wash: true } }))
      .toEqual([mix(warn), mix(broken, washStrength), mix(idle), mix(idle, washStrength)]);
    expect(pixels({ stale: true }))
      .toEqual([warn, broken, idle, idle].map((c) => mix(c, STALE_WASH)));
    expect(pixels({ highlightTag: 'big', tint: 'score' })).toEqual([
      mix(ramp(0.5)), mix(ramp(0.5)), mix(dim, 0, dimAlpha), mix(dim, 0, dimAlpha)]);
    expect(pixels({ stale: true, tint: 'score' })).toEqual([
      mix(ramp(0.5), STALE_WASH), mix(ramp(0.5), STALE_WASH), mix(ramp(1), STALE_WASH),
      mix(base.palette.unmatched.fill, STALE_WASH)]);
  });

  it('keeps the unhovered tiles through a hover, and drops them when the scene changes under it', () => {
    const { make } = surfaces();
    const base = scene(items, 1, 8);
    let held = nextTiles({ tiles: null, unhovered: null }, base, base, make);
    const unhovered = held.tiles!;
    held = nextTiles(held, { ...base, highlight: 'warn' }, base, make);
    expect(held.tiles).not.toBe(unhovered);
    held = nextTiles(held, { ...base, highlightTag: 'big' }, base, make);
    expect(held.unhovered).toBe(unhovered);
    held = nextTiles(held, base, base, make);
    expect(held.tiles).toBe(unhovered);

    const hovered = nextTiles(held, { ...base, highlight: 'warn' }, base, make);
    const refiltered = { ...base, stale: true };
    const moved = nextTiles(hovered, { ...refiltered, highlight: 'warn' }, refiltered, make);
    expect(moved.unhovered).toBeNull();
    expect(nextTiles(moved, refiltered, refiltered, make).tiles).not.toBe(unhovered);
  });

  it('reuses the surfaces of a scene nothing draws from, and never those of the held unhovered one', () => {
    const { made, make } = surfaces();
    const base = scene(items, 1, 8);
    const view = [cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000] as const;
    let held = nextTiles({ tiles: null, unhovered: null }, base, base, make);
    held.tiles!.draw(fakeContext(), ...view);
    const unhoveredSurfaces = [...made];
    for (const highlight of ['warn', 'broken', 'noted']) {
      held = nextTiles(held, { ...base, highlight }, base, make);
      held.tiles!.draw(fakeContext(), ...view);
    }
    // Three hovers drew three scenes; the first hover's was dropped from the chain and reused.
    expect(made.length).toBe(unhoveredSurfaces.length * 3);
    expect(held.unhovered!.peek(tileKey(0, 0, 0))).toBe(unhoveredSurfaces[0]);
    held = nextTiles(held, base, base, make);
    expect(held.tiles!.peek(tileKey(0, 0, 0))).toBe(unhoveredSurfaces[0]);
  });

  it('draws larger cells through paint, without badges or captions', () => {
    const s = scene(items.slice(0, 4), 64, 2);
    const { made, make } = surfaces();
    new TileCache(s, make).draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000);
    const names = (made[0]!.ctx as ReturnType<typeof fakeContext>).calls.map(([name]) => name);
    expect(names).toContain('fillRect');
    expect(names).not.toContain('putImageData');
    expect(names).not.toContain('fillText');
  });

  it('fades a new tile in over what stood in for it, and says so until it is done', () => {
    const { make } = surfaces();
    const old = new TileCache(scene(items, 1, 8), make);
    old.draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000);
    const next = new TileCache(scene(items, 1, 8), make, old);
    let t = 1000;
    const ctx = fakeContext();
    const frame = next.draw(ctx, cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000, () => t);
    expect(frame).toMatchObject({ complete: true, animating: true });
    const drawn = ctx.calls.filter(([name]) => name === 'drawImage').map(([, args]) => args[0]);
    expect(drawn[0]).toBe(old.peek(tileKey(0, 0, 0))!.canvas);
    t += FADE_MS;
    expect(next.draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000, () => t))
      .toMatchObject({ complete: true, animating: false });
  });

  it('stands in with the finer tiles it holds when zooming out', () => {
    const { make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make);
    cache.draw(fakeContext(), cam(0, 0, 1), { width: 1024, height: 1024 }, 1, 1000);
    const ctx = fakeContext();
    let t = 0;
    // The floor renders first and uses the only render this frame allows.
    cache.draw(ctx, cam(0, 0, 0.5), { width: 1024, height: 512 }, 1, 0, () => (t += 1));
    const quarters = ctx.calls.filter(([name, args]) => name === 'drawImage' && args.length === 5
      && (args[3] as number) === TILE_PX / 2);
    expect(quarters.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps the floor level, which holds the whole wall, past the eviction limit', () => {
    const { make } = surfaces();
    // 8 cells of 32 is 256 wide, which two tiles a side at level 2 hold.
    const cache = new TileCache(scene(items, 32, 8), make, null, 1);
    cache.render(at(2, 0, 0));
    cache.render(at(4, 0, 0));
    cache.render(at(4, 1, 0));
    expect(cache.has(tileKey(2, 0, 0))).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('renders a margin off screen and the level above with time left over', () => {
    const { make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make);
    const frame = cache.draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000);
    expect(frame.pending).toBe(false);
    expect(cache.has(tileKey(0, 1, 0))).toBe(true);
    expect(cache.has(tileKey(0, -2, 2))).toBe(true);
    expect(cache.has(tileKey(-1, 0, 0))).toBe(true);
  });

  it('says tiles off screen are pending when the frame runs out of time', () => {
    const { make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make);
    let t = 0;
    const frame = cache.draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 5, () => (t += 3));
    expect(frame).toMatchObject({ complete: true, pending: true });
  });

  it('leans the margin the way the view last moved', () => {
    const { make } = surfaces();
    const cache = new TileCache(scene(items, 1, 8), make);
    const view = { width: 512, height: 512 };
    cache.draw(fakeContext(), cam(0, 0, 1), view, 1, 1000);
    // Moving right by a tile, with time for just one off-screen tile.
    let t = 0;
    const clock = () => (t += 1);
    cache.draw(fakeContext(), cam(40, 0, 1), view, 1, 3, clock);
    expect(cache.has(tileKey(0, 2, 0)) || cache.has(tileKey(0, 3, 0))).toBe(true);
  });

  it('writes borderless square cells below glyph size as pixels when there is no sheet', () => {
    const s = scene(items.slice(0, 4), 12, 2);
    const plain = { ...s, compiled: compile({ ...SPEC, states: SPEC.states.map((st) => ({ ...st, border: null, shape: 'square' as const, variants: undefined })), variants: [] }) };
    plain.facts = derive(plain.compiled, items.slice(0, 4));
    const { made, make } = surfaces();
    new TileCache(plain, make).draw(fakeContext(), cam(0, 0, 1), { width: 512, height: 512 }, 1, 1000);
    expect((made[0]!.ctx as ReturnType<typeof fakeContext>).image).toBeDefined();
  });
});
