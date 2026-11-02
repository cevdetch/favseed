# PNG quality: smaller optional raster output

These are historical measurements before selective SVG precision. Quality 80 remains the
default, but the corrected gradient changes current byte totals and source-error results;
see the [current precision report](../precision/README.md). The byte-equality statements
below describe the recorded pre-quality control, not an opt-out from later SVG corrections.

Measured 31 October 2026 on Ryzen 7 7840U, Linux x64, Node 26.12.1, image 1.15.0. Native/browser use the
same quality path. Public `--quality N` and `quality: N` accept integers 1–100; the browser has the
same control. Default 80 is selected from these measurements. Explicit quality 100 reproduces all pre-quality
outputs and metadata exactly across 11 fixtures. Custom colors without quality retain that fixed-palette path.

Below 100 the native quantizer derives a palette from its maxQuality target. Keep speed 1, minQuality 0
and the existing lossless candidate/tie rule. No extra candidate search or minimum-quality gate.
Custom `colors` cannot combine with quality below 100 because it overrides the native target. At 100,
custom colors still work. The browser disables that field below 100 and restores its value at 100.
Zopfli stays independently opt-in, with release 120/fast 15 iterations. SVG and placement are unchanged.

## Whole-pipeline measurement

Eleven fixtures × four raster files: 44 images including ICO payloads. PNG+ICO bytes include 11
22-byte ICO headers. Three interleaved rotated/reversed repetitions, first excluded; times are the
median of the two remaining whole-corpus totals. Source read, SVG optimization, placement, encoding
and artifact creation are timed; imports, baseline preparation, writes and validation are excluded.
Zopfli is disabled throughout. Source fingerprints and repeat rows are retained.

| Quality | PNG + ICO bytes | Reduction vs 100 | Generation seconds | Worst PNG error vs unquantized placed input |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 74,180 | — | 2.678 | 0.008% |
| 80 | 69,291 | 6.6% | 2.638 | 0.066% |
| 60 | 64,594 | 12.9% | 2.621 | 0.222% |

Quality 80 and 60 retain exactly 40/44 baseline decoded images; the four gradient images change.
ICO error remains 0% for these settings on this corpus. All quality 100 files (SVG, PNG, ICO,
manifest) and metadata match the saved pre-quality modules, not just decoded pixels. The quality
settings offer similar timing here; this is a size/fidelity option, not a claimed major speedup.

Error is the fraction of pixels with channel difference over 8/255, measured on black/white
composites; table maxima exclude ICOs, which are reported separately. The separate original-SVG
source grading gives worst non-gradient error 0.114% at all three settings. Gradient source error
is the existing exception: 1.742% at 100, 2.097% at 80 and 2.608% at 60. Quality is an encoder-specific
target, not an error percentage or a guarantee for other inputs. These settings did not change
flat-logo pixels in the tested corpus; results may differ on other logos.

## Same four-logo raster preset as Vite PWA

Use the exact 16-file/sizes/backgrounds/framing/input-pixel control documented in
[MATCHED-PRESET.md](MATCHED-PRESET.md), including the real ICO routes. Vite PWA 2.0.0/Sharp 0.35.5
measurements are the retained matching-input control; Favseed figures come from the new public
quality path and reproduce the screening bytes. This is encoding on equal rendered pixels,
not independent SVG rendering or complete presets with different file counts.

| Encoder | PNG + ICO bytes | Worst PNG error vs shared input |
| --- | ---: | ---: |
| Vite default, quality 60 | 36,624 | 5.024% |
| Vite higher-fidelity comparator, quality 100 | 52,240 | 0.055% |
| Favseed quality 100 | 40,449 | 0.008% |
| Favseed quality 80 | 35,560 | 0.066% |
| Favseed quality 60 | 30,863 | 0.222% |

On these four fixtures, Favseed 80 is 2.9% smaller than Vite default, with lower measured error;
Favseed 60 is 15.7% smaller. Quality numbers are not comparable across the two engines. These
limited fixtures do not imply a universal winner; gradient dominates the savings here.

## Limits and validation

Lower quality is not monotonic in output size. The exploratory native 99/95 settings produced
75,838/74,610 PNG-payload bytes versus 73,938 at 100, while 80/60 produced 69,049/64,352. Production
keeps only the existing lossless candidate guard; it does not add a second quality 100 encode to
force monotonic file size. Very low settings can visibly damage gradients and tiny ICOs; the
screen records their errors. Quality 80 is now the default; choose 100 for the previous higher-fidelity bytes.

Native suite: 225 tests, 223 pass, two optional TypeScript skips. Site unit 10/10; production build
passes. Desktop/mobile Chromium 16/16: 106 desktop files across 18 cases, 28 mobile files across 5 cases,
including quality 80 and quality 60+Zopfli parity, archives, cache, invalid options, cancellation,
retry, 1024px memory growth, form palette toggling and downloads. A fresh rebuild followed by four
validation/form tests verifies strict type rejection and invalid 0→80 correction. Firefox/WebKit
remain pending supported CI. Cached full Chromium 1234 was used through a temporary test config.

The existing `bench/bench.mjs colors` sweep also reproduces the quality-100/fixed-palette 38,731 PNG bytes and
0.114% worst non-gradient source error.

Fresh review found no encoding-path bugs. Strict quality input coercion was reproduced RED,
fixed to numbers/decimal strings and verified by the full native suite. No production dependency,
renderer, SVG optimizer, Zopfli effort or unrelated pending work was changed by this feature.
No commits, pushes, deployment or docs/ edits. The timing/source fingerprints above were captured
before the default switched from 100 to 80; the explicit quality settings remain reproducible.

## Reproduce

Save the pre-quality core/config/pipeline/engine modules, then run on an otherwise idle CPU:

```sh
node bench/png-quality.mjs /saved/before /fresh/results
pnpm test
pnpm --filter favseed-site test
pnpm --filter favseed-site build
pnpm --filter favseed-site test:browser
```

The local before snapshot/raw results remain ignored at `.superpowers/sdd/2026-10-31-png-quality/`.
Recreating that uncommitted baseline on a fresh clone requires the saved modules. Compact evidence:
[pipeline timings](quality-pipeline.csv), [output hashes](quality-files.csv),
[full quality/source-accuracy screen](quality-screen.csv), [environment and source hashes](quality-environment.json).

## Default-80 verification

After selecting quality 80 as the default, all 66 files across 11 fixtures match the saved explicit-quality 80
outputs byte-for-byte: 69,291 PNG/ICO bytes, including 35,560 bytes for the four-logo competitor control.
Normal builds and cache identity resolve to 80; supplying custom colors alone retains the quality 100
fixed-palette path. Explicit lower quality plus colors remains an error. Current native 225 tests
(223 pass, two optional skips), site 10 tests/build and 16 desktop/mobile Chromium checks pass. Firefox/WebKit
still require supported CI validation. Raw proof remains ignored under
`.superpowers/sdd/2026-10-31-default-quality 80/`.
