#!/usr/bin/env node
// Measures the website end to end, in a real browser: from choosing a file to the engine
// worker reporting ready, to the first set shown (the quick set, at an effort that searches),
// to the final set shown. The page marks both with performance.mark('favseed:quick-set') and
// performance.mark('favseed:final-set'); where a mark is missing (effort 'fast' makes no quick
// set, and a page from before the marks makes neither) the DOM stands in, as markPage() says.
//
// --before DIR measures a second build of the site alongside the first, interleaved cell by
// cell, so a change to the site is judged against its predecessor in one sitting rather than
// against numbers from another day, when the machine was in another state.
//
// Chromium's page-level CDP network emulation does not reach fetches made from a worker (the
// engine worker fetches its own WASM), so --throttle serves the build through a small server in
// this file, with a shared token-bucket downlink and added latency. The unthrottled runs go
// through the same server with the throttle off, serving what site/test/serve.mjs serves (the
// production headers, the `?no-isolation` switch that --compat needs, no compression); it is
// in this file rather than reused so that two builds can be served side by side.
//
// The full --write matrix runs ~35-45 minutes for two builds; each individual measurement is
// checkpointed under bench/out/browser/ as it completes (one file per build, keyed to a hash of
// its dist, so a rebuilt site starts clean rather than reusing stale numbers), so a restart
// resumes rather than re-running everything.
//
// Build the site first: pnpm --filter favseed-site build. For --before, build the earlier
// commit in a worktree: see USAGE below and "Reproducing" in bench/browser/README.md.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { chromium } from '../site/node_modules/@playwright/test/index.mjs';
import { isolationHeaders, securityHeaders } from '../site/headers.mjs';
import { benchmarkPath } from './path.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SITE_DIST = resolve(ROOT, 'site/dist');
const FIXTURES = resolve(ROOT, 'test/fixtures');
const README = resolve(ROOT, 'bench/browser/README.md');
const CHECKPOINT_DIR = resolve(ROOT, 'bench/out/browser');

const FIXTURE_NAMES = ['general', 'gradient'];
const EFFORTS = ['fast', 'default', 'max'];
const NETWORKS = ['unthrottled', 'throttled'];
const MODES = ['threaded', 'compat'];
const DOWNLINK_BYTES_PER_SECOND = 9e6 / 8; // 9 Mbps, the brief's throttled downlink
const ADDED_LATENCY_MS = 60;
const RUN_TIMEOUT_MS = 180_000;

const USAGE = `Usage: node bench/browser.mjs [options]

Times the website in Chromium, from choosing a file to the engine ready, the first set
and the final set, for the general and gradient fixtures at every effort.

  --throttle      serve over a 9 Mbps downlink with 60 ms added latency
  --compat        the single-threaded engine (?no-isolation)
  --reps N        repetitions per cell, 1-10 (default 3)
  --dist DIR      the site build to measure (default site/dist)
  --before DIR    an earlier build to measure alongside it, interleaved per cell
  --write         the full matrix (both networks, both modes) for --dist against
                  --before; regenerates bench/browser/README.md. Requires --before.
  -h, --help      print this and exit

Every DIR must be inside the checkout or the system temporary directory.

  pnpm --filter favseed-site build
  git worktree add /tmp/fs-before <commit>
  (cd /tmp/fs-before && pnpm install --frozen-lockfile && pnpm --filter favseed-site build)
  node bench/browser.mjs --write --before /tmp/fs-before/site/dist
  git worktree remove /tmp/fs-before
`;

// -------------------------------------------------------------------------- argument parsing --
function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
    if (name === '-h' || name === '--help') {
      return { help: true };
    } else if (inline === undefined && (arg === '--throttle' || arg === '--compat' || arg === '--write')) {
      flags.add(arg.slice(2));
    } else if (name === '--reps' || name === '--dist' || name === '--before') {
      const value = inline ?? argv[++i];
      assert.ok(value !== undefined, `${name} needs a value`);
      values[name.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg} (see --help)`);
    }
  }
  const reps = values.reps === undefined ? 3 : Number(values.reps);
  assert.ok(Number.isInteger(reps) && reps >= 1 && reps <= 10, '--reps must be an integer from 1 to 10');
  assert.ok(
    !flags.has('write') || (!flags.has('throttle') && !flags.has('compat')),
    '--write measures the full matrix (both networks, both modes) on its own; pass it without --throttle or --compat',
  );
  assert.ok(!flags.has('write') || values.before, '--write compares two builds; pass --before DIR');
  const dist = values.dist === undefined ? SITE_DIST : benchmarkPath(values.dist);
  const builds = [
    ...(values.before === undefined ? [] : [{ label: 'before', dist: benchmarkPath(values.before) }]),
    { label: values.before === undefined ? 'this build' : 'after', dist },
  ];
  for (const { dist: dir } of builds) {
    assert.ok(
      existsSync(resolve(dir, 'index.html')),
      `${dir} is not a site build; run: pnpm --filter favseed-site build`,
    );
  }
  assert.ok(builds.length === 1 || builds[0].dist !== builds[1].dist, '--before and --dist name the same build');
  const combos = flags.has('write')
    ? NETWORKS.flatMap((network) => MODES.map((mode) => ({ network, mode })))
    : [
        {
          network: flags.has('throttle') ? 'throttled' : 'unthrottled',
          mode: flags.has('compat') ? 'compat' : 'threaded',
        },
      ];
  return { combos, reps, builds, write: flags.has('write') };
}

// ------------------------------------------------------------------------------- the server --
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.wasm', '.svg', '.webmanifest', '.txt', '.xml']);

// A production-header server for one site build. Throttled, it serves brotli-encoded assets
// (cached in memory per content hash, since this process is short-lived) behind a shared
// token-bucket downlink with added latency, standing in for a real network. Unthrottled, it
// serves the files as they are, at loopback speed, as site/test/serve.mjs does.
function startServer(dist, { throttle }) {
  const brotliCache = new Map();
  const brotli = (bytes) => {
    const key = createHash('sha256').update(bytes).digest('hex');
    let cached = brotliCache.get(key);
    if (!cached) {
      cached = brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
      });
      brotliCache.set(key, cached);
    }
    return cached;
  };
  // Brotli quality 11 on a multi-megabyte WASM file is slow enough to otherwise show up as a
  // one-off, cell-contaminating outlier on whichever sample happens to request it first; doing
  // it up front, before any request is timed, keeps every measured request a cache hit.
  if (throttle) {
    for (const relative of readdirSync(dist, { recursive: true })) {
      const file = resolve(dist, relative);
      if (statSync(file).isFile() && COMPRESSIBLE.has(extname(file))) brotli(readFileSync(file));
    }
  }
  // One shared downlink across every request/connection on this server, like one real link.
  let linkFreeAt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = async (res, headers, bytes) => {
    if (!throttle) {
      res.writeHead(200, headers).end(bytes);
      return;
    }
    await sleep(ADDED_LATENCY_MS);
    res.writeHead(200, headers);
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      const chunk = bytes.subarray(offset, offset + 16384);
      const now = Date.now();
      linkFreeAt = Math.max(linkFreeAt, now) + (chunk.length / DOWNLINK_BYTES_PER_SECOND) * 1000;
      await sleep(Math.max(0, linkFreeAt - now));
      res.write(chunk);
    }
    res.end();
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (path !== dist && !path.startsWith(dist + sep)) {
        res.writeHead(403).end();
        return;
      }
      for (const file of [path, `${path}.html`, resolve(path, 'index.html')]) {
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
        let bytes = readFileSync(file);
        const ext = extname(file);
        const headers = {
          ...securityHeaders,
          ...(url.searchParams.has('no-isolation') ? {} : isolationHeaders),
          'content-type': TYPES[ext] ?? 'application/octet-stream',
        };
        if (throttle) {
          headers['cache-control'] = url.pathname.startsWith('/_astro/')
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate';
          if (COMPRESSIBLE.has(ext) && /\bbr\b/.test(req.headers['accept-encoding'] ?? '')) {
            bytes = brotli(bytes);
            headers['content-encoding'] = 'br';
            headers.vary = 'accept-encoding';
          }
        }
        headers['content-length'] = bytes.length;
        await send(res, headers, bytes);
        return;
      }
      res.writeHead(404).end('not found');
    } catch {
      res.writeHead(400).end('bad request');
    }
  });
  return new Promise((resolve_) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve_({ url: `http://127.0.0.1:${port}`, stop: () => server.close() });
    });
  });
}

// --------------------------------------------------------------------------- page measurement --
// Installed before any page script runs. "choose" is the file input's change event; "engine
// ready" is the worker's own ready message (site/src/lib/engine-worker.mjs, sent once its WASM
// has loaded). "First/final set shown" come from the page's own marks (site/src/pages/index.astro)
// when it made them, read after the run in measureOne(); the DOM fallbacks below are the result
// section becoming visible and the status output turning 'good'. The page starts loading the
// engine on hover or focus too; this harness chooses the file without either, so choose->ready
// is the whole load, as a visitor who drops a file straight in would see it.
function markPage() {
  window.__bench = {};
  const mark = (name) => {
    if (!(name in window.__bench)) window.__bench[name] = performance.now();
  };
  document.addEventListener(
    'change',
    (event) => {
      if (event.target?.name === 'file') mark('choose');
    },
    true,
  );
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (data?.type === 'ready') mark('engineReady');
      });
    }
  };
  new MutationObserver(() => {
    const result = document.getElementById('result');
    if (result && !result.hidden) mark('firstSetShown');
    const status = document.querySelector('form output');
    if (status?.className === 'good') mark('finalSetShown');
    if (status?.className === 'bad') {
      mark('failed');
      window.__bench.failureText = status.textContent;
    }
    // document.documentElement does not exist yet when an init script runs (document-start,
    // before parsing); document itself always does and is its ancestor.
  }).observe(document, { subtree: true, attributes: true, childList: true });
}

async function measureOne(browser, { baseUrl, mode, fixture, effort }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(markPage);
    await page.goto(mode === 'compat' ? `${baseUrl}/?no-isolation` : `${baseUrl}/`, { waitUntil: 'load' });
    await page.selectOption('select[name=effort]', effort);
    await page.fill('input[name=sizes]', '192 512');
    await page.setInputFiles('input[name=file]', resolve(FIXTURES, `${fixture}.svg`));
    await page.click('button[type=submit]');
    await page.waitForFunction(() => window.__bench.finalSetShown || window.__bench.failed, null, {
      timeout: RUN_TIMEOUT_MS,
      polling: 25,
    });
    const { quick, final, ...observed } = await page.evaluate(() => ({
      ...window.__bench,
      quick: performance.getEntriesByName('favseed:quick-set', 'mark')[0]?.startTime,
      final: performance.getEntriesByName('favseed:final-set', 'mark')[0]?.startTime,
    }));
    const marks = {
      ...observed,
      firstSetShown: quick ?? final ?? observed.firstSetShown,
      finalSetShown: final ?? observed.finalSetShown,
    };
    assert.ok(!marks.failed, `Build failed for ${fixture}/${effort} (${mode}): ${marks.failureText}`);
    return {
      chooseToReady: Math.round(marks.engineReady - marks.choose),
      chooseToFirst: Math.round(marks.firstSetShown - marks.choose),
      chooseToFinal: Math.round(marks.finalSetShown - marks.choose),
    };
  } finally {
    await context.close();
  }
}

// --------------------------------------------------------------------------- checkpointing --
// The full --write matrix takes the better part of an hour; a restart partway through should
// not repeat runs it already timed. Every individual measurement (one fixture/effort/network/
// mode at one rep index, for one build) is persisted under bench/out/browser/ (gitignored
// scratch, like every other bench/out/ directory) as soon as it completes, keyed so a later run
// can tell which samples it already has. One file per build, named by a hash of its dist, so a
// rebuilt site starts clean instead of silently reusing stale numbers for the same key.
function siteSignature(dist) {
  const hash = createHash('sha256');
  for (const relative of readdirSync(dist, { recursive: true }).toSorted()) {
    const file = resolve(dist, relative);
    if (!statSync(file).isFile()) continue;
    hash.update(relative);
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
const cellKey = ({ network, mode, fixture, effort }) => `${network}|${mode}|${fixture}|${effort}`;
const checkpointFile = (signature) => resolve(CHECKPOINT_DIR, `checkpoint-${signature.slice(0, 16)}.json`);
function loadCheckpoint(signature) {
  try {
    const checkpoint = JSON.parse(readFileSync(checkpointFile(signature), 'utf8'));
    if (checkpoint.signature === signature) return checkpoint;
  } catch {
    // Missing or unreadable: start clean below.
  }
  return { signature, cells: {} };
}
function saveCheckpoint(checkpoint) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const file = checkpointFile(checkpoint.signature);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint));
  renameSync(tmp, file); // atomic on the same filesystem; never a half-written file
}

// ------------------------------------------------------------------------------- the sweep --
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const range = (values) => [Math.min(...values), Math.max(...values)];

// Every (network, mode) combo's (fixture, effort) cells, flattened into one list so a restart
// can resume anywhere in the whole matrix, not just within one combo.
function cellsFor(combos) {
  return combos.flatMap(({ network, mode }) =>
    FIXTURE_NAMES.flatMap((fixture) => EFFORTS.map((effort) => ({ network, mode, fixture, effort }))),
  );
}

async function measureMatrix(browser, { combos, reps, builds }) {
  const cells = cellsFor(combos);
  for (const build of builds) {
    for (const cell of cells) {
      build.checkpoint.cells[cellKey(cell)] ??= { chooseToReady: [], chooseToFirst: [], chooseToFinal: [] };
    }
  }
  // Interleaved across reps (rotated, and reversed on odd reps) rather than grouped by cell,
  // so a drifting machine does not attribute its drift to one fixture, effort or combo; and
  // within each cell the builds take turns going first, so neither always runs on the heels of
  // the other.
  let turn = 0;
  for (let rep = 0; rep < reps; rep++) {
    const offset = rep % cells.length;
    let order = [...cells.slice(offset), ...cells.slice(0, offset)];
    if (rep % 2) order = order.reverse();
    for (const cell of order) {
      const pair = turn++ % 2 ? builds.toReversed() : builds;
      for (const build of pair) {
        const sample = build.checkpoint.cells[cellKey(cell)];
        if (sample.chooseToFinal.length > rep) continue; // a previous, interrupted run already has it
        const started = Date.now();
        const result = await measureOne(browser, {
          baseUrl: build.servers[cell.network].url,
          mode: cell.mode,
          fixture: cell.fixture,
          effort: cell.effort,
        });
        sample.chooseToReady.push(result.chooseToReady);
        sample.chooseToFirst.push(result.chooseToFirst);
        sample.chooseToFinal.push(result.chooseToFinal);
        saveCheckpoint(build.checkpoint);
        process.stderr.write(
          `${build.label}: ${cell.network} ${cell.mode} rep ${rep + 1}/${reps} ${cell.fixture}/${cell.effort}: ` +
            `${result.chooseToFirst}/${result.chooseToFinal}ms (${Date.now() - started}ms wall)\n`,
        );
      }
    }
  }
  const summarise = (values) => ({ median: median(values), range: range(values) });
  return combos.map(({ network, mode }) => ({
    network,
    mode,
    rows: FIXTURE_NAMES.flatMap((fixture) =>
      EFFORTS.map((effort) => ({
        fixture,
        effort,
        builds: builds.map(({ label, checkpoint }) => {
          const sample = checkpoint.cells[cellKey({ network, mode, fixture, effort })];
          const take = (key) => sample[key].slice(0, reps); // ignore samples from a larger past run
          return {
            label,
            chooseToReady: summarise(take('chooseToReady')),
            chooseToFirst: summarise(take('chooseToFirst')),
            chooseToFinal: summarise(take('chooseToFinal')),
          };
        }),
      })),
    ),
  }));
}

function printTable(network, mode, rows) {
  console.log(`\n${network}, ${mode}:`);
  console.log('fixture | effort | build | choose->ready | choose->first | choose->final');
  const cell = (c) => `${c.median}ms (${c.range[0]}-${c.range[1]})`;
  for (const row of rows) {
    for (const build of row.builds) {
      console.log(
        `${row.fixture} | ${row.effort} | ${build.label} | ${cell(build.chooseToReady)} | ` +
          `${cell(build.chooseToFirst)} | ${cell(build.chooseToFinal)}`,
      );
    }
  }
}

const shortCommit = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'an unknown commit';
  }
};

function writeReadme({ date, cpu, threads, chromiumVersion, reps, results, commits }) {
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const cell = (c) => `${fmt(c.median)} (${fmt(c.range[0])}–${fmt(c.range[1])})`;
  const change = (before, after) => {
    const pct = Math.round((100 * (after.median - before.median)) / before.median);
    return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)} %`;
  };
  const table = (rows) =>
    [
      '| Fixture | Effort | Build | choose→ready | choose→first set | choose→final set | first set | final set |',
      '|---|---|---|---:|---:|---:|---:|---:|',
      ...rows.flatMap(({ fixture, effort, builds: [before, after] }) => [
        `| ${fixture} | ${effort} | before | ${cell(before.chooseToReady)} | ${cell(before.chooseToFirst)} | ${cell(before.chooseToFinal)} | | |`,
        `| | | after | ${cell(after.chooseToReady)} | ${cell(after.chooseToFirst)} | ${cell(after.chooseToFinal)} | ` +
          `${change(before.chooseToFirst, after.chooseToFirst)} | ${change(before.chooseToFinal, after.chooseToFinal)} |`,
      ]),
    ].join('\n');
  const section = (network, mode) => {
    const title = network === 'unthrottled' ? 'Unthrottled' : 'Throttled (9 Mbps, 60 ms added latency)';
    const rows = results.find((r) => r.network === network && r.mode === mode).rows;
    return `### ${title}, ${mode}\n\n${table(rows)}`;
  };
  const lines = [
    '# Browser speed',
    '',
    `Two builds of the site, measured side by side on ${date} with Chromium ${chromiumVersion}, ` +
      `Node ${process.version}, on ${cpu} (${threads} logical CPUs): **before** is the site at ` +
      `\`${commits.before}\`, **after** the site at \`${commits.after}\`.`,
    `${reps} repetitions per fixture/effort cell and build, interleaved cell by cell with the builds ` +
      'taking turns to go first; the figure is the median in milliseconds, the range in parentheses ' +
      'is min–max, and the last two columns are the change in the median.',
    '',
    'Each cell times one build in a fresh browser context, from choosing the file to:',
    '',
    '- **choose→ready** — the engine worker reporting it has loaded its WASM and is ready to build.',
    '- **choose→first set** — the first set on the page: the quick set (`favseed:quick-set`) at an ' +
      'effort that searches, the only set at effort fast.',
    '- **choose→final set** — the final set on the page (`favseed:final-set`), with every download ready.',
    '',
    'The before site shows one set, so its first and final set are the same instant, as they are ' +
      'for both sites at effort fast.',
    '',
    '## What changed',
    '',
    'The site now shows a quick set as soon as one exists: every raster encoded once at the fast ' +
      'setting, scored and offered for download, while the search for the smallest passing encode ' +
      'goes on. The search itself walks its quality and colour ladders at the same time instead of ' +
      'one after the other. The threaded engine runs the two walks side by side on its worker ' +
      'threads, which more than pays for building the quick set first; the single-threaded ' +
      'fallback has nothing to run them on but its one thread, so there the final set lands about ' +
      'where it did, now with the quick set shown long before it. Either way the files the search ' +
      'settles on are byte for byte the ones it chose before. The engine also starts loading when ' +
      'the pointer or focus reaches the drop zone, and fetches Zopfli alongside itself rather than ' +
      'after it. These runs choose the file without either, so choose→ready is the whole load in ' +
      'both builds and shows none of that head start; a visitor who hovers first waits less than this.',
    '',
    '`threaded` is the default shared-memory engine; `compat` is the single-threaded fallback ' +
      '(`?no-isolation`, taken when the document cannot share WASM memory with its worker).',
    '',
    'Both networks go through a small server in `bench/browser.mjs` serving each build with the ' +
      'production headers. Unthrottled, it serves the files as they are at loopback speed, like ' +
      '`site/test/serve.mjs`. Throttled, it serves them brotli-compressed behind one shared 9 Mbps ' +
      'token-bucket downlink with 60 ms added per request: Chromium’s page-level network emulation ' +
      'does not reach fetches made from inside a worker, so the engine worker’s own WASM fetch ' +
      'would otherwise go out at full speed regardless of the setting.',
    '',
    '## Results',
    '',
    section('unthrottled', 'threaded'),
    '',
    section('unthrottled', 'compat'),
    '',
    section('throttled', 'threaded'),
    '',
    section('throttled', 'compat'),
    '',
    '## Reproducing',
    '',
    '```sh',
    'pnpm --filter favseed-site build',
    `git worktree add /tmp/fs-before ${commits.before}`,
    '(cd /tmp/fs-before && pnpm install --frozen-lockfile && pnpm --filter favseed-site build)',
    'node bench/browser.mjs --write --before /tmp/fs-before/site/dist',
    'git worktree remove /tmp/fs-before',
    '```',
    '',
    'For one combination without rewriting this file: ' +
      '`node bench/browser.mjs [--throttle] [--compat] [--reps N] [--before DIR]`; `--help` lists the rest.',
    '',
  ];
  writeFileSync(README, lines.join('\n'));
}

// ------------------------------------------------------------------------------------- main --
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    // An argument error, including a path benchmarkPath() refuses, is the caller's to fix:
    // one line, not a stack trace.
    console.error(`bench/browser.mjs: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const { combos, reps, builds, write } = options;
  const networks = new Set(combos.map((c) => c.network));
  let browser;
  try {
    for (const build of builds) {
      build.servers = {};
      for (const network of networks) {
        build.servers[network] = await startServer(build.dist, { throttle: network === 'throttled' });
      }
      build.checkpoint = loadCheckpoint(siteSignature(build.dist));
      saveCheckpoint(build.checkpoint); // persist the signature now, in case nothing else gets measured yet
    }
    browser = await chromium.launch({ channel: 'chromium' });
    const chromiumVersion = browser.version();
    const results = await measureMatrix(browser, { combos, reps, builds });
    for (const { network, mode, rows } of results) printTable(network, mode, rows);
    if (write) {
      writeReadme({
        date: new Date().toISOString().slice(0, 10),
        cpu: cpus()[0]?.model ?? 'unknown CPU',
        threads: cpus().length,
        chromiumVersion,
        reps,
        results,
        commits: { before: shortCommit(builds[0].dist), after: shortCommit(builds[1].dist) },
      });
      console.log(`\nWrote ${README}`);
    }
  } finally {
    await browser?.close();
    for (const build of builds) for (const server of Object.values(build.servers ?? {})) server.stop();
  }
}

await main();
