import pytest

from pezlie import sheet


def test_the_default_levels_are_the_two_sheets_and_the_loose_one():
    assert sheet.DEFAULT_LEVELS.sheets == (8, 32)
    assert sheet.DEFAULT_LEVELS.loose == 128


@pytest.mark.parametrize("bad", [
    {"sheets": (32, 8)}, {"sheets": (8, 8)}, {"sheets": (8, 32), "loose": 32},
    {"sheets": ()}, {"sheets": (0, 8)},
])
def test_levels_refuse_a_ladder_out_of_order(bad):
    with pytest.raises(ValueError):
        sheet.Levels(**bad)


def test_the_grid_is_square_enough_to_hold_every_item():
    g = sheet.geometry(24591, level=32)
    assert (g.cols, g.rows) == (157, 157)


def test_the_coarsest_level_has_no_gutter():
    assert sheet.geometry(100, level=8).gutter == 0
    assert sheet.geometry(100, level=32).gutter == 2


def test_geometry_reads_its_sheets_off_the_levels_given():
    levels = sheet.Levels(sheets=(16, 64), loose=256)
    assert sheet.geometry(100, level=16, levels=levels).gutter == 0
    assert sheet.geometry(100, level=64, levels=levels).gutter == 2
    with pytest.raises(ValueError):
        sheet.geometry(100, level=8, levels=levels)


def test_pitch_is_the_cell_plus_both_gutters():
    g = sheet.geometry(100, level=32)
    assert g.pitch == 36
    assert g.size == g.cols * 36


def test_a_cell_lands_row_major_inside_its_gutter():
    g = sheet.geometry(100, level=32)  # cols == 10
    assert g.cell_box(0) == (2, 2, 34, 34)
    assert g.cell_box(1) == (38, 2, 70, 34)
    assert g.cell_box(10) == (2, 38, 34, 70)


def test_an_index_past_the_grid_is_an_error():
    g = sheet.geometry(4, level=8)
    with pytest.raises(IndexError):
        g.cell_box(g.cols * g.rows)


def test_the_loose_level_is_not_a_sheet():
    with pytest.raises(ValueError):
        sheet.geometry(100, level=sheet.DEFAULT_LEVELS.loose)


def test_a_square_sheet_never_crops_an_uneven_grid():
    g = sheet.geometry(82, level=32)
    assert (g.cols, g.rows) == (10, 9)
    assert g.cell_box(81)[3] <= g.size


def test_a_tiny_corpus_still_has_a_grid():
    for count in (0, 1):
        g = sheet.geometry(count, level=8)
        assert (g.cols, g.rows) == (1, 1)


def test_the_ground_is_transparent():
    assert sheet.GROUND == (0, 0, 0, 0)
