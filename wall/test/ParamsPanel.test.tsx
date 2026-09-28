import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { paramSchema } from '../src/params';
import { ParamsPanel } from '../src/ParamsPanel';
import { expandStates } from '../src/states';
import { SPEC } from './fixture';

afterEach(cleanup);

const schema = paramSchema(expandStates(SPEC));
const panel = (props: Partial<Parameters<typeof ParamsPanel>[0]> = {}) => (
  <ParamsPanel schema={schema} params={schema.defaults} setParam={vi.fn()} reset={vi.fn()}
               {...props} />
);

it('renders a heading per group', () => {
  render(panel());
  expect(screen.getByText('Layout')).toBeTruthy();
  expect(screen.getByText('Appearance')).toBeTruthy();
  expect(screen.getByText('Feel')).toBeTruthy();
});

it('writes a slider change through setParam', () => {
  const setParam = vi.fn();
  const { container } = render(panel({ setParam }));
  // Layout's first field, `cell`, is the first range input in the panel.
  const slider = container.querySelector('input[type="range"]')!;
  fireEvent.change(slider, { target: { value: '64' } });
  expect(setParam).toHaveBeenCalledWith('cell', 64);
});

it('writes a color change through setParam', () => {
  const setParam = vi.fn();
  const { container } = render(panel({ setParam }));
  const swatch = container.querySelector('input[type="color"]')!;
  fireEvent.input(swatch, { target: { value: '#123456' } });
  expect(setParam).toHaveBeenCalledWith(expect.any(String), '#123456');
});

it('draws a color row for each state the schema was generated from', () => {
  render(panel());
  expect(screen.getByText('Warn-remote border')).toBeTruthy();
  expect(screen.getByText('Hidden fill')).toBeTruthy();
});

it('calls reset from its own button', () => {
  const reset = vi.fn();
  render(panel({ reset }));
  fireEvent.click(screen.getByRole('button', { name: 'reset' }));
  expect(reset).toHaveBeenCalled();
});

it('sits inline with nothing to dismiss: the sidebar owns whether it shows', () => {
  const { container } = render(panel());
  expect(container.querySelector('.wall-params-panel')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /close params/i })).toBeNull();
});
