# bakery

Bakes one slot's renders into the wall's mip chain, and serves it. A slot is one
set of renders over the whole corpus; each item gets a loose tile, and its
smaller tiles are composed onto one sheet per level, with a JSON manifest beside
each sheet. The levels are 8px and 32px sheets and 128px loose tiles unless the
host picks others, and `levels.json` beside the sheets tells the wall which.

It knows nothing about what the items are. brick-icons is the first host.

```bash
pip install pezlie
pip install 'pezlie[routes]'  # with the FastAPI routes
pip install 'pezlie[feed]'    # with pezlie.feed, which writes Arrow feeds
```

It needs `resvg` on `PATH` for SVG renders. The wall that draws what it bakes is
[`pezlie` on npm](https://www.npmjs.com/package/pezlie).

## What a host supplies

- **The renders for a slot** — `Render(id, path, sha)` per item that has one.
  SVG goes through `resvg`; anything else is opened with Pillow.
- **The full order** — every item id, drawn or not. A cell's index on a sheet
  is its position in this list, so the host must send the same order to
  `compose` and to the wall's feed, or every sprite lands off by one.
  `compose` refuses a list that repeats an id.
- **Optionally, the levels** — `Levels(sheets=(16, 64), loose=256)`, passed to
  `bake_slot`, or to both `bake_item` and `compose`. Sheet levels ascend and the
  loose level is above them all.
- **For the routes** — a slot-name-to-directory lookup, a lookup naming the
  render file for an item in a slot, and the root those files must sit under.

## What it promises

- **Ink, never ground.** Tiles and sheets are transparent where there is no
  ink. The wall paints the ground.
- **One writer per slot.** `bake_item`, `compose` and `bake_slot` hold a lock
  on `<slot>/.bake.lock` and raise `BakeInProgress` instead of interleaving.
- **Freshness by sha.** An item whose sha matches `baked.json`, with tiles in
  the current format, is not rebaked. The manifest carries the sha map, so the
  wall can tell a stale cell from a fresh one.

```python
from pezlie.batch import Render, bake_slot
bake_slot(renders, out="thumbs/occt", order=all_ids)

from pezlie.routes import render_router, thumbs_router
app.include_router(thumbs_router(slot_dir), prefix="/api/thumbs")
app.include_router(render_router(render_file, root, known_slot), prefix="/api/corpus/render")
```

## Develop

Needs `resvg` on `PATH`.

```bash
uv venv bakery/.venv --python 3.14
uv pip install --python bakery/.venv/bin/python -e 'bakery[test]'
bakery/.venv/bin/python -m pytest bakery -q
```

`tests/test_parity.py` bakes the same inputs through brick-icons'
`brick_icons/thumbs.py` and through this package and compares bytes. It looks
for a brick-icons checkout beside pezlie, or at `$BRICK_ICONS`, and skips
without one.
