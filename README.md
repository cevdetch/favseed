# favseed

One SVG in, an optimised favicon set out: `favicon.ico`, `icon.svg`, an apple-touch-icon and
maskable PWA icons, each PNG the smallest encode that passes a measured accuracy bar.

No install at all: [favseed.cevdet.ch](https://favseed.cevdet.ch) runs the same pipeline in
your browser, and nothing is uploaded.

## Install

favseed is not on npm yet: the first published release will be 1.0.0. Until then, use the
website above.

favseed needs Node 24 or newer and nothing else:

```sh
npm install --save-dev favseed
```

The image engine, `@napi-rs/image`, installs with the package, prebuilt for Linux, macOS and
Windows on x64 and arm64, and FreeBSD on x64. [Install](https://favseed.cevdet.ch/docs#install)
has the details.

## Quickstart

### CLI

```sh
npx favseed logo.svg --out public
```

This writes five files to `public/` and prints their sizes. [Command line](https://favseed.cevdet.ch/docs/cli)
lists every flag, and [SVG input](https://favseed.cevdet.ch/docs/svg-input) what your source needs.

### Vite

```js
// vite.config.js
import { defineConfig } from 'vite'
import favseed from 'favseed/vite'

export default defineConfig({
  plugins: [favseed({ input: 'src/logo.svg' })],
})
```

`vite dev` serves the icons from memory and `vite build` writes them next to `index.html`.
See [Vite plugin](https://favseed.cevdet.ch/docs/vite).

### Astro

Put your SVG at `src/logo.svg`, then run this from your Astro project:

```sh
npx astro add favseed
```

The `<link>` tags go into every page that does not already have a `<link rel="icon">`.
See [Astro integration](https://favseed.cevdet.ch/docs/astro).

## What you get

| File | Size | Bytes |
|---|---|---|
| `icon.svg` | vector | 392 B |
| `favicon.ico` | 48×48 | 464 B |
| `apple-touch-icon.png` | 180×180 | 778 B |
| `icon-192.png` | 192×192 | 816 B |
| `icon-512.png` | 512×512 | 1,279 B |

Bytes for the `general` test fixture at the default effort; yours depend on your mark.
The three PNGs sit on a black ground by default (`--bg`), the mark placed in the safe zone so a
platform's mask cuts nothing. `--manifest` also writes `site.webmanifest`. [Outputs](https://favseed.cevdet.ch/outputs)
covers every file in detail.

`favseed --html` prints the tags for your `<head>`:

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

## Documentation

- [Documentation](https://favseed.cevdet.ch/docs): install and start in 30 seconds.
- [Command line](https://favseed.cevdet.ch/docs/cli): every flag, the config file and the effort levels.
- [SVG input](https://favseed.cevdet.ch/docs/svg-input): the viewBox, text and images, dark mode and animation.
- [Vite plugin](https://favseed.cevdet.ch/docs/vite): icons from memory in dev, emitted in the build.
- [Astro integration](https://favseed.cevdet.ch/docs/astro): setup, options, caching and head tags.
- [Node API](https://favseed.cevdet.ch/docs/node-api): `build()`, `buildFiles()` and the TypeScript types.
- [Troubleshooting](https://favseed.cevdet.ch/docs/troubleshooting): common problems and safe upgrades.
- [How it works](https://favseed.cevdet.ch/how-it-works): the steps from one SVG to the finished set.
- [Outputs](https://favseed.cevdet.ch/outputs): each file, the HTML it needs and who reads it.
- [Benchmarks](https://favseed.cevdet.ch/benchmarks): the measurements behind the defaults.
- [Decisions](https://github.com/cevdetch/favseed/blob/main/docs/DECISIONS.md): what was measured and what changed.
- [Changelog](https://github.com/cevdetch/favseed/blob/main/CHANGELOG.md)

## Contributing

For usage questions, start with the [documentation](https://favseed.cevdet.ch/docs). Use the
repository's issue forms for bugs and feature requests. See
[CONTRIBUTING.md](https://github.com/cevdetch/favseed/blob/main/CONTRIBUTING.md) for setup and
the measurement requirements for pipeline changes.

Follow the [code of conduct](https://github.com/cevdetch/favseed/blob/main/CODE_OF_CONDUCT.md)
in project discussions. Report sensitive findings through the
[security policy](https://github.com/cevdetch/favseed/security/policy).

Created and maintained by [Cevdet](https://cevdet.ch/)
([cevdetch](https://github.com/cevdetch)).

## Licence

MIT. favseed spawns nothing. `@napi-rs/image` is MIT (its quantiser has been clean-room MIT
code since 1.13.0), the resvg inside it is `Apache-2.0 OR MIT`, and the bundled Google Zopfli
is Apache-2.0. Zopfli and WASI libc notices ship under `lib/`. The dependency tree holds no GPL code.
