# The wall at a million items

**Status: built 2026-09-13.** Every gate passes except one: re-sorting a
million rows by name takes 260 ms against a 250 ms bar. Numbers are under
Measured; where the build departs from the design below, the design has been
corrected to what was built.

This is the design for making `wall` fast at 1,114,112 items, with every
Unicode code point as the corpus that proves it. It is for whoever implements
it, and assumes the abstract-wall spec
(`2026-09-07-abstract-wall-design.md`) and the `wall/` package.

## Goal and gates

The corpus is every code point, U+0000 to U+10FFFF. It passes when, against a
warm local server in headless Chromium:

| gate | first bar | target |
|---|---:|---:|
| first paint of the whole wall | ≤ 3 s | < 1 s |
| pan and zoom, whole wall on screen | 60 fps | 60 fps |
| filter, class, tag or sort change redrawn | ≤ 250 ms | ≤ 250 ms |

State matching may run off the main thread if the page stays usable meanwhile.

## Why the current path cannot

Measured on an Apple M2 Max, Node 26.0.0, over 1,114,112 generated items with
Unicode-shaped fields:

| step | cost |
|---|---:|
| items as JSON | 162.9 MB raw, 6.3 MB gzipped |
| `JSON.parse` | 767 ms, 386 MB heap |
| `derive`, a 5-state spec with 2 filters and 2 sorts | 3,127 ms (2.8 µs per item) |

On top of that, `applySelection` sorts every visible row with a comparator on
every selection change, `gridLayout` allocates a `Rect` per item,
`visibleRange` scans every rect, and at full zoom-out `paintCommands` emits a
command for every cell, because every cell is visible.

## Design

### Feed: Arrow

A collection's items arrive as an Arrow IPC table, one column per field.
Strings that repeat (`kind`, `block`, `script`) are dictionary-encoded, lists
(tags) are Arrow lists, and nulls are validity bitmaps. The wall keeps the
columns as Arrow gave them and reads dictionary codes straight from the
buffers; it never builds an object per item.

- **Python:** `bakery` gains `pezlie.feed`, which writes a table with `pyarrow`.
- **JS:** `apache-arrow` (21.2.0) decodes it.
- **Small hosts keep objects.** `storeFromItems(items)` builds the same column
  store from `T[]`, so a host with tens of thousands of items can go on sending
  JSON.
- **Poll deltas** arrive as a table of changed rows and are applied by `index`.
  A delta drops every cached sort order, tint and caption, and the tiles.

**Arrow passed its trial.** Decoding the 1,114,112-row Unicode table (70 MB,
8.0 MB gzipped) and reading every column buffer and dictionary once takes
67.6 ms warm in headless Chromium, against a 200 ms bar; the decode itself is
under 1 ms, because Arrow reads the buffers in place.
`hosts/unicode/bench/arrow-trial.mjs` reproduces it.

### State matching grouped by value

When a spec compiles, the wall walks each CEL expression's parse tree and
collects the fields it reads: `item.f`, `item['f']` with a constant key, and
`has(item.f)`. An expression that uses `item` any other way is marked
ungroupable.

`derive` then groups rows by the codes of an expression's fields and runs the
expression once per distinct group, writing the result to every row in it. For
Unicode the states read only `kind` and the general category, so they cost a few dozen evaluations. An
ungroupable expression, or one whose fields have nearly as many distinct values
as rows (`item.secs > 60`), runs once per row on the main thread;
nothing measured has needed a worker. A value that is nothing but a field read
(`item.cp`) runs no CEL at all and takes the column as it stands.

TypeScript hooks (tints, facets, grouping keys) declare `reads: string[]` and
are grouped the same way; a hook is called with an object holding only those
fields. One of these without `reads` is a spec error. Caption, glyph and mark
hooks need no `reads`: they run for visible rows only and get the whole item.

Results are typed columns: the state as a `Uint8Array` of state codes, each
filter and class as a `Uint8Array`, each facet as codes into its value list.

### Selection without re-sorting

Each sort key's order is computed the first time that sort is used and cached
as a `Uint32Array` of rows. The key's distinct values are ranked -- numbers
through a typed-array sort, or not at all when the column already rises;
strings by one flat natural key each, compared as plain strings -- and rows are
counting-sorted by rank. Ties break by `index`.

A filter, class, facet or tag change is then one linear pass over the cached
order, writing the rows it keeps into a new `Uint32Array`.

### Layout as blocks

A layout returns blocks and bands, not a rect per item. A block is a rectangle
of cells: its origin, column count, the first view position it holds, and its
count. A grid is one block; `blockLayout` and `bandedLayout` produce one block
per group. A cell's rect is arithmetic on its block, and the visible range is
the blocks that intersect the viewport, then the cell range inside each.

Grouping keys become projections (CEL, or a hook with `reads`), so grouping
uses the same value-grouped evaluation as everything else.

`blockLayout` and `bandedLayout` are generic over the item type, so a key
function handed to one needs its parameter typed; it cannot be inferred from the
items passed later.

### Drawing: a tile pyramid built in the browser

Below the drawn size at which badges appear (`BADGE_MIN_PX`, 56 px), the wall
draws from world-space tiles instead of cells:

- Tiles are 512 px squares at power-of-two zoom levels, rendered on demand and
  keyed by layout version, slot, tint, highlight and wash. A frame draws the few
  dozen tiles covering the screen, each at the nearest level.
- A missing tile is drawn from the next coarser level scaled up while it
  renders. Rendering takes a fixed time budget per frame, nearest the center
  first.
- Where a cell is under 4 tile pixels, a tile is written straight into
  `ImageData`: each cell a run of its state's border color, else its fill, or
  its tint swatch. Above that a tile is `paint`'s commands for its cells, drawn
  from the sheets, with badges and captions left off.
- A cache of 128 tiles is evicted least recently used.
- The caret and band labels draw over the tiles each frame, as they do now.

At and above `BADGE_MIN_PX` so few cells fit on screen that they draw one by
one as now, with captions, glyphs and marks computed for visible rows only and
cached per row. A card or detail view builds its item object from the columns
for that one row.

### Unicode host

`hosts/unicode/` replaces `hosts/demo/`, which is deleted.

- **Data:** the Unicode 17.0.0 UCD files (`UnicodeData.txt`, `Blocks.txt`,
  `Scripts.txt`, `DerivedAge.txt`), downloaded once into a
  gitignored cache and checked against pinned sha256 sums.
- **Items:** `id` `U+XXXX`, `index` (in `codepoints`, the code point), `sha` null, and
  `kind` (`assigned`, `unassigned`, `private`, `surrogate`, `noncharacter`),
  general category, block and its first code point, script, age, plane and name.
- **Collections:** one generator pass writes `codepoints` (1,114,112 items) and
  `assigned` (every code point whose `kind` is `assigned`, re-indexed from 0).
  Each has a single slot with nothing rendered and no sheets.
- **Server:** one FastAPI app serves each collection's feed and slots under
  `/api/<collection>/`, gzipping each feed once.
- **Page:** a collection picker in the `WallView` header, held in the hash
  (`#codepoints`, `#assigned`). Switching remounts `WallView` with that
  collection's spec, URLs and `storageKey`.

### Measurement

- **`hosts/unicode/bench/scale.ts`** times decode, derive, sort, select, layout and one
  full-wall tile render over the Unicode table at 25k, 250k and 1,114,112 rows,
  printing each stage as it finishes (`3/18  derive  1114112  41.2 ms`).
- **`hosts/unicode/bench/browser.mjs`** drives headless Chromium through
  Playwright: time from navigation to the first frame with every cell drawn;
  frame times over a scripted pan and zoom with the whole wall on screen; and
  the time from a filter or sort click to the next complete frame. It prints
  each against its gate and exits nonzero on a miss.

## Measured

A production build in headless Chromium (`playwright-core` 1.63.0), 1600 by
1000 at a device pixel ratio of 1, on an Apple M2 Max whose load average from
other work sat between 20 and 30. `hosts/unicode/bench/browser.mjs` reproduces
it.

| gate | measured |
|---|---:|
| first paint, every code point | 731–756 ms |
| median frame, pan and zoom with the whole wall on screen | 16.7 ms |
| 95th percentile frame | 16.8 ms |
| show assigned, show unassigned, show all | 82–135 ms |
| order by code point, by age | 99–125 ms |
| color by age, by status | 100–175 ms |
| **order by name** | **260–268 ms** |

Of first paint, the 8.1 MB gzipped feed has arrived by about 280 ms; decode,
derive, the default sort, layout and the first tiles take the other 470. The
Vite dev server adds about half a second to first paint.

The name sort is the one miss. Its cost is one natural key per distinct name
(159,802) and a comparator sort over them, about 150 ms of the 260. The next
step is working sort orders out before anyone asks -- off the main thread, or
sent by the feed as part of rules evaluated by the server.

## Not in this spec

Each is its own spec, in this order:

1. **Paged sheets.** One square atlas per level caps the 32 px sheet at about
   207k items (WebP's 16,383 px side over a 36 px pitch). Sheets become
   fixed-size pages addressed by index.
2. **Font renders** for both Unicode collections, a slot per font.
3. **Emoji** (Noto Color Emoji, Twemoji, OpenMoji as slots) and **Material
   Symbols** as further collections on the same page.
4. **Rules evaluated by the server**, possibly: the feed ships derived state,
   filter and sort columns, computed by `cel-python` or over Arrow directly.
