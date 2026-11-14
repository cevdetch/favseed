# Contributing

Use the **Bug report** or **Feature request** issue form to describe a problem
before proposing a change. Follow the [code of conduct](CODE_OF_CONDUCT.md) in
project discussions and [SECURITY.md](SECURITY.md) for sensitive findings.
For usage questions, start with the [website](https://favseed.cevdet.ch) and
[README](README.md); open a blank issue if they do not answer your question.

## The one rule

**Every pipeline change arrives with a number.**

If a change touches the optimisation path (plugin list, plugin params, the engine's quantiser
or zopfli settings, stage order, the ICO container), it comes with a `bench/bench.mjs` run showing the
byte delta and proof that every fixture is still inside the accuracy bar. "Looks the same" is
not evidence, and neither is a screenshot.

```sh
pnpm test                      # the definition of done, as node:test
pnpm test:astro                # install the tarball and exercise real Astro static/dev/SSR
node bench/bench.mjs           # every sweep, printed
node bench/bench.mjs colors    # one sweep only
node bench/bench.mjs --write   # regenerate docs/BENCHMARKS.md
```

TypeScript is a pinned root development dependency. `pnpm test` always runs the config and
Vite option type checks; a missing compiler fails instead of skipping them.

`test:astro` runs separately in Linux CI because it needs npm registry access. It installs
the packed package in a temporary external consumer with Astro 7.3.8 and Node adapter 11.1.9,
plus the checkout's installed image/SVGO/Vite/TypeScript versions. Direct test-host versions are pinned;
the temporary npm install resolves transitive dependencies normally and disables lifecycle
scripts. It checks CLI bytes, base paths, both head paths, dev serving, public/ clashes
and streaming SSR responses. The stream body waits for an explicit release request, so the
test proves head delivery before the body completes. It also type-checks the public `favseed`,
`favseed/vite` and `favseed/astro` imports under NodeNext and bundler resolution, accepting
valid options and verifying every intentional invalid call's compiler diagnostic.
It also runs `astro add favseed` in an independent Astro project that initially cannot
resolve Favseed, against locally served packed-package metadata. It checks actual
installation, builds the config it writes with the default `src/logo.svg`, and checks repeat
installation. A dynamic incremental route with a stable `cacheKey` proves unchanged HTML
is reused and refreshed when manifest links or automatic injection change, while icon-only
updates and equivalent head modes retain reuse. An existing user Vite define remains intact.
The installer and npm run normally; lifecycle scripts stay disabled and no package is published.
Servers and temporary files are cleaned
up after success or failure. This does not expand the published Astro peer range.

A change that costs bytes to save build time needs explicit approval and measured tradeoffs.
The default effort keeps each raster's smallest encode that passes the accuracy bar and finishes
it with Zopfli at 15 iterations; `--effort fast` skips both, `--effort max` tries every candidate
and runs 120 iterations.

CI compares generated files with `test/bytes.json` and compares the same manifest across
Linux, macOS and Windows. It records filenames, sizes, SHA-256 hashes and installed
image/SVGO versions plus the bundled Zopfli build identity. The default profile covers the
eleven positive SVG fixtures with a manifest at the default effort; two fixtures also cover
`effort: 'max'`. This is sampled coverage, not a guarantee for every input or option.

```sh
node test/hashes.mjs --check    # fail on changed files, sizes, encoders or profiles
# After reviewing measured size/accuracy changes and choosing a minor/major release:
node test/hashes.mjs --write    # explicitly regenerate the reviewed baseline
git diff -- test/bytes.json
node test/hashes.mjs --check
```

Accepting a baseline does not bypass the patch-release guard. `pnpm test` exercises the
comparison and release policy; the platform CI jobs run the actual generation check.

## Measure before you believe it

`docs/DECISIONS.md` decision 13 exists because an obvious-looking parallelism win measured
12.8 s → 8.1 s in a quick hand test and **13.80 s → 14.08 s** under a controlled interleaved
benchmark. Interleave repetitions, check for background load, and prefer tracing over totals.

Two more traps this repo has already fallen into, both caught only by measuring:

- resvg does **not** stretch a non-square mark to fill `-w N -h N`. It preserves the aspect
  ratio and derives the second dimension, so the "obvious" reading of the flags produced
  32×16 rasters and an ICO whose header disagreed with its own payload.
- `--colors 8` was documented as inside the accuracy bar on every mark and size. On the
  fixtures this repo ships it is not; see `docs/BENCHMARKS.md`.

## Setting up

```sh
pnpm install                   # the whole setup: the root and site/, one workspace, one lockfile
```

Two optional tools turn on more checks. `resvg` on PATH runs the render-fidelity test, which
holds the engine to the resvg CLI pixel for pixel. `icotool` (from `icoutils`) runs the test
asserting favseed's 22-byte ICO writer is byte-identical to `icotool -c -r`. `bench/` needs
nothing beyond `pnpm install` to run its ordinary sweeps, but the precision, framing, ico-size
and placement sweeps read pinned commits with `git show` and need a checkout with full history,
and rebuilding `lib/zopfli.wasm` or the browser-compatibility WASM needs clang and rustc
respectively (see `bench/zopfli/README.md` and `bench/wasm-engine/build.mjs`).

## Definition of done

The root suite, packed-package Astro suite and site browser checks cover these contracts.

1. Produces `icon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`,
   `icon-512.png`, and nothing else.
2. Dimensions are exact: 180×180, 192×192, 512×512; the ICO reports a single 48×48 entry.
3. `icon.svg` preserves animation, styling and accessibility by default, including referenced
   classes/IDs, reduced-motion rules, `xmlns` and `viewBox`. Explicit `--no-animation` strips
   motion and accessibility while retaining color-scheme styling when present.
4. `--var name=value` overrides the fallback, and the old value is gone from the output.
5. An unresolvable `var()` with no fallback fails with an error and a non-zero exit, and writes
   nothing.
6. A referenced id survives; unreferenced ids are dropped.
7. `favicon.ico` starts `00 00 01 00`, its payload is a PNG (`89 50 4E 47`), and the container is
   byte-identical to `icotool -c -r` wherever icotool is available.
8. At the default effort every raster passes the accuracy bar, `pct <= 1.0 %` and edge error
   `<= 1.5883`, scored against **background-matched references, padded the same way**, unless no
   candidate does; such a raster keeps the effort-fast encode. Effort-fast padded PNGs in the
   accuracy fixtures meet `pct <= 1.0 %`. ICO source error is reported separately: the 48px ICO
   reaches 1.215% on two small-grid fixtures, where no candidate passes. See the
   [ICO report](bench/ico-size/README.md). The SVG's static 512px budget does not guarantee
   this threshold at every raster size or quality.
9. `apple-touch-icon.png` has no alpha channel when `--bg` is set (the default).
10. `--manifest` writes valid JSON: the size icons as `"any maskable"` when `--bg` is opaque
    and `"any"` alone when it is `none`, and never `icon.svg`; `--html` emits the `<link>` set with
    `sizes="48x48"` on the ICO.
    Every opaque pixel of every padded icon lies inside the safe circle; a pixel-grid mark is
    snapped to whole pixels, a curved one keeps its exact fit.
11. Re-running with identical inputs and identical engine versions produces byte-identical outputs.
12. Handled staging/publishing failures restore previous file contents and symlinks, remove
    newly published files and clean staging without touching unrelated assets. If restoration
    or cleanup is also refused, report the original failure and leftover/recovery path; keep
    failed-restoration backups past process exit. Use one writer per output directory. This
    is rollback for handled exceptions, not whole-set atomic visibility or crash durability.
    Backup copies preserve contents, not timestamps, extended attributes or hardlink identity.
13. `--colors` outside 2–256, a missing input, a non-SVG input and an unknown flag all fail with a
    clear `favseed: …` message and **no stack trace**.
14. The single `icon.svg` retains motion and resolves its custom properties. Rasters use the
    base appearance; explicit `--no-animation` yields the same raster bytes on the fixtures.
    An unresolved motion variable fails the preserved SVG, naming `--no-animation`.
    Without `--quality` or `--colors`, each raster is chosen by `--effort` (default `default`):
    the smallest encode that passes item 8's bar, or the effort-fast encode when none passes;
    `--effort fast` is that encode alone, unscored. A given quality
    and/or palette pins that exact setting: quality alone at 256 colours, colours alone at
    quality 100, one encode with no search, and a warning (never a failure) when it misses
    the bar. SVG accuracy selection remains active. Reject quality outside integer 1–100,
    colours outside 2–256, explicit colours combined with quality below 100, an effort
    other than `fast`, `default` or `max`, and the removed `zopfli` and `mode` options.

15. Long options accept `--opt=value`; a flag that takes no argument rejects one.
16. `--sizes 48` renders twice when padded: once for `icon-48.png`, once unpadded for
    the ICO payload. Under `--bg none` they share one render and identical PNG bytes.
    An explicit `--sizes 32` still writes a separate 32px PNG.
17. Non-square raster sources retain their rectangular viewport inside a centered square
    canvas, including percentage lengths and shifted origins. `icon.svg` keeps its original
    viewport. ViewBoxes differing by more than 1% warn on stderr; near-square ones remain quiet.
18. `npm pack` contains only `bin/`, `lib/`, `astro/`, `vite/`, `README.md`, `LICENSE`,
    `CHANGELOG.md`, and `lib/core.mjs` by name, since the package cannot run without it.
19. A `favseed.config.js`, `.mjs` or `.ts` in the working directory supplies any option; flags win,
    and `--var` merges by name. An unknown key, a default export that is not an object, or a
    config that fails to load is a `favseed: …` message with no stack trace; a `.ts` Node cannot
    load names `favseed.config.mjs`.
20. `base` prefixes every `href` from `--html` and every icon `src` in the manifest.
21. `favseed/vite` (and `favseed/astro`, which uses it) emits the same bytes as the CLI, once,
    at the output root of a client build and nowhere in an SSR build; links them in `index.html`
    unless the page already has a `<link rel="icon">`; serves them in dev at `base`; and never
    replaces a different file in `public/`.
22. Full builds select the first precision in 1/2/3/4/6/8 whose static 512px render meets a
    1% source-error budget on both black and white composites. Whole-mark disappearance fails.
    If no candidate passes, preserve source geometry. This does not grade every animation frame,
    media state or display size. Keep browser/CLI bytes identical and invalidate integration caches.

---

## Fixtures

`test/fixtures/` contains neutral SVGs authored for this repo. No brand content, ever.
Each one exists to exercise something specific; `test/run.mjs` names it. If you add a
fixture, say in a comment what it is for; if it is generated, commit the generator and its
output together (`heavy.gen.mjs` is the pattern).

Fixtures are calibrated, not arbitrary. `heavy.svg` has to introduce real `floatPrecision`
error and still land inside the bar: it fails at `floatPrecision: 0` and passes at `1`,
which is the property that makes it a gate rather than decoration.

`tiles.svg` is the other calibrated one, and it exists because of a regression: it has the
shape almost every animated mark has (palette classes named once at the top level, a motion
class named only inside the reduced-motion guard), and it must come out with the palette
inlined to `fill=` attributes and `class="blink"` still on the element. `animated.svg`
is the opposite case, where the same class is named both inside and outside the guard and
inlining has to be switched off. Both directions are asserted; neither alone is enough.

`heavy.svg` is also the tightest non-gradient fixture in the suite, by design: at the default
palette it sits at 0.114 % on the 192 px icon, and at `--colors 8` at 0.70 % on the 180 px
apple icon, against a 1.0 % bar. If it is the *only* thing that fails after an engine bump,
that is the fixture doing its job. Run
`node bench/bench.mjs accuracy` and compare against `docs/BENCHMARKS.md` before concluding
favseed regressed.

## House style

- `bin/favseed.mjs` holds the Node APIs and CLI: input/config loading, native engine setup
  and staged publishing. Shared rendering and validation live in `lib/`; those modules may
  import each other, but receive platform-specific engines from their host. The integrations
  use these APIs, and share disk cache code in `vite/cache.mjs`. Keep the CLI implementation and
  shared engine independent of the Astro integration.
- The Astro integration is the Vite plugin plus head injection.
- No new CLI flags without a stated user need. The surface is kept small on purpose.
- Comments explain **why**, and cite the measurement. The code is dense in places because the
  obvious version is wrong, and a reader must be able to find out why without a git
  archaeology trip.
- Errors are `favseed: <message>` on stderr with a non-zero exit, never a raw stack trace.

## Releasing

Set the version in `package.json`, push a `v*` tag, and `release.yml` tests, packs and stages
the tarball on npm; the maintainer approves it there with 2FA. [RELEASING.md](RELEASING.md) has
the whole sequence, including the one-time setup and the hand-published first version.

Byte-output changes (a bumped `@napi-rs/image` or SVGO, a rebuilt `lib/zopfli.wasm`, or any
pipeline change) are **minor at minimum, never patch**. Downstream users diff these files into
git, and a patch release that rewrites six binaries is a nasty surprise in a review.
