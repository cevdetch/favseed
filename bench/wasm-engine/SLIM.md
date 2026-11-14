# A slimmer image engine for the website

Findings only: nothing here ships. The question was whether the website's image engine
(`@napi-rs/image` 1.15.0 compiled to WASM) gets meaningfully smaller with the codecs favseed
never calls taken out, and whether it then still produces the same bytes.

favseed uses the engine for resvg rendering (`Transformer.fromSvg`), PNG decoding
(`Transformer` with `crop`, `png`, `rawPixels` and `metadata`), `pngQuantize` and
`losslessCompressPng`. It never encodes or decodes AVIF, WebP or JPEG. Three C libraries exist
only for those formats: libavif with libaom (AVIF), mozjpeg (lossless JPEG recompression) and
libwebp (WebP encoding).

## The patch

Applied to `packages/binding` of the reviewed source revision (`7bad478`), in a scratch copy:

- `Cargo.toml`: remove the `libavif`, `mozjpeg-sys` and both `libwebp-sys` dependencies, and
  the `with_simd` feature that names mozjpeg (10 lines).
- `src/avif.rs`: keep the `AvifConfig` and `ChromaSubsampling` types, so the JS surface and
  `index.d.ts` stay as they are; `encode_avif_inner` returns an error (−219/+3 lines).
- `src/webp.rs`: both encoders return an error (−181/+12).
- `src/jpeg.rs`: the lossy path, which already uses the `image` crate's encoder, stays; the
  mozjpeg lossless path returns an error (−145/+3).
- `src/transformer.rs`: AVIF input is rejected instead of decoded, and the AVIF output variant
  holds a plain `Vec<u8>` (−40/+3).

Every export stays; the AVIF, WebP and lossless-JPEG entry points reject with a message saying
the codec is not built in. The `image` crate keeps its pure-Rust decoders, including its own
WebP and JPEG decoders. Cargo prunes 19 packages from the lock (214 to 195): the three codec
crates and their build-time tooling (bindgen, cmake, nasm-rs, clang-sys and their
dependencies). Nothing new is resolved.

## Results

Built with `build.mjs`'s recipe unchanged (Rust 1.99.0, WASI SDK 33, the committed tooling
and Cargo locks, `SOURCE_DATE_EPOCH=0`, path remapping) plus the patch. The same recipe without
the patch reproduced the vendored `image.wasm32-wasip1.wasm` exactly (SHA-256 `8beb7ddf…`),
so the patch is the only difference. Both slim builds compile without errors, in about a
minute each on a Ryzen 7 7840U with the crates already fetched, and two clean builds of each
gave identical bytes. The generated loader is byte-identical to the vendored one.

Sizes, with Node's zlib at gzip 9 and Brotli 11 (the method behind the figures in
[README.md](README.md)):

| Engine | Raw | gzip 9 | Brotli 11 |
|---|---:|---:|---:|
| compat, vendored today | 10,285,192 | 3,463,405 | 2,470,599 |
| compat, slim | 5,642,929 | 2,003,774 | 1,433,110 |
| threaded, published npm package | 10,322,976 | 3,488,533 | 2,481,262 |
| threaded, built here without the patch | 10,348,222 | 3,493,791 | 2,489,755 |
| threaded, slim | 5,711,486 | 2,039,150 | 1,456,603 |

The slim engine is 45 % smaller raw and 42 % smaller over Brotli, about 1.0 MB less to fetch
in either mode.

### Same bytes

A Node harness ran favseed's own `lib/engine.mjs` over all 25 SVGs in `test/fixtures/` at 16,
32, 48, 180, 192 and 512 px, each with no ground and on `#000000`, and hashed every output:
`render` (PNG), `renderRgba`, `decode` of the render, `losslessCompressPng` with default options
and with the finish step's (`filter: [1]`, `strip: false`), `encode` at colours 256, 16 and 2
and quality 80 and 60, `decode` of each encode, and `pngQuantize` called directly with each of
those settings. That is 6,000 outputs per engine.

- compat, slim against the vendored engine: **6,000 of 6,000 identical**.
- threaded, slim against the published `@napi-rs/image-wasm32-wasi` 1.15.0: **6,000 of 6,000
  identical**.

The slim WASM imports a subset of the current one's (it no longer needs `fd_seek` or
`fd_fdstat_set_flags`), so the existing loaders run it unchanged.

### In the browser

`bench/browser.mjs` against a copy of the current site build with only the two `.wasm` files
swapped for the slim ones (current site as before, slim as after; 3 repetitions, interleaved;
medians in ms):

| Network, mode | choose→ready | choose→first set, general/default | choose→first set, gradient/default |
|---|---|---|---|
| unthrottled, threaded | 147–152 → 134–137 | 635 → 634 | 1,043 → 1,059 |
| unthrottled, compat | 124–128 → 107–117 | 756 → 733 | 1,587 → 1,569 |
| throttled 9 Mbps, threaded | 3,000–3,111 → 2,080–2,121 | 4,055 → 3,119 | 4,964 → 3,929 |
| throttled 9 Mbps, compat | 2,895–2,972 → 1,937–2,013 | 4,227 → 3,237 | 6,129 → 5,200 |

choose→ready ranges span the six fixture/effort cells. On the throttled link the engine is
ready about a second sooner (−32 %); the first set moves by the same second, and the final set
by 0.3–1.8 s. Unthrottled, the engine is ready 10–20 ms sooner and the build itself takes as
long as before: the final sets agree within 1–2 % in every cell, in both directions.

## What a threaded slim build also needs

The threaded engine is not built here today: the site imports the published
`@napi-rs/image-wasm32-wasi` package. A slim threaded engine needs:

- the `wasm32-wasip1-threads` Rust target and the WASI SDK's threads sysroot, with
  `--target=wasm32-wasi-threads -pthread` in the C flags, and the crate's default features
  (which turn on oxipng's `parallel`), as upstream's CI builds it. That compiled here with the
  same patch, in about a minute;
- vendoring its output (`image.wasi-browser.js`, `wasi-worker-browser.mjs`, the `.wasm`) beside
  the compat engine, pointing `site/src/lib/engine-worker.mjs` at it, extending
  `site/build/wasi-runtime.mjs`'s version and hash guard to it, and dropping the npm package;
- accepting that the threaded engine is then ours rather than upstream's. Built from the same
  source without the patch, it is not byte-identical to the published WASM (different Rust and
  dependency resolution: the committed lock's napi crate adds eleven allocator wrappers and
  six runtime hooks to the exports, with or without the patch), so it carries the same
  both-mode parity checks the compat engine already has.

## Maintenance cost

- A patch to five files (about 600 lines deleted, 25 added), reapplied at every
  `@napi-rs/image` upgrade.
  The upstream files it touches are large (`transformer.rs` is 3,757 lines), but the hunks are
  small and anchored on the codec calls, so a rebase should be mechanical, and a hunk that no
  longer matches stops the build rather than slipping through.
- The build recipe gains a patch step and a threads variant; `build.json` would record the
  patch's hash beside the archive hashes. Each upgrade is already a reviewed rebuild with a
  parity run, because the bytes can change; the slim build adds no new check, only a second
  artifact to check.
- The engine notices shrink: libaom, libavif, mozjpeg and libwebp no longer ship.
- AVIF, WebP and lossless JPEG stop working in the website's engine. The website never offers
  them; the CLI, Vite and Astro use the native package and are unaffected.

## Recommendation

**Ship in a follow-up.** It removes about 1 MB, 42 %, from the largest download on the page,
which on a 9 Mbps link is a second off the time to a first set, and the bytes favseed makes do
not move. Do it as its own change: the compat engine first, since its recipe exists and only
gains a patch step, then the threaded engine, which also moves from the npm package to a
vendored build.
