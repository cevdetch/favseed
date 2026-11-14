---
title: 'Maskable icons: the safe zone and the any maskable trade-off - favseed'
description: 'How maskable PWA icons work: the W3C safe zone, which platforms apply a mask, what Chrome needs to offer an install, and how much padding a mark needs.'
heading: Maskable icons
label: Maskable icons
lede: An installed web app's icon is often cut to a circle, a squircle or a rounded square. This guide covers the safe zone that survives every mask, which platforms apply one, what Chrome needs before it offers to install an app, and how much padding a mark needs.
order: 1
---

## What maskable means

A web app manifest lists the app's icons, and each one can carry a `purpose`. The [W3C Web Application Manifest](https://www.w3.org/TR/appmanifest/#purpose-member) defines three values:

- `any`, the default: "The user agent is free to display the icon where no purpose is required."
- `maskable`: "The image is designed with icon masks and safe zone in mind, such that any part of the image that is outside the safe zone can safely be ignored and masked away by the user agent."
- `monochrome`: the browser discards the colour and uses only the alpha channel, as a mask over a solid fill.

One icon can list several values separated by spaces, and then "it could be used for any of those purposes".

The [safe zone](https://www.w3.org/TR/appmanifest/#icon-masks) is "a circle with center point in the center of the icon and with a radius of 2/5 (40%) of the icon size". The spec then sets the rule a designer relies on: "The user agent MUST NOT make any pixel within the safe zone transparent." Anything outside the circle may be cut away, and the browser composites an icon with transparent pixels "onto a solid fill (e.g., white) of the user agent's choice". So a maskable icon should be opaque to its edges, with everything that matters inside the circle.

## Who applies a mask

Chrome reads `purpose` when it installs an app, and what happens next depends on the platform:

- **Android.** Chrome asks for a maskable icon first ([add_to_homescreen_data_fetcher.cc](https://chromium.googlesource.com/chromium/src/+/97164d4ad8debc5ab6ae0e585426e734481f70ad/components/webapps/browser/android/add_to_homescreen_data_fetcher.cc#69)) and turns it into an Android adaptive icon. Android's own adaptive icons use [108×108 dp layers, of which the inner 66×66 dp is never clipped](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive) by a launcher's mask, a smaller share of the icon than the W3C circle. Chrome pads the web icon so that the W3C circle lands on that 66 dp zone ([WebappsIconUtils.java](https://chromium.googlesource.com/chromium/src/+/97164d4ad8debc5ab6ae0e585426e734481f70ad/components/webapps/browser/android/java/src/org/chromium/components/webapps/WebappsIconUtils.java#48)), so the W3C circle is the only one you design for. Of icons declared `any`, [web.dev's maskable icon article](https://web.dev/articles/maskable-icon) says: "In Android, these icons are resized on a white background."
- **ChromeOS and macOS.** Chrome takes a maskable icon of 256 px or more when the manifest has one, and falls back to an `any` icon ([trusted_icon_filter.cc](https://chromium.googlesource.com/chromium/src/+/97164d4ad8debc5ab6ae0e585426e734481f70ad/chrome/browser/web_applications/icons/trusted_icon_filter.cc#24)). On ChromeOS, Chrome masks a maskable icon ([change 6881749](https://chromium-review.googlesource.com/c/chromium/src/+/6881749)). On macOS, Chrome cut it to Apple's rounded shape itself ([change 4594594](https://chromium-review.googlesource.com/c/chromium/src/+/4594594)); a change merged in August 2026 stops doing that on macOS 26 and later and leaves the shape to the system ([change 8175547](https://chromium-review.googlesource.com/c/chromium/src/+/8175547)).
- **Windows and Linux.** Chrome takes an `any` icon and passes it through unmasked ([icon_masker.cc](https://chromium.googlesource.com/chromium/src/+/97164d4ad8debc5ab6ae0e585426e734481f70ad/chrome/browser/web_applications/icons/icon_masker.cc#15)), so the icon appears exactly as drawn.
- **iOS and iPadOS.** [firt.dev's iOS PWA notes](https://firt.dev/notes/pwa-ios/) list maskable and monochrome icons as recognised but ignored, and add: "The apple-touch-icon link element in the HTML overrides the manifest icon declaration." So when a page has an [`apple-touch-icon`](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html) link, the Home Screen shows that PNG, not the manifest icons.

[Outputs](/outputs#who-reads-what) has the full table, with the file favseed writes for each platform.

## What Chrome needs to offer an install

[web.dev's install criteria](https://web.dev/articles/install-criteria) say the manifest's `icons` "must include a 192px and a 512px icon", and [MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable#required_manifest_members) asks the same of Chromium-based browsers. Chromium's own check is looser on size and strict on purpose: it looks for a square icon of at least 144 px whose `purpose` includes `any` ([installable_evaluator.cc](https://chromium.googlesource.com/chromium/src/+/97164d4ad8debc5ab6ae0e585426e734481f70ad/components/webapps/browser/installable/installable_evaluator.cc#117)). An icon declared `maskable` alone does not count, so a manifest whose icons are all `maskable` fails that check.

These criteria decide when Chrome offers the install, not whether it can happen. In Chrome, web.dev says, an app must meet them "before it will fire the beforeinstallprompt event and show the in-browser install promotion", and it adds: "Users can install your web app even if it doesn't meet the PWA installability criteria" ([install criteria](https://web.dev/articles/install-criteria#criteria)).

So ship a 192 and a 512 px icon, and declare at least one of them `any`.

## One file or two

There are two ways to cover both purposes. The first is two files per size: a full-bleed `any` icon and a padded, opaque `maskable` one. That is what [web.dev recommends](https://web.dev/articles/maskable-icon): "We don't recommend using multiple purposes for maskable icons. Using maskable icons as any icons adds unnecessary padding, making the core icon content smaller." The second is one file declared `any maskable`, which the spec allows.

favseed takes the second route by default. `icon-192.png` and `icon-512.png` are padded into the safe zone on an opaque `--bg` ground and declared `any maskable`, so the same two files pass Chrome's `any` check and survive every mask, with one render and one manifest entry per size. The cost is the one web.dev describes: on Windows and Linux, where Chrome draws the icon as it is, the app shows a smaller mark on its ground rather than edge to edge. [Decision 22](https://github.com/cevdetch/favseed/blob/main/docs/DECISIONS.md#22---padding-measured-by-default-fixed-on-request-one-set-for-both-purposes) records why.

To opt out, build with [`--bg none`](/docs/cli#--bg). The numbered icons are then transparent, unpadded and declared `any` only, and you can add maskable entries of your own to the manifest. `apple-touch-icon.png` is still placed in the safe zone either way.

## How much padding

The W3C spec gives a rule of thumb in its [notes on masks](https://www.w3.org/TR/appmanifest/#icon-masks): "By staying inside the safe zone, most icons will have around 10% padding on the top, bottom, right and left". That holds for a round mark, which can fill the whole circle: 80% of the width, 10% per side. It does not hold for every shape. A square mark reaches the circle with its corners, so it can be only 56.6% of the width, 21.7% padding per side. At 10% its corners fall outside the safe zone, where a circular mask cuts them off.

favseed's `--padding auto`, the default, measures each mark instead of applying one number. It renders the mark at each icon's own size, finds the opaque pixel farthest from the centre, and scales the mark until that pixel's outer corner sits on the safe circle. Across favseed's test fixtures it chooses between 7.6% and 18.8% per side. A mark drawn on a grid is then snapped to whole pixels: on a seven-block grid mark at 512 px, the partly covered edge pixels drop from 1,905 to none. [How it works](/how-it-works#2-placement-in-the-safe-zone) describes each step, and [`--padding`](/docs/cli#--padding) takes a fixed percentage if you would rather choose.

## Check your icons

Look at an icon through the masks before you ship it. [Maskable.app](https://maskable.app/) previews it under a circle, a squircle, a rounded rectangle and other shapes, and can show only the minimum safe area. In Chrome, the Manifest section of DevTools' Application panel lists the app's icons; tick [Show only the minimum safe area for maskable icons](https://developer.chrome.com/docs/devtools/progressive-web-apps#icons) to trim each one to the safe circle. If the whole mark is still visible, no mask will cut it. The same tab shows an Installability section when an error blocks installation.

To make a padded, opaque set from your SVG, open [the generator](/). It runs in your browser and builds the manifest icons, the apple-touch-icon and the favicons as one download.
