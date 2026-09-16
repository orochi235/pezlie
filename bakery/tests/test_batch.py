import pytest

from pezlie.batch import Render, bake_slot
from pezlie.lock import BakeInProgress, slot_lock
from pezlie.sheet import Levels
from pezlie.sidecar import baked_shas


def test_it_bakes_every_render_and_composes_the_sheets(tmp_path, svg):
    out, lines = tmp_path / "slot", []
    got = bake_slot([Render("a", svg, "s1"), Render("b", svg, "s2")], out,
                    order=["a", "b", "c"], log=lines.append)
    assert got == (2, 2)
    assert baked_shas(out) == {"a": "s1", "b": "s2"}
    assert (out / "sheet-32.webp").is_file()
    assert lines[0] == "  1/2 a baked"


def test_it_bakes_the_whole_slot_at_the_levels_it_is_given(tmp_path, svg):
    out = tmp_path / "slot"
    bake_slot([Render("a", svg, "s")], out, order=["a"], log=lambda _: None,
              levels=Levels(sheets=(16,), loose=64))
    assert (out / "64" / "a.webp").is_file()
    assert (out / "sheet-16.webp").is_file()
    assert not (out / "sheet-32.webp").exists()


def test_a_second_run_bakes_nothing(tmp_path, svg):
    out, lines = tmp_path / "slot", []
    renders = [Render("a", svg, "s1")]
    bake_slot(renders, out, order=["a"], log=lambda _: None)
    assert bake_slot(renders, out, order=["a"], log=lines.append) == (0, 1)
    assert lines[0] == "  1/1 a fresh"


def test_a_missing_render_is_reported_and_the_slot_goes_on(tmp_path, svg):
    out, lines = tmp_path / "slot", []
    got = bake_slot([Render("gone", tmp_path / "nope.svg", "s"), Render("a", svg, "s")],
                    out, order=["gone", "a"], log=lines.append)
    assert got == (1, 2)
    assert "MISSING" in lines[0]
    assert (out / "sheet-8.webp").is_file()


def test_an_unreadable_render_does_not_abandon_the_rest(tmp_path, svg):
    empty = tmp_path / "empty.svg"
    empty.write_text("")
    out, lines = tmp_path / "slot", []
    got = bake_slot([Render("bad", empty, "s"), Render("a", svg, "s")],
                    out, order=["bad", "a"], log=lines.append)
    assert got == (1, 2)
    assert "UNREADABLE" in lines[0]


def test_it_refuses_a_slot_another_bake_holds(tmp_path, svg):
    out = tmp_path / "slot"
    with slot_lock(out):
        with pytest.raises(BakeInProgress):
            bake_slot([Render("a", svg, "s")], out, order=["a"], log=lambda _: None)
