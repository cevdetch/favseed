---
title: 'SVG input: viewBox, text, dark mode and animation - favseed'
description: What favseed needs from your source SVG, a usable viewBox, outlined text and embedded images, and how it treats dark-mode rules and animation.
heading: SVG input
label: SVG input
lede: favseed takes any self-contained SVG with a usable viewport. This page covers the root size it needs, why text and external images deserve care, and what happens to dark-mode rules and animation.
order: 2
---

## Requirements

Give the root `<svg>` a valid `viewBox`, or a positive numeric `width` and `height` from which favseed can derive one. Percentage-only dimensions need an explicit `viewBox`.

A missing, non-finite, zero or negative root size fails with guidance before favseed rasterises the source or writes any output. The root `viewBox` must hold four decimal or exponent numbers separated by whitespace or single commas; missing values, hexadecimal tokens and repeated commas are rejected.

[How it works](/how-it-works#1-the-svg-stage) describes what the optimiser keeps, how coordinates are rounded and how a wide or tall viewBox is framed.

## Text and images

The CLI, the Node API and the browser all warn about text and external images. Fonts can differ or be missing between the native and the browser renderer, so convert text to paths for consistent PNG and ICO output. Embed images as `data:` URLs: relative files and remote image references can be left out of the rasters or of SVG image contexts.

The warnings leave the source content as it is, and favseed neither fetches resources nor converts fonts. A build without warnings does not prove that every dependency will render.

API callers receive the guidance through `onWarn`. The browser shows it apart from build progress, including on cached builds and before a later rendering error.

## Dark mode

A source with a `@media (prefers-color-scheme: dark)` block keeps it in `icon.svg`, so the favicon follows the browser's colour scheme. The PNGs render the light rules, because resvg skips `@media`, and they are the same bytes a source without the block would produce.

## Animation

`icon.svg` keeps CSS and SMIL animation, the classes and ids something references, and reduced-motion and colour-scheme styles. It works as both the favicon and an image on your pages; whether it animates depends on the browser and the embedding context.

The PNG and ICO files are still images. The renderer does not sample an animation timeline, so your source needs a useful static base appearance. Where it suits the mark, put optional motion inside a `prefers-reduced-motion: no-preference` media query.

`--no-animation`, or `animation: false` in a config or the API, removes motion and keeps every other static declaration. CSS variable overrides such as `--var brand=#7C0E68` still apply.
