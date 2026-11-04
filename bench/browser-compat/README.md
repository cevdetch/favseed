# Browser compatibility engine

The browser uses the threaded image engine when both document and worker can create and
transfer shared WASM memory. Otherwise it loads a single-thread build of the same image
1.15.0 source. Only one image loader/WASM is fetched per engine worker. Missing common
WebAssembly/DecompressionStream support still reports a CLI alternative; download and
initialization failures are not reasons to switch encoders.

Both modes start with 64 MiB of growable memory. Compatibility mode runs image work inside
one dedicated worker, with no child workers. Cancelling terminates that worker; retry starts
fresh. The CLI and its dependencies do not use this vendored artifact.

## Measured tradeoff

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

The committed compatibility WASM is 10,285,192 bytes raw, 3,463,405 bytes with gzip 9 and
2,470,599 bytes with Brotli 11, versus 10,322,976/3,488,533/2,481,262 bytes for the published
threaded WASM. These are local asset compression measurements, excluding JS and HTTP
headers; they are not Cloudflare transfer sizes. Generated icon sizes match the CLI.

## Rebuilding the vendored artifact

Ordinary site builds use the checked-in files in `site/vendor/image-wasm32-wasip1/`.
`site/build/wasi-runtime.mjs` rejects image/runtime version or artifact hash drift. A dependency
upgrade must rebuild this candidate and pass both-mode native parity before updating the
manifest. The generated loader is upstream output, with initial memory configured through
`napi.wasm.threadlessInitialMemory=1024`; no image Rust source is patched.

Rebuild on Linux x64 with Rust 1.99.0 (`b940084d7`, 2026-09-28), the `wasm32-wasip1`
target, Node/npm, CMake, make and the host C/Clang toolchain. Download these reviewed archives:

- [Image source 7bad478bfe647bca75d4c05db8726ca3d5335e80](https://codeload.github.com/Brooooooklyn/Image/tar.gz/7bad478bfe647bca75d4c05db8726ca3d5335e80)
- [WASI SDK 33.0 Linux x64](https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-linux.tar.gz)

`build.json` records both archive SHA-256 hashes, lock hashes, runtime versions and artifact
hashes. The recipe verifies archive hashes and the Rust version before building. npm uses the
committed tooling lock with lifecycle scripts disabled. Cargo fetches the locked target
inputs, then builds offline with SIMD128, a 16 MiB stack, SOURCE_DATE_EPOCH=0 and normalized
build/Cargo paths.
The fixed epoch removes mozjpeg-sys's embedded wall-clock build timestamp.
The image build disables default features and enables `binding` for `wasm32-wasip1`.
This removes oxipng's parallel feature; the upstream WASM quantizer is already serial.

```sh
rustup target add --toolchain 1.99.0 wasm32-wasip1
node bench/browser-compat/build.mjs /tmp/image-source.tar.gz /tmp/wasi-sdk.tar.gz
# To explicitly replace the candidate, manifest and notices after reviewing an upgrade:
node bench/browser-compat/build.mjs /tmp/image-source.tar.gz /tmp/wasi-sdk.tar.gz --write
pnpm --filter favseed-site build
pnpm --filter favseed-site test:browser
```

Run from the repository root with the pinned toolchain active. The default command compares
fresh output with the vendored artifacts; `--write` replaces them. Two clean builds in
different temporary directories reproduced both committed artifact hashes. The site build
publishes `engine-licenses.txt` from the upstream image license and collected
third-party notices. The vendored binary is excluded from the npm package's file allowlist.

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

The site build, 14 worker tests, 392 root tests and the existing CDP parity/lifecycle
harness passed. A manual build-guard probe rejected changed image/runtime versions and both loader/WASM hashes, then accepted the restored
manifest. Production response headers and real-device behavior need checking after deployment.
