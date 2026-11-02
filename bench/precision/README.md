# Selective SVG precision — 31 October 2026

These recorded measurements use the historical 32px ICO. Current builds use 48px;
see the [ICO report](../ico-size/README.md). The runnable sweep compares its immutable
baseline with the current whole pipeline, including later changes.

These measurements predate the centered non-square raster viewport. See the
[framing report](../framing/README.md) for that later change. The matched Vite inputs
here are square sources and retain the same output bytes.

Full builds try precision 1, 2, 3, 4, 6 and 8, starting each attempt from the original
source. The first passing candidate wins. Validation compares unquantized 512px pixels
against minimally prepared source: at most 1% bad pixels on either a black or white
composite. A bad pixel differs by more than 8/255 in a channel. Completely erasing a mark
fails even when it occupied less than 1% of the canvas. If all candidates fail, the output
retains the source's numeric geometry.

This grades the static base appearance before PNG quantization. It does not prove accuracy
at every SVG display size, animation frame or media state. PNG quality remains 80 by default,
independently of this budget. No Zopfli in the pipeline comparison below.

## Full-pipeline comparison

[Raw results, hashes and methods](results.json) compare PR26 at `9427866` with selective
precision using the same installed engine. Three repetitions rotate and reverse arm order;
repetition 0 is warmup, and the table uses median whole-corpus totals from repetitions 1–2.
Times include in-memory optimization, validation, placement, encoding and artifact construction.
Imports, input reads, reference preparation, disk writes and post-build grading are excluded.
Here “reference preparation” means the benchmark's independent grading references; the new
runtime source preparation and validation are included in the timed builds. These are native
Node timings on the recorded CPU, not browser timing claims.

| Original 11 fixtures | Seconds | PNG + ICO bytes | SVG bytes | Worst final PNG source error |
|---|---:|---:|---:|---:|
| Previous quality 80 | 3.296 | 69,291 | 4,650 | 2.097% |
| Selective quality 80 | 3.191 | 70,254 | 4,652 | 0.114% |
| Selective quality 100 | 3.372 | 74,549 | 4,652 | 0.114% |

The default uses **963 more PNG/ICO bytes (1.4%)** here. The final run is 3.2% faster,
while an [earlier run](earlier-run.json), before the nonvisual document-annotation fix,
measured 2.595s versus 2.672s, or 3.0% slower. Output bytes and accuracy agree across these
runs. Timing variation does not establish a stable speedup or precise validation overhead.
The extra SVG cost is two bytes. All six artifacts for each of the ten non-gradient fixtures
remain byte-identical to the old default. Gradient stops are no longer rounded from
`.42/.78` to `.4/.8`; the gradient's SVG-stage error falls from 2.478% to 0%.

`heavy.svg` retains precision 1 and its 1,527-byte SVG, rather than growing to 3,863 bytes
at precision 3. General, flat, second, mask, animated, tiles, wide, smil and dark also retain p1.

## Coordinate-scale regressions

The generated neutral circle/star fixtures represent the same shape in different units.
The old 1/16/24-unit marks have SVG errors of 15.622%, 1.882% and 1.544%; selected precisions
3/2/2 reduce these to 0.699%, 0.451% and 0.583%. A .001-unit mark previously fails to build;
precision 6 now builds it at 0.699% SVG error. A 1e-12-unit fixture exercises the source fallback.

Across the 14 fixtures both pipelines can build (the original 11 plus three small grids),
worst final PNG source error falls from 10.159% to 0.515%. Final full builds take 4.007s
versus 4.085s. The .001-unit failed old build is excluded from these timing and byte comparisons.

**32px ICO accuracy is separate.** Worst original-corpus source error improves from 2.539%
to 1.660%; the remaining 1.660% is the unchanged heavy ICO. New small-grid ICOs reach 1.465%.
The 512px SVG budget does not establish a 1% guarantee for tiny ICOs. Existing tests gate
default PNGs; the raw data reports ICO failures separately. Actual peak memory also remains
separate work: the 16MiB placement cache is not a process-memory ceiling.

## Fresh Vite PWA comparison

[Encoder and matched-file data](vite-pwa.json) uses assets-generator 2.0.0 and Sharp 0.35.5.
All arms receive identical already-placed, unquantized pixels from the corrected SVGs, with
identity resize and no extra padding. Four fixtures produce 16 matching raster files:
32px ICO and 180/192/512px PNG per fixture. SVG and manifest bytes are excluded. The actual
Vite ICO route is used, with decoded pixels verified unchanged after wrapping.

| Encoder settings | PNG + ICO bytes | Worst PNG error vs unquantized input |
|---|---:|---:|
| Vite PWA default, quality 60 | 36,246 | 5.900% |
| Favseed default, quality 80 | 36,523 | 0.055% |
| Vite PWA quality 100 | 52,404 | 0.065% |

Our default is **277 bytes (0.8%) larger** than Vite's default, with lower measured PNG error.
The previous 2.9%-smaller claim used the old rounded gradient and no longer describes current
output. Against Vite's quality-100 setting, ours is 30.3% smaller; neither quality numbers nor
an aggregate worst-pixel figure establish equivalent fidelity. Vite 100 has lower RMSE on
the gradient payloads and a lower bad-pixel percentage on gradient 180. These fixtures
establish neither a universal size winner nor a speed advantage.

## Reproduce

With the pinned engine installed and git history containing PR26:

```sh
node bench/bench.mjs precision
```

This sweep needs no external resvg/pngquant/oxipng tools. Raw data and first-repetition files
go under ignored `bench/out/precision/`; baseline modules come from git. Other sweeps retain
their native-reference tool requirements. Do not use `--write` for a partial sweep.

For the encoder comparison, install assets-generator 2.0.0 and Sharp 0.35.5 in an isolated
dependency directory under the checkout or system temporary directory, then use fresh outputs:

```sh
node bench/vite-pwa-encode.mjs /tmp/pwa-deps bench/out/matched-default 3 '' vite-default,favseed-default
node bench/vite-pwa-encode.mjs /tmp/pwa-deps bench/out/matched-high-quality 3 100 vite-quality-100
```

Run timings sequentially on an idle CPU. The JSON files retain source/engine/input hashes,
repeated output hashes, per-file errors, settings and timing samples. Browser/native parity
and lifecycle checks run separately from these timings.
