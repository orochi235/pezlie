import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { Rect } from './layout';
import './ItemCard.css';

export const CARD_WIDTH = 320;
export const CARD_HEIGHT = 190;
export const CARD_MARGIN = 8;
/** Past the clicked point, so the card never lands on what was clicked. */
export const CARD_OFFSET = 16;
/** Frame left around the opening on every side. */
export const CARD_PAD = 12;
/** The details column's text width, inside its own pad on either side. */
export const CARD_DETAILS = 200;

interface Size { width: number; height: number }
interface Point { x: number; y: number }

function axis(at: number, span: number, room: number): number {
  const after = at + CARD_OFFSET;
  if (after + span <= room - CARD_MARGIN) return after;
  const before = at - CARD_OFFSET - span;
  if (before >= CARD_MARGIN) return before;
  return Math.max(CARD_MARGIN, Math.min(after, room - span - CARD_MARGIN));
}

/** Below and right of the point; flipped to the other side of it on an axis
 *  without room; clamped inside the viewport where neither side has room. */
export function placeCard(at: Point, viewport: Size, card: Size): Point {
  return { x: axis(at.x, card.width, viewport.width),
           y: axis(at.y, card.height, viewport.height) };
}

export interface CardFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where the cell shows through, in the same screen coordinates as `x`/`y`. */
  opening: { x: number; y: number; width: number; height: number };
  /** Which side of the opening the details column is on. */
  side: 'left' | 'right';
  /** The frame above and below the opening: a pad, plus whatever the details
   *  need past the cell's own height. */
  above: number;
  below: number;
}

/** The frame around a cell's on-screen rect: the opening is the rect itself,
 *  with a pad on every side and the details column past one of them.
 *
 *  Never clamped into the viewport -- a frame that slid off its cell would
 *  point at the wrong one. Only the side the details take flips. Details
 *  taller than the cell (`content`, their text's height) grow the frame down,
 *  then up once the viewport has no more room below. */
export function frameCard(cell: Rect, viewport: Size, content = 0,
                          details = CARD_DETAILS, pad = CARD_PAD): CardFrame {
  const column = details + 2 * pad;
  const width = cell.w + column + pad;
  const fitsRight = cell.x + cell.w + column <= viewport.width - CARD_MARGIN;
  const fitsLeft = cell.x - column >= CARD_MARGIN;
  const side = fitsRight || !fitsLeft ? 'right' : 'left';
  const x = side === 'right' ? cell.x - pad : cell.x - column;
  const extra = Math.max(0, content - cell.h);
  const roomBelow = Math.max(0, viewport.height - CARD_MARGIN - (cell.y + cell.h + pad));
  const down = Math.min(extra, roomBelow);
  const up = Math.min(extra - down, Math.max(0, cell.y - pad - CARD_MARGIN));
  const above = pad + up;
  const below = pad + down;
  return {
    x, y: cell.y - above, width, height: cell.h + above + below, side, above, below,
    opening: { x: cell.x, y: cell.y, width: cell.w, height: cell.h },
  };
}

export interface ItemCardBase {
  viewport: Size;
  onClose: () => void;
  /** Whether the pointer is over the card: a zoom drops the card, except the
   *  one being read. A framed card counts its opening as itself. */
  onHoverChange?: (over: boolean) => void;
  label?: string;
  children: ReactNode;
}

/** Either anchored past a point or framing a cell -- never neither. */
export type ItemCardProps = ItemCardBase
  & ({ at: Point; cell?: undefined } | { cell: Rect; at?: undefined });

export function ItemCard({ at, cell, viewport, onClose, onHoverChange, label = 'item card',
                           children }: ItemCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const openingRef = useRef<HTMLDivElement>(null);
  const openRect = useRef<DOMRect | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState(0);
  const frame = useMemo(() => (cell ? frameCard(cell, viewport, content) : null),
                        [cell, viewport, content]);

  // The details' own height, so the frame can grow to hold them rather than
  // scroll them. Read off the body, which sizes to its content, not the frame.
  const framed = cell !== undefined;
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!framed || !body) return;
    const measure = () => setContent(body.offsetHeight);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(body);
    return () => watch.disconnect();
  }, [framed]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--card-pad', `${CARD_PAD}px`);
    if (frame) {
      el.style.setProperty('--card-x', `${frame.x}px`);
      el.style.setProperty('--card-y', `${frame.y}px`);
      el.style.setProperty('--card-w', `${frame.width}px`);
      el.style.setProperty('--card-h', `${frame.height}px`);
      el.style.setProperty('--open-w', `${frame.opening.width}px`);
      el.style.setProperty('--open-h', `${frame.opening.height}px`);
      el.style.setProperty('--pad-above', `${frame.above}px`);
      el.style.setProperty('--pad-below', `${frame.below}px`);
    } else {
      const { x, y } = placeCard(at ?? { x: 0, y: 0 }, viewport, {
        width: el.offsetWidth || CARD_WIDTH,
        height: el.offsetHeight || CARD_HEIGHT,
      });
      el.style.setProperty('--card-x', `${x}px`);
      el.style.setProperty('--card-y', `${y}px`);
    }
    // Measured once the frame moves, never per pointer event: the gesture that
    // pans the wall must not pay for a layout on every move.
    openRect.current = openingRef.current?.getBoundingClientRect() ?? null;
  }, [at, frame, viewport]);

  /** Whether an event landed on the cell showing through the opening. The
   *  target settles what is on top: a panel drawn over the cell is not it. */
  const onCell = useCallback((e: PointerEvent) => {
    const open = openRect.current;
    if (!open || (e.target as Element | null)?.tagName !== 'CANVAS') return false;
    return e.clientX >= open.left && e.clientX <= open.right
        && e.clientY >= open.top && e.clientY <= open.bottom;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onPress = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      // The opening is a hole: a press there is a press on the cell this card
      // is framing, not one outside it.
      if (onCell(e)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    // Capture, so a handler that stops propagation cannot keep a stale card up.
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [onClose, onCell]);

  const over = useRef(false);
  const hover = useRef(onHoverChange);
  hover.current = onHoverChange;
  const report = useCallback((now: boolean) => {
    if (now === over.current) return;
    over.current = now;
    hover.current?.(now);
  }, []);

  useEffect(() => {
    if (!framed) return;
    // The pointer over the opening has left the frame's own box, and enter and
    // leave alone would call the card being read unhovered.
    const onMove = (e: PointerEvent) =>
      report(!!ref.current?.contains(e.target as Node) || onCell(e));
    document.addEventListener('pointermove', onMove, true);
    return () => {
      document.removeEventListener('pointermove', onMove, true);
      report(false);
    };
  }, [framed, onCell, report]);

  const className = ['wall-card', frame ? 'wall-card--framed' : '',
                     frame?.side === 'left' ? 'wall-card--left' : ''].filter(Boolean).join(' ');
  const hovering = framed ? {} : {
    onPointerEnter: () => report(true),
    onPointerLeave: () => report(false),
  };

  return (
    <div className={className} ref={ref} role="dialog" aria-label={label} {...hovering}>
      {frame ? (
        <>
          <div className="wall-card__pane wall-card__pane--top" />
          <div className="wall-card__pane wall-card__pane--side" />
          <div className="wall-card__opening" ref={openingRef} aria-hidden="true" />
          <div className="wall-card__details">
            <div className="wall-card__body" ref={bodyRef}>{children}</div>
          </div>
          <div className="wall-card__pane wall-card__pane--bottom" />
        </>
      ) : children}
    </div>
  );
}
