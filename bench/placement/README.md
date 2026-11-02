# Bounded placement rendering

Measured 1 November 2026 with image 1.15.0, Node 26.12.1 and Ryzen 7 7840U. The control is
merged PR30 (`2a0eea0cc294d54cb41ed1b85d80d03c93cab4f4`); both arms use default quality 80,
Zopfli off, a 48px ICO and manifest/default PNG sizes. [Raw results](results.json) retain
source/code hashes, per-file hashes/errors, fits, callback requests and all repetitions.

| Native full builds | Before | Bounded | Result |
|---|---:|---:|---|
| Existing 20-fixture corpus | 4.698s | 4.709s | Effectively unchanged |
| Three small painted extents | 23.367s | 2.453s | 9.5× faster |
| Combined 23-fixture corpus | 28.066s | 7.162s | 3.9× faster on this mixture |

The diagnostic fixtures represent a small centered circle, a small grid-aligned square and
an offset circle with fractional coordinates, all with large transparent margins. They expose
the expensive path; the combined speedup depends on their presence and is not a general claim.
On the original 11 fixtures, builds measure 2.703→2.716s, also effectively unchanged.

| Diagnostic | Before | Bounded | Largest RGBA callback dimension, before→bounded |
|---|---:|---:|---:|
| small-mark | 15.014s | 1.355s | 3,164→512px |
| small-grid | 0.475s | 0.083s | 2,316→512px |
| small-offset | 7.878s | 1.015s | 2,550→512px |

## Output and accuracy

All files, fit metadata, links and animation metadata are identical across arms on all 23
fixtures and across three repetitions. Raster bytes stay 126,416; complete sets including SVG
and manifest stay 138,524 bytes. The original 20 retain 118,093 raster/129,206 complete-set bytes.
The existing matched Vite encoder comparison still describes the emitted files: its four
logos belong to this unchanged corpus. This benchmark makes no new Vite speed claim.

Worst padded PNG source error remains 0.515%; worst 48px ICO source error remains 1.215% on
the two small-grid precision fixtures. The three new small-painted-extent cases score 0% source
error at every measured size in both arms. Source references use unoptimized inputs, matched
safe-zone placement and the worse black/white composite at an 8/255 channel tolerance. The
static 512px SVG budget and PNG quality remain unchanged; neither guarantees 1% at all sizes.

## Why the threshold matters

The fit must still enlarge a mark with intrinsic margins. Clamping that fitted box would
make the exported mark too small. Instead, when the fitted box exceeds twice the target
canvas, each probe renders that same box centered on the target canvas. Both sizes are even,
so the translation stays on whole pixels. Every descending candidate, the 10% search window,
first-crisp/tie/halving rules and conservative scheduling remain.

Moderate searches retain direct rendering and reuse across output sizes. Their probe canvases
cannot exceed twice the target. The original 20 have identical renderer callback sequences
and 815 callbacks in both arms, including SVG validation. The flat fixture retains 59 callbacks;
a preliminary target-only approach needed 64 by losing 180/192px reuse. The regression test
checks that cost. The calibrated 180px small-mark test still takes 55probes, now capped at 180px.
Callback counts can differ through cache reuse; they are not logical candidate counts.

For the three diagnostics, estimated callback working pixels drop 2,441,815,960→193,368,000
(92.1%). The estimate sums `px * max(1000, px)` to account for the pinned renderer's 1000px
floor; counters include SVG validation and placement `renderRgba` calls, excluding output
`render` calls. It is not measured allocation, concurrent peak RAM or process memory. The
bound controls each probe's dimensions, not the candidate count or total build-time ceiling.
Large user-requested output canvases still require correspondingly large renders.

## Reproduce

From the repository root with pinned dependencies and the baseline in git history:

```sh
node bench/bench.mjs placement
```

The sweep loads baseline modules without changing the checkout, prepares independent grading
references, then rotates/reverses arm order over three repetitions. Repetition 0 is warmup;
the reported median averages the remaining two whole-corpus totals. Timing includes runtime
SVG validation, placement, rendering and encoding, excluding imports, source reads, grading
references, scoring and output writes. CPU benchmarks ran sequentially without browser/test
competition. Results go under ignored `bench/out/placement/`; do not use partial `--write`.

These are native warm in-memory measurements, not cold startup, browser speed or peak-memory
measurements. Browser/native parity and installed-package lifecycle checks run separately.
