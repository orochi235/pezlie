import {
  useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode,
} from 'react';
import {
  clientToCanvas, fitViewToBounds, useCanvasSize, useViewAnimation, zoomAt, type View,
} from '@weasel-js/core';
import { LabShell } from '@weasel-js/labkit';
import { ToggleBar } from '@weasel-js/ui';
import { CacheFailureButton } from './CacheFailureButton';
import { cacheReport } from './cacheReport';
import { compileSpec, type CompiledSpec, type CompileError } from './cel';
import { clampWallView, DEFAULT_BLANK_PX, sameView } from './clamp';
import { derive, rederive, rowOfId, type Facts } from './derive';
import type { DrawOptions } from './draw2d';
import { ItemCard } from './ItemCard';
import { gridLayout, rectAt, visibleCount, visiblePositions, type Layout } from './layout';
import { Legend } from './Legend';
import { DEFAULT_LADDER, levelFor, pickLevel, sheetFor, type Ladder } from './levels';
import { paramSchema, type Params } from './params';
import { BADGE_MIN_PX, type Appearance } from './paint';
import { centerReveal } from './reveal';
import type { CorpusSpec, Item } from './schema';
import { applySelection } from './select';
import { staleCountOf } from './sheet';
import type { ItemStore } from './store';
import { Sidebar, type SidebarSelection } from './Sidebar';
import { STATUS } from './tint';
import type { SlotUrls } from './urls';
import { useItems, type FetchItems } from './useItems';
import { useLooseThumbs, type LooseHandle } from './useLooseThumbs';
import { useParams } from './useParams';
import { useSheets, type Sheet } from './useSheets';
import { targetPxFor, useVectorThumbs, type VectorHandle } from './useVectorThumbs';
import { useVisualViewport } from './useVisualViewport';
import { Wall } from './Wall';
import './WallView.css';

const IDENTITY_VIEW: View = { x: 0, y: 0, scale: { x: 1, y: 1 } };
/** Past this the compositor magnifies; the backing store costs its square. */
const MAX_PIXEL_SCALE = 3;
/** Slack around a pinched slice, so a pinch-pan has cells to reveal before
 *  its scroll event lands. */
const SLICE_PAD = 0.25;
const NONE = { key: 'none', label: 'nothing' };
const NO_ROWS = new Uint32Array(0);
/** The most cells on screen that the loose and vector rungs will fetch for. */
const MAX_THUMB_CELLS = 5_000;
/** How much of the viewport's height a revealed cell fills at least. */
const REVEAL_MIN_HEIGHT = 0.5;
/** How far past each edge of the screen, in screens, pictures load ahead. */
const THUMB_OVERSCAN = 0.5;

export interface WallGrouping<T extends Item> {
  key: string;
  label: string;
  /** The direction toggle's label, where the grouping's order has one. */
  desc?: string;
  layout: (desc: boolean) => Layout<T>;
}

export interface WallViewState {
  slot: string;
  selection: SidebarSelection;
  /** The item whose detail view is open. */
  opened: string | null;
}

/** What `reveal` found: drawn and now centered, loaded but hidden by the
 *  selection, or not in the drawn slot at all. */
export type RevealResult = 'shown' | 'filtered' | 'absent';

/** The slot state a host's header controls read and drive. `slots` is empty,
 *  and `slot` may be `''`, until the host's list arrives. */
export interface WallHeader {
  slots: { slot: string; n: number }[];
  slot: string;
  setSlot: (slot: string) => void;
  reveal: (id: string) => RevealResult;
}

export interface WallViewProps<T extends Item> {
  title: string;
  spec: CorpusSpec<T>;
  urls: SlotUrls;
  fetchItems: FetchItems<T>;
  fetchSlots: () => Promise<{ slot: string; n: number }[]>;
  /** The slot opened with nothing chosen; else the first the host lists. */
  defaultSlot?: string;
  /** Where the params panel persists. */
  storageKey: string;
  cssRoot?: string;
  pages?: ComponentProps<typeof LabShell>['pages'];
  /** Controls before the panels toggle, after the slot picker when it is
   *  drawn. A function gets the slot state and `reveal`, for a host drawing
   *  its own picker or search. Not drawn when `compact`. */
  header?: ReactNode | ((wall: WallHeader) => ReactNode);
  /** False drops the built-in slot select, for a host that draws its own. */
  slotPicker?: boolean;
  groupings?: WallGrouping<T>[];
  facet?: { key: string; label: string; groupOf?: (value: string) => string | null };
  /** The body of the card a click opens. No card without it. `open` opens the
   *  detail view, as a double click does; `tint` is what the wall is colored by. */
  renderCard?: (item: T, slot: string, card: { open: () => void; tint: string }) => ReactNode;
  /** The view a double click opens. */
  renderDetail?: (item: T, slot: string, close: () => void) => ReactNode;
  linkedBadges?: readonly string[];
  /** The id a linked badge leads to. */
  linkTarget?: (item: T, tag: string) => string | null;
  drawMark?: DrawOptions['drawMark'];
  washColor?: string;
  ground?: string;
  describe?: (item: T) => string;
  initial?: { slot?: string; selection?: Partial<SidebarSelection>; opened?: string | null };
  /** Everything a host would put in an address bar, whenever it changes. */
  onChange?: (state: WallViewState) => void;
  /** Just the wall and its card: no header, sidebar or legend. For a page
   *  embedded somewhere too small for the chrome. */
  compact?: boolean;
  /** The color mode; by default the viewer's. */
  mode?: ComponentProps<typeof LabShell>['mode'];
  /** Params a first visit starts from, before anything is stored. Pass a
   *  stable object. */
  paramDefaults?: Partial<Params>;
}

/** The whole wall as a standalone lab page: slots, selection, layout, camera,
 *  the image rungs, and the chrome around the canvas. */
export function WallView<T extends Item>(props: WallViewProps<T>) {
  const { compiled, errors } = useMemo(() => compileSpec(props.spec), [props.spec]);
  if (!compiled) return <SpecProblems title={props.title} errors={errors} />;
  return <WallViewBody {...props} compiled={compiled} />;
}

/** A spec with mistakes says all of them in place of the wall: a filter that
 *  silently keeps nothing is an hour of chasing. */
function SpecProblems({ title, errors }: { title: string; errors: CompileError[] }) {
  return (
    <LabShell title={title}>
      <div className="wall-problems" role="alert">
        <h2>The corpus spec has {errors.length} problem{errors.length === 1 ? '' : 's'}</h2>
        <ul>
          {errors.map((e) => (
            <li key={`${e.table}.${e.key}`}>
              <code>{e.table}.{e.key}</code> {e.message}
            </li>
          ))}
        </ul>
      </div>
    </LabShell>
  );
}

function initialSelection<T extends Item>(compiled: CompiledSpec<T>,
                                          given?: Partial<SidebarSelection>): SidebarSelection {
  return {
    sort: compiled.spec.sorts[0]?.key ?? '',
    filter: compiled.spec.filters[0]?.key ?? '',
    shown: {}, exclude: {}, tags: [],
    tint: STATUS, gradient: 'ember', grouping: NONE.key, desc: true,
    ...given,
  };
}

function WallViewBody<T extends Item>({
  compiled, title, urls, fetchItems, fetchSlots, defaultSlot, storageKey, cssRoot = '--wall',
  pages, header, slotPicker = true, groupings = [], facet, renderCard, renderDetail, linkedBadges,
  linkTarget, drawMark, washColor, ground, describe, initial, onChange, compact = false, mode,
  paramDefaults,
}: WallViewProps<T> & { compiled: CompiledSpec<T> }) {
  const schema = useMemo(() => {
    const base = paramSchema(compiled.states);
    return paramDefaults ? { ...base, defaults: { ...base.defaults, ...paramDefaults } as Params } : base;
  }, [compiled, paramDefaults]);
  const { params, setParam, reset: resetParams } = useParams(schema, { storageKey, root: cssRoot });

  const [slots, setSlots] = useState<{ slot: string; n: number }[]>([]);
  const [slot, setSlot] = useState(initial?.slot ?? defaultSlot ?? '');
  // Nothing is fetched until there is a slot to fetch.
  const fetchSlot = useCallback<FetchItems<T>>(
    (s, since) => (s ? fetchItems(s, since) : new Promise(() => {})), [fetchItems]);
  const fetched = useItems(fetchSlot, slot, params.pollMs);
  const loaded = useSheets(urls, slot);
  const [level, setLevel] = useState(DEFAULT_LADDER.sheets[DEFAULT_LADDER.sheets.length - 1]!);
  const [selection, setSelection] = useState(() => initialSelection(compiled, initial?.selection));
  const [cam, setCam] = useState<View | null>(null);
  const [opened, setOpened] = useState<string | null>(initial?.opened ?? null);
  // The row as well as the id: finding a row by id means reading every id in
  // the store, which at a million items is a second.
  const [carded, setCarded] = useState<{ id: string; row: number; at: { x: number; y: number } } | null>(null);
  const [openedRow, setOpenedRow] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [highlightTag, setHighlightTag] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);
  const [explicitCaret, setExplicitCaret] = useState<number | null>(null);
  // A ref: the wheel handler reads it in the same tick the pointer moved.
  const overCard = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const { width, height } = useCanvasSize(box);
  const size = useMemo(() => ({ width, height }), [width, height]);

  // The panels set their own width from this property, and the pan allowance
  // has to be the same number.
  const [blankPx, setBlankPx] = useState(DEFAULT_BLANK_PX);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const declared = getComputedStyle(el).getPropertyValue(`${cssRoot}-panel-width`).trim();
    const px = declared.endsWith('rem')
      ? parseFloat(declared) * parseFloat(getComputedStyle(document.documentElement).fontSize)
      : parseFloat(declared);
    if (Number.isFinite(px) && px > 0) setBlankPx(px);
  }, [width, cssRoot]);

  const vv = useVisualViewport();
  const pixelScale = Math.min(vv.scale, MAX_PIXEL_SCALE);
  const slice = useMemo(() => {
    const el = box.current;
    if (!el || vv.scale <= 1) return { x: 0, y: 0, width, height };
    const r = el.getBoundingClientRect();
    const padX = vv.width * SLICE_PAD;
    const padY = vv.height * SLICE_PAD;
    const x0 = Math.max(0, vv.left - r.left - padX);
    const y0 = Math.max(0, vv.top - r.top - padY);
    const x1 = Math.min(width, vv.left + vv.width - r.left + padX);
    const y1 = Math.min(height, vv.top + vv.height - r.top + padY);
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }, [vv, width, height]);

  const touched = useRef(false);
  const camInitialized = useRef(false);
  const camRef = useRef<View | null>(null);
  camRef.current = cam;
  const fittedGrouping = useRef(selection.grouping);

  // Polled: a slot appears when the host indexes it. A later poll never moves
  // anyone off the slot they are looking at — including one picked before the
  // first poll lands.
  const opens = useRef(!!slot);
  const chooseSlot = useCallback((s: string) => { opens.current = true; setSlot(s); }, []);
  useEffect(() => {
    let live = true;
    const load = () => void fetchSlots().then((got) => {
      if (!live) return;
      setSlots(got);
      if (!opens.current && got[0]) {
        opens.current = true;
        setSlot(got[0].slot);
      }
    }).catch(() => {});
    load();
    const id = setInterval(load, params.pollMs);
    return () => { live = false; clearInterval(id); };
  }, [fetchSlots, params.pollMs]);

  // What is on screen: the newest slot whose items and sheets are both in
  // hand. A new slot's items beside the old slot's sheets would draw every
  // cell stale, so the two travel together.
  const drawn = useRef<{ slot: string; store: ItemStore<T>; sheets: Record<number, Sheet>;
                         ladder: Ladder; changed: number[] | null } | null>(null);
  if (fetched.store && fetched.slot === loaded.slot
      && (drawn.current?.store !== fetched.store || drawn.current.sheets !== loaded.sheets)) {
    drawn.current = { slot: fetched.slot, store: fetched.store, sheets: loaded.sheets,
                      ladder: loaded.ladder,
                      changed: drawn.current?.slot === fetched.slot ? fetched.changed : null };
  }
  const view = drawn.current;
  const sheets = view?.sheets ?? {};
  const ladder = view?.ladder ?? DEFAULT_LADDER;
  const drawnSlot = view?.slot ?? slot;
  const stale = view !== null && drawnSlot !== slot;

  const derived = useRef<{ compiled: CompiledSpec<T>; slot: string; store: ItemStore<T>;
                           facts: Facts<T> } | null>(null);
  const facts = useMemo(() => {
    if (!view) return null;
    const held = derived.current;
    if (held && held.compiled === compiled && held.store === view.store) return held.facts;
    let next: Facts<T>;
    if (held && held.compiled === compiled && held.slot === view.slot && view.changed
        && held.store.length === view.store.length) {
      rederive(compiled, held.facts, view.store, view.changed);
      // A new wrapper over the same columns, so everything keyed on it recomputes.
      next = { ...held.facts };
    } else {
      next = derive(compiled, view.store);
    }
    derived.current = { compiled, slot: view.slot, store: view.store, facts: next };
    return next;
  }, [compiled, view]);

  const rows = useMemo(
    () => (facts ? applySelection(compiled, facts, selection) : NO_ROWS),
    [compiled, facts, selection]);
  // What the legend's tag rows count over: picking a tag must not zero the rest.
  const tagRows = useMemo(
    () => (facts && (selection.tags?.length ?? 0) > 0
      ? applySelection(compiled, facts, { ...selection, tags: [] }) : rows),
    [compiled, facts, selection, rows]);

  const facetCounts = useMemo(() => {
    const out = new Map<string, number>();
    const column = facet && facts ? facts.facets[facet.key] : undefined;
    if (!column) return out;
    const perCode = new Uint32Array(column.values.length);
    for (const code of column.codes) perCode[code]!++;
    column.values.forEach((value, code) => {
      if (value === null || !perCode[code]) return;
      out.set(value as string, (out.get(value as string) ?? 0) + perCode[code]!);
    });
    return out;
  }, [facet, facts]);

  const layout = useMemo<Layout<T>>(() => {
    const g = groupings.find((x) => x.key === selection.grouping);
    return g ? g.layout(selection.desc) : gridLayout as unknown as Layout<T>;
  }, [groupings, selection.grouping, selection.desc]);

  const cols = params.cols > 0 ? params.cols : Math.max(1, Math.ceil(Math.sqrt(rows.length)));
  const laid = useMemo(
    () => layout({ rows, facts: facts ?? undefined }, { cell: params.cell, gap: params.gap, cols }),
    [layout, rows, facts, cols, params.cell, params.gap]);

  useEffect(() => { onChange?.({ slot, selection, opened }); }, [onChange, slot, selection, opened]);

  // Every camera write goes through this, inertia included.
  const updateCam = (next: View) => {
    const clamped = laid.bounds.w > 0 && size.width > 0 && size.height > 0
      ? clampWallView(next, laid.bounds, size, compact ? 0 : blankPx) : next;
    // By value: a clamp builds a new object even when its numbers stand still.
    setCam((current) => (sameView(current, clamped) ? current : clamped));
  };
  const camAnim = useViewAnimation({ get: () => camRef.current ?? IDENTITY_VIEW, set: updateCam });

  // Fit the wall's width and let it run off the bottom, top-left at top-left.
  const fitToWall = useCallback(() => {
    if (laid.bounds.w <= 0 || size.width <= 0 || size.height <= 0) return;
    const fitted = fitViewToBounds(
      { x: 0, y: 0, width: laid.bounds.w, height: laid.bounds.h },
      size, camRef.current ?? IDENTITY_VIEW, { mode: 'fill', padding: 0 });
    updateCam({ x: 0, y: 0, scale: fitted.scale });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laid.bounds.w, laid.bounds.h, size.width, size.height]);

  // A regroup is a different arrangement, not a request for the camera back.
  useEffect(() => {
    if (fittedGrouping.current !== selection.grouping) return;
    if (touched.current) return;
    fitToWall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laid.bounds.w, laid.bounds.h, size.width, size.height]);
  useEffect(() => { fittedGrouping.current = selection.grouping; }, [selection.grouping]);

  // cmd-0 puts the whole wall back, the way it opened.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '0' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      touched.current = false;
      camInitialized.current = false;
      fitToWall();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitToWall]);

  // The drawn cell size on the glass, pinch included, is all a level is read
  // off; keyed on it rather than the camera object, which a clamp rewrites.
  const cellPx = cam ? params.cell * cam.scale.x * pixelScale : 0;
  useEffect(() => {
    if (!cam) return;
    if (camInitialized.current) {
      setLevel((current) => pickLevel(current, cellPx, params.levelUpHysteresis,
                                      params.levelDownHysteresis, ladder));
    } else {
      camInitialized.current = true;
      setLevel(levelFor(cellPx, ladder));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellPx, size.width, size.height, params.levelUpHysteresis, params.levelDownHysteresis,
      ladder]);

  // Only the loose and vector rungs fetch per cell, and by then few are on screen.
  // On-screen cells first, then a margin half a screen wide, fetched ahead.
  const visible = useMemo(() => {
    if (!cam || !facts || level < ladder.loose) return [];
    const on = visiblePositions(laid, cam, slice, MAX_THUMB_CELLS) ?? [];
    const wide = visiblePositions(laid, cam, {
      x: slice.x - slice.width * THUMB_OVERSCAN, y: slice.y - slice.height * THUMB_OVERSCAN,
      width: slice.width * (1 + 2 * THUMB_OVERSCAN), height: slice.height * (1 + 2 * THUMB_OVERSCAN),
    }, MAX_THUMB_CELLS) ?? [];
    const seen = new Set(on);
    return [...on, ...wide.filter((p) => !seen.has(p))];
  }, [laid, cam, slice, level, facts, ladder]);
  const visibleItems = useMemo(
    () => (facts ? visible.map((p) => facts.store.get(laid.order[p]!)) : []),
    [facts, visible, laid]);
  const visibleAt = useMemo(() => visibleItems.map((_, i) => i), [visibleItems]);
  const looseHandle = useRef<LooseHandle | null>(null);
  const vectorHandle = useRef<VectorHandle | null>(null);
  const loose = useLooseThumbs(visibleItems, visibleAt, level, drawnSlot, urls, looseHandle,
                               ladder.loose);
  const vector = useVectorThumbs(visibleItems, visibleAt, level, drawnSlot, urls, cellPx,
                                 vectorHandle);

  const gatherCacheReport = async () => {
    const seen = cam && facts ? visiblePositions(laid, cam, slice, MAX_THUMB_CELLS) : null;
    return cacheReport({
      slot: drawnSlot, cellPx, dpr: window.devicePixelRatio || 1, level, ladder,
      cells: { shown: rows.length, visible: cam ? visibleCount(laid, cam, slice) : 0,
               visibleWithSha: (seen ?? []).filter((p) => facts!.store.sha(laid.order[p]!)).length },
      sheets: ladder.sheets.map((lvl) => {
        const sheet = sheets[lvl];
        return { level: lvl, loaded: sheet !== undefined,
                 version: sheet?.manifest.version ?? null,
                 baked: sheet ? Object.keys(sheet.manifest.baked).length : 0 };
      }),
      loose: looseHandle.current?.stats() ?? { loaded: 0, requested: 0 },
      vector: vectorHandle.current?.stats()
        ?? { resident: 0, inFlight: 0, queued: 0, bytesCached: 0, rasterPx: [] },
    });
  };
  void targetPxFor;

  const active = sheets[sheetFor(level, ladder)] ?? null;

  const reported = useRef('');
  useEffect(() => {
    if (!active?.manifest || !rows.length || !facts) return;
    const key = `${drawnSlot}:${active.manifest.level}`;
    if (reported.current === key) return;
    reported.current = key;
    const { stale: behind, missing, total } = staleCountOf(active.manifest, rows.length,
      (i) => ({ id: facts.store.id(rows[i]!), sha: facts.store.sha(rows[i]!) }));
    if (behind + missing > total / 10) {
      console.warn(`[wall] ${drawnSlot} sheet-${active.manifest.level}: ${behind} of ${total} `
        + `cells stale, ${missing} with no tile; re-bake the slot.`);
    }
  }, [active, rows, facts, drawnSlot]);

  const appearance = useMemo<Appearance>(() => ({
    thickBorderFactor: params.thickBorderFactor, thinBorderFactor: params.thinBorderFactor,
    maxBorderPx: params.maxBorderPx, dimAlpha: params.dimAlpha,
    showBadges: params.showBadges, showCaptions: params.showCaptions,
    wash: params.wash, washStrength: params.washStrength,
  }), [params.thickBorderFactor, params.thinBorderFactor, params.maxBorderPx, params.dimAlpha,
       params.showBadges, params.showCaptions, params.wash, params.washStrength]);

  const itemAt = (id: string | null) => {
    if (id === null || !facts) return undefined;
    const row = rowOfId(facts, id);
    return row === undefined ? undefined : facts.store.get(row);
  };
  const cardItem = carded && facts && carded.row < facts.store.length
    && facts.store.id(carded.row) === carded.id ? facts.store.get(carded.row) : undefined;
  const openedItem = opened !== null && openedRow !== null && facts && openedRow < facts.store.length
    && facts.store.id(openedRow) === opened ? facts.store.get(openedRow) : itemAt(opened);

  // What a host's search calls. The caret and card follow the pointer's own
  // path; the camera move counts as the reader's, so a regroup keeps it.
  const reveal = useCallback((id: string): RevealResult => {
    if (!facts) return 'absent';
    const row = rowOfId(facts, id);
    if (row === undefined) return 'absent';
    const position = laid.order.indexOf(row);
    if (position < 0) return 'filtered';
    const rect = rectAt(laid, position);
    const at = camRef.current;
    if (rect && at) {
      touched.current = true;
      camAnim.animate(centerReveal(rect, at, size, REVEAL_MIN_HEIGHT));
    }
    setExplicitCaret(position);
    setOpened(null);
    setOpenedRow(null);
    setCarded({ id, row, at: { x: size.width / 2, y: size.height / 2 } });
    return 'shown';
  }, [facts, laid, size, camAnim]);

  return (
    <LabShell title={title} pages={pages} mode={mode}
              header={compact ? undefined : (
                <>
                  {slotPicker && slots.length > 0 && (
                    <label className="wall-slot">
                      <span>slot</span>
                      <select value={slot} onChange={(e) => chooseSlot(e.target.value)}>
                        {slots.map((s) => (
                          <option key={s.slot} value={s.slot}>{s.slot} ({s.n.toLocaleString()})</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {typeof header === 'function'
                    ? header({ slots, slot, setSlot: chooseSlot, reveal }) : header}
                  <ToggleBar mode="multiple" size="sm" variant="minimal" ariaLabel="Panels"
                             className="wall-panels"
                             items={[{ value: 'legend', label: 'Legend' }]}
                             value={legendOpen ? ['legend'] : []}
                             onChange={(v) => setLegendOpen(v.includes('legend'))} />
                  <CacheFailureButton
                    report={gatherCacheReport}
                    reset={() => { looseHandle.current?.reset(); vectorHandle.current?.reset(); }} />
                </>
              )}>
      <div className={compact ? 'wall-app wall-app--compact' : 'wall-app'}>
        {!compact && <Sidebar compiled={compiled} selection={selection} onChange={setSelection}
                 groupings={[NONE, ...groupings]}
                 facet={facet && { ...facet, counts: facetCounts }}
                 shown={rows.length} total={facts?.store.length ?? 0}
                 paramSchema={schema} params={params} setParam={setParam}
                 resetParams={resetParams} />}
        {/* Mounted from the start: the canvas size is measured on first mount. */}
        <div className="wall-stage" ref={box}
             onWheel={(e) => {
               if (!cam) return;
               touched.current = true;
               const [sx, sy] = clientToCanvas(e.currentTarget, e.clientX, e.clientY);
               // A zoom moves the cell out from under its card, unless that
               // card is the one being read.
               if (!overCard.current) setCarded(null);
               updateCam(zoomAt(cam, { x: sx, y: sy }, e.deltaY < 0 ? 1.1 : 1 / 1.1));
             }}>
          {!facts && (
            <div className="wall-skeleton" aria-busy="true" role="status">
              <span className="wall-skeleton__say">loading the corpus…</span>
            </div>
          )}
          {cam && facts && (
            <Wall compiled={compiled} facts={facts} laid={laid} cam={cam}
                  sheet={active?.image ?? null} manifest={active?.manifest ?? null}
                  loose={loose} vector={vector} width={size.width} height={size.height}
                  highlight={highlight} highlightTag={highlightTag}
                  tint={selection.tint} gradient={selection.gradient}
                  explicitCaret={explicitCaret} onExplicitCaretChange={setExplicitCaret}
                  onPan={(next) => { touched.current = true; updateCam(next); }}
                  onPick={(row, at) => setCarded({ id: facts.store.id(row), row, at })}
                  onDragStart={() => setCarded(null)}
                  onOpen={(row) => {
                    // With no detail view to show, an open would only hide every card after it.
                    if (!renderDetail) return;
                    setCarded(null); setOpenedRow(row); setOpened(facts.store.id(row));
                  }}
                  dragThresholdPx={params.dragThresholdPx} appearance={appearance}
                  stale={stale} pixelScale={pixelScale} sceneRenderer={params.sceneRenderer}
                  linkedBadges={linkedBadges}
                  linkTarget={linkTarget && ((row, tag) => {
                    const id = linkTarget(facts.store.get(row), tag);
                    return id === null ? null : rowOfId(facts, id) ?? null;
                  })}
                  cssRoot={cssRoot} drawMark={drawMark} washColor={washColor} ground={ground}
                  describe={describe && ((row) => describe(facts.store.get(row)))}
                  tiled={params.cell * cam.scale.x < BADGE_MIN_PX && level < ladder.loose} />
          )}
          {stale && (
            <p className="wall-stale" role="status">
              still showing <b>{drawnSlot}</b> while <b>{slot}</b> loads
            </p>
          )}
          {cardItem && carded && !(opened && renderDetail) && renderCard && (
            <ItemCard at={carded.at} viewport={size} onClose={() => setCarded(null)}
                      onHoverChange={(over) => { overCard.current = over; }}>
              {renderCard(cardItem, drawnSlot, {
                tint: selection.tint,
                open: () => {
                  if (!renderDetail) return;
                  setCarded(null); setOpenedRow(carded.row); setOpened(cardItem.id);
                },
              })}
            </ItemCard>
          )}
          {facts && legendOpen && !compact && (
            <Legend compiled={compiled} facts={facts} rows={rows} tagRows={tagRows}
                    highlight={highlight} onHighlight={setHighlight}
                    tags={[...(selection.tags ?? [])]}
                    onTags={(update) => setSelection((s) => ({ ...s, tags: update([...(s.tags ?? [])]) }))}
                    highlightTag={highlightTag} onHighlightTag={setHighlightTag}
                    onClose={() => setLegendOpen(false)}
                    tint={selection.tint} gradient={selection.gradient}
                    root={cssRoot} storageKey={storageKey} />
          )}
        </div>
        {openedItem && renderDetail && renderDetail(openedItem, drawnSlot, () => setOpened(null))}
      </div>
    </LabShell>
  );
}
