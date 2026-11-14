# Changelog

All notable changes to this project are documented here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Byte-output changes (a bumped `@napi-rs/image` or SVGO, a rebuilt `lib/zopfli.wasm`, or any
pipeline change) are minor at minimum, never patch.** Downstream users diff these files into git.

## [Unreleased]

Nothing has been published yet. This section describes what the first release, 1.0.0, will
contain.

### Added

- A CLI, `favseed`, that turns one SVG into a favicon set: an optimised `icon.svg` with
  animation, styling and accessibility preserved by default; `favicon.ico` as a single
  PNG-backed entry; `apple-touch-icon.png` and `icon-<size>.png` (default 192 and 512) with
  the mark placed in the W3C safe zone, measured per mark by default (`--padding auto`) or
  given as a fixed percentage; and an optional `site.webmanifest` declaring the padded sizes
  `"any maskable"`. `--bg none` keeps the set transparent and unpadded, declared `"any"` only.
  `--html` prints the matching `<link>` tags.
- A config file, `favseed.config.js`, `.mjs` or `.ts`, setting any option plus `input` and
  `base`; flags win over it, and `defineConfig` is exported with types.
- `favseed/vite`, a Vite plugin that serves the set from memory in dev and writes it at build
  time, with `favseedIcons()` for projects that also use vite-plugin-pwa.
- `favseed/astro`, an Astro integration installed by `astro add favseed`, built on
  `favseed/vite`: the set is served from memory in `astro dev` and emitted with the client
  build (`dist/`, or `dist/client/` with an SSR adapter). A different file of yours in
  `public/` under a favseed name wins in dev and fails the build. It reads `favseed.config.*`
  (integration options win) and injects `<link>` tags by default via a head-injection
  middleware, with `head: 'component'` (a `<Head />` component) or `head: false` (log the
  tags for pasting) as alternatives.
- A content-addressed build cache shared by the Vite and Astro integrations, keyed on
  favseed's version, the input, the options and the versions of the image engine, SVGO and
  the Zopfli build, so an engine upgrade invalidates it instead of serving stale bytes.
- A website, <https://favseed.cevdet.ch>, running the same pipeline client-side with a WASM
  raster stage and nothing uploaded, including a copy button for the generated head markup. At
  the default and maximum efforts, with nothing pinned, it shows a quick set at once (every
  raster at quality 80, the `--effort fast` set, ready to download) and replaces it with the
  final set when the search ends; downloads always serve the best finished set and say which
  one it is. Progress counts each encode of each raster's search, every file shows the setting
  it kept, and screen readers hear the phases rather than every step. The image engine loads
  when the pointer, focus or a drag first reaches the file picker, or a file is chosen, never
  on page load, and fetches Zopfli alongside itself. `docs/DECISIONS.md` (decision 30) has the
  measurements.
- TypeScript declarations for the package root, `favseed/core`, and the Vite and Astro
  integrations.
- One image engine: `@napi-rs/image`, pinned at 1.16.0, renders, quantises and recompresses,
  and favseed's own `lib/zopfli.wasm` (built from Zopfli 1.0.15) finishes the result, both
  pinned exact, so the CLI needs only Node 24 and no external binaries to install.
- The website's two image engines are built from the 1.16.0 source with the codecs favseed
  never calls (AVIF, WebP encoding, lossless JPEG, JPEG XL decoding) removed, instead of
  importing the published package: the threaded engine is 1,460,499 bytes over Brotli 11, the
  compatibility engine 1,436,532. `docs/DECISIONS.md` (decision 31) has the measurements.
- `--sizes` defaults to `192 512`, the pair Chrome's install criteria document; and `--bg`
  defaults to `#000000`, matching how iOS composites a transparent Home Screen icon.
- Each PNG and the ICO payload is the smallest encode favseed finds that passes its accuracy
  bar. Each raster is scored against a render of the source placed like it, and passes when at
  most 1 % of pixels are off by more than 8/255 and its edge-weighted luma error is at most
  1.5883, on black and on white. `--effort` (`effort` in config, API, Vite and Astro) sets how
  hard it looks: `fast` makes one quality-80 encode, unscored, with no Zopfli; `default` (the
  default) binary-searches quality 40-99 and palettes of 2-256 colours at quality 100, keeps
  the smallest passing candidate it tried, and runs Zopfli at 15 iterations; `max` tries all 26
  candidates and runs Zopfli at 120 iterations. A raster that fails at quality 80 takes a
  passing candidate even when it is larger; one with no passing candidate keeps the `fast`
  encode. Vite and Astro dev builds use `fast`. On the fixtures the byte manifest covers, the
  default set's PNG/ICO bytes are 40.8 % smaller than quality 80's (41 904 B against 70 800,
  Zopfli included); `docs/DECISIONS.md` (decision 29) has the measurements and build times.
- `--quality N` and `--colors N` pin an exact setting: one encode, no search. Quality alone
  uses the full 256-colour palette, colours alone use quality 100, and quality below 100
  cannot combine with colours. A pinned setting that misses the accuracy bar warns with its
  measurements and still builds. To leave a control to the search, omit it: `colors: null`
  and `quality: null` are errors, not the default.
- `zopfli` and `mode` are not options; passing either to `build()`, `buildFiles()`, a config
  file or an integration fails with a message naming `effort`.
- The CLI summary names the effort and its Zopfli iterations, and the setting each PNG kept or
  the pinned one.
- CSS custom properties are resolved before rendering, in attributes and in `<style>` blocks,
  CDATA-wrapped or not. A `var()` written inside a CSS comment is ignored rather than resolved
  or reported as unresolved, and a `/*` inside a quoted string is not taken for a comment.
- The default and maximum efforts walk the quality and palette candidates at the same time.
  The file each raster keeps is the one walking them in turn would keep, byte for byte.
- Errors print as `favseed: <message>` on stderr with a non-zero exit, never a stack trace.
