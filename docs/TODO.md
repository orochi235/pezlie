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
