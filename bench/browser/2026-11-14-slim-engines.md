# Browser speed: the slim 1.16.0 engines

Two builds of the same site, measured side by side on 2026-11-14 with Chromium 158.0.8127.18,
Node v26.13.1, on AMD Ryzen 7 7840U with Radeon 780M Graphics (16 logical CPUs), load average
2.3 at the start of the sweep and 3.9 by the time it started (two unrelated builds were running
on the machine throughout; nothing in this repository competed for the CPU): **before** is the
site at `0089ea0`, with the published `@napi-rs/image` 1.15.0 threaded engine and the 1.15.0
compatibility engine vendored by decision 26; **after** is the same site with the slim 1.16.0
engines recorded in `site/vendor/image/build.json` (`image.wasm32-wasi.wasm` 860d0610…4189,
`image.wasm32-wasip1.wasm` e62b0ed8…f2cc).
3 repetitions per fixture/effort cell and build, interleaved cell by cell with the builds taking
turns to go first; the figure is the median in milliseconds, the range in parentheses is
min–max, and the last two columns are the change in the median.

Each cell times one build in a fresh browser context, from choosing the file to:

- **choose→ready**: the engine worker reporting it has loaded its WASM and is ready to build.
- **choose→first set**: the first set on the page: the quick set (`favseed:quick-set`) at an effort that searches, the only set at effort fast.
- **choose→final set**: the final set on the page (`favseed:final-set`), with every download ready.

Both sites already show the quick set ahead of the final one (decision 30), so first and final
set differ at every effort but fast on both sides; only the image engines differ between them.

## What changed

Only the image engines changed between before and after; the site code is identical at both
points. Before, the threaded engine is the published `@napi-rs/image` 1.15.0 npm package and the
compatibility engine is the 1.15.0 build vendored by decision 26. After, both are the slim 1.16.0
engines: `bench/wasm-engine/build.mjs` applies `slim.patch` to the image 1.16.0 source and leaves
out AVIF, WebP encoding, lossless JPEG (mozjpeg) and the JPEG XL decoder, none of which favseed
calls. Every raster the search settles on is still byte for byte the one it chose before
(`bench/wasm-engine/parity.mjs`: 5,760 of 5,760 cases identical to native on each engine); what
moves here is only how long the smaller download takes to arrive, which matters most on the
throttled link, where the engine is the page's largest fetch.

`threaded` is the default shared-memory engine; `compat` is the single-threaded fallback (`?no-isolation`, taken when the document cannot share WASM memory with its worker).

Both networks go through a small server in `bench/browser.mjs` serving each build with the production headers. Unthrottled, it serves the files as they are at loopback speed, like `site/test/serve.mjs`. Throttled, it serves them brotli-compressed behind one shared 9 Mbps token-bucket downlink with 60 ms added per request: Chromium’s page-level network emulation does not reach fetches made from inside a worker, so the engine worker’s own WASM fetch would otherwise go out at full speed regardless of the setting.

## Results

### Unthrottled, threaded

| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |
|---|---|---|---:|---:|---:|---:|---:|
| general | fast | before | 161 (141–413) | 711 (632–971) | 711 (632–971) | | |
| | | after | 128 (124–162) | 618 (613–873) | 618 (613–873) | −13 % | −13 % |
| general | default | before | 147 (139–155) | 648 (624–954) | 2,790 (2,545–3,024) | | |
| | | after | 130 (125–168) | 653 (621–745) | 2,715 (2,634–2,892) | +1 % | −3 % |
| general | max | before | 150 (142–150) | 645 (638–691) | 10,170 (9,649–11,403) | | |
| | | after | 129 (127–192) | 625 (624–874) | 9,665 (9,599–17,051) | −3 % | −5 % |
| gradient | fast | before | 140 (140–250) | 1,039 (1,031–1,722) | 1,039 (1,031–1,722) | | |
| | | after | 128 (123–223) | 1,040 (1,039–1,727) | 1,040 (1,039–1,727) | ±0 % | ±0 % |
| gradient | default | before | 145 (142–288) | 1,045 (1,035–1,621) | 6,137 (6,099–9,416) | | |
| | | after | 126 (125–195) | 1,039 (1,039–1,570) | 6,082 (6,080–9,264) | −1 % | −1 % |
| gradient | max | before | 153 (147–160) | 1,084 (1,059–1,089) | 23,931 (22,750–25,243) | | |
| | | after | 134 (131–218) | 1,064 (1,036–1,697) | 24,105 (22,607–29,438) | −2 % | +1 % |

### Unthrottled, compat

| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |
|---|---|---|---:|---:|---:|---:|---:|
| general | fast | before | 131 (124–145) | 785 (774–812) | 785 (774–812) | | |
| | | after | 112 (111–113) | 761 (760–807) | 761 (760–807) | −3 % | −3 % |
| general | default | before | 124 (120–130) | 780 (768–797) | 3,959 (3,925–3,979) | | |
| | | after | 114 (107–129) | 764 (757–793) | 3,973 (3,929–3,992) | −2 % | ±0 % |
| general | max | before | 134 (123–201) | 787 (773–1,023) | 14,503 (14,314–14,750) | | |
| | | after | 111 (106–112) | 753 (744–773) | 14,402 (14,189–14,497) | −4 % | −1 % |
| gradient | fast | before | 126 (122–138) | 1,645 (1,589–2,020) | 1,645 (1,589–2,020) | | |
| | | after | 111 (103–114) | 1,610 (1,577–1,626) | 1,610 (1,577–1,626) | −2 % | −2 % |
| gradient | default | before | 120 (119–129) | 1,604 (1,583–1,638) | 10,104 (9,989–10,251) | | |
| | | after | 108 (107–118) | 1,611 (1,595–1,673) | 10,348 (10,069–10,488) | ±0 % | +2 % |
| gradient | max | before | 125 (124–130) | 1,613 (1,602–1,631) | 36,508 (36,389–36,649) | | |
| | | after | 110 (103–111) | 1,643 (1,576–1,658) | 37,337 (36,537–37,900) | +2 % | +2 % |

### Throttled (9 Mbps, 60 ms added latency), threaded

| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |
|---|---|---|---:|---:|---:|---:|---:|
| general | fast | before | 2,963 (2,956–3,096) | 3,468 (3,454–4,004) | 3,468 (3,454–4,004) | | |
| | | after | 2,053 (2,045–2,189) | 2,566 (2,547–3,126) | 2,566 (2,547–3,126) | −26 % | −26 % |
| general | default | before | 3,155 (2,975–3,311) | 4,052 (3,465–4,087) | 6,240 (5,508–8,285) | | |
| | | after | 2,062 (2,058–2,206) | 2,559 (2,557–3,177) | 4,932 (4,711–7,453) | −37 % | −21 % |
| general | max | before | 2,976 (2,967–3,161) | 3,487 (3,457–4,133) | 13,407 (12,792–17,034) | | |
| | | after | 2,063 (2,060–2,121) | 2,637 (2,568–3,049) | 12,663 (11,958–15,564) | −24 % | −6 % |
| gradient | fast | before | 2,963 (2,954–3,144) | 3,869 (3,854–5,005) | 3,869 (3,854–5,005) | | |
| | | after | 2,037 (2,036–2,120) | 2,956 (2,952–4,080) | 2,956 (2,952–4,080) | −24 % | −24 % |
| gradient | default | before | 2,979 (2,973–3,149) | 3,893 (3,889–4,985) | 9,621 (9,226–13,532) | | |
| | | after | 2,065 (2,050–2,112) | 2,990 (2,959–4,018) | 8,701 (8,159–11,642) | −23 % | −10 % |
| gradient | max | before | 2,979 (2,972–3,053) | 3,870 (3,869–4,829) | 26,301 (26,152–29,665) | | |
| | | after | 2,065 (2,057–2,129) | 2,971 (2,961–3,984) | 25,331 (25,156–28,162) | −23 % | −4 % |

### Throttled (9 Mbps, 60 ms added latency), compat

| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |
|---|---|---|---:|---:|---:|---:|---:|
| general | fast | before | 2,847 (2,841–2,873) | 3,484 (3,469–4,144) | 3,484 (3,469–4,144) | | |
| | | after | 1,913 (1,913–1,977) | 2,546 (2,545–3,234) | 2,546 (2,545–3,234) | −27 % | −27 % |
| general | default | before | 2,862 (2,857–2,893) | 3,490 (3,482–4,236) | 6,640 (6,620–10,531) | | |
| | | after | 1,927 (1,913–2,004) | 2,558 (2,552–3,319) | 5,723 (5,682–7,234) | −27 % | −14 % |
| general | max | before | 2,861 (2,853–2,900) | 3,538 (3,495–4,157) | 17,489 (16,999–21,070) | | |
| | | after | 1,922 (1,917–1,935) | 2,558 (2,545–3,095) | 16,012 (15,966–19,273) | −28 % | −8 % |
| gradient | fast | before | 2,850 (2,837–2,937) | 4,370 (4,302–6,238) | 4,370 (4,302–6,238) | | |
| | | after | 1,919 (1,905–1,956) | 3,484 (3,384–5,142) | 3,484 (3,384–5,142) | −20 % | −20 % |
| gradient | default | before | 2,859 (2,854–2,924) | 4,324 (4,321–5,931) | 12,779 (12,710–16,876) | | |
| | | after | 1,922 (1,921–1,969) | 3,462 (3,388–4,884) | 12,036 (11,810–15,645) | −20 % | −6 % |
| gradient | max | before | 2,851 (2,851–2,905) | 4,637 (4,316–6,081) | 39,678 (38,697–43,113) | | |
| | | after | 1,924 (1,920–1,963) | 3,394 (3,384–4,947) | 37,931 (37,823–42,391) | −27 % | −4 % |

## Reproducing

```sh
pnpm --filter favseed-site build
git worktree add /tmp/fs-before 0089ea0
(cd /tmp/fs-before && pnpm install --frozen-lockfile && pnpm --filter favseed-site build)
node bench/browser.mjs --write --before /tmp/fs-before/site/dist
git worktree remove /tmp/fs-before
```

For one combination without rewriting this file: `node bench/browser.mjs [--throttle] [--compat] [--reps N] [--before DIR]`; `--help` lists the rest.
