# Zopfli effort and Vite PWA encoder measurements

Current defaults skip Zopfli and emit one preserved SVG; release/fast compression requires
explicit opt-in. Measurements below describe the earlier policy unless stated otherwise.
See [DEFAULTS.md](DEFAULTS.md) for the current default, fresh Vite PWA comparison and memory checks.

These measurements precede the lossless palette pass in 0.2.0. See [COMPETITOR.md](COMPETITOR.md)
for the subsequent full-generator/Vite build comparison and updated palette results.

Measured 30–31 October 2026 on an AMD Ryzen 7 7840U, Linux x64, Node 26.12.1.
Favseed uses `@napi-rs/image` 1.15.0 and the rebuilt Zopfli WASM whose SHA-256 is
`856c441f051284b2ae0d7ee5384cced1730768e551bdf2fdce0dbb2fbfcd5e2a`.
Production defaults remain 120 iterations for release and 15 for fast.

I recommend testing **5 iterations for interactive generation** and retaining a higher-effort
option for users who prioritize size. On this corpus, 5 iterations save 88.2% of the compression
time at a cost of 295 bytes across 44 PNGs. **30 iterations** offer a conservative alternative:
69.3% less compression time, 76 extra bytes. These percentages cover compression, not full builds.

## Iteration sweep

The benchmark prepares the actual selected PNG encodes once using default release options,
then runs only `engine.finish()` at each effort. Eleven fixtures each contribute 180px, 192px,
512px and the 32px ICO PNG payload: general, flat, second, mask, heavy, animated, tiles, wide,
gradient, smil and dark. SVG, manifest and ICO header bytes are excluded.

Two interleaved repetitions rotate and reverse effort order after warming the compressor.
Reported time is the median of the two whole-corpus totals. Input preparation, disk writes,
PNG decoding and validation occur outside timing. No competing benchmark runs alongside it.
All 792 measurements preserve input dimensions and decoded RGBA hashes. Repeated runs produce
identical PNG bytes. This losslessness claim applies to Zopfli; it does not describe earlier
SVG optimization or palette selection.

| Iterations | PNG bytes | Extra bytes vs 120 | Extra % | Compression seconds | Lowest effort reaching a file's minimum |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 (skip) | 73,938 | 2,389 | 3.339% | <0.001 | 2/44 |
| 1 | 72,672 | 1,123 | 1.570% | 15.08 | 3/44 |
| 3 | 71,987 | 438 | 0.612% | 16.15 | 4/44 |
| 5 | 71,844 | 295 | 0.412% | 18.31 | 1/44 |
| 10 | 71,720 | 171 | 0.239% | 23.69 | 5/44 |
| 15 | 71,697 | 148 | 0.207% | 29.74 | 3/44 |
| 30 | 71,625 | 76 | 0.106% | 47.47 | 8/44 |
| 60 | 71,592 | 43 | 0.060% | 82.96 | 8/44 |
| 120 | 71,549 | 0 | 0 | 154.82 | 10/44 |

120 iterations give the smallest aggregate among the tested fixed settings. Only 10 of 44
PNGs first reach their measured minimum at 120; 34 reach theirs earlier. The worst individual
size penalties versus 120 are 149 bytes at 3 iterations, 86 at 5, and 32 at 30.

Compression size is not monotonic. Four PNGs beat 120 at lower effort:

| PNG | Lowest effort reaching minimum | Minimum bytes | Bytes at 120 |
| --- | ---: | ---: | ---: |
| general-192 | 30 | 1,161 | 1,163 |
| flat-512 | 30 | 3,171 | 3,173 |
| animated-512 | 10 | 4,626 | 4,628 |
| smil-512 | 3 | 2,018 | 2,021 |

Selecting each file's best tested setting would yield 71,540 bytes, only 9 fewer than uniform
120. Searching all settings during normal generation would spend more time to save those bytes.
Stopping on the first repeated size would also miss later gains: tiles ties at 3/5/10/15, then
improves at 30. Fixture frequencies cannot predict which setting will win for an arbitrary logo.

## Controlled Vite PWA encoder comparison

The user identified `@vite-pwa/assets-generator` as the competitor. This comparison pins
version 2.0.0 with Sharp 0.35.5. Its [PNG defaults](https://github.com/vite-pwa/assets-generator/blob/main/src/api/defaults.ts)
are `compressionLevel: 9, quality: 60`. The
[minimal-2023 preset](https://github.com/vite-pwa/assets-generator/blob/main/src/presets/minimal-2023.ts)
uses transparent 64/192/512px, a 48px favicon, maskable 512px and Apple 180px. Favseed's output
set and placement differ, so comparing whole-set byte totals would confound those choices.

Instead, both encoders receive the same 16 already-placed, unquantised PNG inputs from tiles,
general, heavy and gradient at the four Favseed sizes. The benchmark calls Vite's actual
`generateTransparentAsset` API with zero padding and identity resize. Favseed uses
`engine.encode(colors: 256)` followed by the indicated Zopfli effort. Two warmed, interleaved
repetitions time only encoding/compression. This includes Favseed's dual-candidate selection, and excludes SVG rendering, startup,
full-generator latency and browser performance.

Error is the percentage of pixels exceeding 8/255 in any RGB channel, taking the worse result
over white and black composites. The project normally gates non-ICO outputs at 1%. The source
reference renders the original SVG with shared safe-zone placement. Gradient already exceeds
that gate in Favseed; both complete and non-gradient results appear below. The CSV includes
ICO errors separately.

| Encoder | PNG bytes | Encode/compress seconds | Worst error vs input pixels | Worst error vs source SVG | Worst source error excluding gradient |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vite default, quality 60 | 36,099 | 0.289 | 5.024% | 10.912% | 1.389% |
| Vite palette off | 106,517 | 0.183 | 0% | 1.768% | 0.114% |
| Favseed, skip Zopfli | 40,361 | 0.738 | 0.008% | 1.742% | 0.114% |
| Favseed, 3 iterations | 39,540 | 8.840 | 0.008% | 1.742% | 0.114% |
| Favseed, 15 iterations | 39,385 | 13.963 | 0.008% | 1.742% | 0.114% |
| Favseed, 120 iterations | 39,287 | 59.222 | 0.008% | 1.742% | 0.114% |

A separate Vite-only quality sweep measures the same inputs:

| Vite quality | PNG bytes | Encode seconds | Worst error vs input pixels | Worst error vs source SVG | Worst source error excluding gradient |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 60 | 36,099 | 0.491 | 5.024% | 10.912% | 1.389% |
| 80 | 38,704 | 0.485 | 1.508% | 7.122% | 1.557% |
| 90 | 37,613 | 0.481 | 0.743% | 4.481% | 0.512% |
| 100 | 51,857 | 0.583 | 0.055% | 1.899% | 0.114% |

Quality 60 produces identical bytes in both runs, but timing differs between runs. Avoid
precise speed ratios across these separate measurements. Quality 90 is 4.26% smaller than
Favseed at 120 iterations on this subset and passes the 1% source gate for its non-gradient,
non-ICO outputs. It introduces more pixel error and worsens the existing gradient exception
from 1.742% to 4.481%. Quality 100 matches the measured non-gradient source accuracy but makes
the aggregate files larger. Increasing quality does not guarantee monotonic size or error.

Vite's encoder demonstrates that heavy Zopfli work accounts for much of this compression
latency gap. Even without Zopfli, Favseed's measured encoder takes longer than Vite's native
Sharp path. We should investigate faster shared encoding and an explicit accuracy policy
after reducing effort. These measurements do not establish that Sharp can replace our browser
engine while preserving browser/CLI parity, nor that either entire generator is faster by
the ratios above.

## Reproduce and inspect

Run CPU timing commands sequentially on an otherwise idle machine. Use a fresh output directory
or `--resume` with the exact same effort benchmark configuration.

```sh
node bench/zopfli-effort.mjs --out=/tmp/favseed-effort

# Install competitor dependencies separately from the repository.
mkdir -p /tmp/favseed-vite-pwa-bench
cat > /tmp/favseed-vite-pwa-bench/package.json <<'JSON'
{"private":true,"dependencies":{"@vite-pwa/assets-generator":"2.0.0"},"pnpm":{"overrides":{"sharp":"0.35.5"}}}
JSON
pnpm --dir /tmp/favseed-vite-pwa-bench install --ignore-scripts
node bench/vite-pwa-encode.mjs /tmp/favseed-vite-pwa-bench /tmp/favseed-vite-control 3
node bench/vite-pwa-encode.mjs /tmp/favseed-vite-pwa-bench /tmp/favseed-vite-quality 3 60,80,90,100
node bench/vite-pwa-accuracy.mjs /tmp/favseed-vite-control /tmp/favseed-vite-quality
```

Machine-readable results: [effort totals](effort.csv), [per-file sizes](effort-files.csv),
[encoder totals and accuracy](encoder.csv), [measured environment and input hashes](environment.json).
The original temporary competitor dependency installation no longer exists; environment.json
records the measured native library versions. A new install can resolve different transitive
JavaScript dependencies even with the generator and Sharp versions pinned above.

Raw local metadata, PNGs and measurement rows remain under
`.superpowers/sdd/2026-10-30-zopfli-effort/{full,vite-control,vite-quality}/` (git-ignored).
Independent checks recomputed the aggregate timings, byte totals, minima and repeated hashes
from all 1,112 measurement rows, checked saved outputs against those hashes, and decoded all
396 effort outputs again to verify losslessness. They also confirmed that the four Favseed
effort settings preserve identical decoded pixels per input in the encoder comparison.
All three benchmark scripts pass `node --check`. No production settings changed in this experiment.
