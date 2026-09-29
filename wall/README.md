# pezlie

A pan/zoom wall over a million items: which state each item is in, which items
are on the wall and in what order, what color each cell is, how a frame is
drawn, where the pictures come from, and the React page around it all. It knows
nothing about what the items are.

```bash
npm install pezlie
```

It needs React 19 and a bundler that handles CSS imports. The pictures come
from [`bakery`](https://github.com/orochi235/pezlie/tree/main/bakery).

## What a host supplies

A `CorpusSpec` (`src/schema.ts`):

- **States**, each with a CEL `match`, colors, weight, shape and precedence.
  The first to hold by precedence is the item's state; the last one matched is
  the catch-all, and a dimmed cell wears it. A state can name **variants** —
  the same condition holding somewhere else — which the wall generates.
- **Filters, classes and sorts**, as CEL. A sort value of `null` sorts last in
  both directions, and a tie keeps index order.
- **Tags** (a CEL list) and the **axes** they are picked along: alternatives
  within an axis, narrowing across axes.
- **Facets, captions, glyph and mark** — display projections, as CEL or as a
  named TypeScript hook. A facet hook names the fields it `reads`. A glyph's
  `cover`, the share of a cell its characters ink on average, keeps a far cell
  from being brighter than the character that replaces it up close.
- **Badges**: art per tag, in a corner or the strip, with the mark art in
  `marks`. A badge can yield to a caption, and drops wherever that caption is
  drawn. Badges sharing a corner form a row inward from it, in the order the
  tags list them, and a top caption moves aside for the row in its corner.
- **Tints**: TypeScript functions placing an item on a ramp, with the fields
  they `reads`.

For the page, `WallView` also takes the item and slot fetchers, a `SlotUrls`
(`defaultUrls('/api')` matches `bakery`'s routes), groupings, a facet for the
sidebar, and render props for the card and the detail view. `compact` leaves
only the wall and its card, for a page embedded somewhere small; `mode` fixes
light or dark; `paramDefaults` sets what a first visit starts from. The wall
reads each slot's levels from its `levels.json`, and takes a slot without one to
have 8px and 32px sheets and 128px loose tiles.
`header` takes controls for the top bar, or a function of `WallHeader` — the
slots, the current slot, `setSlot`, `reveal(id)` and `poll()` — for a host
drawing its own slot picker or search; `slotPicker={false}` drops the built-in
one. `reveal` centers a drawn item and opens its card, and answers
`'filtered'` or `'absent'` when it cannot. Holding space shows the item under the
pointer, or the picked one, large over the wall until it is let go. The params
panel's Fill lays the sorted cells across rows, in a spiral out from the center,
or in L-shaped shells out from the top-left corner; `LayoutOptions.fill` does the
same for a host's own layout, and a grouped layout squares each group's block.

`fetchItems` answers with `{ items, version }` — objects, fine for tens of
thousands — or `{ table, version }`, an Arrow table in index order, which is
what a million items needs. `bakery`'s `pezlie.feed` writes one. Called with a
`since` version, it answers only what changed; the wall asks every `pollMs`,
and `poll()` asks now, for a host that hears of a change some other way.

**An item's `sha` names its picture.** When a poll changes an item's `sha`, the
wall redraws that cell alone: the loose tile and the vector render are fetched
again, and the cell is drawn into the wall's copy of each sheet from its own
tile at that level, `SlotUrls.tile(slot, level, id, version)` — which `bakery`
already writes for every level — rather than fetching the sheets again. The old
picture stays until the new one lands; a tile that fails keeps it.

## Rules a spec has to follow

- **Items carry `index`, and the indices are exactly `0..n-1`.** An item's cell
  on every sheet is its index. `derive` throws on a repeat or a gap. An Arrow
  feed puts its rows in index order.
- **Say what a hook reads.** CEL rules, tints, facet hooks and grouping keys are
  evaluated once per distinct combination of the fields they read, so a tint or
  a facet hook without `reads` is a spec error, and a hook that reads a field it
  did not name sees it missing. Captions, glyph and mark run for visible cells
  only and get the whole item.
- **Guard optional fields with `has()`.** Reading a field an item lacks is an
  error in CEL; the wall reads it as `false` or `null` and warns once per
  expression.
- **Compile once.** `compile(spec)` reports every bad expression and every
  missing hook together, and throws `SpecError`. `WallView` shows the list in
  place of the wall.
- **Pass stable fetchers and URLs.** The loaders refetch when they change.
- **Mount the page under a labkit `<Persistence>` or `<Lab>`.** The legend
  remembers where it was dragged only beneath one; without it the position
  resets on reload.

## Use

The whole page:

```tsx
<WallView title="things" spec={spec} urls={defaultUrls('/api')}
          fetchItems={fetchItems} fetchSlots={fetchSlots} storageKey="things.params"
          renderCard={(item) => <Card item={item} />} />
```

The pieces, for a host that builds its own page:

```ts
const compiled = compile(spec);
const facts = derive(compiled, storeFromArrow(table));  // or an array of items
const rows = applySelection(compiled, facts, selection); // a Uint32Array, sorted once per sort
const laid = gridLayout({ rows, facts }, { cell: 32, gap: 4, cols: 1000 });
const commands = paintCommands({
  compiled, facts, order: laid.order, rect: (p) => rectAt(laid, p),
  visible: visiblePositions(laid, cam, viewport) ?? [], cam, manifest,
  palette: defaultPalette(compiled.states),
});
```

A layout returns blocks of cells rather than a rect per item; `blockLayout` and
`bandedLayout` group by a `GroupKey`, which names the fields it reads. `Wall`
draws a laid wall on a canvas and handles pan, pinch, keyboard and clicks; below
badge size it draws from a pyramid of tiles it renders as they come into view.
Holding Alt raises a magnifier; `onLens` reports the cells under it and how much
it magnifies, and `lensImages` hands it sharper pictures for them, which is how
`WallView` keeps a magnified cell from being an enlarged thumbnail.
`useItems`, `useSheets`, `useLooseThumbs` and `useVectorThumbs` load what it
draws; `Legend`, `Sidebar`, `ItemCard` and `ParamsPanel` are the chrome. CSS
classes are `wall-*`; colors can be overridden with custom properties under
`--wall`.

## Develop

```bash
npm install          # at the pezlie root
npx vitest run       # in wall/
npx tsc --noEmit
npm run bench -- --against main    # in wall/: drawing cost, this tree against main
```

`bench/render.ts` times the drawing case by case over a synthetic corpus,
into a context that does nothing, so it measures the JavaScript and not the
rasterizing. With `--against <ref>` it alternates every case between that ref
and this tree, and calls a change only when the pairs agree on its direction
(sign test, p < 0.01) and it is at least 5%. `bench/compare.mjs` lines up two
`--out` files from this or the browser bench, with less confidence.

`hosts/unicode/` is a working page over every Unicode code point, and its
`bench/` measures the wall at a million items; `hosts/emoji/` is the compact
wall the portfolio embeds.
