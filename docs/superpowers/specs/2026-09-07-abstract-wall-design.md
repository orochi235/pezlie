# The abstract wall

**Status: built.** This repo holds the CEL spike (`spike/cel/`), `bakery`, and
`wall` — its core (geometry, schema, CEL, `derive`, selection, tints, paint
commands) and its view (drawing, loaders, `Wall`, the chrome, and `WallView`, a
whole wall as a lab page). `hosts/unicode/` and `hosts/emoji/` are hosts built
on the packages.

This is the design of two domain-free packages: `wall`, which draws a corpus of
items as a zoomable wall, and `bakery`, which bakes and serves the thumbnail
atlases it draws from. It is for whoever works on either.

## The shape of the wall

`PaintCommand` is geometry, colors, glyphs and atlas source boxes — nothing
about any host's domain reaches it. What a host decides is the layer directly
above: its states, its sorts, filters and classes, its tints, and its badges,
captions, glyph and mark.

**The wall does not draw with one loop.** `paintCommands` is the boundary, but
two executors sit under it: `drawScene.ts` hands cell bodies to weasel's scene
renderer, and `draw2d.ts` draws what weasel cannot — badges, the kind strip,
captions, the caret, band labels, the glyph and the mark — on a 2D canvas
stacked over it. `toDrawCommands.ts` maps one to the other. The scene renderer
measured faster than drawing every cell in Canvas2D, before far cells became
tiles; since, `hosts/unicode/bench/browser.mjs --scene` shows no difference in
frame times on a GPU, even under `--throttle 4`, and it stays off by default.
The mark, the glyph and the wash color are host hooks.

### What a spec carries beyond a plain predicate

- **Derived variants** — a `VariantDef`. A state that names one generates
  `<key><Variant>`: the same fill, a washed-out border, thin weight, a lower
  precedence, matched from a list of condition keys the server computes. The legend
  folds each variant into its parent's row and count.
- **Two orders** — `precedence` is written separately from listing order.
- **Drawn versus undrawn** — paint: an undrawn cell with a border gets a slash;
  a drawn one wears the border color as the ground behind its tile.
- **State-keyed decoration** — `quiet`: a quiet state swaps captions and badges
  for the spec's `glyph` or `mark`.
- **Measured tints** — `TintDef` hooks, with an inverse for the legend's ticks.
  A measured tint replaces the ground and drops the border.

## The seam

A host describes its corpus as data. The wall reads that description; nothing
else crosses the boundary.

`Expr` is a [CEL](https://cel.dev) expression over `item`. **The built contract
is `wall/src/schema.ts`**; `wall/README.md` states the rules a spec follows.
Predicates, sort values, tags and the wash flag are CEL, because the Python feed
will evaluate the same rules. Captions, facets, the glyph and the mark take
either CEL or a named TypeScript hook: they are display-only, and CEL has no
regex replace. Tints are hooks. A badge is art per tag, in a corner or the
strip, and may yield to a caption.

`fields` below is not built. `WallView` takes the card and detail bodies as
render props, the slot list from `fetchSlots`, and URLs from `SlotUrls`.

`fields` is one declaration read three ways. A field shown as `caption` with a
corner becomes a cell caption; shown as `card` or `modal` it is a row in the
hover card or the detail view. `render` is the escape hatch — it names a hook
returning a node, which the wall places without interpreting.

Filtering is generated in full. `filters`, `sorts`, `classes`, `facets` and
`badges` between them produce the entire filter rail and the legend's tallied
rows. A host writes no filter UI.

### Why CEL rather than closures

The spec is data, not code, and two things follow. The Python feed and the TS
wall evaluate the identical predicate, which closes the two-language constant
problem rather than moving it. And a user-typed filter expression becomes a
small feature instead of an eval sandbox, since CEL is non-Turing-complete and
always terminates.

Registering shared math extensions to keep tints in CEL too was considered and
rejected: every extension is a thing kept in sync across two languages.

## Data flow

CEL runs **once per item per data load** — never per frame, never per filter
click. `@bufbuild/cel` rebuilds a plain object into a CEL map on every call,
about 20 µs for 33 fields, so each item is bound to CEL once rather than once
per expression. A poll delta goes through `rederive` for the rows it
changed, which drops a row's binding first so an item changed in place is seen.
`2026-09-13-wall-at-a-million-design.md` takes this to a million items.

```
spec (JSON + hooks)
  │  compile: every Expr → a CEL program, once
  ▼
items from the feed ──► derive
                          │  one pass over every item: state key, class flags,
                          │  filter flags, badge keys, facet values, sort keys,
                          │  field values
                          ▼
                        facts table (columns parallel to items)
                          │
      selection ─────────►│  filter + sort over precomputed columns
                          ▼
                        view order (indices)
                          │
      layout ────────────►│  rects + bands
                          ▼
      paintCommands ─────►│  reads facts[i], never the item
                          ▼
                        canvas
```

### The index invariant

A cell's atlas index is its position in the full corpus order, and the baker and
the feed must derive it identically or every sprite lands one cell off — which
reads as a rendering fault, not a data fault.

`derive` is the only stage that sees the whole corpus, so it is where the
invariant is asserted: indices dense, unique, `0..n-1`. Everything downstream
filters the *view order*, never the index, so an item a host wants hidden is
filtered out of the view rather than dropped from the order.

## Bakery

`bakery/` bakes one slot's renders into the wall's mip chain and serves the
sheet, tile and render routes. `bakery/README.md` is the host contract.

**Single writer.** Baking and composing take a lock in the slot directory and
raise rather than interleave. The lock stops writers colliding, not readers: a
route serving a sheet mid-write can still hand out a partial file. **A repeated
id in the order is refused**, since it would shift every later cell.

**No ground is baked.** The bake is transparent and the wall paints the ground
under every rung; a baked ground makes the rungs disagree, so a cell changes
shade on one wheel notch. `bakery` asserts it at the pixel.

The item feed stays the host's: `wall`'s `derive` reads what it sends.

## Failure modes

**A bad expression.** Compile every `Expr` at spec load, collect *all* errors,
and render a spec-validation panel in place of the wall. A filter that silently
keeps nothing is an hour of chasing.

**A field the feed does not send.** A feed can be older than the page reading
it. An unknown field resolves to absent and yields `false`, logged once, never
thrown per item per frame.

**A lost sidecar entry** is today indistinguishable from "never rendered": both
draw a blank cell. An item carrying a sha with no manifest entry means the bake
is missing, and that gets its own visible state. An item with no sha is
undrawn, not missing, and never counts toward the stale-sheet warning.

**Staleness.** The manifest carries the sha each cell was baked from; the wall
compares it to the item's current sha. Disagreement means fall back a rung
rather than draw a lie.

**Index drift**, asserted in `derive` as above.

## Testing

**Tests split along the same seam as the code.** Machinery assertions live in
`wall`; policy assertions — *does this condition turn a cell red* — live with
the host. **`wall`'s source and suite name no host's domain**, and
`wall/test/leak.test.ts` fails on one; that is a better detector than reading
imports.

**`wall`'s tests use their own spec**, `wall/test/fixture.ts`, a corpus with
nothing in common with any real host that exercises every feature of the
schema.

**Cross-language conformance.** The expressions the spec uses, evaluated in the
chosen JS implementation and in `cel-python`, asserted equal. The spike that
picked the implementation (`spike/cel/`) is this test. It carries a lesson: a
conformance corpus only catches what someone thought to write down. The corpus
passed both candidates, and the probe that separated them (`regex-probe.mjs` /
`regex-probe.py`) had to be written after the corpus came back clean.

## Decisions

**Where `wall` sits relative to weasel: decided 2026-09-13 — a separate package
in pezlie**, depending on `@weasel-js/core`, `labkit` and `ui` from npm. It
owns both executors. Folding it into weasel was weighed and turned down. Any
renderer feature the 2D overlay covers today lands as a weasel release that
`wall` then picks up.

**Name: settled 2026-09-13 — `pezlie`**, free on npm and PyPI. The working name,
`castleblack`, is a parked npm package someone else owns.

**CEL implementation: settled — `@bufbuild/cel`.** Not on the expression corpus,
which failed to separate the candidates: both JS implementations agreed with
`cel-python` on 105 of 108 cells. It was settled on the regex engine.
`cel-python` and `@bufbuild/cel` both use RE2; `@marcbachmann/cel-js` hands the
pattern to JavaScript's `RegExp`, and the two diverge in both directions —
`(?i)latin` works under RE2 and throws under `RegExp`, while `^(?!_).*` is a
valid JS lookahead that RE2 rejects. A pattern that works in the browser and
throws in the feed is exactly the failure the shared schema exists to prevent,
and it surfaces only when someone writes that pattern. The cost of the choice is
real and worth stating: `@bufbuild/cel` is ~4x slower per evaluation and pulls
10.6 MB of dependencies against 272 KB and none, which will matter if the wall's
bundle size ever binds.

**Two expressions need host support, neither of them a TypeScript hook.**
`lowerAscii` is a CEL string extension rather than core: `@bufbuild/cel` has it
via the `strings` bundle from `@bufbuild/cel/ext`, and `cel-python` needs it
registered as a host function (`env.program(ast, functions={...})`, verified to
return the same string). Reading a field an item omits errors identically in all
three, and `has()`-guarding returns `false` in all three — so that is a
schema-authoring rule, not code.
