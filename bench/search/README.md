# Search sweep

Measured 2026-11-08, with:

```
@napi-rs/image  1.15.0
zopfli          1.0.15+wasm.856c441f051284b2ae0d7ee5384cced1730768e551bdf2fdce0dbb2fbfcd5e2a
svgo            4.1.0
```

For every raster a default build produces (ICO payload, apple-touch-icon, and the two `icon-<size>.png` sizes), this sweep tries every candidate in the search space and records the smallest one that passes the accuracy bar (`pct <= 1%`, test/lib/accuracy.mjs) two ways:

- **Exhaustive** — every candidate is tried; the smallest passing one wins, ties going to the less lossy setting (higher quality, then more colours).
- **Binary** — the colour list and the quality list are each searched independently with a leftmost-passing binary search, assuming the list is monotone (a setting that passes is assumed to mean every less lossy setting on the same list also passes — a cost model for the search itself, not a claim either list is actually sorted by file size). The winner is **the smallest-bytes passing candidate among every candidate either search actually probed** — not "the leftmost passing index" (see the quirk below for why) — tie-broken exactly like the exhaustive winner. `probes` counts those encodes, already measured; no extra encoding happens to pick the winner.

The candidate space: quality in `[40, 50, 60, 70, 80, 90, 95, 98, 99]` at the default colour ceiling (encode ignores colours below quality 100), and quality 100 with colours in `[2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]`. If nothing on either list passes, both winners fall back to quality 100 / colours 256 (the lossless candidate) and report its measured `pct`, which is then above the bar.

**The colours=2 quirk.** `engine.encode` keeps the smaller of a quantised and a lossless encode, and at colours=2 the quantised (1-bit) PNG can be *several times larger* than colours=3 — a flat 512px icon measured here: colours=2 is 3,949 B (the lossless path won, because the 1-bit quantised file was bigger still) against colours=3 at 1,427 B, both passing the bar. The colour list is therefore not monotone in bytes, only in pass/fail, and "fewest passing colours" or any other first-match policy on it would report the colours=2 file as the win — several times the size of a setting right next to it on the same list. The binary winner rule above exists because of exactly this: it picks the smallest of what the search actually looked at, not the first thing that passed.

Today is the production default build’s own encode (quality 80), from the same in-memory run the candidates are measured against, so the comparison needs no second build.

## Totals by corpus

| Corpus | Jobs | Today | Exhaustive | Saved | Binary | Saved |
|---|---:|---:|---:|---:|---:|---:|
| fixtures | 92 | 129,398 | 77,417 | 40.2% | 77,542 | 40.1% |
| open | 320 | 829,568 | 729,860 | 12.0% | 731,324 | 11.8% |
| private | 156 | 183,489 | 110,818 | 39.6% | 111,096 | 39.5% |

## Totals by raster kind

| Kind | Jobs | Today | Exhaustive | Saved | Binary | Saved |
|---|---:|---:|---:|---:|---:|---:|
| ico | 142 | 92,143 | 86,093 | 6.6% | 86,093 | 6.6% |
| apple | 142 | 194,440 | 160,355 | 17.5% | 160,579 | 17.4% |
| icon | 284 | 855,872 | 671,647 | 21.5% | 673,290 | 21.3% |

41 of 568 jobs have no passing candidate on either list (the exhaustive winner is the quality-100/colours-256 fallback, scored above the bar).

Today's default (quality 80) itself misses the bar outright on 66 of 568 rasters — fixtures 2, open 64, private 0 (count only). 41 of those 568 rasters also have no passing candidate anywhere on either list (the line above); the remainder pass under a setting the default build doesn't choose.

Encode time per 512px job (sum of its 26 candidate encodes): median 2458 ms, p95 6352 ms, over 142 jobs.

## Largest relative savings (today → exhaustive)

| Mark | Today | Exhaustive | Saved |
|---|---:|---:|---:|
| fixtures/smil-events | 2,339 | 1,038 | 55.6% |
| fixtures/smil | 4,016 | 1,888 | 53.0% |
| open/flat-color-icons/about | 2,813 | 1,327 | 52.8% |
| fixtures/aspect-offset | 2,283 | 1,090 | 52.3% |
| fixtures/aspect-wide | 2,283 | 1,090 | 52.3% |
| open/flat-color-icons/middle-battery | 2,027 | 1,002 | 50.6% |
| fixtures/aspect-tall | 2,196 | 1,086 | 50.5% |
| fixtures/dark | 4,656 | 2,303 | 50.5% |
| fixtures/second | 3,366 | 1,679 | 50.1% |
| open/logos/expo | 4,758 | 2,396 | 49.6% |

1 private mark(s) would also place in this top 10 by the same relative-savings measure.

## Winning colour counts at >= 180px

Colour-mode wins (quality 100) are bucketed by their winning colour count; quality-mode wins are bucketed by quality instead, since their colour budget wasn't the constraint.

| Colours | Jobs |
|---:|---:|
| 2 | 20 |
| 3 | 73 |
| 4 | 11 |
| 5 | 16 |
| 6 | 15 |
| 8 | 29 |
| 10 | 31 |
| 12 | 20 |
| 16 | 19 |
| 24 | 10 |
| 32 | 4 |
| 48 | 7 |
| 64 | 5 |
| 96 | 4 |
| 128 | 1 |
| 192 | 5 |
| 256 | 114 |

| Quality (colour-unconstrained) | Jobs |
|---:|---:|
| 40 | 10 |
| 50 | 2 |
| 60 | 4 |
| 70 | 2 |
| 80 | 11 |
| 90 | 10 |
| 95 | 3 |

## Reproduce

```sh
node bench/corpus/fetch.mjs
node bench/search.mjs --private DIR --write
```

`--private` falls back to `FAVSEED_PRIVATE_CORPUS`. Omitting `--private` does **not** mean fixtures-only: the open corpus still runs by default, and `FAVSEED_PRIVATE_CORPUS` (if set in the environment) is still picked up with no flag at all. A fixtures-only run needs `--no-open` *and* no private corpus available either way (no `--private`, and `FAVSEED_PRIVATE_CORPUS` unset). Raw per-candidate results are in the gitignored `bench/out/search/results.json`; this file is the committed summary. `node bench/search.mjs --summarise --write` rewrites both of those from the stored candidates alone — no corpus, no engine, no re-encoding — for when only the winner rule changes.
