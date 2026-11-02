# Single 48px ICO fallback

Measured on 1 November 2026 with image 1.15.0, Node 26.12.1 and an AMD Ryzen 7 7840U.
The baseline is merged PR28 (`f526aff07fd28aa7e97f93aef6eef66a10f7dc26`), with one
32px ICO entry. Current builds use one 48px entry. Quality 80 and default-off Zopfli
are unchanged. [Raw full-build results](results.json) include source/code hashes,
per-file bytes and hashes, timings and source/encoding errors.

| Across 20 fixtures | Baseline 32px | Current 48px |
|---|---:|---:|
| ICO bytes | 7,537 | 9,483 |
| All raster bytes | 116,147 | 118,093 |
| Complete set bytes, including SVG and manifest | 127,260 | 129,206 |
| Native full-build total, warm median | 4,669ms | 4,694ms |
| Worst ICO source error | 1.660% | 1.215% |
| ICO fixtures exceeding 1% source error | 4 | 2 |
| Worst ICO encoding error | 0% | 0% |

The ICO adds 1,946 bytes across 20 marks, about 97 bytes per mark: 25.8% more ICO
bytes, 1.7% more raster bytes, or 1.5% more complete-set bytes. All SVG, Apple/PWA
PNG and manifest files are byte-identical to the baseline on these fixtures.
Repeated builds also produced identical files. On the original 11 marks, raster
bytes rise 69,675→70,800 (+1.6%) and full builds measure 2,685→2,687ms.
These short native timings do not establish a speed improvement or browser cost.

| Fixture | ICO bytes, 32→48px | Source error, 32→48px |
|---|---:|---:|
| heavy | 451→632 | 1.660→0.347% |
| gradient | 1,135→1,409 | 0→0% |
| grid-1 and grid-tiny, each | 500→670 | 1.465→1.215% |
| grid-24 | 502→664 | 1.172→0.911% |

We score each ICO against an unoptimized source render at its own resolution,
using the worse black/white composite and an 8/255 channel tolerance. This measures
native-resolution source agreement; it does not measure browser downsampling at
16/32px. The two small-grid fixtures still exceed 1%. The separate static 512px SVG
budget does not promise 1% source error at every raster size. Encoding error here
compares the ICO with unquantized pixels from its selected SVG.

The default file count stays the same. Explicit 32px PNG requests remain 32px.
Transparent 48px PNG exports share the ICO's encoded payload; padded 48px exports
remain separate. Generated and static-site links declare the actual 48×48 payload.

Reproduce from the repository root:

```sh
node bench/bench.mjs ico-size
```

The sweep loads the immutable baseline modules without changing the checkout,
then alternates baseline/current order across 20 fixtures and three repetitions.
Repetition 0 is warmup. The reported median averages the two remaining whole-corpus
totals. Timing includes in-memory SVG validation, placement, rendering and encoding;
imports, input reads, reference preparation, scoring and file writes are excluded.
Each arm uses a manifest and the default asset sizes. The suite asserts single-entry
ICO header/payload dimensions, repeated-file determinism and complete non-ICO identity.
The earlier precision/framing reports retain their historical 32px datasets; running
those sweeps now compares their baselines against the current whole pipeline.


## Matched Vite PWA comparison

[Encoder and matched-file data](vite-pwa.json) uses assets-generator 2.0.0 and Sharp 0.35.5.
Four fixtures (tiles, general, heavy and gradient) produce 16 matching raster files:
one 48px ICO plus 180/192/512px PNG per fixture. Both encoders receive identical
already-placed, unquantized pixels with identity resize and no extra padding.
SVG and manifest bytes are excluded. Vite uses its actual `generateFavicon` route;
the sweep verifies decoded ICO pixels survive repacking unchanged.

| Encoder | Matched PNG/ICO bytes | Worst PNG error vs raw input | Worst ICO encoding error |
|---|---:|---:|---:|
| Vite PWA default, quality 60 | 36,906 | 5.900% | 3.429% |
| Favseed default, quality 80 | 37,082 | 0.055% | 0% |
| Vite PWA quality 100 | 53,888 | 0.065% | 0% |

Favseed is 176 bytes (0.5%) larger than Vite's default on these inputs, with lower
measured PNG error. Against Vite quality 100, ours is 31.2% smaller. Quality numbers
are not equivalent between encoders, and aggregate errors do not establish equal
visual fidelity or a universal winner. Vite has smaller sets for general/heavy;
Favseed has smaller sets for tiles/gradient. The current comparison replaces the
historical 32px 0.8%-larger result in the precision report.

Payload encoding totals measure 381ms Vite default, 905ms Favseed default and 482ms
Vite quality 100. These are medians of two whole-corpus repetitions after warmup,
with reversed/rotated order. Timing excludes SVG processing, placement and ICO
repacking; it is neither full-generator nor browser timing. This change does not
make Favseed faster than Vite's encoder on these inputs.

Install pinned dependencies in an isolated directory under `/tmp`, then run these
commands sequentially with fresh output directories:

```sh
npm install --prefix /tmp/pwa-deps --ignore-scripts --no-audit --no-fund @vite-pwa/assets-generator@2.0.0 sharp@0.35.5
node bench/vite-pwa-encode.mjs /tmp/pwa-deps bench/out/matched-default 3 '' vite-default,favseed-default
node bench/vite-pwa-encode.mjs /tmp/pwa-deps bench/out/matched-quality100 3 100 vite-quality-100
```

Raw records retain identical input hashes, settings, source hashes, engine versions,
per-file hashes/errors and repeated output determinism. Native/browser parity and
lifecycle checks run separately from these timings.
