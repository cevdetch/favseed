# Matching raster presets: Vite PWA and Favseed

Current default quality is 80; the quality-100/default figures below describe the earlier policy. See [QUALITY.md](QUALITY.md).

For the optional native quality control and updated size/error results, see [QUALITY.md](QUALITY.md).

Measured 31 October 2026, current perf/startup-memory source; image 1.15.0, Vite PWA assets-generator 2.0.0,
Sharp 0.35.5, Node 26.12.1, Ryzen 7 7840U, Linux x64. Source/input hashes and engine identity are saved
in [matched-environment.json](matched-environment.json).

Both encoders receive identical already-rendered PNG pixels, including backgrounds and safe-zone
placement. For each of tiles/general/heavy/gradient, compare three 180/192/512px PNGs and one 32px ICO:
**16 files total**. This holds output count, dimensions and framing constant. SVG and manifest bytes
are excluded. It measures encoding on a shared raster preset, not each generator rendering an SVG
independently or using its original default preset.

Vite uses its real generateTransparentAsset API with identity resize/zero extra padding. Its ICO
then follows its real generateFavicon API, which re-encodes the PNG before wrapping it. Favseed uses
its normal dual-candidate encode, optional 120-iteration finish, and ICO wrapper. ICO repacking is
verified pixel-identical. Two rotated/reversed interleaved repetitions after warmup give stable hashes.

| Encoder/settings | Matched PNG + ICO bytes | Worst PNG error vs shared input |
| --- | ---: | ---: |
| Vite PWA default, quality 60 | **36,624** | 5.024% |
| Vite PWA higher-fidelity comparator, quality 100 | 52,240 | 0.055% |
| Favseed default, Zopfli off | 40,449 | **0.008%** |
| Favseed Zopfli on, 120 iterations | 39,266 | **0.008%** |

Error is the share of pixels whose largest channel difference exceeds 8/255 on either a white or
black composite. Worst values cover the 180/192/512 PNGs; ICO accuracy is recorded separately.
Quality 100 is a higher-fidelity comparator, not a claim of lossless encoding or identical quality.

Vite's default is smaller here: Favseed is 10.4% larger without Zopfli and 7.2% larger with it.
Its stronger quantization also causes more error. Relative to Vite quality 100, Favseed is 22.6%
smaller without Zopfli and 24.8% smaller with it. Zopfli itself saves 1,183 bytes (**2.925%**) from
Favseed's 40,449-byte set, changing no decoded pixels. Both Favseed settings reproduce the prior
full-pipeline PNG/ICO bytes exactly; the enabled arm matches the saved compressed control.

## Per-logo totals, bytes

| Fixture | Vite default | Vite quality 100 | Favseed off | Favseed on |
| --- | ---: | ---: | ---: | ---: |
| tiles | 1,552 | 1,960 | 757 | 746 |
| general | 4,104 | 6,943 | 5,756 | 5,421 |
| heavy | 4,088 | 6,621 | 6,070 | 5,789 |
| gradient | 26,880 | 36,716 | 27,866 | 27,310 |

Four fixtures cannot predict all logos. These totals answer the same-size/file-count comparison;
they do not establish a universal compression winner or compare complete website asset bundles.

## Accuracy against the original SVG

The separate untimed source grader includes SVG optimization/placement effects. Worst non-ICO
source error is 10.912% for Vite default, 1.899% for Vite quality 100, and 1.742% for both Favseed arms.
Excluding the documented gradient exception, the maxima are 1.389%, 0.114%, 0.114%, 0.114%, respectively.
The higher-fidelity Vite setting therefore costs more bytes while both tools retain the existing
gradient limitation. The same input pixels do not imply identical output pixels across encoders;
Zopfli on/off, however, is exactly pixel-identical.

## Timing scope and reproduction

PNG encoding/finish-only totals were 0.290s (Vite default), 0.341s (Vite quality 100), 0.740s (Favseed off)
and 58.571s (Favseed 120). These serial encoder-control timings exclude rendering, placement, imports,
file writes and Vite's subsequent ICO packaging. They are not full-generator, browser or concurrent
pipeline wall times; use [DEFAULTS.md](DEFAULTS.md) for those earlier generation measurements.

```sh
node bench/vite-pwa-encode.mjs /isolated/deps /fresh/results 3 100 vite-default,vite-quality-100,favseed-0,favseed-120
node bench/vite-pwa-accuracy.mjs /fresh/results
```

Use the pinned isolated dependencies above. The low-effort argument 3 is retained for the historical
harness interface; the selected arms here use only 0/120 iterations. `matched-summary.json` and
`matched-files/` include the real ICO step. `summary.json` contains PNG-only encoder timings/totals.
Raw files and source scores are retained under ignored `.superpowers/sdd/2026-10-31-matched-preset/`.
The main run used the pre-existing PNG harness, then the identical new matched-ICO phase separately;
a short full-harness run validates the reusable path and reproduces the saved hashes.

Compact evidence: [matched files](matched-preset.csv), [PNG timing/error rows](matched-encoding.csv),
[environment, fingerprints and summaries](matched-environment.json). No production code changed.
