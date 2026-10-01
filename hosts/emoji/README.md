# Emoji host

All 3,944 fully-qualified emoji in Emoji 17.0 on one compact wall: no header,
sidebar or legend, dark, sized to embed. Each cell draws its emoji in the
viewer's own emoji font, so there is nothing to bake and no server. It is
published to GitHub Pages by `.github/workflows/pages.yml`.

```bash
npm run dev -w hosts/emoji       # http://localhost:5197
npm run build -w hosts/emoji     # dist/
npx vitest run                   # in hosts/emoji/
```

`scripts/emoji.mjs` fetches `emoji-test.txt` once into `.cache/`, checks its
pinned sha256, and writes `public/emoji.json`; `dev` and `build` run it first.

**Bench.** `node hosts/emoji/bench/fling.mjs [--against main]` times how long a
flicked wall's landing takes to fill with loose and vector thumbnails. No host
serves those yet, so it gives the feed shas and serves plain squares from a
simulated HTTP/1.1 server (`--connections`, `--latency`), or from a real one
with `--protocol h1|h2`. `--tune NAME=VALUE` pairs this tree against a copy
with one constant changed, which is how the loading limits were swept. Use
`--runs 8` or more: `compare.mjs` calls nothing on fewer pairs. A node of the
fleet has only pushed commits, so `--against` there takes a pushed ref.
