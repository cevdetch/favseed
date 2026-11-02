# Shared Zopfli WASM

Current defaults skip Zopfli and emit one preserved SVG; release/fast compression requires
explicit opt-in. Measurements below describe the earlier policy unless stated otherwise.
See [DEFAULTS.md](DEFAULTS.md) for the current default, fresh Vite PWA comparison and memory checks.

For iteration-count and Vite PWA encoder measurements, see [EFFORT.md](EFFORT.md).
For whole-generator/Vite builds and the later palette optimization, see [COMPETITOR.md](COMPETITOR.md).

For the positional-path benchmark commands below and in those reports, keep snapshots,
isolated dependencies, archives and results below this checkout (for example `bench/out/`)
or the system temporary directory. Absolute and relative paths are supported; symlinks
that escape those locations are rejected. Replace the illustrative `/saved`, `/fresh`,
`/isolated` and `/path/to` prefixes accordingly.

`lib/zopfli.wasm` compiles the exact Google Zopfli source used by `@gfx/zopfli` 1.0.15,
revision `ae43a8b73827577c4b19b005b6eed81f5cf9bbac`. Both hosts instantiate this asset
through `lib/zopfli.mjs`. The original package is a development-only byte comparator.
`engineVersions()['@gfx/zopfli']` retains its public key and includes the rebuilt WASM's
SHA-256, so integration caches distinguish compiler builds. The rebuild retains Zopfli's
iteration/block settings; the later lossless palette pass changes PNG bytes separately.

Rebuild with Clang/wasm-ld 23.1.4 on PATH and these archives:

- [Zopfli source](https://codeload.github.com/google/zopfli/tar.gz/ae43a8b73827577c4b19b005b6eed81f5cf9bbac)
  SHA-256: `9c2fe109838ce43ec90e88ae4a74473c4c46667e32a2980eeb62a04aa1748829`
- [WASI SDK34 sysroot](https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sysroot-34.0.tar.gz)
  SHA-256: `9d813544eeebe38b7b8f2244ed591de46b6db812c6dd1a257ff9f0d2a905a2be`

```sh
node bench/zopfli/build.mjs /path/to/source.tar.gz /path/to/sysroot.tar.gz
node --test test/zopfli.mjs
node bench/performance.mjs
```

The recipe verifies archives before extraction, uses sorted translation units, `-O3 -flto
-msimd128`, and no fast-math. `noio.h` removes verbose logging, which the adapter never enables.
The ABI copies input/output and releases both buffers; it starts at 2MiB and grows as needed.
The binary and its generated identity are committed; normal consumers need no build tools.
Licenses ship alongside the binary in `lib/ZOPFLI-LICENSE` and `lib/WASI-LICENSE`.

`bench/performance.mjs` interleaves full native builds with the old and new compressors,
compares every output byte and metadata, and reports cold first calls separately from warm
medians. Run without other CPU-heavy work. Browser engine/lifecycle checks remain in
`site/test/`; `bench/browser-memory.mjs` records current Chromium renderer PSS/RSS on Linux.

## Measurements, 30 October 2026

Full native release builds, default options, Ryzen 7 7840U, Node 26.12.1. Three interleaved
repetitions; the table uses the two warm repetitions after excluding the first. Both arms
produce identical bytes and metadata. The eleven-fixture fast corpus also matches all 66
files from the previous engine.

| Fixture | Previous build | Rebuilt Zopfli | Improvement |
| --- | ---: | ---: | ---: |
| tiles | 5.13s | 3.78s | 26.4% |
| general | 21.76s | 16.54s | 24.0% |
| heavy | 18.30s | 14.42s | 21.2% |
| gradient | 27.65s | 24.52s | 11.3% |

The browser memory script holds the new compressor constant and restores only the upstream
image loader for its control. Fresh Chromium instances alternate control/tuned settings on a
16-core profile. Worker targets fall from 21 to 9. Warm initialization measures 208 ms control
versus 171–197 ms tuned. After general/heavy/gradient fast builds, summed renderer PSS measures
317–319 MiB control versus 273–274 MiB tuned (about 14% less). Build times remain equivalent
between these loader settings. One- and two-core profiles complete with seven worker targets.
These local measurements do not predict memory use or startup time on a particular phone.
The 250→64MiB linear-memory setting alone does not imply a proportional resident-memory saving.

Competitor sources explain why their defaults do different work:

- [favicons](https://github.com/itgalaxy/favicons/blob/master/src/helpers.ts) uses Sharp's
  `.png().toBuffer()` in its PNG helper.
- [RealFaviconGenerator](https://github.com/RealFaviconGenerator/core/blob/main/packages/image-adapter-node/src/adapter.ts)
  uses Sharp for raw pixel processing and PNG encoding.
- [Vite PWA assets-generator](https://github.com/vite-pwa/assets-generator/blob/main/src/api/defaults.ts)
  defaults to PNG compressionLevel9 and quality60.

Those settings do not establish equal file size, placement or fidelity. We retained Favseed's
rendering, palette selection and 120/15 compression effort and improved execution of the same
algorithm. Binaryen-only optimization did not improve warm compression time, so it was rejected.
