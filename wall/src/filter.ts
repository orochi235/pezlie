/** A per-pixel pass over every image the wall draws a cell from -- sheet,
 *  loose tile and vector raster alike. Each source is filtered once and the
 *  result cached, so a filter costs a redraw of each image, not of each frame. */
export interface ImageFilter {
  /** Names the output: two filters with one key must draw the same pixels.
   *  The cache is keyed on it, so a new key is what re-filters. */
  key: string;
  /** Draw `src` filtered into `ctx`, a fresh canvas of the source's size.
   *  `mask` is the item's companion image from `WallView`'s `maskUrls`,
   *  scaled to `w` x `h`, or null where it has none; what it means is the
   *  host's business. */
  apply(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number,
        mask: CanvasImageSource | null): void;
}

function sizeOf(src: CanvasImageSource): { w: number; h: number } {
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { w: src.naturalWidth, h: src.naturalHeight };
  }
  const { width, height } = src as { width: number; height: number };
  return { w: width, h: height };
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** `mask` at `w` x `h`: as it is when it already fits, else redrawn to. */
function fitted(mask: CanvasImageSource, w: number, h: number): CanvasImageSource {
  const size = sizeOf(mask);
  if (size.w === w && size.h === h) return mask;
  const canvas = canvasOf(w, h);
  canvas.getContext('2d')?.drawImage(mask, 0, 0, w, h);
  return canvas;
}

/** `src` run through `filter`, as a new canvas of the same size. */
export function applyFilter(src: CanvasImageSource, filter: ImageFilter,
                            mask: CanvasImageSource | null = null): HTMLCanvasElement {
  const { w, h } = sizeOf(src);
  const canvas = canvasOf(w, h);
  const ctx = canvas.getContext('2d');
  if (ctx && w > 0 && h > 0) filter.apply(ctx, src, w, h, mask && fitted(mask, w, h));
  return canvas;
}

/** `filters` in order, each reading the last one's output. */
export function composeFilters(...filters: ImageFilter[]): ImageFilter {
  return {
    key: filters.map((f) => f.key).join('|'),
    apply(ctx, src, w, h, mask) {
      let current: CanvasImageSource = src;
      filters.forEach((f, i) => {
        if (i === filters.length - 1) { f.apply(ctx, current, w, h, mask); return; }
        current = applyFilter(current, f, mask);
      });
    },
  };
}

/** Black drawn as `ink`, white left white, alpha untouched.
 *
 *  A screen blend is exactly that map on every channel -- `ink + (1 - ink) * v`
 *  -- so a grayscale drawing keeps its shading as tints of the one color. The
 *  second draw puts back the source's alpha, which the blend filled solid. */
export function inkFilter(ink: string): ImageFilter {
  return {
    key: `ink:${ink}`,
    apply(ctx, src, w, h) {
      ctx.drawImage(src, 0, 0);
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = ink;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(src, 0, 0);
    },
  };
}

export type FilterImage = (src: CanvasImageSource, filter: ImageFilter,
                           mask?: CanvasImageSource | null) => HTMLCanvasElement;

/** Filters each source once per filter key and mask. Only the latest pair is
 *  kept per source, and an entry goes when its source does -- so a mask
 *  arriving after its drawing re-filters that one drawing. */
export function filterCache(): FilterImage {
  const cache = new WeakMap<object, { key: string; mask: CanvasImageSource | null;
                                      canvas: HTMLCanvasElement }>();
  return (src, filter, mask = null) => {
    const hit = cache.get(src);
    if (hit && hit.key === filter.key && hit.mask === mask) return hit.canvas;
    const canvas = applyFilter(src, filter, mask);
    cache.set(src, { key: filter.key, mask, canvas });
    return canvas;
  };
}

/** `images` with every value filtered against its entry in `masks`, or
 *  `images` itself with no filter. */
export function filterMap<K>(images: Map<K, CanvasImageSource>, filter: ImageFilter | null | undefined,
                             filtered: FilterImage,
                             masks?: ReadonlyMap<K, CanvasImageSource>):
    Map<K, CanvasImageSource> {
  if (!filter) return images;
  const out = new Map<K, CanvasImageSource>();
  for (const [key, src] of images) out.set(key, filtered(src, filter, masks?.get(key) ?? null));
  return out;
}
