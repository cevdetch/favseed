---
title: 'Command line: every flag, the config file and defaults - favseed'
description: Every favseed command-line flag with its default, the favseed.config file, --var, --bg, --padding, the effort levels and how a build writes its files.
heading: Command line
label: CLI
lede: One command turns an SVG into the whole favicon set. This page lists every flag and its default, the config file that can hold them, and how the files reach your disk.
order: 1
---

## Usage

```sh
npx favseed logo.svg --out public
```

The build writes the set to the output directory and prints each file's size. These are all the flags:

```text
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

Long options also accept `--opt=value`, and `--` ends option parsing. A flag that takes no argument rejects one.

If a value matches a known flag, use the inline form, such as `--out=--manifest`. A recognised flag given as the next argument means the option before it is missing its value. CSS assignments such as `--var --brand=#0E7C68` stay valid.

## A config file

Every option can live in `favseed.config.js`, `favseed.config.mjs` or `favseed.config.ts` in the working directory; favseed reads the first one it finds. Flags win over it, and `--var` merges with its `vars` by name. Two keys have no flag: `input`, so a bare `favseed` builds the project's mark, and `base`, the path the site is served under.

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

`base` prefixes every `href` that `--html` prints and every icon `src` in the manifest. `manifest` as an object writes `site.webmanifest` with those members ahead of the icons. `effort`, `quality` and `colors` take the same values as their flags.

The summary names the effort and its Zopfli iterations, then the setting each PNG kept, or the pinned setting once.

A `.ts` config loads through Node's type stripping, which erases annotations and transforms nothing. An `enum` or a `namespace` fails with a message pointing you to `favseed.config.mjs`.

## `--var`

Your mark can be a template. `var(--brand, #0E7C68)` renders as `#0E7C68` by default, the way a browser resolves an undefined property, and `--var brand=#7C0E68` overrides it:

```sh
favseed logo.svg --var brand=#7C0E68 --out public
```

A `var()` with no fallback and no override is an error, not a black square. resvg has no `var()` support at all: it renders the whole mark black and warns on stderr, so favseed resolves every custom property before anything is rasterised.

## `--bg`

The padded icons get an opaque ground, `#000000` by default. iOS composites a transparent Home Screen icon onto black anyway, and a maskable icon should be opaque, so the alpha channel would be lost regardless. Black is what the platform would have done to a transparent icon, minus the tRNS chunk.

favseed warns when you did not choose a ground, because the right one depends on your mark, not on the format. Use `--bg '#fff'` for a mark drawn on light, or `--bg none` to keep the alpha. `--bg none` also makes the set unpadded and declares it `"any"` only: a platform composites a transparent icon onto a colour of its own choosing, so the safe zone would mean nothing, and padding the ICO fallback only makes the mark smaller.

With `--bg none`, an explicit `--padding` affects only `apple-touch-icon.png`; the numbered PNGs and `favicon.ico` stay unpadded. The CLI warns about this after a successful build, even when the options come from a config file or `--quiet` is set.

favseed validates the colour by asking resvg to render a 1×1 pixel with it, so anything resvg takes works (`#fff`, `teal`, `rgb(14 124 104)`, `hsl(170 80% 27%)`), and the validator can never disagree with the renderer. That pixel must come out opaque. `transparent`, `rgba(…, 0.5)` or `#ffffff80` would put alpha into icons declared maskable, so favseed refuses them and points you to `--bg none`.

## `--padding`

`apple-touch-icon.png` and every `icon-<size>.png` place the mark inside the safe zone, the circle every platform's mask shows. [How it works](/how-it-works#2-placement-in-the-safe-zone) explains the safe zone, and [Outputs](/outputs#who-reads-what) lists which platform reads which file through which mask.

`auto`, the default, renders `icon.svg` at each padded icon's size, finds the opaque pixel farthest from the centre (its outer corner, so the whole pixel counts), and scales the mark until that pixel sits on the safe circle. A mark with its own margin is enlarged, and one that reaches its corners is shrunk. No fixed number suits every mark: a round one fills 80% of the width, while a square one's corners touch the safe circle at 56.6%. Across the test fixtures `auto` chooses 7.6% to 18.8% per side.

`auto` then snaps a mark drawn on a grid to whole pixels: a seven-block grid mark at 512 px drops from 1,905 partly covered edge pixels to none, and at 180 px the same mark snaps from 116 to 112 px and the apple icon is 151 B.

A number, such as `--padding 12`, sets a fixed percentage per side, applied as given and never snapped. A source that is opaque in all four corners is full-bleed: it is drawn with its own ground and used as it is. `--bg none` turns placement off: the set stays transparent and unpadded, declared `"any"` only.

## Effort and pinned settings

Every PNG and the ICO payload must pass the accuracy bar: at most 1% of pixels off by more than 8/255 in any channel, and an edge-weighted luma error of at most 1.5883, on black and on white. [How it works](/how-it-works#3-each-raster-against-the-accuracy-bar) explains the bar and the 26 candidates. `--effort` (`effort` in a config) decides how hard favseed looks for the smallest encode that passes:

| Effort | Encode | Zopfli |
|---|---|---|
| `fast` | One encode at quality 80 with the full 256-colour palette. No search, no scoring. | none |
| `default` | A binary search over quality 40 to 99 at the full palette, then over palettes of 2 to 256 colours at quality 100. The smallest candidate that passes wins. | 15 iterations |
| `max` | Every one of those candidates; the smallest that passes wins. | 120 iterations |

When no candidate passes, as with a 48 px ICO of a dense grid, favseed keeps the `fast` encode; when quality 80 fails and another candidate passes, that candidate wins even if it is larger. Builds are deterministic at every effort. The Vite plugin and the Astro integration use `fast` in dev and the configured effort in a build.

`--quality N` or `--colors N` (`quality` and `colors` in a config, the Node API, Vite and Astro) pins that exact setting instead: one encode, no search, at the effort's Zopfli iterations. Quality alone pins that quality at the full palette. Colours alone pin that palette at quality 100. Both together are allowed only at quality 100.

A pinned setting that misses the accuracy bar builds anyway and warns, naming the file, the setting and both measurements. Quality is the native encoder's target, not an error percentage or Sharp's quality scale, and a lower value does not always make a smaller file.

SVG optimisation, SVG precision selection and safe-zone placement are the same at every effort and pin. The [precision report](https://github.com/cevdetch/favseed/blob/main/bench/precision/README.md) holds current size and source-accuracy measurements and the Vite PWA comparison, and the [earlier quality measurements](https://github.com/cevdetch/favseed/blob/main/bench/zopfli/QUALITY.md) record how the quality policy was chosen. The [default-performance report](https://github.com/cevdetch/favseed/blob/main/bench/zopfli/DEFAULTS.md) measures Zopfli's speed and byte tradeoffs.

## How files are written

The CLI and `build()` stage the complete set before publishing it. When a write fails, favseed restores the previous file contents and symlinks and removes the files it had newly installed. If the filesystem also refuses the restoration, the error names the recovery directory it kept: keep that directory until you have recovered the affected files. Cleanup failures name any staging directories left behind.

Unrelated files in the output directory are left alone. Use one writer per output directory: each file is replaced individually, so the set as a whole is not atomic and a crash is not covered. Rollback copies keep file contents, but timestamps, extended attributes and hardlink relationships may change.
