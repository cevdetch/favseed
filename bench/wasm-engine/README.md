# The browser's two image engines

The website never imports the published `@napi-rs/image-wasm32-wasi` package. Both WASM engines
in `site/vendor/image/` are built from the `@napi-rs/image` source with a patch that removes the
codecs favseed never calls, then vendored and hash-checked at every site build.

- **Threaded** (`image.wasi-browser.js`, `wasi-worker-browser.mjs`, `image.wasm32-wasi.wasm`) is
  the default: it shares WASM memory with its worker threads and runs the quality and colour
  search walks side by side (decision 30). It loads when the document and worker can both create
  and transfer shared memory.
- **Compatibility** (`image.wasip1-browser.js`, `image.wasm32-wasip1.wasm`) is the fallback
  (`?no-isolation`), one dedicated worker, no child workers, no shared memory. It loads when the
  page is not cross-origin isolated.

Only one engine is fetched per page load. Missing `SharedArrayBuffer`/`DecompressionStream`
support still reports a CLI alternative; a download or initialization failure is not a reason to
switch engines. Neither engine touches the CLI, Vite or Astro: they import the native
`@napi-rs/image` package, unpatched, with every codec it ships.

## Why the codecs come out

favseed calls four things on the engine: `Transformer.fromSvg` (resvg rendering), PNG decode
(`crop`, `png`, `rawPixels`, `metadata`), `pngQuantize` and `losslessCompressPng`. It never
encodes or decodes AVIF, WebP or JPEG, lossy or lossless. Four codecs exist in the image source
only for those formats: libavif with libaom (AVIF), mozjpeg (lossless JPEG recompression),
libwebp (WebP encoding) and the JPEG XL decoder. `bench/wasm-engine/slim.patch`, applied to
`packages/binding` of the reviewed source, removes all four:

| File | Change |
|---|---|
| Cargo.toml | drops libavif, mozjpeg-sys, both libwebp-sys, jxl, moxcms and bytemuck |
| src/avif.rs | keeps `AvifConfig`/`ChromaSubsampling`; `encode_avif_inner` errors |
| src/jpeg.rs | lossy path (the `image` crate's own encoder) kept; mozjpeg lossless errors |
| src/lib.rs | `mod jxl`/`mod jxl_hdr` removed; the files stay on disk, uncompiled |
| src/transformer.rs | JPEG XL input and AVIF input rejected; `EncodeOutput::Avif(Vec<u8>)` holds a plain buffer |
| src/webp.rs | both encoders error |

Every export and `index.d.ts` stay as they are: a codec entry point rejects at call time with a
message naming it as not built into this engine, instead of disappearing from the surface. The
`image` crate's own pure-Rust decoders, including its WebP and JPEG decoders, are unaffected.
AVIF, WebP and lossless JPEG stop working in the website's two engines only; the CLI, Vite and
Astro are unaffected, because favseed never asks for any of them.

## Sizes

Raw bytes, then Node's zlib at gzip 9 and Brotli 11:

| Engine | Raw | gzip 9 | Brotli 11 |
|---|---:|---:|---:|
| threaded, published 1.15.0 | 10,322,976 | 3,488,533 | 2,481,262 |
| threaded, published 1.16.0 | 12,210,498 | 4,173,498 | 2,953,703 |
| threaded, slim 1.16.0 (vendored) | 5,722,390 | 2,044,471 | 1,460,499 |
| compatibility, vendored 1.15.0 | 10,285,192 | 3,463,405 | 2,470,599 |
| compatibility, slim 1.16.0 (vendored) | 5,653,958 | 2,009,857 | 1,436,532 |

See `docs/DECISIONS.md` (decision 31) for the full writeup, parity totals and browser timing.

## Rebuilding

Rebuild on Linux x64 with Rust 1.99.0 (`b940084d7`, 2026-09-28), the `wasm32-wasip1` and
`wasm32-wasip1-threads` targets, Node/npm, and the WASI SDK 33 archive (its threads sysroot is
under `share/wasi-sysroot/lib/wasm32-wasip1-threads`; the threaded build fails early if that
directory is missing). Download these reviewed archives:

- [Image source a57319b7506405d991696459830f1a0e60cc88bf](https://codeload.github.com/Brooooooklyn/Image/tar.gz/a57319b7506405d991696459830f1a0e60cc88bf)
- [WASI SDK 33.0 Linux x64](https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-linux.tar.gz)

```sh
rustup target add --toolchain 1.99.0 wasm32-wasip1 wasm32-wasip1-threads
node bench/wasm-engine/build.mjs /tmp/image-source.tar.gz /tmp/wasi-sdk.tar.gz
# To replace the vendored engines, manifest and notices after reviewing an upgrade:
node bench/wasm-engine/build.mjs /tmp/image-source.tar.gz /tmp/wasi-sdk.tar.gz --write
pnpm --filter favseed-site build
pnpm --filter favseed-site test:browser
```

`build.mjs` checks the archive hashes and the Rust version before building, fetches both
targets' crates with `cargo fetch --locked`, applies `slim.patch` with `patch -p1 --forward
--fuzz=0`, and builds offline with `SOURCE_DATE_EPOCH=0` and normalized build/Cargo paths:
threaded first (`wasm32-wasip1-threads`, default features, so oxipng's `parallel` stays on, with
`--target=wasm32-wasi-threads -pthread` in the C flags), then compatibility (`wasm32-wasip1`,
`--no-default-features --features binding`). Each engine's output moves to its own directory
inside the source tree immediately after its build, because the napi CLI deletes the other WASI
flavour's output as stale.

**The parity gate.** Before anything is written, `compareEngines()` (`bench/wasm-engine/
parity.mjs`) runs favseed's own `lib/engine.mjs` calls (`render`, `renderRgba`, `decode`,
`losslessCompressPng`, `encode` and `pngQuantize`) over every fixture in `test/fixtures/` at six
sizes, with and without a background, and hashes every output. Nothing is accepted unless both
engines match the native `@napi-rs/image` module byte for byte; one fixture that draws text is
skipped on both sides as host-dependent, since native resvg renders it with system fonts and the
WASI sandbox has none. Without `--write`, the same build is checked against the committed
`build.json` and artifacts instead of replacing them, so a rebuild with no intended change proves
it is reproducible rather than merely passing parity again.

Without `--write`, a failing check means one of: the archive hashes, the Rust version, a changed
`Cargo.lock` (the recipe copies the reviewed lock in and fails if the build would change it), a
runtime version drift (`@emnapi/core`, `@emnapi/runtime` or `@napi-rs/wasm-runtime` against
`build.json`'s `runtime` block), or an artifact hash. `--write` regenerates `build.json`, copies
the five engine files into `site/vendor/image/`, and collects `LICENSE` plus
`THIRD-PARTY-NOTICES.txt` from the union of `cargo tree` over both targets and feature sets, the
tooling lock's packages, wasi-libc and the Rust standard library notice.

**The guard.** `site/build/wasi-runtime.mjs` runs `verifyEngines()` at `buildStart`: the native
`@napi-rs/image` version against `build.json.imageVersion`, each runtime package's installed
version against `build.json.runtime`, and every vendored file's SHA-256 against
`build.json.artifacts`. Any drift fails the site build with a message pointing back here, rather
than shipping an engine that silently stopped matching the CLI.

## Measured tradeoff (2026-11-04, image 1.15.0)

The 2026-11-04 investigation compared the published threaded image 1.15.0 package with a
threadless prototype from its source revision. Linux, Ryzen 7 7840U (16 logical CPUs),
Chromium 156.0.8078.4; three fresh-browser trials per variant, interleaved B/P/P/B/B/P.
Default quality 80, Zopfli off, manifest on; four fixtures after initialization. Medians:

| Measurement | Threaded | Compatibility prototype |
|---|---:|---:|
| Engine initialization | 155.9 ms | 139.9 ms |
| Renderer PSS after initialization | 149.6 MiB | 116.6 MiB |
| Renderer PSS after four builds | 322.6 MiB | 225.6 MiB |
| Four builds total | 1765.6 ms | 2655.2 ms |
| Worker targets | 9 | 1 |
| general | 481.2 ms | 620.0 ms |
| tiles | 137.4 ms | 170.6 ms |
| heavy | 365.3 ms | 499.1 ms |
| gradient | 782.5 ms | 1366.8 ms |

About 30% less sampled renderer memory costs about 50% longer generation in this workload,
so compatibility is a fallback. Initialization excludes browser launch and real network
transfer. PSS sums renderer processes at sample points, not peak or total browser RAM.
The first trial was slower in both variants: initialization 156–250/134–219 ms and four-build
totals 1.76–3.69/2.65–4.25 s (threaded/compatibility). No CPU throttling or real-device result.

The prototype matched 184 files across 31 fixture/option cases against native SHA-256,
filename, size, fit, links and animation status, including quality 60/80/100, Zopfli,
transparent/custom outputs and 1024px. It passed cache ownership, invalid-input recovery,
initialization/raster cancellation and retry. A separate Firefox 161.0a1 profile with
`dom.postMessage.sharedArrayBuffer.withCOOP_COEP=false` generated matching results for four
fixtures and passed cancellation/retry under production headers.

These are prototype measurements, not a causal isolation of threading: upstream published
WASM and the local build use different Rust/toolchain dependency resolutions. The source
release had no Cargo.lock. The committed locks preserve this candidate's inputs; output
parity remains the acceptance check. Artifact path normalization for production changes
WASM bytes relative to the measured prototype. Generated icon bytes are checked separately.
Raw prototype results are in [investigation.json](investigation.json).

The committed compatibility WASM at the time was 10,285,192 bytes raw, 3,463,405 bytes with
gzip 9 and 2,470,599 bytes with Brotli 11, versus 10,322,976/3,488,533/2,481,262 bytes for the
published threaded WASM. These are local asset compression measurements, excluding JS and HTTP
headers; they are not Cloudflare transfer sizes. Generated icon sizes match the CLI. The slim
engines built from image 1.16.0 (above) replace both of these.

## Production verification

The automatic selector passed the same 30-case desktop matrix (179 files per mode) and
12-case mobile matrix (71 files per mode), comparing filenames, SHA-256, sizes and metadata
with native output. Both shared and unshared 1024px growth, cache ownership, cancellation,
retry, form downloads, blocked-sharing selection, exclusive engine fetching and load-error
handling are covered in the existing browser suite. Cold startup budgets still pass.

A temporary system Firefox 161.0a1 profile with shared memory disabled also automatically
selected compatibility under production headers, matching four default fixture sets and
passing cancellation/retry. This is separate from the Playwright Firefox project: local
bundled Firefox/WebKit binaries cannot launch on this host because of system-library
incompatibilities. The existing Ubuntu CI matrix remains the full Firefox/WebKit gate;
mobile emulation does not replace real-device checks.
