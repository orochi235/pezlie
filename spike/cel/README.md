# Which CEL implementation

The wall's schema puts one CEL expression in front of two runtimes: TypeScript in the
browser and Python in the feed. This spike checks whether the JS candidates actually agree with
`cel-python`, the closest thing to a reference, on the expressions the schema needs. Read it
before writing a predicate into a schema.

Run it: `node run.mjs buf && node run.mjs marc && .venv/bin/python run.py && .venv/bin/python compare.py`.
Every runner reads the same `expressions.json` — 27 expressions across 4 fixtures, 108 cells —
so no runner can quietly test a different set. `compare.py` exits 1 while anything disagrees.

Versions: `@bufbuild/cel@0.6.1`, `@marcbachmann/cel-js@8.0.0`, `cel-python==0.5.0`.

## Use `@bufbuild/cel`

Both JS candidates agree with `cel-python` on 105 of 108 cells, and the three exceptions are the
same expression. Agreement on the corpus is not what separates them — the regex engine is.

`.matches()` is the one place a CEL expression carries a whole second language, and the three
implementations do not run the same one. `cel-python` and `@bufbuild/cel` both use RE2;
`@marcbachmann/cel-js` hands the pattern to JavaScript's `RegExp`. Those diverge in both
directions, and `regex-probe.py` shows it:

| pattern | cel-python | @bufbuild/cel | @marcbachmann/cel-js |
| --- | --- | --- | --- |
| `^[~=_\|]` | false | false | false |
| `(?:brick\|dome)` | false | false | false |
| `(?i)brick` | true | true | **throws** — `Invalid regular expression` |
| `^(?!_).*` | error — `invalid perl op` | error — `unsupported Perl syntax` | **true** |
| `a{2,3}` | false | false | false |

A pattern that works in the browser and throws in the feed is the failure the shared-schema design
exists to prevent, and it only surfaces when someone writes that pattern. `@bufbuild/cel` removes
the class of bug.

What it costs: `@bufbuild/cel` pulls `@bufbuild/cel-spec`, `@bufbuild/protobuf` and `@bufbuild/re2`
(10.6 MB installed) against 272 KB and zero dependencies for `@marcbachmann/cel-js`, and it is
about 4x slower per evaluation. If the browser bundle later turns out to be the binding constraint,
`@marcbachmann/cel-js` is the fallback, and the schema then has to restrict `.matches()` to patterns
both engines read the same way.

`lowerAscii` is not in `@bufbuild/cel`'s standard function set; it ships in the opt-in
`@bufbuild/cel/ext` `strings` bundle, which `run.mjs` enables.

## What disagreed

Three cells, all `str.lower` — `item.category.lowerAscii()` — on the three fixtures that have a
`category`:

| cell | cel-python | @bufbuild/cel | @marcbachmann/cel-js |
| --- | --- | --- | --- |
| `str.lower@plain` | error — `undeclared reference to 'lowerAscii'` | `"brick"` | `"brick"` |
| `str.lower@timeout` | error — same | `"~moved"` | `"~moved"` |
| `str.lower@sticker` | error — same | `"_sticker"` | `"_sticker"` |

`lowerAscii` is a CEL string extension, not standard CEL, and `cel-python` 0.5.0 does not carry it.

Everything else matches, including the two cases the corpus was built to break. The unguarded read
of an absent field (`guard.absentField@absent`) errors in all three, with different messages but
the same outcome; guarding it with `has()` returns `false` in all three. The corpus's own regex,
`^[~=_|]`, agrees everywhere.

## Cost

`item.open_defects > 0`, compiled once and evaluated 24,591 times (`bench.mjs`, Node 26, warmed):

- `@bufbuild/cel` — **32 ms** for the full corpus, **1.3 us** per evaluation.
- `@marcbachmann/cel-js` — 7 ms, 0.26 us per evaluation.

Re-evaluating one predicate over the whole corpus costs about two frames. Fine on a filter change,
too slow per frame — cache the results against the item set rather than recomputing them during
pan and zoom.

## The three edge expressions

None of them needs a TypeScript hook, given `@bufbuild/cel`. Each needs something, though:

**`guard.absentField`** — nothing. All three error identically on a missing field, and
`has(item.tags) && …` returns `false` in all three. This is a schema-authoring rule, not a code
problem: guard any field a fixture may omit.

**`str.lower`** — register `lowerAscii` on the Python side. `cel-python` takes custom functions via
`env.program(ast, functions={"lowerAscii": …})`; passing a `str.lower` wrapper there makes the
expression evaluate to the same string both runtimes already produce. It is a host-registered
function the schema must declare, not free standard library — the same is true of anything else
from the strings extension.

**`str.matches`** — nothing, with `@bufbuild/cel`. Its RE2 and `cel-python`'s agree, including on
rejecting the same patterns. Under `@marcbachmann/cel-js` this one would need a hook, or a
documented pattern subset.
