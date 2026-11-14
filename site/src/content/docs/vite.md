---
title: 'Vite plugin: favicons in dev and in the build - favseed'
description: Add favseed/vite to a Vite project to serve favicons from memory in dev, emit them in the build, inject the link tags and feed icons to vite-plugin-pwa.
heading: Vite plugin
label: Vite
lede: favseed/vite builds the favicon set inside Vite. The dev server serves it from memory, a build writes it next to index.html, and the link tags go into your page for you.
order: 3
---

## Set up

```js
// vite.config.js
import { defineConfig } from 'vite'
import favseed from 'favseed/vite'

export default defineConfig({
  plugins: [favseed({ input: 'src/logo.svg' })],
})
```

## In dev

`vite dev` builds the icons the first time a page asks for one, then serves them from memory. Edit the logo or `favseed.config.*` and the icons rebuild and the page reloads.

Dev builds use `effort: 'fast'`, so their PNG and ICO bytes differ from the build's.

## In a build

`vite build` writes the release icons to the output directory, next to `index.html`. favseed never writes to `public/`.

## The head tags

favseed adds its `<link>` tags to `index.html`, unless the page already has a `<link rel="icon">`. A framework without an `index.html` can import them instead:

```js
import { links, files } from 'virtual:favseed'
```

## Options

The plugin takes the same options as [`favseed.config.*`](/docs/cli#a-config-file), except `out`: Vite decides the output directory. Options passed to the plugin win over the config file. `base` defaults to Vite's `base`.

## Files in public/

Your files come first. If `public/` already holds a file favseed would write, such as `favicon.ico`, with different bytes, `vite build` stops with an error and `vite dev` serves your file with a warning. Delete it to use favseed's.

## With vite-plugin-pwa

vite-plugin-pwa writes its own manifest, so favseed does not write one. Pass favseed's icons to it:

```js
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import favseed, { favseedIcons } from 'favseed/vite'

export default defineConfig({
  plugins: [
    favseed(),
    VitePWA({ manifest: { name: 'Example', icons: favseedIcons() } }),
  ],
})
```

Give `favseedIcons()` the same `sizes`, `bg` and `base` as the plugin. Turn off vite-plugin-pwa's `pwaAssets` option: it writes a `favicon.ico` of its own, and favseed warns when both are on.
