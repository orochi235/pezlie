# pezlie

A pan/zoom canvas over a million items, one cell each, drawn from a baked mip
chain of sprites, with a live status color per cell and a detail view behind a
click. Two packages:

- **[`wall`](wall/README.md)** (TypeScript, `pezlie` on npm) — the canvas, the
  level chain, the layout, the chrome. Knows about items, slots and states in
  the abstract and nothing else. **Built**, with
  [`hosts/unicode/`](hosts/unicode/README.md) drawing every Unicode code point.
- **[`bakery`](bakery/README.md)** (Python) — rasterize, square, compose
  atlases, and serve them. **Built.**

A host supplies a corpus and a schema describing it; the wall draws it.
`hosts/unicode` draws all 1,114,112 code points; `hosts/emoji` draws all 3,944
emoji.

The design, and what is built of it, is
[`docs/superpowers/specs/2026-09-07-abstract-wall-design.md`](docs/superpowers/specs/2026-09-07-abstract-wall-design.md);
how it reaches a million items is
[`docs/superpowers/specs/2026-09-13-wall-at-a-million-design.md`](docs/superpowers/specs/2026-09-13-wall-at-a-million-design.md).
