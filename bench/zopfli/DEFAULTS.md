# Default performance: Zopfli opt-in and one SVG

Current default quality is 80; the quality-100/default figures below describe the earlier policy. See [QUALITY.md](QUALITY.md).

For the optional native quality control and updated size/error results, see [QUALITY.md](QUALITY.md).

For matching raster dimensions, backgrounds and file counts, see [MATCHED-PRESET.md](MATCHED-PRESET.md).

Measured 31 October 2026 on Ryzen 7 7840U, Linux x64, Node 26.12.1, image 1.15.0.
The default skips Zopfli. Enable it with `--zopfli` or `zopfli: true`; release/fast effort
remains 120/15 iterations. Both hosts emit one `icon.svg` preserving animation, styling and
accessibility. Explicit `--no-animation` remains available.

## Generation and byte tradeoff

Four fixtures: tiles, general, heavy and gradient. Three interleaved repetitions, first excluded;
tables use the median of the remaining whole-corpus totals. These are warm generation times,
including source reads, SVG optimization, complete safe-zone/alignment search and artifact creation.
Imports, output disk writes and validation are excluded. Both controls use saved pre-change
modules and the same pinned modern image/Zopfli engine, including the earlier palette improvement.
The baseline is the saved working tree, not a published release.

| Pipeline | Seconds for four fixtures | PNG + ICO bytes | Complete set bytes |
| --- | ---: | ---: | ---: |
| Before, default 120 iterations | 59.610 | 39,266 | 44,990 |
| Before, Zopfli disabled | 1.161 | 40,449 | 46,173 |
| Current default | 0.903 | 40,449 | 44,095 |

The new default is **66.0× faster** than the previous default and
**22.2% less time** than the previous pipeline with compression already disabled.
PNG/ICO growth is **1,183 bytes, 3.0%**, relative to the previous default. Every decoded pixel,
dimension and placement result matches the no-Zopfli control; the compressed control has identical
pixels too. Repeat output hashes are stable. Removing the duplicate SVG reduces complete-set
bytes by 2.0%, despite the larger PNGs. Manifest enabled: seven files become six per fixture.
Raster and complete-set counts are separate because SVG preservation changes the output contract.

Both quantized and lossless candidates remain. Complete alignment searches run in bounded batches
rather than accepting an approximate fit. Output batches retain serial fallback for large custom
sizes and drain active work on failure. The canvas budget estimates working pixels; it is not a
process RAM ceiling.

A separate serial control using the current SVG policy measured 1.151s
versus 0.901s for bounded batches, with exact whole-result equality
and monotonic progress. This isolates scheduling from the SVG contract change.

The existing `bench/bench.mjs colors` sweep also completed: default 256 produces 38,731 PNG bytes
across nine non-gradient marks, with worst source error 0.114% (bar 1.0%). Lower palettes have
separate accuracy tradeoffs; the existing gradient exception remains documented and tested.

## Fresh Vite PWA comparison

Pinned assets-generator 2.0.0, vite-plugin-pwa 2.0.0, Sharp 0.35.5 and Vite 8.3.3. Full generator timings
include source preparation, file writes and manifest serialization; imports and validation are
excluded. This differs from the in-memory table above. Same four fixtures and repetition policy.

| Generator | Seconds | PNG + ICO bytes |
| --- | ---: | ---: |
| Vite PWA default preset | 0.419 | 69,999 |
| Favseed default | 0.901 | 40,449 |

Favseed is still **2.15× slower** at uncached generation. The smaller whole set does not
prove superior compression: Vite's preset produces more images, uses different sizes/backgrounds
and fixed padding; Favseed optimizes the SVG and measures placement. Earlier equal-pixel fidelity
controls remain in [EFFORT.md](EFFORT.md#controlled-vite-pwa-encoder-comparison).

Real Vite builds use the same minimal HTML app and service-worker setup across general/heavy/gradient.
The first run starts with empty icon caches; subsequent runs retain unchanged inputs. Totals cover
all three projects. First-run figures have only one sample per project and are descriptive.

| Vite configuration | Empty icon caches, seconds | Unchanged inputs, seconds |
| --- | ---: | ---: |
| Vite PWA default assets | 1.767 | 1.560 |
| Favseed default + Vite PWA | 2.352 | 1.240 |

Favseed remains slower on empty icon caches, but its persistent icon cache wins the unchanged
builds here. The next performance opportunity is reducing repeated renderer work without dropping
complete alignment search or the encoder size guard. No general speed or compression win is claimed.

## Browser memory and verification

Fresh Chromium profiles compare the current pipeline with a route-only control restoring upstream
250 MiB allocation and uncapped spare-worker preload. On a simulated 16-core device, tuned initial
linear memory is 64 MiB rather than 250 MiB; worker count is 9 rather than 21. Across two paired runs,
post-gradient renderer PSS averages 305.6 MiB versus 359.0 MiB, about 14.9% lower. Memory grows as needed.
Simulated 1/2-core builds also produce identical output. These are initialization/post-build samples,
not peak memory; this control isolates loader settings and does not compare old serial scheduling
against concurrent peak usage. Initialization timings are retained raw; first-run filesystem/cache
warming makes a broad startup percentage inappropriate.

Native suite: 220 tests, 218 pass, two optional TypeScript skips. Site unit tests: 10/10; production
build succeeds. Desktop/mobile Chromium: 14/14, 95 desktop files across 16 cases and 23 mobile files
across four cases, including opt-in 15/120 parity, 1024 px memory growth, cancellation, retry,
isolation errors and form downloads. Earlier full CDP checks also cover worker cleanup and BFcache.
Cached Chromium was used because the installed Playwright version's matching browser was unavailable.
Firefox/WebKit require supported CI validation; no fresh pass is claimed for those engines.
Review regressions cover preserved ARIA IDREF targets, drained asynchronous/synchronous encoder
failures and invalid Astro options on cache hits. The deleted logo asset's 404 reference is corrected.

## Reproduce and evidence

Run CPU benchmarks sequentially without browser tests competing for CPU. Competitor dependencies
must be installed outside the pnpm workspace. Save the four pre-change modules before modifying
production; `default-performance.mjs` accepts that directory. The exact local snapshot/raw outputs
are retained under ignored `.superpowers/sdd/2026-10-31-default-performance/`; their source hashes
are in [default-environment.json](default-environment.json). Reconstructing that uncommitted baseline
on a fresh clone requires those saved modules.

```sh
node bench/default-performance.mjs /saved/before /fresh/default-results
node bench/vite-pwa-pipeline.mjs /isolated/deps /fresh/generator generator tiles,general,heavy,gradient vite-default,favseed-default
node bench/vite-pwa-pipeline.mjs /isolated/deps /fresh/plugin plugin general,heavy,gradient vite-default,favseed-default
node bench/pipeline-concurrency.mjs /fresh/concurrency 0
node bench/bench.mjs colors
node bench/browser-memory.mjs
```

For an existing local browser, the memory harness accepts `FAVSEED_CHROMIUM_PATH`.
Compact evidence: [before/after](default-before-after.csv), [generators](default-generator.csv),
[Vite builds](default-vite-build.csv), [scheduling](default-concurrency.csv),
[browser memory](default-memory.csv).
