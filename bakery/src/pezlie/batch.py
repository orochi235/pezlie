"""Bake one slot: every render the host has for it, then the sheets."""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

from pezlie.bake import _bake_item, _compose
from pezlie.lock import slot_lock
from pezlie.sheet import DEFAULT_LEVELS, Levels


@dataclass(frozen=True)
class Render:
    id: str
    path: Path
    sha: str


def bake_slot(renders: Iterable[Render], out: Path | str, order: list[str],
              log: Callable[[str], None] = print,
              levels: Levels = DEFAULT_LEVELS) -> tuple[int, int]:
    """Returns (baked, total). One line per render as it completes.

    A render that is missing or will not rasterize is reported and skipped:
    an interrupted fetch leaves zero-byte files, and one of them is not a
    reason to abandon the thousands after it.
    """
    out, renders = Path(out), list(renders)
    total, baked = len(renders), 0
    with slot_lock(out):
        for i, r in enumerate(renders, 1):
            if not r.path.is_file():
                log(f"  {i}/{total} {r.id} MISSING {r.path}")
                continue
            try:
                made = _bake_item(r.id, r.path, out, r.sha, levels)
            except Exception as e:  # noqa: BLE001
                log(f"  {i}/{total} {r.id} UNREADABLE {type(e).__name__}: {e}")
                continue
            baked += bool(made)
            log(f"  {i}/{total} {r.id} {'baked' if made else 'fresh'}")
        for path in _compose(out, order, levels):
            log(f"  wrote {path}")
    return baked, total
