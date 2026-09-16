"""Where a cell sits on a sheet: the level chain and the grid geometry."""
from __future__ import annotations

import math
from dataclasses import dataclass

#: The coarsest sheet ends the mip chain, so it cannot bleed and needs no
#: padding. Every finer sheet does.
GUTTER = 2

#: The bake owns the ink and the wall owns the ground. A baked ground makes
#: the zoom rungs disagree, and a cell changes shade on one wheel notch.
GROUND = (0, 0, 0, 0)

#: Beside a slot's sheets: the levels it was baked at, which the wall reads
#: rather than assumes.
LADDER = "levels.json"


@dataclass(frozen=True)
class Levels:
    """The sizes a slot is baked at: one sprite sheet per `sheets` level, and
    one file per item at `loose`, which is also the width resvg draws at."""
    sheets: tuple[int, ...] = (8, 32)
    loose: int = 128

    def __post_init__(self):
        object.__setattr__(self, "sheets", tuple(self.sheets))
        sizes = self.all
        if not self.sheets:
            raise ValueError("a ladder needs at least one sheet level")
        if any(type(n) is not int or n < 1 for n in sizes):
            raise ValueError(f"levels are positive pixel sizes, not {sizes}")
        if any(a >= b for a, b in zip(sizes, sizes[1:])):
            raise ValueError(f"levels ascend, sheets then loose, with no repeats: {sizes}")

    @property
    def all(self) -> tuple[int, ...]:
        return (*self.sheets, self.loose)

    def as_json(self) -> dict:
        return {"sheets": list(self.sheets), "loose": self.loose}


DEFAULT_LEVELS = Levels()


@dataclass(frozen=True)
class Geometry:
    count: int
    level: int
    cols: int
    rows: int
    gutter: int

    @property
    def pitch(self) -> int:
        return self.level + 2 * self.gutter

    @property
    def size(self) -> int:
        return self.cols * self.pitch

    def cell_box(self, index: int) -> tuple[int, int, int, int]:
        """The cell's (left, top, right, bottom) on the sheet, gutters excluded."""
        if not 0 <= index < self.cols * self.rows:
            raise IndexError(f"cell {index} is outside a {self.cols}x{self.rows} grid")
        col, row = index % self.cols, index // self.cols
        x = col * self.pitch + self.gutter
        y = row * self.pitch + self.gutter
        return (x, y, x + self.level, y + self.level)


def geometry(count: int, level: int, levels: Levels = DEFAULT_LEVELS) -> Geometry:
    if level not in levels.sheets:
        raise ValueError(f"{level} is not a sheet level; sheets are {levels.sheets}")
    cols = max(1, math.ceil(math.sqrt(count)))
    # cols >= sqrt(count) keeps rows <= cols, so the square sheet never crops.
    rows = max(1, math.ceil(count / cols))
    gutter = 0 if level == levels.sheets[0] else GUTTER
    return Geometry(count=count, level=level, cols=cols, rows=rows, gutter=gutter)
