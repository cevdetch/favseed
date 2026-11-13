#!/usr/bin/env node
// Measures the website end to end, in a real browser: from choosing a file to the engine
// worker reporting ready, to the first set shown (the quick set, at an effort that searches),
// to the final set shown. The page marks both with performance.mark('favseed:quick-set') and
// performance.mark('favseed:final-set'); where a mark is missing (effort 'fast' makes no quick
// set, and a page from before the marks makes neither) the DOM stands in, as markPage() says.
//
// Chromium's page-level CDP network emulation does not reach fetches made from a worker (the
// engine worker fetches its own WASM), so --throttle serves the production build through a
// small server in this file instead, with a shared token-bucket downlink and added latency.
// The unthrottled runs reuse site/test/serve.mjs, which already serves site/dist with the
// production headers and the `?no-isolation` switch that --compat needs.
//
// The full --write matrix runs ~15-25 minutes; each individual measurement is checkpointed to
// bench/out/browser/checkpoint.json as it completes (keyed to a hash of site/dist, so a
// rebuilt site starts clean rather than reusing stale numbers), so a restart resumes rather
// than re-running everything.
//
//   node bench/browser.mjs                     unthrottled, threaded: prints a table
//   node bench/browser.mjs --throttle --compat one combination: prints a table
//   node bench/browser.mjs --reps 1             fewer repetitions, for a quick check
//   node bench/browser.mjs --write              the full matrix; regenerates the README
//
// Build the site first: pnpm --filter favseed-site build
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { chromium } from '../site/node_modules/@playwright/test/index.mjs';
import { isolationHeaders, securityHeaders } from '../site/headers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SITE_DIST = resolve(ROOT, 'site/dist');
const FIXTURES = resolve(ROOT, 'test/fixtures');
const README = resolve(ROOT, 'bench/browser/README.md');
const CHECKPOINT_DIR = resolve(ROOT, 'bench/out/browser');
const CHECKPOINT_FILE = resolve(CHECKPOINT_DIR, 'checkpoint.json');
const UNTHROTTLED_URL = 'http://127.0.0.1:4175';

const FIXTURE_NAMES = ['general', 'gradient'];
const EFFORTS = ['fast', 'default', 'max'];
const NETWORKS = ['unthrottled', 'throttled'];
const MODES = ['threaded', 'compat'];
const DOWNLINK_BYTES_PER_SECOND = 9e6 / 8; // 9 Mbps, the brief's throttled downlink
const ADDED_LATENCY_MS = 60;
const RUN_TIMEOUT_MS = 180_000;

// -------------------------------------------------------------------------- argument parsing --
function parseArgs(argv) {
  const flags = new Set();
  let reps;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--throttle' || arg === '--compat' || arg === '--write') {
      flags.add(arg.slice(2));
    } else if (arg === '--reps') {
      reps = Number(argv[++i]);
    } else if (arg.startsWith('--reps=')) {
      reps = Number(arg.slice('--reps='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  reps ??= 3;
  assert.ok(Number.isInteger(reps) && reps >= 1 && reps <= 10, '--reps must be an integer from 1 to 10');
  assert.ok(
    !flags.has('write') || (!flags.has('throttle') && !flags.has('compat')),
    '--write measures the full matrix (both networks, both modes) on its own; pass it alone',
  );
  const combos = flags.has('write')
    ? NETWORKS.flatMap((network) => MODES.map((mode) => ({ network, mode })))
    : [
        {
          network: flags.has('throttle') ? 'throttled' : 'unthrottled',
          mode: flags.has('compat') ? 'compat' : 'threaded',
        },
      ];
  return { combos, reps, write: flags.has('write') };
}

// ------------------------------------------------------------------------------ the servers --
// Reused rather than reimplemented: this is the same server the Playwright suite and the other
// browser benchmarks serve site/dist through.
function startUnthrottledServer() {
  const child = spawn(process.execPath, [resolve(ROOT, 'site/test/serve.mjs')], { stdio: 'inherit' });
  const exited = new Promise((_resolve, reject) =>
    child.once('exit', (code) => reject(new Error(`serve.mjs exited early (${code})`))),
  );
  const ready = (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(`${UNTHROTTLED_URL}/check.html`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error('site/test/serve.mjs did not start in time');
  })();
  return { child, ready: Promise.race([ready, exited]), stop: () => child.kill('SIGTERM') };
}

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

// A production-header server for site/dist: brotli-encoded assets (cached in memory per
// content hash, since this process is short-lived) behind a shared token-bucket downlink with
// added latency, standing in for the real network the baseline was measured against.
function startThrottledServer() {
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
  for (const relative of readdirSync(SITE_DIST, { recursive: true })) {
    const file = resolve(SITE_DIST, relative);
    if (statSync(file).isFile() && COMPRESSIBLE.has(extname(file))) brotli(readFileSync(file));
  }
  // One shared downlink across every request/connection on this server, like one real link.
  let linkFreeAt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = async (res, headers, bytes) => {
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
      const path = resolve(SITE_DIST, `.${decodeURIComponent(url.pathname)}`);
      if (path !== SITE_DIST && !path.startsWith(SITE_DIST + sep)) {
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
          'cache-control': url.pathname.startsWith('/_astro/')
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate',
        };
        if (COMPRESSIBLE.has(ext) && /\bbr\b/.test(req.headers['accept-encoding'] ?? '')) {
          bytes = brotli(bytes);
          headers['content-encoding'] = 'br';
          headers.vary = 'accept-encoding';
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
// The full --write matrix takes 15-25 minutes; a restart partway through should not repeat
// runs it already timed. Every individual measurement (one fixture/effort/network/mode at one
// rep index) is persisted to bench/out/browser/checkpoint.json (gitignored scratch, like every
// other bench/out/ directory) as soon as it completes, keyed so a later run can tell which
// samples it already has. Keyed on a hash of site/dist so a rebuilt site (a later task's
// optimisation) starts clean instead of silently reusing stale numbers for the same key.
function siteSignature() {
  const hash = createHash('sha256');
  for (const relative of readdirSync(SITE_DIST, { recursive: true }).toSorted()) {
    const file = resolve(SITE_DIST, relative);
    if (!statSync(file).isFile()) continue;
    hash.update(relative);
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
const cellKey = ({ network, mode, fixture, effort }) => `${network}|${mode}|${fixture}|${effort}`;
function loadCheckpoint(signature) {
  try {
    const checkpoint = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8'));
    if (checkpoint.signature === signature) return checkpoint;
  } catch {
    // Missing, unreadable or from a different site build: start clean below.
  }
  return { signature, cells: {} };
}
function saveCheckpoint(checkpoint) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const tmp = `${CHECKPOINT_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint));
  renameSync(tmp, CHECKPOINT_FILE); // atomic on the same filesystem; never a half-written file
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

async function measureMatrix(browser, { combos, reps, urlFor, checkpoint }) {
  const cells = cellsFor(combos);
  for (const cell of cells) {
    checkpoint.cells[cellKey(cell)] ??= { chooseToReady: [], chooseToFirst: [], chooseToFinal: [] };
  }
  // Interleaved across reps (rotated, and reversed on odd reps) rather than grouped by cell,
  // so a drifting machine does not attribute its drift to one fixture, effort or combo.
  for (let rep = 0; rep < reps; rep++) {
    const offset = rep % cells.length;
    let order = [...cells.slice(offset), ...cells.slice(0, offset)];
    if (rep % 2) order = order.reverse();
    for (const cell of order) {
      const sample = checkpoint.cells[cellKey(cell)];
      if (sample.chooseToFinal.length > rep) continue; // a previous, interrupted run already has it
      const started = Date.now();
      const result = await measureOne(browser, {
        baseUrl: urlFor(cell.network),
        mode: cell.mode,
        fixture: cell.fixture,
        effort: cell.effort,
      });
      sample.chooseToReady.push(result.chooseToReady);
      sample.chooseToFirst.push(result.chooseToFirst);
      sample.chooseToFinal.push(result.chooseToFinal);
      saveCheckpoint(checkpoint);
      process.stderr.write(
        `${cell.network} ${cell.mode} rep ${rep + 1}/${reps} ${cell.fixture}/${cell.effort}: ` +
          `${result.chooseToFinal}ms (${Date.now() - started}ms wall)\n`,
      );
    }
  }
  return combos.map(({ network, mode }) => ({
    network,
    mode,
    rows: FIXTURE_NAMES.flatMap((fixture) =>
      EFFORTS.map((effort) => {
        const sample = checkpoint.cells[cellKey({ network, mode, fixture, effort })];
        const take = (key) => sample[key].slice(0, reps); // ignore samples from a larger past run
        return {
          fixture,
          effort,
          chooseToReady: { median: median(take('chooseToReady')), range: range(take('chooseToReady')) },
          chooseToFirst: { median: median(take('chooseToFirst')), range: range(take('chooseToFirst')) },
          chooseToFinal: { median: median(take('chooseToFinal')), range: range(take('chooseToFinal')) },
        };
      }),
    ),
  }));
}

function printTable(network, mode, rows) {
  console.log(`\n${network}, ${mode}:`);
  console.log('fixture | effort | choose->ready | choose->first | choose->final');
  for (const row of rows) {
    const cell = (c) => `${c.median}ms (${c.range[0]}-${c.range[1]})`;
    console.log(
      `${row.fixture} | ${row.effort} | ${cell(row.chooseToReady)} | ${cell(row.chooseToFirst)} | ${cell(row.chooseToFinal)}`,
    );
  }
}

function writeReadme({ date, cpu, threads, chromiumVersion, reps, results }) {
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const cell = (c) => `${fmt(c.median)} (${fmt(c.range[0])}–${fmt(c.range[1])})`;
  const table = (rows) =>
    [
      '| Fixture | Effort | choose→ready | choose→first set | choose→final set |',
      '|---|---|---:|---:|---:|',
      ...rows.map(
        (row) =>
          `| ${row.fixture} | ${row.effort} | ${cell(row.chooseToReady)} | ${cell(row.chooseToFirst)} | ${cell(row.chooseToFinal)} |`,
      ),
    ].join('\n');
  const section = (network, mode) => {
    const title = network === 'unthrottled' ? 'Unthrottled' : 'Throttled (9 Mbps, 60 ms added latency)';
    const rows = results.find((r) => r.network === network && r.mode === mode).rows;
    return `### ${title}, ${mode}\n\n${table(rows)}`;
  };
  const lines = [
    '# Browser speed',
    '',
    `Measured ${date} with Chromium ${chromiumVersion}, Node ${process.version}, on ${cpu} (${threads} logical CPUs).`,
    `${reps} repetitions per fixture/effort cell, interleaved; the figure is the median, the range in parentheses is min–max.`,
    '',
    'Each cell times one build in a fresh browser context, from choosing the file to:',
    '',
    '- **choose→ready** — the engine worker reporting it has loaded its WASM and is ready to build.',
    '- **choose→first set** — the first set on the page: the quick set (`favseed:quick-set`) at an ' +
      'effort that searches, the only set at effort fast.',
    '- **choose→final set** — the final set on the page (`favseed:final-set`), with every download ready.',
    '',
    'At effort fast the two are the same instant. The page starts loading the engine as soon as ' +
      'the pointer or focus reaches the drop zone; these runs choose the file without either, so ' +
      'choose→ready is the whole load.',
    '',
    '`threaded` is the default shared-memory engine; `compat` is the single-threaded fallback ' +
      '(`?no-isolation`, taken when the document cannot share WASM memory with its worker).',
    '',
    'Unthrottled runs go through `site/test/serve.mjs`. Throttled runs go through a small ' +
      'server in this file instead: Chromium’s page-level network emulation does not reach ' +
      'fetches made from inside a worker, so the engine worker’s own WASM fetch would otherwise ' +
      'go out at full speed regardless of the setting. That server serves the production build ' +
      'with the production headers, brotli-compressed, behind one shared 9 Mbps token-bucket ' +
      'downlink with 60 ms added per request.',
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
    'node bench/browser.mjs --write',
    '```',
    '',
    'For one combination without rewriting this file: `node bench/browser.mjs [--throttle] [--compat] [--reps N]`.',
    '',
  ];
  writeFileSync(README, lines.join('\n'));
}

// ------------------------------------------------------------------------------------- main --
async function main() {
  const { combos, reps, write } = parseArgs(process.argv.slice(2));
  assert.ok(existsSync(SITE_DIST), `${SITE_DIST} is missing; run: pnpm --filter favseed-site build`);
  mkdirSync(resolve(ROOT, 'bench/browser'), { recursive: true });

  const needsUnthrottled = combos.some((c) => c.network === 'unthrottled');
  const needsThrottled = combos.some((c) => c.network === 'throttled');
  const unthrottled = needsUnthrottled ? startUnthrottledServer() : undefined;
  const throttled = needsThrottled ? await startThrottledServer() : undefined;
  let browser;
  try {
    if (unthrottled) await unthrottled.ready;
    browser = await chromium.launch({ channel: 'chromium' });
    const chromiumVersion = browser.version();
    const checkpoint = loadCheckpoint(siteSignature());
    saveCheckpoint(checkpoint); // persist the signature now, in case nothing else gets measured yet
    const urlFor = (network) => (network === 'unthrottled' ? UNTHROTTLED_URL : throttled.url);
    const results = await measureMatrix(browser, { combos, reps, urlFor, checkpoint });
    for (const { network, mode, rows } of results) printTable(network, mode, rows);
    if (write) {
      writeReadme({
        date: new Date().toISOString().slice(0, 10),
        cpu: cpus()[0]?.model ?? 'unknown CPU',
        threads: cpus().length,
        chromiumVersion,
        reps,
        results,
      });
      console.log(`\nWrote ${README}`);
    }
  } finally {
    await browser?.close();
    unthrottled?.stop();
    throttled?.stop();
  }
}

await main();
