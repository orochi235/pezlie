# Unicode host

Every Unicode code point on one wall, 1,114,112 of them, and the 159,866
assigned characters as a second collection. It is the corpus that proves `wall`
at a million items, and what `bench/` measures.

## Run

```bash
uv venv hosts/unicode/.venv --python 3.14
uv pip install --python hosts/unicode/.venv/bin/python -e 'hosts/unicode[test]'

hosts/unicode/.venv/bin/python hosts/unicode/make.py         # fetches UCD 17.0.0 once
hosts/unicode/.venv/bin/python -m uvicorn --factory 'server:app_from_env' --app-dir hosts/unicode --port 8796
npm run dev -w hosts/unicode     # http://localhost:5196, /api proxied to 8796
```

`#codepoints` and `#assigned` pick the collection.

**Static build.** `make.py --parts <dir>` also writes each collection as gzipped
Arrow parts of 131,072 rows with a `manifest.json`; a build with
`VITE_STATIC=1` fetches those from `data/<collection>/` beside the page, in
parallel, with no server. `.github/workflows/pages.yml` publishes one at
`https://michaelbaker.tech/pezlie/unicode/`. `make.py` checks the UCD files
against pinned sha256 sums in `ucd.py`; the server reads `UNICODE_OUT` (default
`hosts/unicode/out`).

## Tests and benches

```bash
hosts/unicode/.venv/bin/python -m pytest hosts/unicode/tests -q
npx vitest run                   # in hosts/unicode/
node hosts/unicode/bench/arrow-trial.mjs
node hosts/unicode/bench/browser.mjs --out run.json   # needs .venv: uv sync
node hosts/unicode/bench/sheet-source.mjs        # <img> against ImageBitmap as a sheet source
```
