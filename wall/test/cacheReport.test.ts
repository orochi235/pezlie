import { expect, it, vi } from 'vitest';
import { cacheReport, findings, probeCell, rungName } from '../src/cacheReport';
import type { CacheReportInput } from '../src/cacheReport';
import { VECTOR_LEVEL } from '../src/levels';

const healthy: CacheReportInput = {
  slot: 'outline-second',
  cellPx: 300,
  dpr: 2,
  level: VECTOR_LEVEL,
  cells: { shown: 9000, visible: 20, visibleWithSha: 20 },
  sheets: [{ level: 8, loaded: true, version: 'v1', baked: 9000 },
           { level: 32, loaded: true, version: 'v1', baked: 9000 }],
  loose: { loaded: 40, requested: 40 },
  vector: { resident: 20, inFlight: 0, queued: 0, bytesCached: 20,
            rasterPx: [600] },
};

const only = (input: CacheReportInput) => findings(input).join(' | ');

it('says so plainly when nothing is wrong', () => {
  expect(findings(healthy)).toEqual([expect.stringContaining('nothing wrong')]);
});

it('names the rung in the words the code uses', () => {
  expect(rungName(8)).toBe('sheet-8');
  expect(rungName(32)).toBe('sheet-32');
  expect(rungName(128)).toBe('loose');
  expect(rungName(VECTOR_LEVEL)).toBe('vector');
  expect(rungName(128, { sheets: [16, 64], loose: 256 })).toBe('sheet-128');
});

it('catches a wall stuck on upscaled 128px thumbs', () => {
  const report = cacheReport({ ...healthy, level: 128 });
  expect(report.ladder).toMatchObject({ rung: 'loose', wants: 'vector', loose: 128 });
  expect(only({ ...healthy, level: 128 }))
    .toContain('every cell is an upscaled 128px PNG');
});

it('quotes the slot\'s own loose level', () => {
  const ladder = { sheets: [16, 64], loose: 256 };
  expect(only({ ...healthy, level: 256, ladder }))
    .toContain('every cell is an upscaled 256px PNG');
  expect(cacheReport({ ...healthy, level: 256, ladder }).ladder)
    .toEqual({ rung: 'loose', wants: 'vector', sheets: [16, 64], loose: 256 });
});

it('catches a slot whose rows carry no hash', () => {
  // Both upper rungs skip an item with no sha, so neither asks for anything
  // and no error is raised anywhere.
  const blind = { ...healthy,
                  cells: { shown: 9000, visible: 20, visibleWithSha: 0 } };
  expect(only(blind)).toContain('no visible cell has a sha256');
  expect(cacheReport(blind).cells.visibleWithoutSha).toBe(20);
});

it('reports the pixel budget starving a big viewport', () => {
  const crowded = { ...healthy, cellPx: 512,
                    cells: { shown: 9000, visible: 400, visibleWithSha: 400 } };
  const report = cacheReport(crowded);
  expect(report.budget.starved).toBe(true);
  expect(only(crowded)).toContain('the pixel budget holds');
});

it('does not call the budget starved below the vector rung', () => {
  // Below the vector rung nothing is rasterized, so naming the cap sends the reader to
  // the wrong rung.
  const report = cacheReport({ ...healthy, level: 32,
    cells: { shown: 9000, visible: 400, visibleWithSha: 400 } });
  expect(report.budget.starved).toBe(false);
});

it('catches the vector rung being idle when it should be working', () => {
  expect(only({ ...healthy,
    vector: { resident: 0, inFlight: 0, queued: 0, bytesCached: 0, rasterPx: [] } }))
    .toContain('the work is not being asked for at all');
});

it('catches loose thumbs that were all asked for and never arrived', () => {
  expect(only({ ...healthy, level: 128,
                loose: { loaded: 0, requested: 200 } }))
    .toContain('200 loose thumbs were requested and none loaded');
});

it('catches a sheet that never loaded, and says to re-bake the slot', () => {
  const report = only({ ...healthy,
    sheets: [{ level: 8, loaded: false, version: null, baked: 0 },
             { level: 32, loaded: true, version: 'v1', baked: 9000 }] });
  expect(report).toContain('sheet-8 never loaded');
  expect(report).toContain('re-bake the slot');
});

it('surfaces the fetch status the wall swallows', () => {
  const probes = [{ id: 'a1', url: '/api/corpus/render/second/a1.svg',
                    status: 404, contentType: null, bytes: null, error: null }];
  expect(findings(healthy, probes).join(' | '))
    .toContain('the render URL answered 404');
});

it('surfaces the rasterize error the wall swallows', () => {
  const probes = [{ id: 'a1', url: '/x.svg', status: 200,
                    contentType: 'image/svg+xml', bytes: 12,
                    error: 'no element found' }];
  expect(findings(healthy, probes).join(' | '))
    .toContain('failed to rasterize -- no element found');
});

it('probes a cell by walking the same two steps the rung does', async () => {
  const fetch = vi.fn(async () => new Response('nope', { status: 500 }));
  const probe = await probeCell('a1', '/api/x.svg', 512, { fetch } as never);
  expect(probe).toMatchObject({ id: 'a1', status: 500, bytes: null });
  // A non-ok response is not rasterized, so no parse error distracts from it.
  expect(probe.error).toBeNull();
});

it('reports a fetch that never answered', async () => {
  const fetch = vi.fn(async () => { throw new Error('Failed to fetch'); });
  const probe = await probeCell('a1', '/api/x.svg', 512, { fetch } as never);
  expect(probe.status).toBeNull();
  expect(probe.error).toBe('fetch: Failed to fetch');
});

it('refuses to report on a wall that has not drawn yet', () => {
  const cold = findings({ ...healthy, cellPx: 0, level: 32,
    cells: { shown: 0, visible: 0, visibleWithSha: 0 },
    sheets: [{ level: 8, loaded: false, version: null, baked: 0 }] });
  expect(cold).toEqual([expect.stringContaining('has not laid out yet')]);
});
