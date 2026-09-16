"""Bake a sample of real brick-icons renders through its thumbs.py and through
bakery, and compare bytes. Run with bakery/.venv/bin/python.

Read-only against brick-icons: renders are read, corpus.db is opened ro, and
every bake goes under --out.
"""
import argparse
import importlib.util
import random
import sqlite3
import sys
from pathlib import Path

from pezlie import bake

ap = argparse.ArgumentParser()
ap.add_argument("--brick-icons", required=True, type=Path)
ap.add_argument("--out", required=True, type=Path)
ap.add_argument("--per-slot", type=int, default=150)
args = ap.parse_args()

spec = importlib.util.spec_from_file_location(
    "legacy_thumbs", args.brick_icons / "brick_icons" / "thumbs.py")
legacy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = legacy
spec.loader.exec_module(legacy)

conn = sqlite3.connect(f"file:{args.brick_icons / 'corpus.db'}?mode=ro", uri=True)
order = [r[0] for r in conn.execute("SELECT id FROM parts ORDER BY id")]
sources = [r[0] for r in conn.execute("SELECT DISTINCT source FROM renders ORDER BY source")]
rng = random.Random(13)


def files(root):
    # levels.json is bakery's own addition: the legacy bake writes no ladder.
    return {str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*"))
            if p.is_file() and p.name not in (".bake.lock", "levels.json")}


total_items = total_files = total_diff = 0
for n, source in enumerate(sources, 1):
    rows = conn.execute("SELECT part_id, path, sha256 FROM renders WHERE source = ?",
                        (source,)).fetchall()
    rows = [r for r in rows if (args.brick_icons / r[1]).is_file()]
    sample = rng.sample(rows, min(args.per_slot, len(rows)))
    exts = sorted({Path(r[1]).suffix for r in sample})
    a, b = args.out / "legacy" / source, args.out / "lifted" / source
    errors = 0
    for part_id, path, sha in sample:
        render = args.brick_icons / path
        outcomes = []
        for fn, out in ((legacy.bake_part, a), (bake.bake_item, b)):
            try:
                fn(part_id, render, out, sha=sha)
                outcomes.append("ok")
            except Exception as e:  # noqa: BLE001
                outcomes.append(type(e).__name__)
        if outcomes[0] != outcomes[1]:
            print(f"  {source} {part_id}: legacy {outcomes[0]}, lifted {outcomes[1]}")
        errors += outcomes[0] != "ok"
    legacy.compose(a, order)
    bake.compose(b, order)
    fa, fb = files(a), files(b)
    diff = sorted(set(fa) ^ set(fb)) + [k for k in fa if k in fb and fa[k] != fb[k]]
    total_items += len(sample)
    total_files += len(fa)
    total_diff += len(diff)
    print(f"[{n:2d}/{len(sources)}] {source:<22} {len(sample):4d} renders {','.join(exts):<10}"
          f" {errors:3d} unreadable  {len(fa):5d} files  {len(diff):3d} differ", flush=True)
    for name in diff[:5]:
        print(f"      differs: {name}")

print(f"{len(sources)} slots, {total_items} renders, {total_files} files, {total_diff} differ")
sys.exit(1 if total_diff else 0)
