"""Rasterize an item at every level, and compose the levels into sheets.

An item's cell is its position in the host's full order, so a render landing
later fills the cell it already had rather than renumbering the sheet.
"""
from __future__ import annotations

import subprocess
from collections import Counter
from pathlib import Path

from PIL import Image

from pezlie.lock import slot_lock
from pezlie.sheet import DEFAULT_LEVELS, GROUND, LADDER, Levels, geometry
from pezlie.sidecar import BAKED, baked_shas, write_json

#: WebP q90 halves sheet-32 against PNG, and the wall fetches it on every open.
THUMB_EXT = "webp"
THUMB_SAVE = {"format": "WEBP", "quality": 90, "method": 4}


def bake_item(item_id: str, render: Path | str, out: Path | str,
              sha: str, levels: Levels = DEFAULT_LEVELS) -> list[int]:
    """Rasterize one item at every level. Returns the levels written; an
    unchanged sha writes nothing."""
    out = Path(out)
    with slot_lock(out):
        return _bake_item(item_id, Path(render), out, sha, levels)


def compose(out: Path | str, order: list[str],
            levels: Levels = DEFAULT_LEVELS) -> list[Path]:
    """Paste every baked tile onto its sheet at its index in `order`, and
    write the levels beside the sheets. Pass the levels the tiles were baked at.

    `order` is every item, drawn or not: an index is a position in the corpus.
    """
    out = Path(out)
    with slot_lock(out):
        return _compose(out, order, levels)


def _bake_item(item_id: str, render: Path, out: Path, sha: str,
               levels: Levels = DEFAULT_LEVELS) -> list[int]:
    shas = baked_shas(out)
    # The sha covers the render, not the encoding: a tile in an old format is a miss.
    if shas.get(item_id) == sha and all(
            (out / str(level) / f"{item_id}.{THUMB_EXT}").is_file()
            for level in levels.all):
        return []
    drawn = _drawn(item_id, render, out, levels.loose)
    for level in levels.all:
        path = out / str(level) / f"{item_id}.{THUMB_EXT}"
        path.parent.mkdir(parents=True, exist_ok=True)
        _square(drawn, level).save(path, **THUMB_SAVE)
    write_json(out / BAKED, {**shas, item_id: sha})
    return list(levels.all)


def _compose(out: Path, order: list[str],
             levels: Levels = DEFAULT_LEVELS) -> list[Path]:
    repeated = [item_id for item_id, n in Counter(order).items() if n > 1]
    if repeated:
        raise ValueError(f"order repeats {len(repeated)} id(s), first {repeated[:3]}: "
                         "every cell after one lands a place off")
    shas = baked_shas(out)
    written = []
    for level in levels.sheets:
        g = geometry(len(order), level, levels)
        sheet = Image.new("RGBA", (g.size, g.size), (0, 0, 0, 0))
        for index, item_id in enumerate(order):
            tile = out / str(level) / f"{item_id}.{THUMB_EXT}"
            if not tile.is_file():
                continue
            with Image.open(tile) as img:
                cell = img.convert("RGBA")
            x0, y0, _, _ = g.cell_box(index)
            sheet.paste(cell, (x0, y0))
            if g.gutter:
                _replicate_edges(sheet, cell, x0, y0, g.gutter)
        path = out / f"sheet-{level}.{THUMB_EXT}"
        sheet.save(path, **THUMB_SAVE)
        write_json(out / f"sheet-{level}.json", {
            "level": level, "gutter": g.gutter, "pitch": g.pitch,
            "cols": g.cols, "rows": g.rows, "count": len(order),
            "size": g.size, "baked": shas,
        })
        written.append(path)
    # Last, so a ladder never names a sheet that is not there yet.
    write_json(out / LADDER, levels.as_json())
    return written


def _drawn(item_id: str, render: Path, out: Path, width: int) -> Image.Image:
    """The render at `width` wide, as RGBA.

    resvg has no letterbox flag, and passing both -w and -h stretches, so it is
    asked for a width and `_square` pads. A raster render skips resvg, which
    rejects one as "not an UTF-8 encoding" -- reading like a corrupt file.
    """
    if render.suffix.lower() != ".svg":
        with Image.open(render) as img:
            return img.convert("RGBA")
    wide = out / f".{item_id}.wide.png"
    proc = subprocess.run(
        ["resvg", "--width", str(width), str(render), str(wide)],
        capture_output=True, text=True)
    if proc.returncode != 0 or not wide.is_file():
        raise RuntimeError(f"resvg failed on {item_id}: "
                           f"{(proc.stderr or proc.stdout).strip()[:200]}")
    try:
        with Image.open(wide) as img:
            return img.convert("RGBA")
    finally:
        wide.unlink(missing_ok=True)


def _replicate_edges(sheet: Image.Image, cell: Image.Image,
                     x0: int, y0: int, gutter: int) -> None:
    """Pad a cell with its own edge pixels, or each mip reduction averages it
    against its neighbor and the wall reads as halos."""
    w, h = cell.size
    for d in range(1, gutter + 1):
        sheet.paste(cell.crop((0, 0, w, 1)), (x0, y0 - d))
        sheet.paste(cell.crop((0, h - 1, w, h)), (x0, y0 + h + d - 1))
        sheet.paste(cell.crop((0, 0, 1, h)), (x0 - d, y0))
        sheet.paste(cell.crop((w - 1, 0, w, h)), (x0 + w + d - 1, y0))


def _square(drawn: Image.Image, level: int) -> Image.Image:
    """Fit a render, centered, inside a `GROUND` square of `level` px."""
    scale = level / max(drawn.size)
    size = (max(1, round(drawn.width * scale)), max(1, round(drawn.height * scale)))
    cell = Image.new("RGBA", (level, level), GROUND)
    fitted = drawn.resize(size, Image.LANCZOS)
    cell.paste(fitted, ((level - size[0]) // 2, (level - size[1]) // 2), fitted)
    return cell
