---
title: 'Documentation: install and use favseed - favseed'
description: Install favseed and make a favicon set from one SVG with the CLI, the Vite plugin, the Astro integration or the website, and see every file it writes.
heading: Documentation
label: Docs
lede: favseed turns one SVG into an optimised favicon set. These pages cover installing it, running it from the command line, Vite, Astro or this website, and the files it writes.
order: 0
---

## Install

favseed is not on npm yet: the first published release will be 1.0.0, and until then [the generator on this site](/) runs the same pipeline in your browser.

favseed needs Node 24 or newer and nothing else. Add it to a project:

```sh
npm install --save-dev favseed
```

Or run it once with `npx favseed`. The image engine, `@napi-rs/image`, installs with the package: resvg, oxipng and a quantiser in one native module, prebuilt for Linux, macOS and Windows on x64 and arm64, and FreeBSD on x64. Zopfli, which recompresses the PNGs, is bundled as WebAssembly built from Google's source, and the command line and this website share it.

## Start in 30 seconds

### Command line

```sh
npx favseed logo.svg --out public
```

This writes five files to `public/` and prints their sizes. Add `--html` and it also prints the `<link>` tags for your `<head>`:

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

### Vite

```js
// vite.config.js
import { defineConfig } from 'vite'
import favseed from 'favseed/vite'

export default defineConfig({
  plugins: [favseed({ input: 'src/logo.svg' })],
})
```

`vite dev` builds the icons the first time a page asks for one and serves them from memory. `vite build` writes the release icons next to `index.html`. favseed adds its `<link>` tags to `index.html` unless the page already has a `<link rel="icon">`.

### Astro

Put your SVG at `src/logo.svg`, then run this from your Astro project:

```sh
npx astro add favseed
```

Astro installs the package and adds the integration to `astro.config.mjs`. The `<link>` tags go into every page that does not already have a `<link rel="icon">`.

### Website

Open [the generator](/), choose an SVG and download the set as a zip. The build runs in your browser tab, so nothing is uploaded.

## What you get

| File | What it is |
|---|---|
| `icon.svg` | One optimised SVG for the favicon and page images. Animation, styling and accessibility are preserved by default. |
| `favicon.ico` | One 48×48 entry, stored as a raw PNG in a 22-byte container. |
| `apple-touch-icon.png` | 180×180 on the `--bg` ground, the mark placed in the safe zone so iOS's rounded mask cuts nothing. |
| `icon-<size>.png` | On the `--bg` ground, the mark placed in the safe zone the same way. Default 192 and 512, the pair Chrome's install criteria document. The manifest's `any maskable` icons. |
| `site.webmanifest` | Only with `--manifest`. Icons only: you merge your own `name` and `theme_color`. |

Use the same `/icon.svg` URL in `<link rel="icon">` and `<img>`, so the browser can reuse the cached file. PNG and ICO exports use the source's static base appearance. [Outputs](/outputs) covers every file in detail: its size, its format, the markup it needs and which platforms read it.

## The pages

- [How it works](/how-it-works): the steps from one SVG to the finished set, from SVG optimisation and safe-zone placement to the accuracy bar and Zopfli.
- [Outputs](/outputs): each file favseed writes, the HTML it needs, and which browser or platform reads it.
- [Benchmarks](/benchmarks): measured bytes, accuracy and build time behind favseed's defaults.
