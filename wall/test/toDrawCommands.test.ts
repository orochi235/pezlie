import { ellipsePath } from '@weasel-js/core';
import { expect, it } from 'vitest';
import { CIRCLE_SCALE } from '../src/draw2d';
import type { PaintCommand } from '../src/paint';
import { UNSUPPORTED, toDrawCommands } from '../src/toDrawCommands';

const SHEET = {} as ImageBitmap;

const fill = (over: Partial<Extract<PaintCommand, { kind: 'fill' }>> = {}): PaintCommand => ({
  kind: 'fill', dx: 0, dy: 0, dw: 40, dh: 40, fill: '#aabbcc',
  border: null, borderWidth: 0, shape: 'square', slash: false, ...over,
});

const sprite = (over: Partial<Extract<PaintCommand, { kind: 'sprite' }>> = {}): PaintCommand => ({
  kind: 'sprite', dx: 10, dy: 20, dw: 60, dh: 60,
  sx: 4, sy: 8, sw: 32, sh: 32, ground: '#eeeeee', ...over,
});

it('names each feature it declines', () => {
  const cases: [PaintCommand, string][] = [
    [{ kind: 'label', text: 'north', count: 2, dx: 0, dy: 0, size: 12, depth: 0 }, 'band label'],
    [sprite({ badges: [{ tag: 'star', field: '#ffffff', ink: '#000000', corner: 'tr' }] }), 'badges'],
    [sprite({ captions: [{ text: 'A1', corner: 'bl', ink: '#222222' }] }), 'captions'],
    [fill({ mark: 'pin' }), 'mark'],
    [fill({ glyph: 'G' }), 'glyph'],
  ];
  for (const [cmd, feature] of cases) {
    expect([...toDrawCommands([cmd], SHEET).unsupported], feature).toEqual([feature]);
  }
  expect(UNSUPPORTED.mark).toBe('mark');
  expect(UNSUPPORTED.glyph).toBe('glyph');
});

it('maps a plain fill to a filled rect and a round one to an inset ellipse', () => {
  const { commands, unsupported } = toDrawCommands([fill(), fill({ shape: 'circle' })], SHEET);
  expect(unsupported.size).toBe(0);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({ kind: 'path', fill: { paint: { color: '#aabbcc' } } });
  const size = 40 * CIRCLE_SCALE;
  const inset = (40 - size) / 2;
  expect(commands[1]).toEqual({
    kind: 'path', fill: { paint: { color: '#aabbcc' } },
    path: ellipsePath({ x: inset, y: inset, width: size, height: size }),
  });
});

it('maps a sprite to its ground and its tile, and washes in the passed color', () => {
  const plain = toDrawCommands([sprite()], SHEET, 'linear');
  expect(plain.unsupported.size).toBe(0);
  expect(plain.commands).toMatchObject([
    { kind: 'path', fill: { paint: { color: '#eeeeee' } } },
    { kind: 'image', image: SHEET, x: 10, y: 20, w: 60, h: 60,
      source: { x: 4, y: 8, w: 32, h: 32 }, sampling: 'linear' },
  ]);
  const washed = toDrawCommands([sprite({ wash: 0.5 })], SHEET, 'nearest', '#123456');
  expect(washed.commands[2]).toMatchObject({ kind: 'path', fill: { paint: { color: '#123456', opacity: 0.5 } } });
});

it('maps a glyphed cell to its ground, as faint as draw2d draws it', async () => {
  const { glyphBlend } = await import('../src/paint');
  const { commands } = toDrawCommands([fill({ glyph: 'G', cover: 0.2 })], SHEET);
  expect(commands).toMatchObject([
    { kind: 'path', fill: { paint: { color: '#aabbcc', opacity: glyphBlend(40, 0.2).ground } } },
  ]);
});

it('groups a dimmed sprite under its alpha', () => {
  const { commands } = toDrawCommands([sprite({ alpha: 0.25 })], SHEET);
  expect(commands).toMatchObject([{ kind: 'group', alpha: 0.25 }]);
});

it('skips a sprite when there is no sheet', () => {
  expect(toDrawCommands([sprite()], null).commands).toEqual([]);
});
