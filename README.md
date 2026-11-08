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

Sizes depend on your mark. Each PNG is the smallest encode favseed finds that still passes its
accuracy bar, finished with Zopfli. `--effort fast` makes one quick encode instead, and
`--effort max` tries every candidate.

No install at all: **[favseed.cevdet.ch](https://favseed.cevdet.ch)** runs the same engine and
build pipeline in your browser, with nothing uploaded. Matching input and options
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
Zopfli finishing also tries a guarded lossless palette pass; the
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

The CLI and `build()` stage the complete set before publishing. Handled write failures
restore previous file contents and symlinks and remove newly installed files. If the
filesystem also refuses restoration, the error names the retained recovery directory;
keep it until you have recovered the affected files. Cleanup failures identify leftover
staging directories. Unrelated assets are preserved. Use one writer per output directory;
individual replacements do not make the whole set atomic or protect against crashes.
Rollback copies preserve contents; timestamps, extended attributes and hardlink relationships
may change.

## Why not one of the others

There are several favicon generators on npm. Most write whatever sharp's encoder produced; the
quantizing generators commonly use Sharp. Favseed measures safe-zone placement, keeps the
smallest PNG encode that passes a measured accuracy bar, finishes it with Zopfli, and caches
integration output, through the same browser and CLI engine.

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

Favseed generates a small set with measured safe-zone placement and searches quantized and
lossless PNG candidates for the smallest one that passes its accuracy bar. Its browser and CLI share the
same engine and options, with matching output bytes for self-contained SVGs. Full builds select
SVG precision against the source's static appearance before PNG encoding; PNG quality and
tiny-ICO error are measured separately.

In our four-logo benchmark with matching raster inputs, the quality-80 set that `--effort fast`
builds used **0.5% more PNG/ICO bytes than Vite PWA assets-generator 2.0.0’s default**, with lower measured PNG pixel error.
The default effort was not part of that comparison; on the byte-manifest fixtures it writes
40.8 % fewer PNG/ICO bytes than the quality-80 set (decision 29).
See [the measurements and method](https://github.com/cevdetch/favseed/blob/main/bench/ico-size/README.md); results depend on the input.

## Flags

```
-o, --out DIR     Output directory (default: current)
    --effort LEVEL  fast, default or max (default: default). See "Effort and pinned settings".
    --quality N   Pin PNG quality 1-100 at the full palette: one encode, no search.
    --colors N    Pin a palette of 2-256 colours at quality 100: one encode, no search.
                  Quality below 100 cannot combine with --colors.
    --sizes LIST  Padded "any maskable" PNG sizes (default: "192 512")
    --bg COLOR    Ground of the padded icons (default: #000000). "none" keeps the set
                  transparent and unpadded, declared "any" only.
    --padding P   Margin of each padded icon, as a percentage per side (default: auto).
                  `auto` measures the mark's own extent and snaps it to whole pixels;
                  give a number to override it.
    --var N=V     Set a CSS custom property, e.g. --var brand=#0E7C68. Repeatable.
    --no-animation  Explicitly remove motion from icon.svg.
    --manifest    Also write site.webmanifest.
    --html        Print the <link> tags.
-q, --quiet   -V, --version   -h, --help
```

Long options also accept `--opt=value`; `--` ends option parsing. A flag that takes no
argument rejects one.
If a value matches a known flag, use the inline form, such as `--out=--manifest`.
A separate recognized flag means the preceding option is missing its value.
CSS assignments such as `--var --brand=#0E7C68` remain valid.

### A config file

Every option can live in `favseed.config.js`, `favseed.config.mjs` or `favseed.config.ts` in the
working directory, the first one found. Flags win over it, and `--var` merges with its `vars`
by name. Two keys have no flag: `input`, so a bare `favseed` builds the project's mark, and
`base`, the path the site is served under.

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
`effort`, `quality` and `colors` take the same values as their flags. The summary names the
effort and its Zopfli iterations, the setting each PNG kept, or the pinned setting once.

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

With `--bg none`, explicit `--padding` affects only `apple-touch-icon.png`; numbered PNGs
and `favicon.ico` stay unpadded. The CLI warns about this after a successful build, including
when the options come from a config file or `--quiet` is set.

The background value is validated by asking resvg to render a 1×1 pixel with it, so anything resvg takes
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

## Effort and pinned settings

Every PNG and the ICO payload is scored against a render of your source placed exactly like it:
an encode passes when at most 1 % of pixels are off by more than 8/255 in any channel and the
edge-weighted luma error stays at or below 1.5883, on both a black and a white composite. One
`effort` option (`--effort`) decides how hard favseed looks for the smallest passing encode:

| Effort | Encode | Zopfli |
|---|---|---|
| `fast` | One encode at quality 80 with the full 256-colour palette. No search, no scoring. | none |
| `default` | A binary search over quality 40-99 at the full palette, then over palettes of 2-256 colours at quality 100. The smallest candidate that passes wins. | 15 iterations |
| `max` | Every one of those candidates; the smallest that passes wins. | 120 iterations |

When no candidate passes (a mark too fine for its pixel grid, such as a 48 px ICO of a dense
grid), favseed keeps the `fast` encode. When the quality-80 encode fails but a candidate
passes, the passing candidate wins even if it is larger. Builds are deterministic at every
effort. The Vite plugin and the Astro integration use `fast` in dev and the configured effort
in a build.

`--quality N` or `--colors N` (`quality` and `colors` in config/API, Vite and Astro) pins that
exact setting instead: one encode, no search, at the effort's Zopfli iterations. Quality alone
pins that quality at the full palette; colours alone pin that palette at quality 100; both are
allowed only at quality 100. A pinned setting that misses the accuracy bar builds anyway and
warns, naming the file, the setting and both measurements. Quality is the native encoder's
target, not an error percentage or Sharp's quality scale, and lower values do not always make
smaller files.

SVG optimization, SVG precision selection and safe-zone placement are the same at every effort
and pin. See [current measurements](https://github.com/cevdetch/favseed/blob/main/bench/precision/README.md)
for size, source accuracy and Vite PWA comparisons; [earlier quality measurements](https://github.com/cevdetch/favseed/blob/main/bench/zopfli/QUALITY.md) record the quality-policy choice.

Output jobs and complete alignment searches run in bounded batches. Large custom output sizes
retain serial scheduling; failures drain active work before returning. Both hosts use the
same placement and encoding rules.
Measured speed and byte tradeoffs of Zopfli are recorded in
[the default-performance report](https://github.com/cevdetch/favseed/blob/main/bench/zopfli/DEFAULTS.md).

## Node API

Use named imports from `favseed` in an ES module (`.mjs`, or a project with
`"type": "module"`). The default export is the [Astro integration](#astro).

```js
import { build, FavseedError } from 'favseed'

try {
  const result = await build({
    input: 'src/logo.svg',
    out: 'public',
    bg: '#0E1C28',
    base: '/blog/',
    manifest: { name: 'Example', short_name: 'Ex' },
    onWarn: message => console.warn(message),
  })
  console.log(result.links)
  for (const name of result.files) {
    console.log(name, result.bytes[name])
  }
} catch (error) {
  if (!(error instanceof FavseedError)) throw error
  console.error(error.message)
  process.exitCode = 1
}
```

`build()` writes the complete set into `out` (the working directory by default).
Its result contains:

| Field | Value |
|---|---|
| `files` | Filenames in write order. |
| `bytes` | Byte count by filename. |
| `dir` | Absolute output directory, with symlinks resolved. |
| `links` | HTML `<link>` block with `base` applied. |
| `animated` | Whether `icon.svg` preserves animation. |
| `fit` | Placement measurements for `apple` and `icons[size]`; numbered icons have `null` placement with `bg: null`. |

To get the generated bytes without writing output files, use `buildFiles()`:

```js
import { buildFiles } from 'favseed'

const result = await buildFiles({
  input: 'src/logo.svg',
  bg: '#0E1C28',
  manifest: true,
  onWarn: message => console.warn(message),
})

for (const { name, bytes } of result.files) {
  // bytes is a Uint8Array, ready for your asset emitter or storage API.
  console.log(name, bytes.byteLength)
}
console.log(result.links)
```

`buildFiles()` returns `files: { name, bytes }[]` plus `links`, `animated` and `fit`.
It has no `dir` or separate byte-count map. It still reads `input` from disk and
validates the same options as `build()`, including `out` if supplied.

Both functions accept the [config options](#a-config-file) plus `onWarn`. Paths are
relative to the process working directory. They do **not** discover config files;
import your config and pass it explicitly, for example
`build({ ...config, input: 'src/logo.svg', onWarn: console.warn })`.
Warnings are silent unless you supply `onWarn`. Neither function prints a summary
or exits the process; await the result and handle rejected promises in your caller.
`FavseedError.message` contains a readable diagnostic. Writing through `build()` uses
the staging and recovery behavior described under [What you get](#what-you-get).

TypeScript exports include `FavseedConfig`, `BuildOptions`, `BuildResult`,
`BuildFilesResult` and `Placement`. Node, Vite and Astro share the `ImageOptions`
declarations. `vars` accepts an object or a `Map<string, string | number>`.
The declarations check shapes; builds enforce ranges and option combinations at runtime.
`defineConfig()` returns its argument unchanged and does not validate it or fill defaults.
Root and core types work without installing the optional Astro or Vite peers.

### Advanced helpers

Use `build()` or `buildFiles()` for a complete favicon set. The existing helpers below
are also available as named imports from `favseed`:

| Export | Contract |
|---|---|
| `optimiseSvg(source, options?)` | Synchronous SVG optimization; returns `{ data, stripped, animated }`. Options include `vars`, `name`, `precision` (default `1`), `icon` (default `false`), `reference` and `onWarn`. `icon: true` strips motion and accessibility. `reference: true` preserves geometry, validates the viewport and reports text/image dependencies. |
| `loadEngine()` | Loads and caches the native engine on first use. Returns a promise for `render`, `renderRgba`, `probe`, `encode` and `finish`. Rendering needs a square SVG with a valid viewBox; encoding/finishing take PNG bytes. Each method is asynchronous. |
| `engineVersions()` | Returns image, Zopfli build and SVGO identities without loading the rendering or SVG optimizer modules. |
| `loadConfigFile(dir?)` | Imports the first config in `dir` (default working directory). Returns `{ config, file, ignored }`; filenames are basenames, and `file` is `null` when absent. Checks object shape and known keys only. Field values remain `unknown` in TypeScript until narrowed. |
| `CONFIG_FILES` | Config discovery order: `.js`, `.mjs`, `.ts`. Treat this shared array as read-only. |
| `icoWrap`, `maskableFit`, `nestForMask`, `placeInSafeZone`, `linkTags` | The same functions exposed by `favseed/core`, described below. |
| `cli(argv)` | Runs CLI parsing and output. Resolves to an exit code on success; errors may terminate the process. Use the build APIs inside an application. |

`optimiseSvg()` performs one configured optimization operation. It does **not** run
the full build's measured SVG precision selection, raster encoding or output publishing.
Use the build APIs for those guarantees. Engine `encode()` defaults to quality `100`
when omitted; full builds choose each raster's setting by effort, or use the pinned one.
`finish()` uses the supplied iteration count; `0` skips Zopfli.

```js
import { optimiseSvg } from 'favseed'

const { data, animated } = optimiseSvg(source, {
  vars: { brand: '#123456' },
  precision: 3,
})
```

### Portable core

`favseed/core` imports no Node modules or rendering libraries. It exposes the following
helpers for custom hosts; its declaration file describes callbacks and return values.

| Export | Contract |
|---|---|
| `createSvgStage({ optimize })` | Inject an SVGO-compatible implementation; returns `{ optimiseSvg }` with the same options/result as the root helper. |
| `normaliseVars(vars?)` | Returns a `Map<string, string>` with `--`-prefixed names and stringified values. |
| `icoWrap(png, px)` | Returns `Uint8Array` ICO bytes for one square PNG. Checks that its dimensions match `px` in `1–256`. |
| `maskableFit({ width, height, rgba })` | Measures the mark and returns `{ radius, scale, fullBleed }`; rejects an empty mark. RGBA data has four bytes per pixel. |
| `nestForMask(svg, box, canvas)` | Centers the SVG viewport on a square canvas and returns SVG text. |
| `placeInSafeZone(svg, render, canvas, padding?)` | Returns a promise for `{ svg, box, scale, snapped, radius, fullBleed, padding }`. The renderer supplies transparent RGBA pixels, synchronously or asynchronously. Canvas size must be positive and even; padding defaults to `'auto'`. Unlike build placement metadata, this result has no `canvas` field. |
| `squareIconSvg(svg)` | Frames a rectangular viewport; returns `{ data, warning }`, with `warning: null` when no warning applies. |
| `mapImages(items, sizeOf, work, options?)` | Runs image work in bounded batches and returns results in input order. `sizeOf` supplies canvas pixels; `serial: true` runs one at a time. A failed batch drains before rejection. |
| `linkTags(base?, manifest?)`, `declaresIcon(html)` | Generate the link block or detect an existing icon link. |
| `manifestIcons({ sizes, base?, purpose? })`, `manifestJson({ sizes, base?, purpose?, extra? })` | Generate icon entries or manifest text. `extra.icons` is replaced with generated entries. |
| `FavseedError` | The same error class as the root export. |

The low-level link/manifest helpers concatenate `base` as supplied; include a trailing
slash, such as `/blog/`. Full builds normalize `base` for you. Low-level helpers do not
apply the complete build-option validation.

Core also exports `ICO_SIZE`, `APPLE_SIZE`, `DEFAULT_QUALITY`, `DEFAULT_COLORS`,
`DEFAULT_SIZES`, `DEFAULT_BG`, `DEFAULT_EFFORT`, `EFFORT_ITERATIONS`, `ACCURACY_PCT`,
`EDGE_GATE`, `SEARCH_QUALITIES`, `SEARCH_COLORS`, `MASK_SAFE_RADIUS` and `SNAP_WINDOW`.
Treat `DEFAULT_SIZES` as read-only.
Current values describe the engine; output policy can change in a release that allows
byte changes. Import through `favseed/core`; other `lib/` paths are package internals.

Full builds normalize variable names in objects and Maps. When calling `optimiseSvg()`
directly, pass an object or normalize a Map with `normaliseVars()` first: that helper's
Map path expects keys such as `--brand` and uses them as supplied.

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
builds use `effort: 'fast'`, so their PNG and ICO bytes differ from the build's.

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

Put your SVG at `src/logo.svg`, then run this from your Astro project:

```sh
npx astro add favseed
```

Astro installs the package and adds `import favseed from 'favseed'` with
`integrations: [favseed()]`. Edit that call to configure another input or other options.
The package-root default is the Astro integration; named library imports such as `build`
and `defineConfig` keep their existing behavior. Manual installation can use the explicit
`favseed/astro` entry:

```js
// astro.config.mjs
import favseed from 'favseed/astro'

export default defineConfig({
  integrations: [favseed({ input: 'src/logo.svg' })],
})
```

The integration is `favseed/vite` plus head injection. In dev the icons are served from
memory; a build emits them with your client assets. A file you keep in `public/` under the same
name wins in dev and fails the build, so nothing of yours is ever replaced. The `<link>` tags go
into every page that does not already have a `<link rel="icon">`, and `config.base` is prefixed
for you.

`sizes` is an array. `vars` accepts an object or a `Map`. Astro controls `base` and `out`, so
set those through Astro's configuration rather than in this call. A `favseed.config.*` in the
project root is read too; options passed here win over it.

| Option | Default | Notes |
|---|---|---|
| `input` | `src/logo.svg` | Path to the mark, relative to the project root. |
| `effort` | `'default'` | `'fast'`, `'default'` or `'max'`; see [Effort and pinned settings](#effort-and-pinned-settings). Dev always uses `'fast'`. |
| `quality` | none | Pins a PNG quality from 1 to 100 at the full palette: one encode, no search. Below 100 cannot be combined with `colors`. |
| `colors` | none | Pins a palette of 2 to 256 colours at quality 100: one encode, no search. |
| `sizes` | `[192, 512]` | Even pixel sizes for padded maskable PNGs. |
| `bg` | `'#000000'` | Ground for padded icons. `null` or `'none'` makes the set transparent and unpadded. |
| `padding` | `'auto'` | Measured per mark, or a fixed 0–45% per side. |
| `vars` | none | CSS custom properties as an object or `Map`. |
| `animation` | `true` | Preserve animation; `false` removes it from `icon.svg`. |
| `manifest` | `false` | `true` writes icons-only; an object merges app metadata. |
| `head` | `'inject'` | Automatic injection (`true` is an alias), `Head.astro`, or manual links (`false` logs them). |

```js
favseed({
  input: 'src/logo.svg',
  sizes: [192, 512],
  vars: { brand: '#0E7C68' },
  bg: '#0E1C28',     // the padded icons' ground; also a good background_color below
  manifest: { name: 'Example', short_name: 'Ex', theme_color: '#0E7C68', background_color: '#0E1C28' },
  head: 'inject',    // true | 'inject' | 'component' | false
})
```

Options are validated when the integration is created, including for `sync` and `preview`.
Typos, unsupported options and invalid build values fail before generation. Set paths with
Astro's `base` and build output (`outDir`, `build.client`), rather than passing `base` or `out` to
Favseed.
Checks that need the renderer, such as background opacity or unresolved SVG variables, still
run during generation. They warn in development and fail production builds, with advice using
`bg`, `vars` and `animation: false` configuration syntax.

**It does not rebuild on every dev-server restart.** The icons are built on the first request
for one, at `effort: 'fast'` and every configured size, and kept in a content-addressed cache whose key
includes favseed's version, input bytes, canonicalised options, and the identities of
`@napi-rs/image`, SVGO and the Zopfli build (including its WASM hash). These can change generated
bytes, so a cache keyed only on the SVG could return stale files after an upgrade. The effort and
any pinned setting are part of the key, so a dev set never stands in for a build's. The cache keeps
eight recently used complete sets with verified integrity metadata, including the current one;
staging directories, symlinks, modified or unrecognized entries, and older slots without
integrity metadata are left alone. An evicted set is rebuilt when needed.

With Astro 7's `experimental.incrementalBuild` enabled, changing the generated head links
or automatic injection invalidates cached HTML. Eligible pages remain reusable when those
head settings are unchanged, including when only the icon bytes change. Equivalent
`head: true` and `head: 'inject'` settings share the same behavior.

Build dependencies load on demand: the explicit `favseed/astro` entry avoids the Node build
module during configuration, `sync` and `preview`. The package-root entry also
loads the named library API, but neither entry initializes SVGO or the native engine during
import. CLI help/version and early option validation skip SVGO; the synchronous
SVG helper initializes it on first use. Generated icons and cache identity are unchanged.

**Head tags.** Astro has no official head-injection hook. All four `injectScript` stages are
JavaScript, and a `<link rel="icon">` written by a script is found after the browser has
already asked for `/favicon.ico`. So `head: 'inject'` (the default) is an `order: 'post'`
middleware that splices before `</head>` and skips any page whose head already has a
`<link rel="icon">`. It buffers at most 64 KiB until the closing head, then streams the rest
of the response. If the closing head is missing or exceeds that limit, it passes the HTML
through unchanged; use the component or manual tags for those pages.
`head: 'component'` gives you `favseed/astro/Head.astro` to place yourself, and
`head: false` logs the block for pasting. `head: true` is an alias for `'inject'`.

**Migrating an Astro starter.** Delete its `public/favicon.ico` and `public/favicon.svg` if you
want favseed's icons, and remove their old `<link rel="icon">` tags from your layout or pages.
Existing icon declarations make automatic injection skip the page. If you keep manual tags,
update them to favseed's generated URLs and choose `head: 'component'` or `head: false` as
appropriate.

## How it decides

Every step was chosen by measurement. The decisions in force, and the ones they replaced, are in
**[docs/DECISIONS.md](https://github.com/cevdetch/favseed/blob/main/docs/DECISIONS.md)** and the reproducible sweeps in
**[docs/BENCHMARKS.md](https://github.com/cevdetch/favseed/blob/main/docs/BENCHMARKS.md)**.
Current raster proportions, byte and timing results are in the [framing report](https://github.com/cevdetch/favseed/blob/main/bench/framing/README.md).
The [precision report](https://github.com/cevdetch/favseed/blob/main/bench/precision/README.md) records the SVG rounding policy and matched Vite PWA comparison.

The short version, because these are the parts that look wrong until you know why:

- **One engine, nothing to install.** `@napi-rs/image` bundles the resvg and oxipng versions
  favseed was measured with, and its renders match the resvg CLI pixel for pixel. Against the
  native resvg, pngquant and oxipng pipeline, the earlier engine comparison found it 9 % smaller
  on a gradient and 0.46 % larger across nine flat marks (decision 26).
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
- **Each raster is the smallest candidate that passes.** At the default effort a binary
  search tries 7 to 9 of 26 quality and palette settings per raster and keeps the smallest that
  passes the accuracy bar; a raster that fails at quality 80 takes a passing candidate even when
  it is larger. Over 568 rasters that came to 20.4 % fewer bytes than quality 80, within 0.2 %
  of trying all 26 (decision 29).
- **Zopfli runs at most once per raster**, after the choice, on the winning encode: 15
  iterations at the default effort, 120 at `max`, none at `fast`. Candidates are compared
  before it, because finishing every one would multiply its cost by the number tried.
- **Bounded concurrency overlaps raster jobs and complete alignment searches.** The shared
  scheduler limits active canvas work, keeps large custom sizes serial, and drains failures
  before a retry. Candidate selection and output order remain deterministic.
- **Placement probes avoid oversized transparent margins.** A small mark still enlarges into
  its safe zone. Large-margin searches use target-size canvases; other probes stay within
  twice the target size, retaining ordinary render reuse. The full candidate walk remains;
  this bounds each probe, not the number of probes or process RAM.
  See the [placement measurements](https://github.com/cevdetch/favseed/blob/main/bench/placement/README.md).

## Upgrading

Keep Favseed and your dependency lockfile pinned when you need repeatable generated
assets. Use the same source SVG and options, with fonts outlined and external images
embedded as described in [SVG input requirements](#svg-input-requirements).
The browser and CLI share the pipeline; compare matching versions and options,
including `manifest` (enabled by default on the website, opt-in in the CLI/API).

New versions can improve compression or placement and produce different bytes.
Byte-output changes require at least a minor release under this project's policy;
they are not patch changes. Before upgrading, read the [changelog](CHANGELOG.md),
regenerate your icons, and review the file-size and visual changes before committing
the new assets and lockfile. Smaller files alone do not prove better rendering.
The [contributor byte baseline](CONTRIBUTING.md#the-one-rule) checks representative
fixtures; it is not a guarantee for every SVG or across versions.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Missing or invalid SVG dimensions | Give the root SVG a valid `viewBox` or positive numeric `width` and `height`. Percentage-only dimensions need a `viewBox`. See [SVG input requirements](#svg-input-requirements). |
| Text or images look different or disappear | Outline fonts and embed images as data URLs. Favseed warns about these dependencies but does not fetch resources or convert fonts. |
| An unresolved `var()` stops generation | Supply a fallback in the SVG or a value through [`--var`](#--var) / the API's `vars` option. |
| `colors` conflicts with `quality` | Pin one control, or use `quality: 100` with an explicit palette. Usually pin neither: the default effort chooses per raster. See [Effort and pinned settings](#effort-and-pinned-settings). |
| A warning says a file misses the accuracy bar | A pinned `quality` or `colors` is too low for that raster. Raise it, or remove the pin so the effort searches. |
| API options appear to be ignored | Pass your config object explicitly; `build()` and `buildFiles()` do not load it automatically. Use `base` for URL prefixes and `out` for disk paths. |
| Browser generation is unavailable | Use HTTPS or localhost and a browser with WebAssembly and `DecompressionStream`, or use the Node CLI. Disabled shared memory automatically selects the compatibility engine; changing privacy settings is unnecessary. |
| A self-hosted site cannot load its worker or WASM | Check failed requests and response headers against the [site hosting guidance](site/README.md). Document and worker isolation headers enable the faster threaded engine. |
| Writing fails and reports recovery files | Keep the reported directory until you have restored the previous files. Check permissions and ensure only one build writes to the output directory at a time. |

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
