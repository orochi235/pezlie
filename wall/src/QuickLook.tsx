import { useEffect, useRef } from 'react';
import { fetchRender, rasterize } from './svgRaster';
import type { FilterImage, ImageFilter } from './filter';
import type { Item } from './schema';
import { shaVersion, type SlotUrls } from './urls';
import './QuickLook.css';

/** Share of the stage's shorter side the picture fills. */
export const QUICK_LOOK_SHARE = 0.8;

export interface QuickLookProps {
  item: Item;
  slot: string;
  urls: SlotUrls;
  /** The stage it is centered on, in CSS pixels. */
  stage: { width: number; height: number };
  /** Drawn until the render arrives: the cell's loose tile, when the wall has it. */
  placeholder?: CanvasImageSource | null;
  filter?: ImageFilter | null;
  filterImage: FilterImage;
  /** Where the filter's mask for this item's render is fetched from. */
  maskUrls?: SlotUrls | null;
  label?: string;
}

/** A large view of one item's render, over the wall while a key is held. It
 *  takes no pointer events, so the wall under it keeps its hover. */
export function QuickLook({ item, slot, urls, stage, placeholder, filter, filterImage, maskUrls,
                            label }: QuickLookProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const side = Math.max(1, Math.floor(Math.min(stage.width, stage.height) * QUICK_LOOK_SHARE));

  useEffect(() => { box.current?.style.setProperty('--quicklook-side', `${side}px`); }, [side]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const px = Math.round(side * (window.devicePixelRatio || 1));
    canvas.width = px;
    canvas.height = px;
    const paint = (src: CanvasImageSource, mask: CanvasImageSource | null = null) => {
      ctx.clearRect(0, 0, px, px);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(filter ? filterImage(src, filter, mask) : src, 0, 0, px, px);
    };
    if (placeholder) paint(placeholder);
    if (!item.sha) return;
    let live = true;
    const version = shaVersion(item.sha);
    const raster = (from: SlotUrls) =>
      fetchRender(from.render(slot, item.id, version)).then((blob) => rasterize(blob, px, px));
    void Promise.all([
      raster(urls),
      filter && maskUrls ? raster(maskUrls).catch(() => null) : Promise.resolve(null),
    ]).then(([image, mask]) => { if (live) paint(image, mask); }).catch(() => {});
    return () => { live = false; };
    // The placeholder is drawn once, not again each time the wall hands over a new map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.sha, slot, urls, side, filter, filterImage, maskUrls]);

  return (
    <div ref={box} className="wall-quicklook" role="img" aria-label={label ?? item.id}>
      <canvas ref={ref} className="wall-quicklook__picture" />
    </div>
  );
}
