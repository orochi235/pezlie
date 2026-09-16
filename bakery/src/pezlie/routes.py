"""Mountable routes for a baked slot and the renders behind it.

    app.include_router(thumbs_router(slot_dir), prefix="/api/thumbs")
    app.include_router(render_router(render_file, root, known_slot),
                       prefix="/api/corpus/render")
"""
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from pezlie.sheet import LADDER

MEDIA_TYPES = {".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp"}


def _tile(base: Path, stem: str) -> Path | None:
    """The file for `stem` in whichever format it was baked: slots baked
    before WebP are PNG, so a request's extension is a name, not a format."""
    for ext in ("webp", "png"):
        path = base / f"{stem}.{ext}"
        if path.is_file():
            return path
    return None


def thumbs_router(slot_dir: Callable[[str], Path | None]) -> APIRouter:
    """`slot_dir` maps a slot name to its bake directory, or None for a slot
    the host does not have."""
    router = APIRouter()

    def _slot(slot: str) -> Path:
        base = slot_dir(slot)
        if base is None:
            raise HTTPException(400, f"no such slot: {slot}")
        return base

    @router.get("/{slot}/levels.json")
    def get_levels(slot: str):
        path = _slot(slot) / LADDER
        if not path.is_file():
            raise HTTPException(404, "no levels.json; the slot was baked before it")
        return JSONResponse(json.loads(path.read_text()))

    @router.get("/{slot}/sheet-{level}.{ext}")
    def get_sheet(slot: str, level: int, ext: str):
        base = _slot(slot)
        if ext == "json":
            path = base / f"sheet-{level}.json"
            if not path.is_file():
                raise HTTPException(404, "no such sheet manifest")
            manifest = json.loads(path.read_text())
            # The image is rewritten at a URL the client never varies, so a
            # browser can hold last week's atlas against this manifest.
            image = _tile(base, f"sheet-{level}")
            if image is not None:
                manifest["version"] = str(int(image.stat().st_mtime))
            return JSONResponse(manifest)
        path = _tile(base, f"sheet-{level}")
        if path is None:
            raise HTTPException(404, "no such sheet")
        return FileResponse(path)

    @router.get("/{slot}/{level}/{name}")
    def get_tile(slot: str, level: int, name: str):
        if "/" in name or ".." in name or not name.endswith((".png", ".webp")):
            raise HTTPException(400, "bad thumbnail path")
        path = _tile(_slot(slot) / str(level), Path(name).stem)
        if path is None:
            raise HTTPException(404, "no such thumbnail")
        return FileResponse(path)

    return router


def render_router(render_file: Callable[[str, str], Path | None], root: Path,
                  known_slot: Callable[[str], bool]) -> APIRouter:
    """`render_file` names the render the host holds for an item in a slot.
    Only its answer reaches the filesystem, and it must resolve inside `root`."""
    router = APIRouter()
    store = Path(root).resolve()

    @router.get("/{slot}/{item_id}.svg")
    def get_render(slot: str, item_id: str):
        if not known_slot(slot):
            raise HTTPException(400, f"no such slot: {slot}")
        found = render_file(slot, item_id)
        path = found.resolve() if found is not None else None
        if path is None or store not in path.parents or not path.is_file():
            raise HTTPException(404, "no such render")
        # `.svg` is the wall's URL for a render, not a claim about the bytes.
        return FileResponse(path, media_type=MEDIA_TYPES.get(
            path.suffix, "application/octet-stream"))

    return router
