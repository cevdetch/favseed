---
title: 'Troubleshooting favseed builds, and upgrading safely - favseed'
description: Fixes for common favseed problems, from SVG dimensions and var() errors to accuracy warnings and browser support, and how to upgrade without surprise bytes.
heading: Troubleshooting
label: Troubleshooting
lede: The problems people meet most often, what to check for each, and how to upgrade favseed when you need generated icons you can reproduce.
order: 6
---

## Common problems

| Symptom | What to check |
|---|---|
| Missing or invalid SVG dimensions | Give the root SVG a valid `viewBox` or a positive numeric `width` and `height`. Percentage-only dimensions need a `viewBox`. See [SVG input requirements](/docs/svg-input#requirements). |
| Text or images look different or disappear | Outline fonts and embed images as `data:` URLs. favseed warns about these dependencies but does not fetch resources or convert fonts. |
| An unresolved `var()` stops generation | Supply a fallback in the SVG, or a value through [`--var`](/docs/cli#--var) or the API's `vars` option. |
| `colors` conflicts with `quality` | Pin one control, or use `quality: 100` with an explicit palette. Usually pin neither: the default effort chooses per raster. See [Effort and pinned settings](/docs/cli#effort-and-pinned-settings). |
| A warning says a file misses the accuracy bar | A pinned `quality` or `colors` is too low for that raster. Raise it, or remove the pin so the effort searches. |
| API options appear to be ignored | Pass your config object explicitly: `build()` and `buildFiles()` do not load it for you. Use `base` for URL prefixes and `out` for disk paths. |
| Browser generation is unavailable | Use HTTPS or localhost and a browser with WebAssembly and `DecompressionStream`, or use the Node CLI. With shared memory disabled the site picks the compatibility engine by itself, so you do not need to change privacy settings. |
| A self-hosted site cannot load its worker or WASM | Check the failed requests and response headers against the [site hosting guidance](https://github.com/cevdetch/favseed/blob/main/site/README.md). Document and worker isolation headers enable the faster threaded engine. |
| Writing fails and reports recovery files | Keep the reported directory until you have restored the previous files. Check permissions, and make sure only one build writes to the output directory at a time. See [How files are written](/docs/cli#how-files-are-written). |

## Upgrading

Keep favseed and your dependency lockfile pinned when you need repeatable generated assets. Use the same source SVG and options, with fonts outlined and external images embedded as [SVG input](/docs/svg-input#text-and-images) describes.

The browser and the CLI share the pipeline, so compare matching versions and options, including `manifest`: the website writes a manifest by default, while the CLI and the API write one only when asked.

A new version can improve compression or placement and produce different bytes. Under this project's policy a change to output bytes needs at least a minor release, never a patch.

Before upgrading, read the [changelog](https://github.com/cevdetch/favseed/blob/main/CHANGELOG.md), regenerate your icons, and review the changes in file size and appearance before committing the new assets and lockfile. Smaller files alone do not prove better rendering. The [contributor byte baseline](https://github.com/cevdetch/favseed/blob/main/CONTRIBUTING.md#the-one-rule) checks representative fixtures; it is not a guarantee for every SVG or across versions.
