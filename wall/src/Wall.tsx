import {
  useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  clientToCanvas, screenToWorld, viewToTransform, worldToScreen, useDecayLoop,
  viewportDragPanAction, zoomAt, WeaselProvider,
  type InvocationCtx, type OngoingHandle, type View,
} from '@weasel-js/core';
import { LoupeBubble, LoupeGestures, resolveLoupe, useLoupe } from '@weasel-js/labkit/loupe';
import { adjacent, impliedCaret, type Direction } from './caret';
import type { CompiledSpec } from './cel';
import type { Facts } from './derive';
import { cornerBadgesAt, DEFAULT_WASH, drawPaintCommand, type DrawOptions } from './draw2d';
import { scenePainter, type SceneWallPainter } from './drawScene';
import { positionAt, rectAt, visiblePositions, type Laid } from './layout';
import { DEFAULT_APPEARANCE, DEFAULT_GROUND, paintCommands, type Appearance, type PaintCommand } from './paint';
import { defaultPalette, readPalette, type Palette } from './palette';
import { pinchPair, pinchStep, type Midpoint } from './pinch';
import { centerReveal, panToReveal } from './reveal';
import type { Item } from './schema';
import type { SheetImage, SheetManifest } from './sheet';
import { STATUS, type RampName } from './tint';
import { offscreenSurface, TileCache } from './tiles';
import './Wall.css';

const ARROW_DIRECTION: Record<string, Direction> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

export const DEFAULT_DRAG_THRESHOLD_PX = 4;
/** Past this many cells on screen the wall draws nothing cell by cell. */
export const MAX_DRAWN_CELLS = 50_000;
/** How long a frame may spend rendering tiles before it draws what it has. */
const TILE_BUDGET_MS = 10;
/** A performance mark set the first time the wall is fully drawn for a given
 *  set of items, selection and colors, so a bench can time it. */
export const COMPLETE_MARK = 'pezlie:complete';

export interface WallProps<T extends Item> {
  compiled: CompiledSpec<T>;
  facts: Facts<T>;
  /** Where every cell sits. `laid.order` holds the rows in view order, and
   *  the caret and every position below index into it. */
  laid: Laid;
  cam: View;
  sheet: SheetImage | null;
  manifest: SheetManifest | null;
  loose: Map<string, CanvasImageSource>;
  vector: Map<string, CanvasImageSource>;
  width: number;
  height: number;
  highlight: string | null;
  highlightTag: string | null;
  /** Paint cell bodies with weasel; the overlays stay on Canvas2D above. */
  sceneRenderer?: boolean;
  explicitCaret: number | null;
  onExplicitCaretChange: (position: number | null) => void;
  onPan: (next: View) => void;
  /** `position` is where the row sits in `laid.order`, which the hit test
   *  already knows: a host anchoring to the cell needs it to find the rect.
   *  It is only meaningful against the `laid` it came from -- a sort or a
   *  regroup between the pick and the next render moves the row elsewhere,
   *  and the position then names a different cell. `via` says whether a
   *  double click may still follow it. */
  onPick: (row: number, at: { x: number; y: number }, position: number,
           via: 'click' | 'key') => void;
  /** A drag has passed the threshold and the wall moves under anything
   *  anchored to it. */
  onDragStart?: () => void;
  onOpen: (row: number) => void;
  dragThresholdPx?: number;
  appearance?: Appearance;
  stale?: boolean;
  /** How much sharper than `devicePixelRatio` to draw, for a pinch the page
   *  cannot otherwise see. */
  pixelScale?: number;
  tint?: string;
  gradient?: RampName;
  /** Badges that link to another item when clicked, and where each goes. */
  linkedBadges?: readonly string[];
  linkTarget?: (row: number, tag: string) => number | null;
  /** The root of the CSS custom properties the palette is read from. */
  cssRoot?: string;
  drawMark?: DrawOptions['drawMark'];
  washColor?: string;
  ground?: string;
  /** What a screen reader hears when the caret lands on a row. */
  describe?: (row: number) => string;
  /** Draw from the tile pyramid rather than cell by cell: for cells too small
   *  to carry badges, where a whole corpus can be on screen. */
  tiled?: boolean;
  /** The position under the pointer as it changes, null once it leaves. */
  onHover?: (position: number | null) => void;
  /** The magnifier's diameter in CSS pixels. */
  lensDiameter?: number;
  /** The cells under the magnifier and how much it magnifies them, or null
   *  once it is put away, so a host can load them at the size they are drawn. */
  onLens?: (lens: Lens | null) => void;
  /** What the magnifier draws from, where the host has loaded sharper
   *  pictures than the wall's; each falls back to the wall's own. */
  lensImages?: LensImages;
}

export interface Lens { positions: readonly number[]; factor: number }

export interface LensImages {
  sheet?: SheetImage | null;
  manifest?: SheetManifest | null;
  loose?: Map<string, CanvasImageSource>;
  vector?: Map<string, CanvasImageSource>;
}

/** Twice and a half labkit's default, so a lens shows a neighborhood rather
 *  than a cell or two. */
export const LENS_DIAMETER = 500;
/** Past this many cells under the lens, none are reported: the lens is over
 *  cells too small for sharper pictures to matter. */
const MAX_LENS_CELLS = 2_000;

function ongoingInvoker(action: typeof viewportDragPanAction) {
  if (!action.invoker || action.invoker.timing !== 'ongoing') {
    throw new Error('viewport.dragPan: expected an ongoing invoker');
  }
  return action.invoker;
}

const NOOP_MODIFIERS = { alt: false, ctrl: false, meta: false, shift: false };

/** The wall's rendering surface: a canvas the host positions and sizes. */
export function Wall<T extends Item>({
  compiled, facts, laid, cam, sheet, manifest, loose, vector, width, height,
  highlight, highlightTag, explicitCaret, onExplicitCaretChange,
  onPan, onPick, onOpen, onDragStart,
  dragThresholdPx = DEFAULT_DRAG_THRESHOLD_PX,
  pixelScale = 1, appearance, tint, gradient, stale = false,
  sceneRenderer = false, linkedBadges, linkTarget, cssRoot = '--wall',
  drawMark, washColor = DEFAULT_WASH, ground, describe, tiled = false,
  lensDiameter = LENS_DIAMETER, onLens, lensImages, onHover,
}: WallProps<T>) {
  const ref = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const painterRef = useRef<{ painter: SceneWallPainter; gl: HTMLCanvasElement } | null>(null);
  const glClearRef = useRef(false);
  const [sheetBitmap, setSheetBitmap] = useState<ImageBitmap | null>(null);
  const [dragging, setDragging] = useState(false);
  const decay = useDecayLoop();
  const [palette, setPalette] = useState<Palette>(() => defaultPalette(compiled.states));

  // The drag spans several pointer events and must see the live camera, not
  // the one closed over when it started.
  const camRef = useRef(cam);
  camRef.current = cam;
  const handleRef = useRef<OngoingHandle | null>(null);
  const draggedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const downRef = useRef(new Map<number, Midpoint>());
  const dragPointerRef = useRef<number | null>(null);
  const pinchAtRef = useRef<{ x: number; y: number } | null>(null);

  const view = { get: () => camRef.current, set: onPan, decay: decay.start };

  const options: DrawOptions = useMemo(
    () => ({ marks: compiled.spec.marks ?? {}, drawMark, washColor }),
    [compiled, drawMark, washColor]);

  // Canvas fills cannot see CSS except through getComputedStyle: read on mount,
  // on a theme change above the canvas, and when a params row writes a custom
  // property onto `.lk-root` (watched alone, since the canvas restyles itself
  // every frame).
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const update = () => {
      const styles = getComputedStyle(canvas);
      setPalette(readPalette((prop) => styles.getPropertyValue(prop), compiled.states, cssRoot));
    };
    update();
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-wzl-mode', 'data-wzl-theme'], subtree: true,
    });
    const root = canvas.closest('.lk-root');
    const rootObserver = root ? new MutationObserver(update) : null;
    rootObserver?.observe(root!, { attributes: true, attributeFilter: ['style'] });
    return () => { themeObserver.disconnect(); rootObserver?.disconnect(); };
  }, [compiled, cssRoot]);

  const tileScene = useMemo(() => ({
    compiled, facts, laid, manifest, sheet, palette, options, highlight, highlightTag,
    appearance: appearance ?? DEFAULT_APPEARANCE, tint: tint ?? STATUS, gradient: gradient ?? 'ember',
    stale, ground: ground ?? DEFAULT_GROUND,
  }), [compiled, facts, laid, manifest, sheet, palette, options, highlight, highlightTag,
       appearance, tint, gradient, stale, ground]);
  const tilesRef = useRef<TileCache<T> | null>(null);
  if (tilesRef.current?.scene !== tileScene) {
    tilesRef.current = new TileCache(tileScene, offscreenSurface, tilesRef.current);
  }
  // Bumped to draw again while tiles are still rendering.
  const [frame, setFrame] = useState(0);
  const marked = useRef<object | null>(null);
  const markComplete = () => {
    if (marked.current === tileScene) return;
    marked.current = tileScene;
    performance.mark(COMPLETE_MARK);
  };

  const loupeCapability = useMemo(() => resolveLoupe({ diameter: lensDiameter }), [lensDiameter]);
  const loupe = useLoupe({ capability: loupeCapability, hostRef: ref, enabled: false });
  const lensRef = useRef<HTMLCanvasElement>(null);

  const order = laid.order;
  const rectOf = useMemo(() => (p: number) => rectAt(laid, p), [laid]);
  const visible = useMemo(
    () => visiblePositions(laid, cam, { width, height }, MAX_DRAWN_CELLS) ?? [],
    [laid, cam, width, height]);
  const implied = useMemo(
    () => impliedCaret(rectOf, visible, cam, { width, height }),
    [rectOf, visible, cam, width, height]);
  // Built the first time a link is followed: a map over a million rows is not free.
  const positions = useRef<{ laid: Laid; of: Int32Array } | null>(null);
  const positionOf = (row: number): number | undefined => {
    if (positions.current?.laid !== laid) {
      const of = new Int32Array(facts.store.length).fill(-1);
      order.forEach((r, p) => { of[r] = p; });
      positions.current = { laid, of };
    }
    const p = positions.current.of[row];
    return p === undefined || p < 0 ? undefined : p;
  };
  const linked = useMemo(() => new Set(linkedBadges ?? []), [linkedBadges]);

  const followLink = (position: number, tag: string): boolean => {
    const target = linkTarget?.(order[position]!, tag);
    if (target == null) return false;
    const next = positionOf(target);
    if (next == null) return false;
    onExplicitCaretChange(next);
    const rect = rectAt(laid, next);
    // Centered: the target is elsewhere in the wall entirely, and landing it
    // against an edge leaves the reader hunting for it.
    if (rect) onPan(centerReveal(rect, camRef.current, { width, height }));
    return true;
  };

  const caretPosition = explicitCaret ?? implied;
  // Drawn only where somebody put it: the implied caret slides around under
  // the pointer whenever nobody is navigating by keyboard.
  const caretDrawn = explicitCaret;

  const commandsFor = (at: View, overlayOnly = false, only: ArrayLike<number> = visible,
                       from: LensImages = { manifest, loose, vector }) =>
    paintCommands({
      compiled, facts, order, rect: rectOf, visible: only, cam: at, manifest: from.manifest ?? null,
      palette, loose: from.loose, vector: from.vector, highlight, highlightTag, caret: overlayOnly ? null : caretDrawn,
      appearance, bands: laid.bands, tint, gradient, stale, ground,
    });

  // Weasel takes a texture, not an <img>. Never closed: a paint may still hold
  // the previous one when a slot swap replaces it.
  useEffect(() => {
    if (!sceneRenderer || !sheet) { setSheetBitmap(null); return; }
    let live = true;
    void createImageBitmap(sheet)
      .then((b) => { if (live) setSheetBitmap(b); })
      .catch(() => { if (live) setSheetBitmap(null); });
    return () => { live = false; };
  }, [sceneRenderer, sheet]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    // Times the pinch: Chrome's pinch zoom magnifies the composited layer
    // without moving devicePixelRatio.
    const dpr = (window.devicePixelRatio || 1) * pixelScale;
    const cmds = tiled ? [] : commandsFor(cam);

    const gl = glRef.current;
    if (sceneRenderer && gl) {
      if (painterRef.current?.gl !== gl) {
        painterRef.current = { painter: scenePainter(gl, canvas), gl };
      }
      // A tiled wall is past the cells `visible` will list, so it draws below
      // as tiles; one empty paint clears the GL layer they would show through.
      if (!tiled || !glClearRef.current) {
        painterRef.current.painter.paint(cmds, { width, height, dpr },
                                         { bitmap: sheetBitmap, img: sheet }, palette, options,
                                         'linear');
      }
      glClearRef.current = tiled;
      if (!tiled) {
        markComplete();
        return;
      }
    }

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    // The backing store is oversized for sharpness; the CSS size pins it back.
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    if (tiled && tilesRef.current) {
      const { complete, animating, pending } = tilesRef.current.draw(ctx, cam, { width, height }, dpr,
                                                            TILE_BUDGET_MS);
      // The caret and band labels sit over the tiles, drawn fresh every frame.
      for (const cmd of commandsFor(cam, false, caretDrawn != null ? [caretDrawn] : [])) {
        drawPaintCommand(ctx, cmd, sheet, palette, options);
      }
      if (complete) markComplete();
      if (!complete || animating) {
        const id = requestAnimationFrame(() => setFrame((f) => f + 1));
        return () => cancelAnimationFrame(id);
      }
      // With the screen drawn, spend idle time on the tiles just off it.
      if (pending) {
        const idle = window.requestIdleCallback
          ? window.requestIdleCallback(() => setFrame((f) => f + 1), { timeout: 200 })
          : window.setTimeout(() => setFrame((f) => f + 1), 32);
        return () => (window.cancelIdleCallback ? window.cancelIdleCallback(idle) : window.clearTimeout(idle));
      }
      return;
    }
    for (const cmd of cmds) drawPaintCommand(ctx, cmd, sheet, palette, options);
    markComplete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled, facts, laid, rectOf, visible, cam, sheet, manifest, palette, loose, vector,
      highlight, highlightTag, caretDrawn, appearance, tint, gradient, stale, ground,
      width, height, pixelScale, sceneRenderer, sheetBitmap, options, tiled, tileScene, frame]);

  // The lens magnifies what is already on screen, so it redraws the same
  // visible set recentred rather than recomputing visibility.
  useEffect(() => {
    const canvas = lensRef.current;
    if (!canvas || !loupe.visible) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const d = loupeCapability.diameter;
    canvas.width = d * dpr;
    canvas.height = d * dpr;
    canvas.style.width = `${d}px`;
    canvas.style.height = `${d}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, d, d);
    ctx.imageSmoothingEnabled = true;
    const offset = { x: d / 2 - loupe.aim.x, y: d / 2 - loupe.aim.y };
    const merged = (own?: Map<string, CanvasImageSource>, lens?: Map<string, CanvasImageSource>) =>
      (lens?.size ? new Map([...(own ?? []), ...lens]) : own);
    const lensSheet = lensImages?.sheet && lensImages.manifest ? lensImages : null;
    const from: LensImages = {
      manifest: lensSheet ? lensSheet.manifest : manifest,
      loose: merged(loose, lensImages?.loose),
      vector: merged(vector, lensImages?.vector),
    };
    for (const cmd of commandsFor(zoomAt(cam, loupe.aim, loupe.factor), false, visible, from)) {
      drawPaintCommand(ctx, cmd, lensSheet ? lensSheet.sheet! : sheet, palette, { ...options, offset });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loupe.visible, loupe.aim, loupe.factor, loupeCapability.diameter, compiled, facts, laid,
      rectOf, visible, cam, sheet, manifest, palette, loose, vector, highlight, caretDrawn,
      appearance, tint, gradient, stale, width, height, options, lensImages]);

  // Which cells the lens covers, told to the host only when that changes.
  const lensKey = useRef('');
  useEffect(() => {
    if (!onLens) return;
    if (!loupe.visible) {
      if (lensKey.current) { lensKey.current = ''; onLens(null); }
      return;
    }
    const d = loupeCapability.diameter;
    const positions = visiblePositions(laid, zoomAt(cam, loupe.aim, loupe.factor), {
      x: loupe.aim.x - d / 2, y: loupe.aim.y - d / 2, width: d, height: d,
    }, MAX_LENS_CELLS) ?? [];
    const key = `${loupe.factor}:${positions.join(',')}`;
    if (key === lensKey.current) return;
    lensKey.current = key;
    onLens({ positions, factor: loupe.factor });
  }, [onLens, loupe.visible, loupe.aim, loupe.factor, loupeCapability.diameter, cam, laid]);

  const hitTest = (e: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) => {
    const [sx, sy] = clientToCanvas(e.currentTarget, e.clientX, e.clientY);
    const [wx, wy] = screenToWorld(sx, sy, viewToTransform(cam));
    const position = positionAt(laid, wx, wy);
    if (position === null || order[position] === undefined) return null;
    // `appearance` and not the default: a click must not find a badge the
    // wall never drew.
    const c = commandsFor(cam, true, [position])
      .find((cmd): cmd is Exclude<PaintCommand, { kind: 'label' }> => cmd.kind !== 'label');
    if (!c) return null;
    const badges = ('badges' in c ? c.badges : undefined) ?? [];
    const discs = cornerBadgesAt(badges, c);
    const badge = badges.find((b, i) => {
      if (!linked.has(b.tag)) return false;
      const { cx, cy, radius } = discs[i]!;
      return Math.hypot(sx - cx, sy - cy) <= radius;
    });
    return { position, row: order[position]!, at: { x: sx, y: sy }, badge };
  };

  const dragCtx = (screenDelta: { x: number; y: number }): InvocationCtx => ({
    world: { x: 0, y: 0 }, screen: { x: 0, y: 0 }, modifiers: NOOP_MODIFIERS,
    deps: { view },
    drag: { start: { x: 0, y: 0 }, current: screenDelta, delta: screenDelta, screenDelta },
  });

  const endDrag = (delta: { x: number; y: number }, reason: 'commit' | 'cancel') => {
    dragPointerRef.current = null;
    if (!handleRef.current) return;
    handleRef.current.onEnd?.(dragCtx(delta), reason);
    handleRef.current = null;
    setDragging(false);
    if (reason === 'commit' && draggedRef.current) suppressClickRef.current = true;
  };

  const dragDelta = (e: ReactPointerEvent<HTMLCanvasElement>) =>
    ({ x: e.clientX - startRef.current.x, y: e.clientY - startRef.current.y });

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    downRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger makes it a pinch, which must not fight a pan underneath.
    if (downRef.current.size > 1) { endDrag({ x: 0, y: 0 }, 'cancel'); return; }
    if (e.button !== 0) return;
    suppressClickRef.current = false;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* uncaptured is fine */ }
    startRef.current = { x: e.clientX, y: e.clientY };
    draggedRef.current = false;
    dragPointerRef.current = e.pointerId;
    handleRef.current = ongoingInvoker(viewportDragPanAction)
      .start(dragCtx({ x: 0, y: 0 }), { params: { inertia: {} } });
  };

  const hovered = useRef<number | null>(null);
  const hover = (position: number | null) => {
    if (hovered.current === position) return;
    hovered.current = position;
    onHover?.(position);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (onHover) hover(hitTest(e)?.position ?? null);
    const held = downRef.current;
    if (held.has(e.pointerId)) {
      const before = pinchPair(held);
      held.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = pinchPair(held);
      if (before && after && before.spread > 0) {
        pinch(after.midpoint, after.spread / before.spread);
        return;
      }
    }
    if (!handleRef.current || e.pointerId !== dragPointerRef.current) return;
    const { x: dx, y: dy } = dragDelta(e);
    if (!draggedRef.current) {
      if (Math.hypot(dx, dy) < dragThresholdPx) return;
      draggedRef.current = true;
      setDragging(true);
      onDragStart?.();
    }
    handleRef.current.onMove?.(dragCtx({ x: dx, y: dy }));
  };

  const onPointerRelease = (e: ReactPointerEvent<HTMLCanvasElement>,
                            reason: 'commit' | 'cancel') => {
    downRef.current.delete(e.pointerId);
    if (downRef.current.size < 2) pinchAtRef.current = null;
    if (e.pointerId === dragPointerRef.current) endDrag(dragDelta(e), reason);
  };

  const pinch = (clientAnchor: Midpoint, factor: number) => {
    const canvas = ref.current;
    if (!canvas) return;
    const [x, y] = clientToCanvas(canvas, clientAnchor.x, clientAnchor.y);
    if (!pinchAtRef.current) onDragStart?.();
    onPan(pinchStep(camRef.current, { x, y }, pinchAtRef.current, factor));
    pinchAtRef.current = { x, y };
    suppressClickRef.current = true;
  };

  // Role, name and keyboard operability without a focusable node per cell:
  // arrows move the caret, Enter picks, Escape drops back to the implied one.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const direction = ARROW_DIRECTION[e.key];
    if (direction) {
      e.preventDefault();
      if (caretPosition == null) return;
      const next = adjacent(rectOf, order.length, caretPosition, direction);
      if (next == null) return;
      onExplicitCaretChange(next);
      const rect = rectAt(laid, next);
      if (rect) onPan(panToReveal(rect, camRef.current, { width, height }));
      return;
    }
    if (e.key === 'Enter') {
      if (caretPosition == null) return;
      const rect = rectAt(laid, caretPosition);
      const row = order[caretPosition];
      if (!rect || row === undefined) return;
      const [sx, sy] = worldToScreen(rect.x + rect.w / 2, rect.y + rect.h / 2,
                                     viewToTransform(camRef.current));
      onPick(row, { x: sx, y: sy }, caretPosition, 'key');
      return;
    }
    if (e.key === 'Escape') onExplicitCaretChange(null);
  };

  const announced = caretDrawn != null && order[caretDrawn] !== undefined
    ? (describe ?? ((row: number) => facts.store.id(row)))(order[caretDrawn]!)
    : '';

  return (
    <>
      <div className="wall-canvas-stack">
        {sceneRenderer && <canvas ref={glRef} className="wall-canvas-gl" />}
        <canvas
          ref={ref}
          className={[
            'wall-canvas',
            dragging ? 'wall-canvas-dragging' : '',
            sceneRenderer ? 'wall-canvas-over' : '',
          ].filter(Boolean).join(' ')}
          width={width}
          height={height}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => onPointerRelease(e, 'commit')}
          onPointerCancel={(e) => onPointerRelease(e, 'cancel')}
          onPointerLeave={() => hover(null)}
          onClick={(e) => {
            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
            // The first click of a double click; onDoubleClick takes it.
            if (e.detail === 2) return;
            const hit = hitTest(e);
            if (!hit) return;
            if (hit.badge && followLink(hit.position, hit.badge.tag)) return;
            onPick(hit.row, hit.at, hit.position, 'click');
          }}
          onDoubleClick={(e) => {
            const hit = hitTest(e);
            if (hit) onOpen(hit.row);
          }}
        />
      </div>
      {/* The peek key and the lens' wheel route through a dispatcher, which
          needs a registry; nothing above the wall is known to provide one. */}
      <WeaselProvider>
        <LoupeGestures hostRef={ref} input={loupe.input} peekKey={loupeCapability.peekKey} />
      </WeaselProvider>
      {loupe.visible && (
        <LoupeBubble aim={loupe.aim} diameter={loupeCapability.diameter}>
          <canvas ref={lensRef} className="lk-loupe__canvas" />
        </LoupeBubble>
      )}
      <div className="wall-caret-announce" aria-live="polite">{announced}</div>
    </>
  );
}
