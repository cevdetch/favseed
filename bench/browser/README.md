# Browser speed

Two builds of the site, measured side by side on 2026-11-13 with Chromium 156.0.8078.4, Node v26.13.1, on AMD Ryzen 7 7840U with Radeon 780M Graphics (16 logical CPUs): **before** is the site at `62f4d15`, **after** the site at `57c52b4`.
3 repetitions per fixture/effort cell and build, interleaved cell by cell with the builds taking turns to go first; the figure is the median in milliseconds, the range in parentheses is min–max, and the last two columns are the change in the median.

Each cell times one build in a fresh browser context, from choosing the file to:

- **choose→ready** — the engine worker reporting it has loaded its WASM and is ready to build.
- **choose→first set** — the first set on the page: the quick set (`favseed:quick-set`) at an effort that searches, the only set at effort fast.
- **choose→final set** — the final set on the page (`favseed:final-set`), with every download ready.

The before site shows one set, so its first and final set are the same instant, as they are for both sites at effort fast.

## What changed

The site now shows a quick set as soon as one exists: every raster encoded once at the fast setting, scored and offered for download, while the search for the smallest passing encode goes on. The search itself walks its quality and colour ladders at the same time instead of one after the other. The threaded engine runs the two walks side by side on its worker threads, which more than pays for building the quick set first; the single-threaded fallback has nothing to run them on but its one thread, so there the final set lands about where it did, now with the quick set shown long before it. Either way the files the search settles on are byte for byte the ones it chose before. The engine also starts loading when the pointer or focus reaches the drop zone, and fetches Zopfli alongside itself rather than after it. These runs choose the file without either, so choose→ready is the whole load in both builds and shows none of that head start; a visitor who hovers first waits less than this.

`threaded` is the default shared-memory engine; `compat` is the single-threaded fallback (`?no-isolation`, taken when the document cannot share WASM memory with its worker).

Both networks go through a small server in `bench/browser.mjs` serving each build with the production headers. Unthrottled, it serves the files as they are at loopback speed, like `site/test/serve.mjs`. Throttled, it serves them brotli-compressed behind one shared 9 Mbps token-bucket downlink with 60 ms added per request: Chromium’s page-level network emulation does not reach fetches made from inside a worker, so the engine worker’s own WASM fetch would otherwise go out at full speed regardless of the setting.

## Results

### Unthrottled, threaded

| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |
|---|---|---|---:|---:|---:|---:|---:|
| general | fast | before | 147 (142–151) | 638 (633–670) | 638 (633–670) | | |
| | | after | 145 (142–145) | 637 (635–643) | 637 (635–643) | ±0 % | ±0 % |
| general | default | before | 145 (142–146) | 3,078 (3,049–3,171) | 3,078 (3,049–3,171) | | |
| | | after | 153 (150–158) | 649 (639–649) | 2,612 (2,559–2,635) | −79 % | −15 % |
| general | max | before | 147 (145–151) | 11,441 (11,302–11,453) | 11,442 (11,302–11,453) | | |
| | | after | 146 (144–148) | 634 (624–635) | 9,724 (9,714–10,010) | −94 % | −15 % |
| gradient | fast | before | 152 (148–162) | 1,049 (1,040–1,050) | 1,049 (1,040–1,050) | | |
| | | after | 144 (141–147) | 1,040 (1,034–1,050) | 1,040 (1,034–1,050) | −1 % | −1 % |
| gradient | default | before | 151 (144–175) | 7,067 (7,031–7,321) | 7,067 (7,031–7,321) | | |
| | | after | 150 (149–150) | 1,039 (1,035–1,043) | 6,154 (6,112–6,156) | −85 % | −13 % |
| gradient | max | before | 157 (149–260) | 25,802 (25,389–29,777) | 25,802 (25,389–29,777) | | |
| | | after | 147 (147–150) | 1,039 (1,037–1,049) | 23,165 (23,058–29,430) | −96 % | −10 % |

### Unthrottled, compat

| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |
|---|---|---|---:|---:|---:|---:|---:|
| general | fast | before | 127 (123–128) | 772 (751–792) | 773 (751–792) | | |
| | | after | 127 (121–131) | 762 (761–781) | 762 (761–781) | −1 % | −1 % |
| general | default | before | 124 (123–140) | 3,900 (3,861–3,997) | 3,900 (3,861–3,997) | | |
| | | after | 127 (124–151) | 762 (755–804) | 3,952 (3,905–3,964) | −80 % | +1 % |
| general | max | before | 127 (124–127) | 14,257 (14,195–14,405) | 14,257 (14,195–14,405) | | |
| | | after | 125 (122–134) | 758 (753–772) | 14,235 (14,165–14,294) | −95 % | ±0 % |
| gradient | fast | before | 121 (120–125) | 1,594 (1,590–1,615) | 1,594 (1,590–1,615) | | |
| | | after | 122 (120–127) | 1,597 (1,587–1,614) | 1,597 (1,587–1,614) | ±0 % | ±0 % |
| gradient | default | before | 122 (121–127) | 10,113 (9,992–10,137) | 10,113 (9,992–10,138) | | |
| | | after | 124 (123–129) | 1,603 (1,587–1,621) | 10,115 (10,036–10,122) | −84 % | ±0 % |
| gradient | max | before | 124 (124–170) | 36,804 (36,271–37,122) | 36,804 (36,271–37,122) | | |
| | | after | 124 (123–165) | 1,603 (1,585–2,995) | 36,562 (36,229–48,743) | −96 % | −1 % |

### Throttled (9 Mbps, 60 ms added latency), threaded

| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |
|---|---|---|---:|---:|---:|---:|---:|
| general | fast | before | 2,997 (2,979–3,080) | 3,886 (3,479–4,046) | 3,886 (3,479–4,046) | | |
| | | after | 3,090 (3,059–3,195) | 4,015 (3,933–4,110) | 4,015 (3,933–4,110) | +3 % | +3 % |
| general | default | before | 3,054 (3,034–3,065) | 9,140 (8,631–9,338) | 9,140 (8,631–9,338) | | |
| | | after | 3,074 (2,996–3,116) | 3,946 (3,941–4,014) | 8,159 (7,825–8,294) | −57 % | −11 % |
| general | max | before | 3,050 (3,032–3,116) | 18,057 (18,031–18,877) | 18,057 (18,031–18,877) | | |
| | | after | 3,031 (2,998–3,038) | 3,977 (3,835–4,000) | 16,714 (16,101–17,000) | −78 % | −7 % |
| gradient | fast | before | 3,114 (3,059–3,141) | 4,919 (4,826–4,932) | 4,919 (4,826–4,932) | | |
| | | after | 3,064 (3,026–3,067) | 4,805 (4,731–4,898) | 4,805 (4,731–4,898) | −2 % | −2 % |
| gradient | default | before | 3,089 (2,981–3,125) | 13,048 (11,445–14,819) | 13,048 (11,445–14,819) | | |
| | | after | 3,040 (3,012–3,095) | 4,858 (4,819–4,954) | 13,265 (12,893–13,386) | −63 % | +2 % |
| gradient | max | before | 2,959 (2,956–3,080) | 29,808 (29,221–32,453) | 29,808 (29,221–32,453) | | |
| | | after | 3,014 (2,975–3,032) | 4,711 (3,880–4,859) | 29,694 (27,054–29,906) | −84 % | ±0 % |

### Throttled (9 Mbps, 60 ms added latency), compat

| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |
|---|---|---|---:|---:|---:|---:|---:|
| general | fast | before | 2,877 (2,844–2,911) | 3,943 (3,514–4,211) | 3,943 (3,514–4,211) | | |
| | | after | 2,897 (2,846–2,971) | 3,743 (3,502–4,230) | 3,743 (3,502–4,230) | −5 % | −5 % |
| general | default | before | 2,857 (2,845–2,945) | 7,831 (6,766–11,194) | 7,831 (6,766–11,194) | | |
| | | after | 2,890 (2,857–2,996) | 3,716 (3,517–4,302) | 7,420 (6,717–11,289) | −53 % | −5 % |
| general | max | before | 2,979 (2,859–3,033) | 21,958 (17,680–22,043) | 21,958 (17,681–22,043) | | |
| | | after | 2,889 (2,858–2,965) | 4,061 (3,508–4,231) | 20,194 (17,175–21,412) | −82 % | −8 % |
| gradient | fast | before | 2,981 (2,979–3,033) | 6,109 (6,107–6,246) | 6,109 (6,107–6,246) | | |
| | | after | 2,915 (2,911–2,973) | 6,092 (6,061–6,179) | 6,092 (6,061–6,179) | ±0 % | ±0 % |
| gradient | default | before | 2,937 (2,934–2,975) | 17,541 (17,196–17,554) | 17,541 (17,196–17,554) | | |
| | | after | 2,980 (2,898–2,985) | 6,131 (6,112–6,155) | 17,192 (16,027–17,297) | −65 % | −2 % |
| gradient | max | before | 2,887 (2,861–2,964) | 42,802 (42,041–43,594) | 42,802 (42,041–43,594) | | |
| | | after | 2,930 (2,889–2,966) | 6,054 (5,294–6,130) | 43,476 (40,587–43,495) | −86 % | +2 % |

## Reproducing

```sh
pnpm --filter favseed-site build
git worktree add /tmp/fs-before 62f4d15
(cd /tmp/fs-before && pnpm install --frozen-lockfile && pnpm --filter favseed-site build)
node bench/browser.mjs --write --before /tmp/fs-before/site/dist
git worktree remove /tmp/fs-before
```

For one combination without rewriting this file: `node bench/browser.mjs [--throttle] [--compat] [--reps N] [--before DIR]`; `--help` lists the rest.
