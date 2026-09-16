import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from pezlie.routes import render_router, thumbs_router


@pytest.fixture
def client(tmp_path):
    slot = tmp_path / "thumbs" / "naive"
    (slot / "128").mkdir(parents=True)
    Image.new("RGBA", (128, 128)).save(slot / "128" / "3001.webp", "WEBP")
    Image.new("RGBA", (8, 8)).save(slot / "sheet-8.webp", "WEBP")
    (slot / "sheet-8.json").write_text('{"level": 8}')
    (slot / "baked.json").write_text("{}")
    (slot / "levels.json").write_text('{"sheets": [8], "loose": 128}')

    store = tmp_path / "store"
    (store / "naive").mkdir(parents=True)
    (store / "naive" / "3001.svg").write_text("<svg viewBox='0 0 256 170'></svg>")
    (store / "naive" / "3002.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBPVP8 ")
    (tmp_path / "outside.svg").write_text("<svg>not in the store</svg>")
    renders = {("naive", "3001"): store / "naive" / "3001.svg",
               ("naive", "3002"): store / "naive" / "3002.webp",
               ("naive", "escape"): store / ".." / "outside.svg"}

    slots = {"naive"}
    app = FastAPI()
    app.include_router(thumbs_router(
        lambda s: tmp_path / "thumbs" / s if s in slots else None), prefix="/api/thumbs")
    app.include_router(render_router(
        lambda s, i: renders.get((s, i)), store, lambda s: s in slots),
        prefix="/api/corpus/render")
    return TestClient(app)


def test_a_loose_tile_is_served_whatever_extension_was_asked(client):
    r = client.get("/api/thumbs/naive/128/3001.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"


def test_a_sheet_is_served(client):
    assert client.get("/api/thumbs/naive/sheet-8.webp").status_code == 200


def test_a_manifest_carries_its_image_version(client):
    body = client.get("/api/thumbs/naive/sheet-8.json").json()
    assert body["level"] == 8
    assert body["version"].isdigit()


def test_a_slot_names_its_levels(client):
    assert client.get("/api/thumbs/naive/levels.json").json() == {"sheets": [8], "loose": 128}


def test_a_slot_baked_before_levels_json_is_404(client, tmp_path):
    (tmp_path / "thumbs" / "naive" / "levels.json").unlink()
    assert client.get("/api/thumbs/naive/levels.json").status_code == 404


def test_a_missing_manifest_is_404(client):
    assert client.get("/api/thumbs/naive/sheet-32.json").status_code == 404


def test_an_unknown_slot_is_400(client):
    assert client.get("/api/thumbs/nonsense/128/3001.png").status_code == 400


def test_a_tile_route_serves_images_only(client):
    assert client.get("/api/thumbs/naive/128/baked.json").status_code == 400


def test_a_tile_route_refuses_traversal(client):
    assert client.get(
        "/api/thumbs/naive/128/..%2F..%2Fbaked.json").status_code in (400, 404)


def test_a_render_is_served(client):
    r = client.get("/api/corpus/render/naive/3001.svg")
    assert r.status_code == 200
    assert "<svg" in r.text


def test_a_render_is_typed_by_what_it_is_not_by_its_url(client):
    r = client.get("/api/corpus/render/naive/3002.svg")
    assert r.headers["content-type"] == "image/webp"


def test_an_unknown_render_is_404(client):
    assert client.get("/api/corpus/render/naive/9999.svg").status_code == 404


def test_a_render_in_an_unknown_slot_is_400(client):
    assert client.get("/api/corpus/render/nonsense/3001.svg").status_code == 400


def test_a_render_outside_the_store_is_404(client):
    assert client.get("/api/corpus/render/naive/escape.svg").status_code == 404
