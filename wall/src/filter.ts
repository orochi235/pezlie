/** A per-pixel pass over every image the wall draws a cell from -- sheet,
 *  loose tile and vector raster alike. Each source is filtered once and the
 *  result cached, so a filter costs a redraw of each image, not of each frame. */
export interface ImageFilter {
  /** Names the output: two filters with one key must draw the same pixels.
   *  The cache is keyed on it, so a new key is what re-filters. */
  key: string;
  /** Draw `src` filtered into `ctx`, a fresh canvas of the source's size. */
  apply(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number): void;
}

function sizeOf(src: CanvasImageSource): { w: number; h: number } {
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { w: src.naturalWidth, h: src.naturalHeight };
  }
  const { width, height } = src as { width: number; height: number };
  return { w: width, h: height };
}

/** `src` run through `filter`, as a new canvas of the same size. */
export function applyFilter(src: CanvasImageSource, filter: ImageFilter): HTMLCanvasElement {
  const { w, h } = sizeOf(src);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx && w > 0 && h > 0) filter.apply(ctx, src, w, h);
  return canvas;
}

/** `filters` in order, each reading the last one's output. */
export function composeFilters(...filters: ImageFilter[]): ImageFilter {
  return {
    key: filters.map((f) => f.key).join('|'),
    apply(ctx, src, w, h) {
      let current: CanvasImageSource = src;
      filters.forEach((f, i) => {
        if (i === filters.length - 1) { f.apply(ctx, current, w, h); return; }
        current = applyFilter(current, f);
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

/** Filters each source once per filter key. Only the latest key is kept per
 *  source, and an entry goes when its source does. */
export function filterCache(): (src: CanvasImageSource, filter: ImageFilter) => HTMLCanvasElement {
  const cache = new WeakMap<object, { key: string; canvas: HTMLCanvasElement }>();
  return (src, filter) => {
    const hit = cache.get(src);
    if (hit && hit.key === filter.key) return hit.canvas;
    const canvas = applyFilter(src, filter);
    cache.set(src, { key: filter.key, canvas });
    return canvas;
  };
}

/** `images` with every value filtered, or `images` itself with no filter. */
export function filterMap<K>(images: Map<K, CanvasImageSource>, filter: ImageFilter | null | undefined,
                             filtered: (src: CanvasImageSource, filter: ImageFilter) => HTMLCanvasElement):
    Map<K, CanvasImageSource> {
  if (!filter) return images;
  const out = new Map<K, CanvasImageSource>();
  for (const [key, src] of images) out.set(key, filtered(src, filter));
  return out;
}
