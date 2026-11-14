---
title: 'Dark-mode favicon: an SVG icon that follows the colour scheme - favseed'
description: 'How an SVG favicon switches colours with prefers-color-scheme, which browsers take an SVG favicon, and why the ICO and PNG fallbacks keep the light colours.'
heading: Dark-mode favicon
label: Dark-mode favicon
lede: A dark mark all but disappears on a dark tab strip. An SVG favicon can carry a second set of colours for dark mode and switch to them on its own. This guide covers the markup, which browsers take an SVG favicon, and what the bitmap fallbacks show.
order: 2
---

## The idea

An SVG file can hold a `<style>` element, and the CSS inside it can use media queries. The [`prefers-color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme) media feature detects whether the visitor "has requested light or dark color themes", and MDN says they set that preference "through an operating system setting (e.g., light or dark mode) or a user agent setting".

So write the light colours as the default rules, and override them inside `@media (prefers-color-scheme: dark)`. A browser that applies the query to the favicon then shows the dark rules to a visitor who prefers dark: one file, two appearances, no script.

## An example

A ring in a mid blue that reads on light and dark backgrounds, which turns a lighter blue in dark mode:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    .ink { fill: #2f7fd1; }
    @media (prefers-color-scheme: dark) {
      .ink { fill: #8ab8ec; }
    }
  </style>
  <path class="ink" d="M16 2a14 14 0 1 0 0 28a14 14 0 1 0 0-28zm0 7a7 7 0 1 1 0 14a7 7 0 1 1 0-14z"/>
</svg>
```

The `viewBox` lets the icon scale to any size, and the `xmlns` makes it a standalone SVG document. Keep the `<style>` inside the file. Link it next to the fallbacks, in your `<head>`:

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

[The minimal favicon set](/outputs#the-markup) explains each tag. Serve the SVG as `image/svg+xml`: [caniuse notes](https://github.com/Fyrd/caniuse/blob/main/features-json/link-icon-svg.json) that Chrome, Edge, Firefox and Samsung Internet require that MIME type.

## Browser support

[caniuse's data for SVG favicons](https://github.com/Fyrd/caniuse/blob/main/features-json/link-icon-svg.json) gives the first version of each browser that takes one:

| Browser | SVG favicon since |
| --- | --- |
| Chrome | 80 |
| Edge | 80 |
| Firefox | 41 |
| Safari on macOS | 26.0 |
| Safari on iOS | 26.0 |
| Chrome for Android | Supported (caniuse tracks only the current version, 157) |
| Samsung Internet | 13.0 |

Firefox 4 to 40 had partial support, "only loading the SVG favicon the first time, but not on subsequent loads". WebKit announced the Safari change with the [Safari 26 beta](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/): "Safari 26 beta now supports the SVG file format for icons everyplace there are icons in the interface, including favicons." The announcement does not mention colour schemes.

What happens when the visitor changes the setting with the page open varies. Mozilla closed its report of an [SVG favicon that did not update on a colour-scheme change](https://bugzilla.mozilla.org/show_bug.cgi?id=1598892) as a duplicate of [bug 1598480](https://bugzilla.mozilla.org/show_bug.cgi?id=1598480), whose fix makes SVG images respond to theme changes and shipped in Firefox 74. For the other browsers, switch the setting, reload the page and look at the tab in each browser you support.

Test with the real setting, not a simulated one. Chrome DevTools can [emulate `prefers-color-scheme`](https://developer.chrome.com/docs/devtools/rendering/emulate-css#emulate_css_media_feature_prefers-color-scheme) from its Rendering tab, but an open Chromium issue reports that the [emulation does not reach media queries in SVG favicons](https://issues.chromium.org/issues/40108320).

## The fallbacks keep the light colours

`favicon.ico`, `apple-touch-icon.png` and the manifest PNGs are bitmaps, each with one appearance. A browser that does not take the SVG shows `favicon.ico`, in light and dark mode alike, so the light rules are what those visitors see on a dark tab strip.

The query also reports the visitor's preference, not the colour behind the icon. In Firefox's New Tab shortcuts, an icon with dark rules once showed white on a white tile ([bug 1936587](https://bugzilla.mozilla.org/show_bug.cgi?id=1936587)).

So choose light colours that still read on a dark background, such as a mid-tone or a mark with a light outline, or draw the mark on a filled shape of its own so it carries its contrast with it. The example's mid blue passes that test; its dark rule only raises the contrast.

## With favseed

favseed keeps the `@media (prefers-color-scheme: dark)` block in `icon.svg`, with the classes it selects ([how it works](/how-it-works#1-the-svg-stage)). Built with favseed, the example above becomes:

```text
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.ink{fill:#2f7fd1}@media (prefers-color-scheme:dark){.ink{fill:#8ab8ec}}</style><path d="M16 2a14 14 0 1 0 0 28 14 14 0 1 0 0-28m0 7a7 7 0 1 1 0 14 7 7 0 1 1 0-14" class="ink"/></svg>
```

Every raster comes from the light rules, because favseed's renderer skips `@media`: the ICO and PNGs are the same bytes the source would give without its dark block. [Decision 25](https://github.com/cevdetch/favseed/blob/main/docs/DECISIONS.md#25-iconsvg-keeps-a-prefers-color-scheme-block) records the test that checks this, and [SVG input](/docs/svg-input#dark-mode) covers the dark block in a source. The padded PNGs sit on an opaque ground, black by default, and [`--bg`](/docs/cli#--bg) chooses another. To build the set from the command line:

```sh
npx favseed logo.svg --out public
```

Or open [the generator](/), which builds the same set in your browser.
