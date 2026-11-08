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
- A config file, `favseed.config.js`, `.mjs` or `.ts`, setting any option plus `input`, `base`
  and `mode`; flags win over it, and `defineConfig` is exported with types.
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
  raster stage and nothing uploaded, including a copy button for the generated head markup.
- TypeScript declarations for the package root, `favseed/core`, and the Vite and Astro
  integrations.
- One image engine: `@napi-rs/image` renders, quantises and recompresses, and favseed's own
  `lib/zopfli.wasm` (built from Zopfli 1.0.15) finishes the result, both pinned exact, so the
  CLI needs only Node 24 and no external binaries to install.
- `--colors` defaults to 256, a ceiling rather than a target; `--sizes` defaults to `192 512`,
  the pair Chrome's install criteria document; and `--bg` defaults to `#000000`, matching how
  iOS composites a transparent Home Screen icon.
- `--quality` (default 80) sets a PNG quality target; combining an explicit `--colors` with
  default quality selects the higher-fidelity fixed-palette path at quality 100.
- Extra Zopfli compression is opt-in with `--zopfli`.
- Errors print as `favseed: <message>` on stderr with a non-zero exit, never a stack trace.
