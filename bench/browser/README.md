# Browser speed

Measured 2026-11-13 with Chromium 156.0.8078.4, Node v26.13.1, on AMD Ryzen 7 7840U with Radeon 780M Graphics (16 logical CPUs).
3 repetitions per fixture/effort cell, interleaved; the figure is the median, the range in parentheses is min–max.

Each cell times one build in a fresh browser context, from choosing the file to:

- **choose→ready** — the engine worker reporting it has loaded its WASM and is ready to build.
- **choose→first set** — the result section becoming visible.
- **choose→final set** — the status line reporting the build complete, with every download ready.

The site currently produces only one result, so first and final set are the same instant; a later change that shows a quick set before the final one will make them differ.

`threaded` is the default shared-memory engine; `compat` is the single-threaded fallback (`?no-isolation`, taken when the document cannot share WASM memory with its worker).

Unthrottled runs go through `site/test/serve.mjs`. Throttled runs go through a small server in this file instead: Chromium’s page-level network emulation does not reach fetches made from inside a worker, so the engine worker’s own WASM fetch would otherwise go out at full speed regardless of the setting. That server serves the production build with the production headers, brotli-compressed, behind one shared 9 Mbps token-bucket downlink with 60 ms added per request.

## Results

### Unthrottled, threaded

| Fixture | Effort | choose→ready | choose→first set | choose→final set |
|---|---|---:|---:|---:|
| general | fast | 151 (140–189) | 688 (622–840) | 688 (622–840) |
| general | default | 144 (141–194) | 3,037 (3,025–3,750) | 3,037 (3,025–3,750) |
| general | max | 147 (143–233) | 11,368 (11,359–11,979) | 11,368 (11,359–11,979) |
| gradient | fast | 145 (142–153) | 1,030 (1,015–1,099) | 1,030 (1,015–1,099) |
| gradient | default | 144 (142–197) | 6,982 (6,931–7,035) | 6,982 (6,931–7,035) |
| gradient | max | 145 (145–145) | 25,067 (24,976–25,372) | 25,067 (24,976–25,372) |

### Unthrottled, compat

| Fixture | Effort | choose→ready | choose→first set | choose→final set |
|---|---|---:|---:|---:|
| general | fast | 127 (119–128) | 745 (740–770) | 745 (740–770) |
| general | default | 123 (122–129) | 3,877 (3,863–3,896) | 3,877 (3,863–3,896) |
| general | max | 122 (122–126) | 14,091 (14,087–14,281) | 14,091 (14,087–14,281) |
| gradient | fast | 124 (122–125) | 1,579 (1,578–1,588) | 1,579 (1,578–1,588) |
| gradient | default | 126 (124–126) | 10,010 (9,995–10,040) | 10,010 (9,995–10,040) |
| gradient | max | 130 (125–174) | 36,084 (36,069–39,560) | 36,084 (36,069–39,560) |

### Throttled (9 Mbps, 60 ms added latency), threaded

| Fixture | Effort | choose→ready | choose→first set | choose→final set |
|---|---|---:|---:|---:|
| general | fast | 3,025 (3,015–3,078) | 3,913 (3,869–4,077) | 3,913 (3,869–4,077) |
| general | default | 3,079 (2,955–3,132) | 9,430 (6,919–9,462) | 9,430 (6,919–9,462) |
| general | max | 3,079 (3,079–3,152) | 18,624 (18,564–19,102) | 18,624 (18,564–19,102) |
| gradient | fast | 3,042 (3,006–3,064) | 4,878 (4,836–4,881) | 4,878 (4,836–4,881) |
| gradient | default | 3,105 (3,024–3,106) | 14,658 (14,173–14,754) | 14,658 (14,173–14,754) |
| gradient | max | 3,059 (3,028–3,136) | 32,248 (32,165–32,819) | 32,248 (32,165–32,819) |

### Throttled (9 Mbps, 60 ms added latency), compat

| Fixture | Effort | choose→ready | choose→first set | choose→final set |
|---|---|---:|---:|---:|
| general | fast | 2,907 (2,882–2,981) | 4,178 (4,170–4,273) | 4,178 (4,170–4,273) |
| general | default | 2,942 (2,914–3,001) | 11,091 (11,034–11,404) | 11,091 (11,034–11,405) |
| general | max | 2,937 (2,926–2,976) | 21,949 (21,825–21,976) | 21,949 (21,825–21,976) |
| gradient | fast | 2,873 (2,862–2,897) | 6,044 (6,037–6,100) | 6,044 (6,037–6,100) |
| gradient | default | 2,922 (2,881–2,937) | 16,976 (15,457–17,463) | 16,976 (15,457–17,463) |
| gradient | max | 2,882 (2,830–2,923) | 43,299 (38,980–49,215) | 43,299 (38,980–49,215) |

## Reproducing

```sh
pnpm --filter favseed-site build
node bench/browser.mjs --write
```

For one combination without rewriting this file: `node bench/browser.mjs [--throttle] [--compat] [--reps N]`.
