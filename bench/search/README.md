# Search sweep

Measured 2026-11-08, with:

```
@napi-rs/image  1.15.0
zopfli          1.0.15+wasm.856c441f051284b2ae0d7ee5384cced1730768e551bdf2fdce0dbb2fbfcd5e2a
svgo            4.1.0
```

For every raster a default build produces (ICO payload, apple-touch-icon, and the two `icon-<size>.png` sizes), this sweep tries every candidate in the search space and records the smallest one that passes the accuracy bar (`pct <= 1%`, test/lib/accuracy.mjs) two ways:

- **Exhaustive** — every candidate is tried; the smallest passing one wins, ties going to the less lossy setting (higher quality, then more colours).
- **Binary** — the colour list and the quality list are each searched independently with a leftmost-passing binary search, assuming the list is monotone in pass/fail (a setting that passes is assumed to mean every less lossy setting on the same list also passes — a cost model for the search itself; see below for how often that holds). The winner is **the smallest-bytes passing candidate among every candidate either search actually probed** — not "the leftmost passing index" (see the quirk below for why) — tie-broken exactly like the exhaustive winner. `probes` counts those encodes, already measured; no extra encoding happens to pick the winner.

The candidate space: quality in `[40, 50, 60, 70, 80, 90, 95, 98, 99]` at the default colour ceiling (encode ignores colours below quality 100), and quality 100 with colours in `[2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]`. Every candidate is `engine.encode`'s own output, the smaller of a quantised and a lossless encode, exactly as a build would make it. If nothing on either list passes, both winners are today's own encode: the default setting (quality 80, colours 256), today's bytes and today's `pct`, which is then above the bar.

Today is the production default build's own encode (quality 80), from the same in-memory run the candidates are measured against, so the comparison needs no second build. It is also the quality-80 candidate, byte for byte, on all 568 jobs, so wherever today passes, the exhaustive winner is never larger than today.

**The colours=2 quirk.** At colours=2 the quantised (1-bit) PNG can be *larger* than the lossless encode, and the candidate is then the lossless file: a flat 512px icon measured here is 3,949 B at colours=2 against 1,427 B at colours=3, both passing the bar. The colour list is therefore not monotone in bytes, and "fewest passing colours" or any other first-match policy on it would report the colours=2 file as the win — several times the size of a setting right next to it on the same list. The binary winner rule above exists because of exactly this: it picks the smallest of what the search actually looked at, not the first thing that passed.

**Monotone pass/fail.** The quality list is monotone on 568 of 568 jobs. The colour list is not quite: on 13 of 568 jobs a colour count passes and a higher one fails again (fixtures 5, open 6, private 2; private by count only):

| Job | First pass at colours | Fails again at |
|---|---:|---|
| fixtures/dark apple-180 | 2 | 3 and 4 |
| fixtures/dark icon-192 | 2 | 3 |
| fixtures/flat apple-180 | 2 | 3, 4, 5, 6 and 8 |
| fixtures/flat icon-192 | 2 | 3, 4, 5 and 6 |
| fixtures/heavy icon-192 | 5 | 6 |
| open/flat-color-icons/command-line icon-192 | 2 | 3 |
| open/logos/gwt icon-512 | 3 | 4 and 5 |
| open/logos/open-zeppelin-icon apple-180 | 10 | 12 |
| open/logos/open-zeppelin-icon icon-192 | 6 | 8 |
| open/logos/peer5 icon-512 | 3 | 4 |
| open/logos/vite-dark icon-512 | 8 | 10 |

…and 2 private job(s), not listed.

## Totals by corpus

All jobs, in bytes:

| Corpus | Jobs | Today | Exhaustive | Saved | Binary | Saved |
|---|---:|---:|---:|---:|---:|---:|
| fixtures | 92 | 129,398 | 77,417 | 40.2% | 77,542 | 40.1% |
| open | 320 | 829,568 | 715,569 | 13.7% | 717,033 | 13.6% |
| private | 156 | 183,489 | 110,818 | 39.6% | 111,096 | 39.5% |

Jobs where today passes the bar (502 of 568) — pure savings, since a passing today is itself a candidate:

| Corpus | Jobs | Today | Exhaustive | Saved | Binary | Saved |
|---|---:|---:|---:|---:|---:|---:|
| fixtures | 90 | 128,102 | 76,121 | 40.6% | 76,246 | 40.5% |
| open | 256 | 504,831 | 384,656 | 23.8% | 386,120 | 23.5% |
| private | 156 | 183,489 | 110,818 | 39.6% | 111,096 | 39.5% |

## Jobs where today misses the bar

Today's default misses the bar on 66 of 568 jobs (fixtures 2, open 64, private 0; private by count only).

- **25 of those 66** have a passing candidate (fixtures 0, open 25, private 0). Passing costs bytes there: today 179,216 B against 185,392 B for the exhaustive winners (+3.4%). The binary search finds a pass on 25 of them.
- **41 of those 66** have no passing candidate on either list (fixtures 2, open 39, private 0) and keep today's bytes.

The 2 fixture miss(es): grid-1 ico 48px at 1.2153% and grid-tiny ico 48px at 1.2153%. These are the suite’s accepted exception for those two grids (28 of 2,304 pixels, test/run.mjs and bench/ico-size/README.md), not a regression.

## Totals by raster kind

All jobs, in bytes:

| Kind | Jobs | Today | Exhaustive | Saved | Binary | Saved |
|---|---:|---:|---:|---:|---:|---:|
| ico | 142 | 92,143 | 81,218 | 11.9% | 81,218 | 11.9% |
| apple | 142 | 194,440 | 158,018 | 18.7% | 158,242 | 18.6% |
| icon | 284 | 855,872 | 664,568 | 22.4% | 666,211 | 22.2% |

## Binary against exhaustive

Where both pass, the binary winner differs in bytes from the exhaustive one on 25 of 568 jobs (fixtures 2, open 9, private 14), 1,867 B in all. The worst relative gap outside the private corpus is open/logos/gwt icon-512: 2,659 B against 1,816 B (+46.4%). 0 private job(s) have a larger relative gap.

Probes per job: min 7, median 7, mean 7.3, max 9 — against 26 candidates for the exhaustive sweep.

Time per 512px job, over 142 jobs. Encode is `engine.encode` alone (the zopfli finish every path pays once, on its winner, is not included); score is the accuracy gate, which today's default build never runs. results.json stores each job's summed times, so today and binary are estimated from the per-candidate mean of the same job:

| Path | Median encode ms | Median score ms | Median total ms | p95 total ms |
|---|---:|---:|---:|---:|
| today (1 encode, estimate) | 95 | 0 | 95 | 244 |
| binary (its probes, estimate) | 662 | 103 | 770 | 2,074 |
| exhaustive (all 26, measured) | 2,458 | 380 | 2,840 | 6,741 |

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

Colour-mode wins (quality 100) are bucketed by their winning colour count; quality-mode wins are bucketed by quality instead, since their colour budget wasn't the constraint. 17 of the 426 jobs at >= 180px have no passing candidate and are left out: their winner is today's default setting, not a search result.

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
| 256 | 97 |

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

`--private` falls back to `FAVSEED_PRIVATE_CORPUS`, and `DIR` must be inside this checkout or the OS temporary directory (see [the corpus README](../corpus/README.md#the-private-corpus)). Omitting `--private` does **not** mean fixtures-only: the open corpus still runs by default, and `FAVSEED_PRIVATE_CORPUS` (if set in the environment) is still picked up with no flag at all. A fixtures-only run needs `--no-open` *and* no private corpus available either way (no `--private`, and `FAVSEED_PRIVATE_CORPUS` unset). Raw per-candidate results are in the gitignored `bench/out/search/results.json`; this file is the committed summary. `node bench/search.mjs --summarise --write` rewrites both of those from the stored candidates alone — no corpus, no engine, no re-encoding — for when only the winner rule changes.
