# pezlie — pickup state

**2026-09-13.** `bakery` and `wall` are built and on `main`. The wall now holds
items as columns and draws all 1,114,112 Unicode code points
(`hosts/unicode/`, which replaced the generated demo host). What is left of the
original plan is step 7: brick-icons switching to both packages.

**A parallel `/wall` page is on brick-icons `main`.** It draws the corpus
through `WallView` beside `CorpusWall`, pinned to a pezlie sha from before the
column rewrite.

## Where things are

- `docs/superpowers/specs/2026-09-07-abstract-wall-design.md` — the design and
  what is built of it. Read this first.
- `docs/superpowers/specs/2026-09-13-wall-at-a-million-design.md` — how the
  wall reaches a million items, with the measured gates.
- `docs/superpowers/plans/` — every phase, each ending with "What it found".
- `wall/` — the TypeScript package. `wall/README.md` is the host contract.
- `hosts/brick-icons/` — brick-icons' spec, and the tests proving it draws what
  brick-icons drew: goldens, a differential test against the legacy code, and
  `bench/derive.ts`.
- `hosts/unicode/` — every code point and the assigned characters as Arrow
  feeds from UCD 17.0.0, a FastAPI server, the page, and `bench/` (the Arrow
  trial, per-stage `scale.ts`, and `browser.mjs`, the gates).
  `hosts/unicode/README.md` has the commands.
- `hosts/emoji/` — all 3,944 emoji on a compact dark wall, static, deployed to
  `https://michaelbaker.tech/pezlie/` by `.github/workflows/pages.yml` and
  embedded as pezlie's portfolio tile.
- `bakery/` — the Python package, now with `pezlie.feed` for Arrow feeds; its
  README has setup.
- `scripts/brick-icons-bake-parity.py`, `spike/cel/`.

The root is an npm workspace (`wall`, `hosts/brick-icons`, `hosts/unicode`, `hosts/emoji`):
`npm install` once at the root. `bakery/.venv` and `hosts/unicode/.venv` are
gitignored and recreated from each README.

**`wall` is published to npm as `pezlie`** by `.github/workflows/release.yml`, on a pushed `v*`
tag or by hand from the Actions tab, through npm trusted publishing (OIDC); no npm token is involved.
**`bakery` 0.2.0 is built but not yet on PyPI**; it uploads with the owner's
token (`uv publish --token …`). The hosts import the wall's source as `@pezlie/wall/src/*`, through a
tsconfig path and a vite alias, the specifier brick-icons' lab aliases too.

**`bakery` is published on PyPI as `pezlie` and imports as `pezlie`.**

## What is decided that the code does not say

**The name is `pezlie`**, after the first person born tiny in *Solar
Opposites*' wall. The working name, `castleblack`, is a parked npm package
someone else owns.

**Display projections may be hooks; predicates may not.** States, filters,
classes, sorts, tags and the wash flag are CEL so a Python feed can evaluate
them. Captions, facets, glyph, mark and tints are TypeScript.

**`WallView` keeps no address bar.** A host keeps its own hash through
`initial` and `onChange`; brick-icons' `wallHash` stays in brick-icons.

**Rules evaluated by the server stay a maybe.** Approach C in the million-item
spec: the feed would ship derived columns. Not started.

## Traps

**Moving brick-icons' pin past the column rewrite breaks its `/wall` page.**
`Layout` is now `({ rows, facts }, opts) => Laid`; `blockLayout` and
`bandedLayout` take a `GroupKey` (`reads`, `of`, optional `label`) where
brick-icons' `lab/src/wall/host.ts` passes plain functions; tints and facet
hooks need `reads` (`hosts/brick-icons/src/spec.ts` already has them); and a
tie in a sort now keeps index order, not natural id order.

**The host tests read brick-icons' source at `$BRICK_ICONS`**, defaulting to
the checkout beside pezlie — which other sessions edit. For a clean read,
point it at a snapshot: `git -C ~/src/brick-icons archive main lab | tar -x -C
<dir>` and `BRICK_ICONS=<dir>`.

**brick-icons is shared.** Other sessions commit to its `main`. Read it through
`git show main:<path>` or a snapshot; work there only in a worktree.

**The `bakery` parity test skips without a brick-icons checkout.** A green suite
on such a machine has not checked parity.

**Never prove a test can fail by editing a same-length constant on disk.**
Python's bytecode cache keys on mtime and size. Patch in memory.

**A top-left badge sits on a top-left caption.** Only top-right captions make
room; brick-icons has the same overlap.

**Bench numbers on this machine swing by a third.** Other sessions keep the
load average at 20–30; the recorded gates were taken under that load. Compare
runs taken minutes apart, not across days.

**The spec's CEL tables trail brick-icons.** A key brick-icons adds to its
states, filters, classes or sorts makes `hosts/brick-icons/src/spec.ts` throw on
load; the parity tests catch it.

**`_pw_npm_token: command not found`** after npm commands is shell noise from
the work profile, not a failure.

## Next

1. **The name sort gate** (260 ms against 250): work sort orders out before
   they are asked for, off the main thread, or have the feed send them.
2. **Paged sheets**, then font renders, then emoji and Material Symbols — the
   roadmap at the end of the million-item spec. An emoji wall small enough to
   embed in the portfolio was asked about and not decided.
3. **Close the gaps between `/wall` and `/corpus`** in brick-icons (part search,
   the slot groups, the camera and caret in the hash), and adapt `/wall` to the
   column rewrite when its pin moves.
4. **Pop-in, as of the last change.** A glyph cell now turns from a colored square into a character on a faint ground gradually with size (`glyphBlend`), and the wall shows one level at a time, crossfading the whole view when the next level is ready.
   Whether the rest is enough is the owner's call from using it.