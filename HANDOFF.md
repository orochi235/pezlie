# pezlie — pickup state

**2026-09-13.** `bakery` and `wall` are built and on `main`. The wall now holds
items as columns and draws all 1,114,112 Unicode code points
(`hosts/unicode/`, which replaced the generated demo host).

## Where things are

- `docs/superpowers/specs/2026-09-07-abstract-wall-design.md` — the design and
  what is built of it. Read this first.
- `docs/superpowers/specs/2026-09-13-wall-at-a-million-design.md` — how the
  wall reaches a million items, with the measured gates.
- `wall/` — the TypeScript package. `wall/README.md` is the host contract.
- `hosts/unicode/` — every code point and the assigned characters as Arrow
  feeds from UCD 17.0.0, a FastAPI server, the page, and `bench/` (the Arrow
  trial, per-stage `scale.ts`, and `browser.mjs`, the gates).
  `hosts/unicode/README.md` has the commands.
- `hosts/emoji/` — all 3,944 emoji on a compact dark wall, static, deployed to
  `https://michaelbaker.tech/pezlie/` by `.github/workflows/pages.yml` and
  embedded as pezlie's portfolio tile.
- `bakery/` — the Python package, now with `pezlie.feed` for Arrow feeds; its
  README has setup.
- `spike/cel/` — the probe that chose CEL for the rules.

The root is an npm workspace (`wall`, `hosts/unicode`, `hosts/emoji`):
`npm install` once at the root. `bakery/.venv` and `hosts/unicode/.venv` are
gitignored and recreated from each README.

**`wall` is published to npm as `pezlie`** by `.github/workflows/release.yml`, on a pushed `v*`
tag or by hand from the Actions tab, through npm trusted publishing (OIDC); no npm token is involved.
**`bakery` 0.2.0 is built but not yet on PyPI**; it uploads with the owner's
token (`uv publish --token …`). The hosts import the wall's source as `@pezlie/wall/src/*`, through a
tsconfig path and a vite alias.

**`bakery` is published on PyPI as `pezlie` and imports as `pezlie`.**

## What is decided that the code does not say

**The name is `pezlie`**, after the first person born tiny in *Solar
Opposites*' wall. The working name, `castleblack`, is a parked npm package
someone else owns.

**Display projections may be hooks; predicates may not.** States, filters,
classes, sorts, tags and the wash flag are CEL so a Python feed can evaluate
them. Captions, facets, glyph, mark and tints are TypeScript.

**`WallView` keeps no address bar.** A host keeps its own hash through
`initial` and `onChange`.

**Rules evaluated by the server stay a maybe.** Approach C in the million-item
spec: the feed would ship derived columns. Not started.

## Traps

**Never prove a test can fail by editing a same-length constant on disk.**
Python's bytecode cache keys on mtime and size. Patch in memory.

**A top-left badge sits on a top-left caption.** Only top-right captions make
room.

**Bench numbers on this machine swing by a third or more.** Other sessions keep
the load average anywhere from 20 to 300; the recorded gates were taken at
20–30. Prove a render change with `npm run bench -- --against <ref>` in
`wall/`, which pairs its runs; two `--out` files from different minutes
disagree about identical code.

**`_pw_npm_token: command not found`** after npm commands is shell noise from
the work profile, not a failure.

## Next

1. **The name sort gate** (260 ms against 250): work sort orders out before
   they are asked for, off the main thread, or have the feed send them.
2. **Paged sheets**, then font renders, then emoji and Material Symbols — the
   roadmap at the end of the million-item spec. An emoji wall small enough to
   embed in the portfolio was asked about and not decided.
3. **Pop-in, as of the last change.** A glyph cell now turns from a colored square into a character on a faint ground gradually with size (`glyphBlend`), and the wall shows one level at a time, crossfading the whole view when the next level is ready.
   Whether the rest is enough is the owner's call from using it.
4. **One small render saving, measured and not built.** The other fixes
   from reading the render code are on `main` (`c5b1823` onward, numbers in
   each commit). Prove any render change with `npm run bench -- --against main`
   in `wall/`.
   - `drawGlyph` measures each glyph every frame: 0.15 ms a frame over 400
     glyph cells (2.98 against 2.83 ms). Caching means scaling one measurement
     across sizes, which risks the vertical placement its comment guards.
