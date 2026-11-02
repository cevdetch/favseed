# favseed

One SVG in, an optimised favicon set out.

```sh
npx favseed logo.svg --out public
```

That is the whole quickstart. It writes five files, prints their sizes, and tells you if your
mark is animated.

```
icon.svg                  (optimized, animation and styling preserved)
favicon.ico               (48×48 PNG payload)
apple-touch-icon.png      (180×180, safe-zone placement)
icon-192.png               (192×192, safe-zone placement)
icon-512.png               (512×512, safe-zone placement)
```

Sizes depend on your mark. Standard builds skip Zopfli; add `--zopfli` for extra lossless
compression at the cost of generation time.

No install at all: **[favseed.cevdet.ch](https://favseed.cevdet.ch)** runs the same engine and
build pipeline in your browser, with nothing uploaded. Matching input, options, and build mode
produce identical files for self-contained SVGs. Outline text and embed external images for
consistent raster output. The page includes a manifest; use `--manifest` for the matching CLI
set. Builds run in a worker with progress and cancellation; see [browser requirements and
measurements](site/README.md).

Add the links to your `<head>`. `favseed --html` prints them:

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

## Install

`npx favseed logo.svg --out public` needs Node 24 or newer and nothing else. The image engine,
[`@napi-rs/image`](https://www.npmjs.com/package/@napi-rs/image), installs with the package:
resvg, oxipng and a quantiser in one native module, prebuilt for Linux, macOS and Windows on
x64 and arm64, and FreeBSD on x64. The bundled Zopfli WASM uses the same Google source as
`@gfx/zopfli` 1.0.15, rebuilt with modern LLVM for both the CLI and browser. Its source,
toolchain checksums and build recipe are in
[bench/zopfli](https://github.com/cevdetch/favseed/blob/main/bench/zopfli/README.md).
Opt-in final compression also tries a guarded lossless palette pass; the
[Vite PWA comparison](https://github.com/cevdetch/favseed/blob/main/bench/zopfli/COMPETITOR.md)
records its byte savings and the speed, size and accuracy tradeoffs.

## What you get

| File | What it is |
|---|---|
| `icon.svg` | One optimized SVG for the favicon and page images. Animation, styling and accessibility are preserved by default. |
| `favicon.ico` | One 48×48 entry, stored as a raw PNG in a 22-byte container. |
| `apple-touch-icon.png` | 180×180 (60pt @3x; no iPhone renders above @3x) on the `--bg` ground, the mark placed in the safe zone so iOS's rounded mask cuts nothing. |
| `icon-<size>.png` | On the `--bg` ground, the mark placed in the safe zone the same way (`--padding`, default `auto`). Default 192 and 512, the pair Chrome's install criteria document. The manifest's `any maskable` icons. |
| `site.webmanifest` | Only with `--manifest`. Icons only: you merge your own `name` and `theme_color`. |

Use the same `/icon.svg` URL in `<link rel="icon">` and `<img>` so cacheable responses can be
reused. PNG and ICO exports use the source's static base appearance. `--no-animation` is an
explicit option for a static SVG.

## Why not one of the others

There are several favicon generators on npm. Most write whatever sharp's encoder produced; the
quantizing generators commonly use Sharp. Favseed measures safe-zone placement, compares
quantized and lossless PNGs, caches integration output, and offers optional Zopfli compression
through the same browser and CLI engine.

| | weekly | dependencies |
|---|---|---|
| [`favicons`](https://www.npmjs.com/package/favicons) | ~573k | `sharp` `xml2js` `escape-html` |
| [`@vite-pwa/assets-generator`](https://www.npmjs.com/package/@vite-pwa/assets-generator) | ~312k | `sharp` `sharp-ico` `cac` `consola` `picocolors` `unconfig` |
| [`astro-favicons`](https://www.npmjs.com/package/astro-favicons) | ~5.7k | `favilib` `ultrahtml` |
| [`favgen`](https://www.npmjs.com/package/favgen) | ~3 | `svgo` `sharp` `is-svg` `to-ico` `commander` |

(Weekly downloads for 22–28 September 2026.) `favicons` is thorough (it will write you thirty
files for platforms that stopped existing), and its PNGs are whatever sharp's encoder produced.
`astro-favicons` wraps the same engine for Astro. `@vite-pwa/assets-generator` encodes at
sharp's `quality: 60` and `favgen` at `colors: 64`: one quantised encode, no comparison, no
zopfli.

Favseed generates a small set with measured safe-zone placement and compares quantized and
lossless PNG candidates. Extra Zopfli compression is opt-in. Its browser and CLI share the
same engine and options, with matching output bytes for self-contained SVGs. Full builds select
SVG precision against the source's static appearance before PNG encoding; PNG quality and
tiny-ICO error are measured separately.

In our four-logo benchmark with matching raster inputs, the default quality-80 set used **0.5%
more PNG/ICO bytes than Vite PWA assets-generator 2.0.0’s default**, with lower measured PNG pixel error.
See [the measurements and method](https://github.com/cevdetch/favseed/blob/main/bench/ico-size/README.md); results depend on the input.

## Flags

```
-o, --out DIR     Output directory (default: current)
    --colors N    Explicit palette ceiling, 2-256; selects quality 100 when given alone
    --sizes LIST  Padded "any maskable" PNG sizes (default: "192 512")
    --bg COLOR    Ground of the padded icons (default: #000000). "none" keeps the set
                  transparent and unpadded, declared "any" only.
    --padding P   Margin of each padded icon, as a percentage per side (default: auto).
                  `auto` measures the mark's own extent and snaps it to whole pixels;
                  give a number to override it.
    --var N=V     Set a CSS custom property, e.g. --var brand=#0E7C68. Repeatable.
    --no-animation  Explicitly remove motion from icon.svg.
    --quality N     PNG quality target, 1-100 (default: 80). Use 100 with --colors.
    --zopfli        Extra lossless PNG compression; slower, off by default.
    --no-zopfli     Override a config that enables Zopfli.
    --manifest    Also write site.webmanifest.
    --html        Print the <link> tags.
-q, --quiet   -V, --version   -h, --help
```

Long options also accept `--opt=value`; `--` ends option parsing. A flag that takes no
argument rejects one.

### A config file

Every option can live in `favseed.config.js`, `favseed.config.mjs` or `favseed.config.ts` in the
working directory, the first one found. Flags win over it, and `--var` merges with its `vars`
by name. Three keys have no flag: `input`, so a bare `favseed` builds the project's mark;
`base`, the path the site is served under; and `mode`.

```js
// favseed.config.mjs
import { defineConfig } from 'favseed'

export default defineConfig({
  input: 'src/logo.svg',
  out: 'public',
  bg: '#0E1C28',
  base: '/blog/',
  manifest: { name: 'Example', short_name: 'Ex', theme_color: '#0E7C68' },
})
```

`base` prefixes every `href` that `--html` prints and every icon `src` in the manifest.
`manifest` as an object writes `site.webmanifest` with those members ahead of the icons.
With `zopfli: true`, `mode: 'fast'` uses 15 iterations instead of 120. The summary reports
whether extra compression ran. Without opt-in, both modes use standard PNG output.

A `.ts` config loads through Node's type stripping, which erases annotations and transforms
nothing: an `enum` or a `namespace` fails with a message pointing at `favseed.config.mjs`.

### `--var`

Your mark can be a template. `var(--brand, #0E7C68)` renders as `#0E7C68` by default, the way
a browser resolves an undefined property, and `--var brand=#7C0E68` overrides it:

```sh
favseed logo.svg --var brand=#7C0E68 --out public
```

A `var()` with no fallback and no override is an error, not a black square. (resvg has no
`var()` support at all: it renders the whole mark black and warns on stderr, so favseed
resolves every custom property before anything is rasterised.)

### `--bg`

iOS composites transparent Home Screen icons onto **black**, and a maskable icon should be
opaque, so the padded icons get a ground rather than an alpha channel they would lose anyway.
The default is `#000000`: what the platform would have done to a transparent icon regardless,
minus the tRNS chunk. favseed warns when you did not choose, because the right ground is a
property of your mark and not of the format. `--bg '#fff'` for a mark drawn on light,
`--bg none` to keep the alpha (and with it an unpadded set, declared `"any"` only).

The value is validated by asking resvg to render a 1×1 pixel with it, so anything resvg takes
works (`#fff`, `teal`, `rgb(14 124 104)`, `hsl(170 80% 27%)`), and the validator can
never disagree with the renderer. The same pixel must come out opaque: `transparent`,
`rgba(…, 0.5)` or `#ffffff80` would put alpha into icons declared maskable, so favseed refuses
them and points you to `--bg none`.

### The padded icons

Every platform that installs a web app shows its icon through a shape of its own:

| Platform | Reads | Shape | favseed's file |
|---|---|---|---|
| iOS, iPadOS, Safari Add to Dock | `apple-touch-icon`, 180 px for iPhone | rounded square, corners about 22 % | `apple-touch-icon.png` |
| Android (Chrome, WebAPK) | manifest, `any maskable` | circle, squircle, rounded square | `icon-192.png`, `icon-512.png` |
| ChromeOS, macOS (Chrome installs) | manifest, `any maskable` | the OS's rounded shape | `icon-192.png`, `icon-512.png` |
| Windows, Linux desktops | manifest, `any maskable` | none; drawn as is, on light and dark | `icon-192.png`, `icon-512.png` |
| Chrome's install criteria | manifest, `any maskable` icons at 192 and 512 px | none | `icon-192.png`, `icon-512.png` |
| Browser tabs | `<link rel="icon">` | none | `icon.svg`, `favicon.ico` |

The sizes are the documented ones: 180 px is the largest size Apple lists for a web clip
icon, and web.dev's install criteria, Chrome's own docs and MDN all ask for a 192 and a 512.
One set carries both purposes: the icons are padded into the safe zone, so the `maskable`
claim holds, and Chrome will not install a PWA whose icons are all `maskable`: it needs at
least one `any`. The cost is on desktops, which do not mask: there the icon shows a smaller
mark on its ground rather than edge to edge. `--bg none` opts out of all of it (transparent,
unpadded, `"any"` only).

`icon.svg` is not in the manifest. An SVG entry makes Chrome's Android install fail and fall
back to a home-screen bookmark ([crbug.com/40925759](https://issues.chromium.org/issues/40925759)).

**The safe zone.** The W3C Web App Manifest names the one area every mask shows: a circle
centred on the icon, with a radius of 40 % of its size. iOS's rounded square contains that
circle whole, so every padded icon uses it.

**Placement is measured by default, fixed on request.** `auto` (the default) renders `icon.svg`
at each padded icon's size, finds the farthest opaque pixel from the centre (its outer corner,
so the whole pixel counts), and scales the mark until that pixel sits on the safe circle. A mark
with its own margin is enlarged, one that reaches its corners is shrunk. `--padding` overrides
it with a fixed percentage per side, applied as given and never snapped. No fixed number is
right for every mark (a round one fills 80 % of the width; a square one's corners touch the
safe circle at 56.6 %): across the fixtures `auto` chooses 7.6 %–18.8 % per side. A source
opaque in all four corners is full-bleed, drawn with its own ground, and used as it is.

**Then it snaps to whole pixels.** An exact fit scales by an arbitrary factor, so the edges of
a mark drawn on a grid fall between pixels and every one of them is anti-aliased. favseed walks
the size down in whole pixels, no more than 10 %, and takes the size where the mark renders
with the fewest pixels covered in part, but only if that at least halves them. A curved mark,
which is anti-aliased at every size, keeps its exact fit. Measured on a seven-block grid mark
at 512 px:

| Placement | Mark box | Colours | Edge pixels | Bytes |
|---|---|---|---|---|
| exact fit | 330 of 512 px | 12 | 1905 | 571 B |
| snapped | 320 of 512 px | 3 | 0 | 290 B |

At 180 px the same mark snaps from 116 to 112 px and the apple icon is 151 B.

`--bg none` keeps the set transparent and unpadded, declared `"any"` only: a platform
composites a transparent icon onto a colour of its own choosing, so the safe zone would mean
nothing, and padding the ICO fallback only makes the mark smaller.

## Dark mode

A source with a `@media (prefers-color-scheme: dark)` block keeps it in `icon.svg`, so the
favicon follows the browser's colour scheme. The PNGs render the light rules, because resvg
skips `@media`, and they are the same bytes a source without the block would produce.

## Animation

The single `icon.svg` preserves CSS/SMIL animation, referenced classes and IDs, and reduced-motion
and color-scheme styles. It can be used as both the favicon and a page image; animation support
depends on the browser and embedding context.

PNG and ICO exports are still images. Their source must have a useful static base appearance;
the renderer does not sample an animation timeline. Put optional motion inside a
`prefers-reduced-motion: no-preference` media query when appropriate.

`--no-animation` (or `animation: false`) explicitly removes motion while retaining other
static declarations. CSS variable overrides such as `--var brand=#7C0E68` still apply.

## SVG input requirements

Give the root SVG a valid `viewBox`, or positive numeric width and height from which one can
be derived. Percentage-only dimensions need an explicit `viewBox`. Missing, non-finite,
zero or negative root sizes fail with guidance before source rasterization and output writes.
The root `viewBox` must contain four decimal or exponent numbers separated by whitespace
or single commas; missing values, hexadecimal tokens and repeated commas are rejected.

Text and external images produce warnings in the CLI/API and browser. Fonts can differ or
be missing between native and browser rendering, so convert text to paths for consistent
PNG/ICO output. Embed images as `data:` URLs: relative files and remote image references can
be omitted in rasters or SVG image contexts. The warnings preserve the source content and
do not fetch resources or convert fonts. They do not prove that every dependency will render.
API callers receive guidance through `onWarn`; the browser shows it separately from build
progress, including on cached builds and before a later rendering error.

## PNG quality

`favseed logo.svg --quality 80 --out public` trades some PNG/ICO accuracy for smaller files.
The same `quality: 80` option works in config/API, Vite and Astro; the browser has a numeric control.
Default `80` balances file size and fidelity. Set `--quality 100` to use the
higher-fidelity output. An explicit `colors` option without quality selects the fixed-palette
quality-100 path for compatibility. Explicit quality below 100 cannot combine with `colors`. The browser disables that
field and restores its value when returning to 100.

Quality is the native encoder's target, not an error percentage or Sharp's quality scale. Lower
values do not always make smaller files. SVG optimization and safe-zone placement stay unchanged.
Zopfli is independent: add `--zopfli` for extra lossless compression at any quality.
SVG precision selection stays active at every PNG quality. See [current measurements](https://github.com/cevdetch/favseed/blob/main/bench/precision/README.md)
for size, source accuracy and Vite PWA comparisons; [earlier quality measurements](https://github.com/cevdetch/favseed/blob/main/bench/zopfli/QUALITY.md) record the quality-policy choice.

## Compression

Standard builds compare the quantized and lossless PNG candidates and stop there. `--zopfli`
(or `zopfli: true` in config/API options) opts into additional lossless compression. With it,
`mode: 'release'` uses 120 iterations and `mode: 'fast'` uses 15. Mode does not change bytes
when Zopfli is disabled. The browser exposes the same opt-in.

Output jobs and complete alignment searches run in bounded batches. Large custom output sizes
retain serial scheduling; failures drain active work before returning. Both hosts use the
same placement and encoding rules.
Measured speed, byte tradeoffs and the current Vite PWA comparison are recorded in
[the default-performance report](https://github.com/cevdetch/favseed/blob/main/bench/zopfli/DEFAULTS.md).

## Vite

```js
// vite.config.js
import { defineConfig } from 'vite'
import favseed from 'favseed/vite'

export default defineConfig({
  plugins: [favseed({ input: 'src/logo.svg' })],
})
```

**`vite dev`** builds the icons the first time a page asks for one, then serves them from
memory. Edit the logo or `favseed.config.*` and the icons rebuild and the page reloads. Dev
builds use fast effort only when Zopfli is enabled; otherwise their bytes match the build.

**`vite build`** writes the release icons to the output directory, next to `index.html`.
favseed never writes to `public/`.

**The `<head>` tags.** favseed adds its `<link>` tags to `index.html`, unless the page already
has a `<link rel="icon">`. A framework without an `index.html` can import them instead:

```js
import { links, files } from 'virtual:favseed'
```

**Options.** The plugin takes the same options as `favseed.config.*`, except `out`: Vite decides
the output directory. Options passed to the plugin win over the config file. `base` defaults
to Vite's `base`.

**Your files come first.** If `public/` already holds a file favseed would write, such as
`favicon.ico`, with different bytes, `vite build` stops with an error and `vite dev` serves
your file with a warning. Delete it to use favseed's.

### With vite-plugin-pwa

vite-plugin-pwa writes its own manifest, so favseed does not write one. Pass favseed's icons
to it:

```js
import { VitePWA } from 'vite-plugin-pwa'
import favseed, { favseedIcons } from 'favseed/vite'

export default defineConfig({
  plugins: [
    favseed(),
    VitePWA({ manifest: { name: 'Example', icons: favseedIcons() } }),
  ],
})
```

Give `favseedIcons()` the same `sizes`, `bg` and `base` as the plugin. Turn off
vite-plugin-pwa's `pwaAssets` option: it writes a `favicon.ico` of its own, and favseed warns
when both are on.

## Astro

```js
// astro.config.mjs
import favseed from 'favseed/astro'

export default defineConfig({
  integrations: [favseed({ input: 'src/logo.svg' })],
})
```

That is all of it. The files land in `public/`, the `<link>` tags go into every page that
does not already have a `<link rel="icon">`, and `config.base` is prefixed for you.

Options mirror the CLI, except that `sizes` is a real array and `vars` is an object: that is
what the flags *mean*; the string forms exist only because argv is strings. `manifest` also
takes an object (`name`, `short_name`, `theme_color`, …) which is merged into the icons; the
CLI writes icons-only because a CLI cannot know your app's name, but an integration can.

```js
favseed({
  input: 'src/logo.svg',
  sizes: [192, 512],
  vars: { brand: '#0E7C68' },
  bg: '#0E1C28',     // the padded icons' ground; also a good background_color below
  manifest: { name: 'Example', short_name: 'Ex', theme_color: '#0E7C68', background_color: '#0E1C28' },
  dev: 'fast',       // 'fast' | 'full' | 'skip'
  head: 'inject',    // true | 'inject' | 'component' | false
})
```

**It does not rebuild on every dev-server restart.** The cache is content-addressed, not a
heuristic: keyed on favseed's version, the input bytes, the canonicalised options **and the
versions of `@napi-rs/image` and Zopfli (including the WASM build hash)**. That last part is what makes it correct:
both change their output across releases, so a cache keyed only on the SVG would hand back
stale files after an upgrade, with no sign of it. A hit copies cached files into `public/`.
Published files are independent copies, so editing them cannot change cached output.

For a cold first run, `dev: 'fast'` (the default) builds one 256 px size. With Zopfli opted in,
it uses 15 iterations; otherwise it skips extra compression. `dev: 'full'` generates the
production set.

**Head tags.** Astro has no official head-injection hook. All four `injectScript` stages are
JavaScript, and a `<link rel="icon">` written by a script is found after the browser has
already asked for `/favicon.ico`. So `head: 'inject'` (the default) is an `order: 'post'`
middleware that splices before `</head>` and skips any page whose head already has a
`<link rel="icon">`. It buffers at most 64 KiB until the closing head, then streams the rest
of the response. If the closing head is missing or exceeds that limit, it passes the HTML
through unchanged; use the component or manual tags for those pages.
`head: 'component'` gives you `favseed/astro/Head.astro` to place yourself, and
`head: false` logs the block for pasting. `head: true` is an alias for `'inject'`.

**Migrating an Astro starter.** Back up and move its existing `public/favicon.ico` and
`public/favicon.svg` if you want favseed to replace them, and remove their old
`<link rel="icon">` tags from your layout or pages. Existing icon declarations make automatic
injection skip the page. If you keep manual tags, update them to favseed's generated URLs
and choose `head: 'component'` or `head: false` as appropriate.

favseed will not overwrite a differing file unless its hash matches the previous ownership
record. The error names the actual asset path, including a custom Astro `publicDir`.
After a clean checkout or removal of `node_modules/.cache/favseed`, identical generated files
are accepted without the record. Differing files cannot be distinguished from user edits:
back up and move only the generated files you intend to replace, then rebuild. A cache reset
alone cannot establish ownership. Keep generated assets out of version control and generate
them during builds, or use `dev: 'full'` when committing outputs to avoid the default
development/production set differences. Changed source, options or engine versions can still
require this deliberate recovery when the ownership record is missing.

Changing sizes, disabling the manifest or switching from development to production removes
discontinued generated files before Astro copies `public/` into its output. This also works
on cache hits. Favseed removes only regular files whose bytes match its previous ownership
record; it preserves edited files, symlinks and unrelated assets. Files with no ownership
record, including older leftovers whose record is already lost, need manual cleanup.

## How it decides

Every step was chosen by measurement. Earlier decisions are in
**[docs/DECISIONS.md](https://github.com/cevdetch/favseed/blob/main/docs/DECISIONS.md)** and the native-reference sweeps in
**[docs/BENCHMARKS.md](https://github.com/cevdetch/favseed/blob/main/docs/BENCHMARKS.md)**.
Current raster proportions, byte and timing results are in the [framing report](https://github.com/cevdetch/favseed/blob/main/bench/framing/README.md).
The [precision report](https://github.com/cevdetch/favseed/blob/main/bench/precision/README.md) records the SVG rounding policy and matched Vite PWA comparison.

The short version, because these are the parts that look wrong until you know why:

- **One engine, nothing to install.** `@napi-rs/image` bundles the resvg and oxipng versions
  favseed was measured with, and its renders match the resvg CLI pixel for pixel. Against the
  native resvg, pngquant and oxipng pipeline the earlier engine comparison recorded encodes 9 % smaller on a gradient and
  0.46 % larger on flat marks (decision 26).
- **SVG rounding follows source accuracy.** Full builds keep one decimal when it passes a
  1% pixel-error check at 512px, trying higher precision only when needed. The comparison uses
  the static base appearance over black and white, before PNG quantization. If no candidate
  passes, the SVG retains its source geometry. Animation, styling and accessibility remain
  unless you explicitly request `--no-animation`. This is not a guarantee for every display
  size, animation frame or media state.
- **Square raster canvases preserve proportions.** Wide and tall SVG viewports are centered
  inside the PNG/ICO canvas. Transparent exports keep transparent bands; opaque PNGs use your
  chosen background and the existing safe-zone fit. `icon.svg` keeps its original viewport.
  See the [framing measurements](https://github.com/cevdetch/favseed/blob/main/bench/framing/README.md).
- **Quantise before you recompress.** The quantiser re-encodes from scratch, so any order
  ending in quantisation throws away everything the recompressor did. Measured at 192 px, the
  wrong order is 21.0 % bigger.
- **An ICO holding a PNG is a 22-byte header plus that PNG verbatim**, so nothing can be
  optimised after packing. favseed writes that header itself, byte-identical to
  `icotool -c -r`, which removes the only dependency with no npm package and no Windows build.
  The BMP payload `icotool` writes by default is 8.8× larger on the fixtures.
- **Opt-in Zopfli runs once**, on the file that already won the lossy/lossless comparison. Running it
  on both sides costs three times as much for identical bytes.
- **Bounded concurrency overlaps raster jobs and complete alignment searches.** The shared
  scheduler limits active canvas work, keeps large custom sizes serial, and drains failures
  before a retry. Candidate selection and output order remain deterministic.
- **Placement probes avoid oversized transparent margins.** A small mark still enlarges into
  its safe zone. Large-margin searches use target-size canvases; other probes stay within
  twice the target size, retaining ordinary render reuse. The full candidate walk remains;
  this bounds each probe, not the number of probes or process RAM.
  See the [placement measurements](https://github.com/cevdetch/favseed/blob/main/bench/placement/README.md).

## Contributing and help

For usage questions, start with the [website](https://favseed.cevdet.ch) and the
examples above. Use the repository's issue forms for bugs and feature requests.
See [CONTRIBUTING.md](https://github.com/cevdetch/favseed/blob/main/CONTRIBUTING.md)
for setup and the measurement requirements for pipeline changes.

Follow the [code of conduct](https://github.com/cevdetch/favseed/blob/main/CODE_OF_CONDUCT.md)
in project discussions. Report sensitive findings through the
[security policy](https://github.com/cevdetch/favseed/security/policy).

Created and maintained by [Cevdet](https://cevdet.ch/)
([cevdetch](https://github.com/cevdetch)).

## Licence

MIT. favseed spawns nothing. `@napi-rs/image` is MIT (its quantiser has been clean-room MIT
code since 1.13.0), the resvg inside it is `Apache-2.0 OR MIT`, and the bundled Google Zopfli
is Apache-2.0. Zopfli and WASI libc notices ship under `lib/`. The dependency tree holds no GPL code.
