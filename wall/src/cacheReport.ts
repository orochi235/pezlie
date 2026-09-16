import { DEFAULT_LADDER, levelFor, VECTOR_LEVEL, type Ladder } from './levels';
import { PIXEL_BUDGET, residentCap, targetPxFor } from './useVectorThumbs';

/** Why the wall can stop sharpening.
 *
 *  Every rung above the sprite sheets fails quietly by design, which is right
 *  for one bad item and indistinguishable from a broken rung when it is every
 *  item. This report tells the two apart. */
export interface CacheReportInput {
  slot: string;
  /** On-screen cell size in CSS px, and the device ratio the rasters use. */
  cellPx: number;
  dpr: number;
  /** The rung in hand, as `pickLevel` last settled it. */
  level: number;
  /** The levels the slot was baked at; `DEFAULT_LADDER` when absent. */
  ladder?: Ladder;
  cells: { shown: number; visible: number; visibleWithSha: number };
  sheets: { level: number; loaded: boolean; version: string | null;
            baked: number }[];
  loose: { loaded: number; requested: number };
  vector: { resident: number; inFlight: number; queued: number;
            bytesCached: number; rasterPx: number[] };
  /** One per sampled cell, from `probeCell`. */
  probes?: CacheProbe[];
}

/** What actually came back for one visible cell's render URL. */
export interface CacheProbe {
  id: string;
  url: string;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  /** The rasterize error, verbatim -- normally swallowed by design. */
  error: string | null;
}

export interface CacheReport {
  when: string;
  slot: string;
  camera: { cellPx: number; dpr: number; targetPx: number };
  /** Rungs by name, since the vector rung is past every number. */
  ladder: { rung: string; wants: string; sheets: readonly number[]; loose: number };
  cells: { shown: number; visible: number; visibleWithSha: number;
           visibleWithoutSha: number };
  budget: { pixelBudget: number; residentCap: number; starved: boolean };
  rungs: Pick<CacheReportInput, 'sheets' | 'loose' | 'vector'>;
  probes: CacheProbe[];
  findings: string[];
}

/** The rung a level is on, in the words the code uses for it. */
export function rungName(level: number, ladder: Ladder = DEFAULT_LADDER): string {
  if (level >= VECTOR_LEVEL) return 'vector';
  if (level >= ladder.loose) return 'loose';
  return `sheet-${level}`;
}

/** Plain statements about what is wrong, derived only from the numbers.
 *
 *  Ordered by where the ladder breaks, not severity: reporting a raster fault
 *  on a wall that never reaches the vector rung invites fixing the wrong one. */
export function findings(input: CacheReportInput,
                         probes: CacheProbe[] = []): string[] {
  const out: string[] = [];
  const { cellPx, dpr, level, cells } = input;
  const ladder = input.ladder ?? DEFAULT_LADDER;
  const targetPx = targetPxFor(cellPx, dpr);
  const wants = levelFor(cellPx, ladder);

  if (cellPx <= 0) {
    return ['the wall has not laid out yet: no camera, so no cell size and '
      + 'nothing has been asked for. Reopen this once cells are on screen.'];
  }

  if (wants > level) {
    out.push(`the ladder is behind: ${cellPx.toFixed(0)}px cells want `
      + `${rungName(wants, ladder)} and the wall is holding ${rungName(level, ladder)}. `
      + `Hysteresis keeps a rung until the cell size is half again past its `
      + `band, so this is only wrong if it persists once the camera stops.`);
  }
  if (level < VECTOR_LEVEL && cellPx > ladder.loose) {
    out.push(`cells are ${cellPx.toFixed(0)}px but the level is ${level}: `
      + `above ${ladder.loose}px every cell is an upscaled ${ladder.loose}px PNG.`);
  }
  if (cells.visible > 0 && cells.visibleWithSha === 0) {
    out.push('no visible cell has a sha256, so both upper rungs skip every '
      + 'one of them. The host is serving items with no render hash, or has '
      + 'not indexed the slot\'s renders.');
  }
  const cap = residentCap(targetPx);
  if (level >= VECTOR_LEVEL && cells.visibleWithSha > cap) {
    out.push(`${cells.visibleWithSha} visible cells want a raster and the `
      + `pixel budget holds ${cap} at ${targetPx}px. The cells past the cap `
      + `stay on their loose tile until the viewport holds fewer.`);
  }
  if (level >= VECTOR_LEVEL && input.vector.resident === 0
      && input.vector.inFlight === 0 && input.vector.queued === 0
      && cells.visibleWithSha > 0) {
    out.push('at the vector rung with nothing rasterized, nothing in flight '
      + 'and nothing queued: the work is not being asked for at all.');
  }
  if (level >= ladder.loose && input.loose.requested > 0
      && input.loose.loaded === 0) {
    out.push(`${input.loose.requested} loose thumbs were requested and none `
      + `loaded. The ${ladder.loose}px bake is missing for this slot, or its `
      + 'URLs are failing -- an image error here is not reported anywhere else.');
  }
  for (const sheet of input.sheets) {
    if (!sheet.loaded) {
      out.push(`sheet-${sheet.level} never loaded, so cells below `
        + `${ladder.loose}px have no tile to draw: re-bake the slot.`);
    } else if (sheet.baked === 0) {
      out.push(`sheet-${sheet.level} loaded with an empty manifest.`);
    }
  }
  for (const probe of probes) {
    if (probe.status !== null && probe.status !== 200) {
      out.push(`${probe.id}: the render URL answered ${probe.status}. `
        + 'A failed fetch here is swallowed on purpose, so this is the error '
        + 'the wall cannot show you.');
    } else if (probe.error) {
      out.push(`${probe.id}: fetched ${probe.bytes ?? '?'} bytes and failed `
        + `to rasterize -- ${probe.error}`);
    }
  }
  if (out.length === 0) {
    out.push('nothing wrong found: the rung matches the cell size, the '
      + 'budget is not starved, and a sampled cell fetches and rasterizes.');
  }
  return out;
}

export function cacheReport(input: CacheReportInput): CacheReport {
  const probes = input.probes ?? [];
  const ladder = input.ladder ?? DEFAULT_LADDER;
  const targetPx = targetPxFor(input.cellPx, input.dpr);
  return {
    when: new Date().toISOString(),
    slot: input.slot,
    camera: { cellPx: input.cellPx, dpr: input.dpr, targetPx },
    ladder: {
      rung: rungName(input.level, ladder),
      wants: rungName(levelFor(input.cellPx, ladder), ladder),
      sheets: ladder.sheets,
      loose: ladder.loose,
    },
    cells: {
      ...input.cells,
      visibleWithoutSha: input.cells.visible - input.cells.visibleWithSha,
    },
    budget: {
      pixelBudget: PIXEL_BUDGET,
      residentCap: residentCap(targetPx),
      starved: input.level >= VECTOR_LEVEL
        && input.cells.visibleWithSha > residentCap(targetPx),
    },
    rungs: { sheets: input.sheets, loose: input.loose, vector: input.vector },
    probes,
    findings: findings(input, probes),
  };
}

/** Fetch and rasterize one cell's render for real, with the errors the vector
 *  rung swallows left in. The only part of the report that touches the network. */
export async function probeCell(id: string, url: string, targetPx: number,
                                deps = { fetch: globalThis.fetch.bind(globalThis) }):
                                Promise<CacheProbe> {
  const probe: CacheProbe = { id, url, status: null, contentType: null,
                              bytes: null, error: null };
  let blob: Blob;
  try {
    const response = await deps.fetch(url);
    probe.status = response.status;
    probe.contentType = response.headers.get('content-type');
    if (!response.ok) return probe;
    blob = await response.blob();
    probe.bytes = blob.size;
  } catch (e) {
    probe.error = `fetch: ${e instanceof Error ? e.message : String(e)}`;
    return probe;
  }
  try {
    const { rasterize } = await import('./svgRaster');
    await rasterize(blob, targetPx, targetPx);
  } catch (e) {
    probe.error = e instanceof Error ? e.message : String(e);
  }
  return probe;
}
