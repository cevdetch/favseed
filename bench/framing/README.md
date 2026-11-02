# Preserved raster proportions — 1 November 2026

These recorded measurements use the historical 32px ICO. Current builds use 48px;
see the [ICO report](../ico-size/README.md). The runnable sweep compares its immutable
baseline with the current whole pipeline, including later changes.

Non-square sources now retain their original rectangular SVG viewport inside a centered
square raster canvas. This preserves shape, shifted origins and percentage coordinates.
Rewriting the source viewBox to a square would change percentage geometry. The exported
`icon.svg` retains its original viewport; the wrapper is private to raster preparation.

The safe-zone fit and alignment search remain unchanged. Transparent outputs have transparent
bands, while opaque PNGs use the chosen background and fitted placement. The existing warning
now describes preserved proportions; viewBoxes within the existing 1% tolerance remain quiet.
Square inputs use the same raster source as before. Version 0.4.0 invalidates integration caches.

## Accuracy and bytes

[Raw results and hashes](results.json) compare merged PR27 (`deaba2b`) with the new framing,
using the same installed engine, default quality 80 and no Zopfli. Non-square references are
literal square goldens derived by hand. Padded references apply the existing placement to
those goldens. Error counts pixels differing by more than 8/255 on black and white composites.
These references expose stretching that the old stretch-matched accuracy reference hid.

| Existing wide fixture | PR27 | Preserved proportions |
|---|---:|---:|
| Worst PNG source error | 8.312% | 0% |
| 32px ICO source error | 15.234% | 0% |
| PNG + ICO bytes | 2,333 | 1,754 |
| SVG bytes | 128 | 128 |

The wide set uses **579 fewer raster bytes (24.8%)**. New wide/tall/offset controls and both
near-square directions also have 0% final PNG/ICO error against their literal source goldens.
The rectangular percentage fixture previously fails during automatic placement; it now builds
with 0% error and 521 raster bytes. Its failed baseline is excluded from paired totals.

All six artifacts for each of the ten square original-corpus fixtures remain byte-identical
to PR27, including tiles/general/heavy/gradient, the matched Vite PWA comparison inputs.
Consequently the existing four-logo Vite result remains unchanged: Favseed's default is
0.8% larger with lower measured PNG error. This fix establishes no universal size winner.
Every comparable emitted SVG is also byte-identical across the two arms.

## Full-build cost

Three repetitions alternate arm order per fixture; repetition 0 is warmup. Times are the
median of the two measured whole-corpus totals. They include optimization, runtime reference
validation, placement and encoding; imports, input reads, independent grading references,
post-build scoring and disk writes are excluded.

| Corpus | PR27 seconds | Preserved seconds | PR27 raster bytes | Preserved raster bytes |
|---|---:|---:|---:|---:|
| Original 11 | 2.671 | 2.680 | 70,254 | 69,675 |
| Paired 16, including geometric controls | 3.827 | 4.049 | 86,935 | 85,039 |

The original corpus uses **0.8% fewer raster bytes** with a measured time change of +0.3%.
The expanded paired corpus uses 2.2% fewer bytes and takes 5.8% longer here. Corrected geometry
can change fitted sizes and the number of alignment probes. These short native measurements
do not establish a speed improvement or describe browser runtime or total process memory.

## Verification and limits

Native regressions compare actual renders and exported PNG/ICO files with literal goldens.
They cover near-square dimensions, tiny coordinate units, nested viewports, inherited styles,
namespace references, XML prologs/self-closing roots, fixed padding and transparent exports.
Default PNG source accuracy remains gated at 1%; ICO accuracy is separately reported.
The unchanged heavy ICO still reaches 1.660% source error. The renderer's existing tiny-arc
approximation is preserved, not repaired by this framing change.

This change retains the separate static 512px SVG precision budget. It does not establish
accuracy at every animation frame, media state, output size or custom PNG quality. The
16MiB pixel cache remains a cache bound, not a process/native memory ceiling.

## Reproduce

With dependencies installed and PR27 available in git history:

```sh
node bench/bench.mjs framing
```

The sweep needs no external resvg/pngquant/oxipng binaries. It reads the immutable baseline
modules through git, leaves HEAD unchanged, and stores scratch outputs under ignored
`bench/out/framing/`. It checks repeated file hashes, default PNG accuracy and square-set byte
identity. Run it sequentially on an idle CPU. Browser parity and lifecycle checks run separately.
