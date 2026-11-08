# Search sweep

Measured 2026-11-08, with:

```
@napi-rs/image  1.15.0
zopfli          1.0.15+wasm.856c441f051284b2ae0d7ee5384cced1730768e551bdf2fdce0dbb2fbfcd5e2a
svgo            4.1.0
```

For every raster a default build produces (ICO payload, apple-touch-icon, and the two `icon-<size>.png` sizes), this sweep tries every candidate in the search space and records the smallest one that passes the accuracy bar (`pct <= 1%`, test/lib/accuracy.mjs) two ways:

- **Exhaustive** — every candidate is tried; the smallest passing one wins, ties going to the less lossy setting (higher quality, then more colours).
- **Binary** — the colour list and the quality list are each searched independently for the fewest colours / lowest quality that passes, assuming the list is monotone (a setting that passes is assumed to mean every less lossy setting on the same list also passes). The smaller of the two results wins; `probes` counts the encodes either search actually needed.

The candidate space: quality in `[40, 50, 60, 70, 80, 90, 95, 98, 99]` at the default colour ceiling (encode ignores colours below quality 100), and quality 100 with colours in `[2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]`. If nothing on either list passes, both winners fall back to quality 100 / colours 256 (the lossless candidate) and report its measured `pct`, which is then above the bar.

Today is the production default build’s own encode (quality 80), from the same in-memory run the candidates are measured against, so the comparison needs no second build.

## Totals by corpus

| Corpus | Jobs | Today | Exhaustive | Δ | Binary | Δ |
|---|---:|---:|---:|---:|---:|---:|
| fixtures | 92 | 129,398 | 77,417 | 40.2% | 95,166 | 26.5% |
| open | 320 | 829,568 | 729,860 | 12.0% | 737,035 | 11.2% |
| private | 156 | 183,489 | 110,818 | 39.6% | 111,138 | 39.4% |

## Totals by raster kind

| Kind | Jobs | Today | Exhaustive | Δ | Binary | Δ |
|---|---:|---:|---:|---:|---:|---:|
| ico | 142 | 92,143 | 86,093 | 6.6% | 86,095 | 6.6% |
| apple | 142 | 194,440 | 160,355 | 17.5% | 161,106 | 17.1% |
| icon | 284 | 855,872 | 671,647 | 21.5% | 696,138 | 18.7% |

41 of 568 jobs have no passing candidate on either list (the exhaustive winner is the quality-100/colours-256 fallback, scored above the bar).

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

`--private` falls back to `FAVSEED_PRIVATE_CORPUS`; omit it (or pass `--no-open`) for a fixtures-only run. Raw per-candidate results are in the gitignored `bench/out/search/results.json`; this file is the committed summary.
