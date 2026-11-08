# Where the edge gate came from

The accuracy bar's second clause, edge error `<= 1.5883` (`EDGE_GATE` in `lib/core.mjs`,
decision 29 in [docs/DECISIONS.md](../../docs/DECISIONS.md)), was taken from one run of
`bench/sheet.mjs` on 2026-11-08. That run read the results of the search sweep as merged in
141862a, which used the pct-only bar: every winner it sampled was the smallest candidate with
`pct <= 1 %` and no other clause.

`bench/sheet.mjs` re-encodes a sample of those winners and quality 80 for the same rasters,
renders them side by side, and scores both against the reference with three metrics the sweep
did not compute. For each metric, the threshold is quality 80's worst value over every eligible
raster where quality 80 already passed the bar: 346 rasters over the fixtures and the open
corpus, every kind and size. Private marks are not eligible.

| metric | threshold (quality 80's worst) | sampled winners beyond it |
|---|---:|---:|
| RMSE (higher is worse) | 5.6273 | 3 of 109 |
| SSIM (lower is worse) | 0.9925 | 6 of 109 |
| edge error (higher is worse) | **1.5883** | **17 of 109** |

106 of the 109 winners were worse than quality 80 for their own raster on every metric. That is
expected, because a smaller encode drops information. The question was which ones it showed.
Looking at the sheet:

| raster | winner's edge error | what it looked like |
|---|---:|---|
| `open/flat-color-icons/file` icon-192 | 3.39 | visibly serrated edges |
| `open/logos/deepgram-dark` icon-512 | 6.59 (quality 80: 0.74) | harsher lettering |
| `fixtures/second` apple-180 | 1.90 | identical to quality 80 |

pct passed all three. Edge error put both visible failures at two to four times the worst
value quality 80 had shipped as passing, so it became the second clause. Its threshold is the
measured worst of what already shipped as passing, not a derived constant. `fixtures/second` apple-180 is above it, so the gate also refuses some winners that
looked fine. [README.md](README.md), "The edge gate's cost", gives what that costs in bytes:
+0.5 % over the pct-only winners.

**This run cannot be reproduced row for row.** The sweep's winners now pass both clauses
(`passesBar` in `lib/quality.mjs`), and `bench/sheet.mjs` samples from those gated winners.
A re-run therefore samples different rasters, and no sampled winner should exceed 1.5883.
The thresholds themselves are drawn from quality 80, which the gate does not change.
