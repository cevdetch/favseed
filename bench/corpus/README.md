# The bench corpus

A pinned, real-world set of 80 SVG icons drawn from four open Iconify JSON packages (see
`LICENSES.md`), used **only** by `bench/`. Nothing here ships in the package, is imported by
`lib/`, `bin/`, `vite/` or `astro/`, or is read by `test/run.mjs`'s definition-of-done suite —
the test fixtures in `test/fixtures/` remain the only inputs the published tool is measured
against.

## Fetching it

```sh
node bench/corpus/fetch.mjs
```

Downloads the four pinned packages with `npm pack`, extracts `icons.json` alone, and writes
`bench/corpus/.cache/<prefix>/<name>.svg` for every icon `manifest.json` names — then verifies
each file's SHA-256 against the manifest, failing loudly on any mismatch. The cache is
gitignored: it is reconstructed, never committed, and `git status` should show nothing under
`bench/corpus/.cache/` after a fetch.

```sh
node bench/corpus/fetch.mjs --update
```

Re-selects icons with `selectIcons()` (evenly spaced over each set's sorted names, aliases
excluded) and rewrites `manifest.json`. This is a maintainer action, not a routine one: bumping
a pinned version or a selection count changes which icons are measured, so **every number any
benchmark reports against this corpus changes too**. Run it only alongside a reviewed change to
the pinned table in `fetch.mjs`, and re-run every affected benchmark afterwards.

## The private corpus

Real brand marks never enter this repository (see the project's no-brand-content policy).
Benchmarks that want to measure against a maintainer's own, unpublished logo concepts read an
optional second corpus from the `FAVSEED_PRIVATE_CORPUS` environment variable — a local
directory of SVGs, supplied out of band and never committed, never named file-by-file, and
reported in benchmark output only as a total (count, byte sums, pass/fail tallies) — the same
way `.claude/`'s own gitignored notes never reach a commit.

`benchmarkPath()` only accepts a directory inside this checkout or the OS temporary directory, so
the variable cannot point directly at a logo source living elsewhere on disk. Copy it into a
temporary directory first, then point the variable at the copy:

```sh
cp -r ~/dev/branding-c/logos/concepts /tmp/favseed-private
FAVSEED_PRIVATE_CORPUS=/tmp/favseed-private node bench/bench.mjs
```
