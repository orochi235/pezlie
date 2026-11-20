# TODO

## A baked sheet carries no corpus identity

Loose and vector thumbnails are keyed by `imageKey` (`id@sha`, `wall/src/urls.ts`), so a raster
that lands late can't be drawn on the wrong item. Sprite sheets are not: `wall/src/useSheets.ts`
keys a sheet set by slot alone and swaps it in whole, and a sheet's cells are positions in the
corpus order it was baked from. If the corpus behind a slot is replaced or reordered (a new
`ItemStore`, or a patch from `ItemStore.patch` that a rebake hasn't caught up with), the wall would
draw the old sheet's sprites over the new rows until the slot changes. Inferred from the source; not
reproduced. A fix gives the corpus a generation or content hash that sheets, patches, and level
requests carry, so a mismatched sheet is refused rather than drawn. (filed 2026-11-15 from automated
review)

## The wall's zoom-out stops at weasel's default 0.1, short of a million-cell fit

`WallView` zooms with `zoomAt` (wheel, and pinch through `wall/src/pinch.ts`) and fits with
`fitViewToBounds`, all without limits, so they take `@weasel-js/core`'s `DEFAULT_MIN_ZOOM` 0.1 and
`DEFAULT_MAX_ZOOM` 8 (rechecked against core 1.19.1 on 2026-11-19: `zoomAt` clamps each axis's magnitude
to `opts.min`/`opts.max`, and `fitViewToBounds` to `minScale`/`maxScale`, both defaulting to those). At
cell 32 and gap 4, the 1,114,112-cell unicode wall is about 38,000 world units a side: fitting it to
1600×1000 wants a scale near 0.026, so at 0.1 the view holds about 11% of the cells, and
`hosts/unicode/bench/browser.mjs`'s "whole wall" step (eight wheel-outs) measures that part, not the wall.
The lens meets the other end: `Wall.tsx` draws it at `zoomAt(cam, aim, loupe.factor)`, so camera scale times
lens factor stops at 8, and past that a lens (labkit's factor 6 by default, up to 32) magnifies less than
its factor while `onLens` still reports the factor. Inferred from the source and arithmetic; not run.
Closes when the wall passes a `min` derived from its fitted scale to every zoom path, the lens's `zoomAt` a
`max` that keeps its factor, and the bench asserts the whole wall is on screen. (filed 2026-11-19 from
weasel's review of pezlie's scaling)
