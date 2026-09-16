"""The lift renamed things and moved nothing: bakery and the brick-icons file
it came from bake the same inputs to the same bytes. Skips without a
brick-icons checkout beside pezlie, or at $BRICK_ICONS."""
import importlib.util
import os
import sys
from pathlib import Path

import pytest
from PIL import Image

from pezlie import bake

LEGACY = (Path(os.environ.get("BRICK_ICONS")
               or Path(__file__).resolve().parents[3] / "brick-icons")
          / "brick_icons" / "thumbs.py")


def _legacy():
    if not LEGACY.is_file():
        pytest.skip(f"no brick-icons thumbs.py at {LEGACY}")
    spec = importlib.util.spec_from_file_location("legacy_thumbs", LEGACY)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # @dataclass looks its module up here
    spec.loader.exec_module(module)
    return module


def _renders(root: Path) -> dict[str, Path]:
    root.mkdir()
    wide = root / "wide.svg"
    wide.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 170">'
                    '<rect x="20" y="10" width="200" height="150" fill="#c33"/>'
                    '<circle cx="128" cy="85" r="60" fill="#36c"/></svg>')
    tall = root / "tall.svg"
    tall.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 240">'
                    '<path d="M0 240 L45 0 L90 240 Z" fill="#2a2"/></svg>')
    raster = root / "raster.webp"
    img = Image.new("RGBA", (256, 170))
    for x in range(256):
        for y in range(0, 170, 3):
            img.putpixel((x, y), (x, 255 - x, y, 255))
    img.save(raster, "WEBP")
    return {"a": wide, "b": tall, "c": raster}


def _files(root: Path) -> dict[str, bytes]:
    # levels.json is bakery's own addition: the legacy bake writes no ladder.
    return {str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*"))
            if p.is_file() and p.name not in (".bake.lock", "levels.json")}


def test_a_slot_bakes_to_the_same_bytes_as_the_code_it_was_lifted_from(tmp_path):
    legacy = _legacy()
    renders = _renders(tmp_path / "src")
    order = ["a", "never-drawn", "b", "c"]

    for item_id, path in renders.items():
        legacy.bake_part(item_id, path, tmp_path / "legacy", sha=f"sha-{item_id}")
        bake.bake_item(item_id, path, tmp_path / "lifted", sha=f"sha-{item_id}")
    legacy.compose(tmp_path / "legacy", order)
    bake.compose(tmp_path / "lifted", order)

    before, after = _files(tmp_path / "legacy"), _files(tmp_path / "lifted")
    assert sorted(before) == sorted(after)
    assert [name for name in before if before[name] != after[name]] == []
