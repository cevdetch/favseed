# Vite PWA comparison and lossless palette optimization

For matching raster dimensions, backgrounds and file counts, see [MATCHED-PRESET.md](MATCHED-PRESET.md).

Current defaults skip Zopfli and emit one preserved SVG; release/fast compression requires
explicit opt-in. Measurements below describe the earlier policy unless stated otherwise.
See [DEFAULTS.md](DEFAULTS.md) for the current default, fresh Vite PWA comparison and memory checks.

Measured 31 October 2026 on Ryzen 7 7840U, Node 26.12.1, Linux x64. Pinned competitors:
`@vite-pwa/assets-generator` 2.0.0, `vite-plugin-pwa` 2.0.0, Sharp 0.35.5 and Vite 8.3.3.
Favseed uses image 1.15.0 and the shared rebuilt Zopfli WASM described in this directory.

Favseed wins the measured unchanged-input Vite builds through its persistent icon cache.
It remains slower at uncached generation. Its default set is smaller, but differs in file
count, placement and fidelity; that total cannot establish a better compression algorithm.
The earlier [equal-pixel encoder comparison](EFFORT.md#controlled-vite-pwa-encoder-comparison)
separates those factors.

The timing tables below measure the startup/memory branch before the new palette pass,
with package version 0.1.0. The later 0.2.0 change is a small, separately measured lossless
optimization. Both versions use 120 release / 15 fast iterations and serial raster jobs.

## Whole default generators

Four SVGs: tiles, general, heavy and gradient. Three repetitions rotate/reverse arm order.
The table uses the median of the two warm whole-corpus totals after excluding repetition 0.
Read/prepare/generate, file writes and manifest serialization are timed; module imports,
directory creation and output validation are excluded. Both image paths receive a small
untimed initialization image. These are warmed process timings, not cold CLI startup times.

| Generator | Seconds for four SVGs | PNG + ICO bytes |
| --- | ---: | ---: |
| Vite PWA default, quality 60 | 0.450 | 69,999 |
| Vite PWA quality 90 | 0.448 | 73,963 |
| Favseed release, 120 iterations | 59.784 | 39,375 |
| Favseed fast, 15 iterations | 14.467 | 39,473 |
| Favseed experimental 5 iterations | 10.159 | 39,537 |
| Favseed experimental no Zopfli | 1.163 | 40,449 |

Vite's [minimal-2023 preset](https://github.com/vite-pwa/assets-generator/blob/main/src/presets/minimal-2023.ts)
generates transparent 64/192/512px PNGs, a 48px ICO, maskable 512px and Apple 180px PNGs.
Favseed generates three PNGs at 180/192/512px and a 32px ICO. Both use PNG payloads in ICOs.
Favseed also optimizes SVGs, resolves custom properties and measures per-size safe-zone
placement; Vite uses fixed padding with Sharp. Backgrounds and source processing differ.
The benchmark saves file counts, dimensions and every output hash. SVG/manifest sizes appear
in the CSV separately from the raster total.

Whole-preset images are not scored against Favseed's placement: that would count different
framing/backgrounds as encoding error. Use the retained equal-pixel controls for fidelity.
In that 16-PNG experiment, Sharp quality 90 made smaller files but increased worst source
gradient error from 1.742% to 4.481%. The higher-fidelity quality-100 arm produced 51,857 bytes
in 0.583s; Favseed without Zopfli produced 40,361 bytes in 0.738s. That is 22.2% fewer bytes,
with lower worst encoder error, but still slower encoding. Those timings came from separate
controlled runs; they do not predict the ratios for arbitrary SVGs or whole builds.

## Actual Vite plugin builds

Three projects use general, heavy and gradient. Both arms build the same minimal HTML app
with vite-plugin-pwa and the same service-worker settings. Vite's arm enables its assets
generator; Favseed's arm uses `favseed/vite` and disables Vite PWA's own asset generation.
The timer covers the Vite build and hooks, including service-worker generation. Project
setup and plugin construction occur before timing. Shared Workbox/Vite machinery receives
an untimed warmup before empty icon caches are measured.

| Vite build configuration | Empty icon caches, seconds | Unchanged inputs, seconds |
| --- | ---: | ---: |
| Vite PWA default assets | 1.727 | 1.617 |
| Vite PWA quality-90 assets | 1.676 | 1.553 |
| Favseed release + Vite PWA | 57.241 | 1.250 |
| Favseed fast + Vite PWA | 15.129 | 1.225 |

Times sum the three projects. Empty-cache results are one observation per project;
unchanged-input results use the median of two repetition totals. Icons and manifests must
remain byte-identical across all three builds. App/service-worker JavaScript is excluded
from reported icon bytes but included in build time.

Favseed's measured warm release builds take 22.7% less time than the default Vite PWA arm.
The [persistent cache](../../vite/cache.mjs) restores the previously generated files. Vite's
[asset build hook](https://github.com/vite-pwa/vite-plugin-pwa/blob/main/src/pwa-assets/build.ts)
invokes generation with overwrite enabled; its build API does not use the dev request cache.
An unchanged Vite process/project alone therefore does not eliminate PNG encoding there.
Larger applications can dilute this difference through unrelated build work. This experiment
does not compare development HTTP request latency or browser memory between the products.

## Changes measured

### Implemented: one guarded lossless palette pass

Re-running lossless optimization with Sub on selected PNGs changes palette ordering even
when the original rows already use Sub. A broad seven-option screen over 44 actual selected
PNGs found a useful choice for two gradient outputs. At 120 iterations these two outputs
fall from 10,669 to 10,560 bytes; at five iterations, from 10,707 to 10,579. All decoded
dimensions and RGBA bytes remain identical.

Two interleaved repetitions of these selected cases, including the extra lossless call,
measured 3.48s original versus 3.06s candidate at 120, and 0.657s versus 0.595s at five.
The corrected counterfactual script reproduces every output byte: a fresh paired run measured
3.345s versus 3.063s at 120 and 0.673s versus 0.602s at five. These selected cases and timing
ranges do not establish a whole-corpus speed improvement.
Full 256-entry palettes that do not improve still incur the extra pass. Across the four
full-palette screening inputs, that pass took about 139ms total; 512px consumed about 91ms
without a size gain. All other measured palettes avoid it.

The shared engine tries this once only on bare PNGs with 256-entry palettes. Metadata-bearing
PNGs keep their previous path. A size guard retains the smaller preliminary encode, followed
by one Zopfli call. As with the existing quantized/lossless choice, the pre-Zopfli size guard
does not mathematically guarantee the best final size for every possible input. Corpus checks
compare final bytes and decoded pixels against the retained old outputs at both 15 and 120.
All 88 comparisons preserve exact pixels and none grows. The 44-PNG totals fall from
71,697 to 71,565 bytes at 15, and from 71,549 to 71,440 at 120; only the two selected
gradient outputs change at each effort.
See [palette regression data](palette-regression.csv) for those per-file results.

Version 0.2.0 invalidates integration caches after this byte change. The compressor binary,
120/15 counts, palette limit/quality and serial scheduling remain unchanged. The compressor
rebuild still preserves exact upstream compression bytes for a given input stream; this
separate palette pass changes the input stream on which it operates.

### Kept as a prototype: concurrent preparation

A native-only prototype runs the four default raster jobs concurrently. With Zopfli disabled,
paired warm totals fall from 1.131s to 0.941s across four SVGs, about 16.8%. Every complete result
(files, placement, links and animation metadata) matches the serial result, and progress stays
monotonic. These timings exclude filesystem writes and differ from the generator table.

This prototype lacks browser peak-memory, cancellation and large-input validation. Default
four-job behavior does not define a safe policy for arbitrary 8192px sizes or long size lists.
It is not enabled in production, and it does not demonstrate the same benefit with Zopfli on.

### Rejected: lower palette caps and faster quantizer settings

The speed-3 and speed-5 quantizer options produced the same measured PNGs as speed 1 across
44 inputs, without a convincing timing gain. Lowering the cap to 128/64 cut preliminary PNG
bytes from 73,938 to 66,765/61,790, but changed the four gradient images and worsened their
source accuracy. The other 40 images already use fewer colors and retained identical pixels.
A 32-color cap worsened source RMSE in 24 cases even though worst non-gradient threshold
percentage stayed similar. A quality/merge-down experiment produced larger files and worse
gradient error. None changes production policy.

## Next changes worth pursuing

1. Complete supported-browser CI for the current startup/memory and lossless palette work.
2. Decide interactive effort separately. Five iterations offer a useful latency/size tradeoff;
   no Zopfli brings larger PNGs but retains the same pixels. Neither removes the cold-generation
   gap on this corpus, and neither is the current default.
3. Validate bounded raster preparation in the browser if low-effort/preview generation is the
   target. Keep cancellation, memory growth and input-size limits in that experiment.
4. Profile shared render/encode APIs after reducing compression effort. Avoiding intermediate
   PNG encode/decode work and requesting exact SVG raster dimensions upstream are better
   targets than lowering accuracy. A CLI-only Sharp replacement would break the required
   browser/CLI parity.

## Reproduce and evidence

Use isolated competitor dependencies outside this pnpm workspace. Pin the four versions above;
the exact install manifest and lockfile from this run are saved with the ignored raw evidence.
Current scripts record source hashes and package version for future runs. Timing tables above
predate the later 0.2.0 palette change; reproducing with current code can yield smaller PNGs.
The filter-finish script explicitly bypasses automatic palette recoding in both finish arms,
then applies one real pass only in the candidate. Its original arm must reproduce the saved
pre-palette output bytes. This keeps the historical comparison valid after the product change.
Run CPU benchmarks sequentially on an otherwise idle machine.

```sh
node bench/vite-pwa-pipeline.mjs /isolated/deps /fresh/generator-results generator
node bench/vite-pwa-pipeline.mjs /isolated/deps /fresh/plugin-results plugin general,heavy,gradient
node bench/png-lossless-screen.mjs /saved/effort-results /fresh/filter-results
node bench/png-filter-finish.mjs /saved/effort-results /fresh/filter-results /fresh/final-filter-results
node bench/png-quantize-screen.mjs /fresh/palette-results
node bench/pipeline-concurrency.mjs /fresh/concurrency-results 0
```

Compact data: [generator timings](generator.csv), [Vite builds](vite-build.csv),
[experiment summary](experiments.csv), [palette regression](palette-regression.csv).
Raw rows, output PNGs, logs, dependency lockfile and validation live under the git-ignored
`.superpowers/sdd/2026-10-31-generator-performance/`. The earlier 44-PNG iteration sweep and
16-PNG encoder controls remain in `.superpowers/sdd/2026-10-30-zopfli-effort/`.

Fresh native validation passes: 206 tests, two optional skips; site unit tests pass 10/10
and the production build succeeds. Full Chromium parity passes all 104 files across 15
cases, including gradients at 15/120, archives, cache, responsiveness, cancellation/retry,
worker cleanup and back/forward cache. The benchmark correction reproduces its saved bytes.
Firefox requires the supported Ubuntu CI environment; local Arch Firefox launch remains
unverified. Real-device behavior is not established by native measurements or emulation.
