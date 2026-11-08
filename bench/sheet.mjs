#!/usr/bin/env node
// A side-by-side HTML sheet of the search sweep's winners (bench/search.mjs), for a human to
// actually look at before any winner setting becomes a default. results.json only stores
// bytes and pct per candidate, not the encoded image, so this script re-runs captureJobs per
// mark to get back the raw pixels, re-encodes the winner setting, and scores both today's
// output and the winner against the same reference every candidate was measured against —
// with three second-gate metrics (bench/lib/metrics.mjs) the sweep itself never computed.
//
// Private marks are never selected, rendered, or named here: corpusFiles({ private }) is not
// even asked for a private directory, so a private mark cannot reach this script by accident.
//
//   node bench/sheet.mjs
//
// Writes bench/out/sheet/index.html, bench/out/sheet/metrics.csv and three PNGs per selected
// job under bench/out/sheet/img/ (all gitignored). Prints the index.html path and, per
// metric, today's worst value across the selected jobs and how many winners exceed it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../bin/favseed.mjs';
import { decode, encode } from '../test/lib/png.mjs';
import { corpusFiles } from './corpus/files.mjs';
import { captureJobs } from './jobs.mjs';
import { edgeError, rmse, ssim } from './lib/metrics.mjs';
import { benchmarkPath } from './path.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RESULTS = join(ROOT, 'bench/out/search/results.json');
const OUT_DIR = join(ROOT, 'bench/out/sheet');
const IMG_DIR = join(OUT_DIR, 'img');

const COLOUR_SIZE_FLOOR = 180;
const COLOUR_COUNT_CEILING = 8;
const TOP_SAVINGS = 20;
const CONTROL_COUNT = 10;

// ----------------------------------------------------------------- selection --

/** A deterministic 0..1 generator: Numerical-Recipes LCG, 32-bit via Math.imul. */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Fisher-Yates over `list`, using `rng` for every swap: deterministic for a given seed. */
function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const jobId = (j) => `${j.corpus}/${j.name}#${j.kind}-${j.px}`;

/** Flatten fixtures+open marks' jobs (never private), each carrying its relative saving. */
function eligibleJobs(results) {
  const out = [];
  for (const mark of results.marks) {
    if (!mark.ok || mark.corpus === 'private') continue;
    for (const job of mark.jobs) {
      const relative = job.today.bytes ? (job.today.bytes - job.exhaustive.bytes) / job.today.bytes : 0;
      out.push({ corpus: mark.corpus, name: mark.name, ...job, relative });
    }
  }
  return out;
}

/**
 * Every exhaustive winner with <= 8 colours at >= 180px (colour mode only), plus the 20
 * largest relative savings, plus 10 seeded controls from what's left, deduped.
 */
function selectJobs(results) {
  const all = eligibleJobs(results);

  const ruleA = all.filter(
    (j) =>
      j.exhaustive.setting.quality === 100 &&
      j.exhaustive.setting.colors <= COLOUR_COUNT_CEILING &&
      j.px >= COLOUR_SIZE_FLOOR,
  );
  const bySaving = all.toSorted((a, b) => b.relative - a.relative).slice(0, TOP_SAVINGS);

  const picked = new Map();
  for (const j of [...ruleA, ...bySaving]) picked.set(jobId(j), j);

  const remaining = all.filter((j) => !picked.has(jobId(j)));
  const rng = makeRng(1);
  for (const j of shuffle(remaining, rng).slice(0, CONTROL_COUNT)) picked.set(jobId(j), j);

  return [...picked.values()];
}

// --------------------------------------------------------------------- capture --

/** captureJobs, cached per mark: several selected jobs can share one mark. */
function markCache(pathsByMark) {
  const cache = new Map();
  return async (corpus, name) => {
    const key = `${corpus}/${name}`;
    if (!cache.has(key)) {
      const path = pathsByMark.get(key);
      if (!path) throw new Error(`sheet: no corpus file for ${key}`);
      cache.set(key, captureJobs(path, { name }));
    }
    return cache.get(key);
  };
}

async function pathsByMark() {
  const files = await corpusFiles({ private: undefined, open: true, fixtures: true });
  return new Map(files.map((f) => [`${f.corpus}/${f.name}`, f.path]));
}

// ----------------------------------------------------------------------- html --

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct1 = (n) => n.toFixed(1);
const safeId = (j) =>
  jobId(j)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function imgTag(src, px, scale, tile) {
  const size = px * scale;
  return (
    `<div class="tile tile-${tile}" style="width:${size}px;height:${size}px;background:${tile === 'light' ? '#f4f6f8' : '#111'}">` +
    `<img src="${src}" width="${size}" height="${size}" style="image-rendering:pixelated" alt=""></div>`
  );
}

function rowHtml(j, m) {
  const id = safeId(j);
  const deltaPct = j.today.bytes ? pct1(((j.today.bytes - j.exhaustive.bytes) / j.today.bytes) * 100) : '0.0';
  const setting = j.exhaustive.setting;
  const colours = setting.quality === 100 ? setting.colors : '—';
  const sameAsBinary = j.binary.setting.quality === setting.quality && j.binary.setting.colors === setting.colors;

  const figure = (label, src) => `
    <div class="figure">
      <div class="figure-label">${label}</div>
      <div class="scales">
        <div class="scale">${imgTag(src, j.px, 1, 'light')}${imgTag(src, j.px, 1, 'dark')}</div>
        <div class="scale">${imgTag(src, j.px, 4, 'light')}${imgTag(src, j.px, 4, 'dark')}</div>
      </div>
    </div>`;

  return `
  <tr>
    <td>
      <div class="mark">${escapeHtml(j.corpus)}/${escapeHtml(j.name)}</div>
      <div class="job">${escapeHtml(j.kind)} · ${j.px}px</div>
      <div class="bytes">${j.today.bytes.toLocaleString()} B &rarr; ${j.exhaustive.bytes.toLocaleString()} B (&minus;${deltaPct}%)</div>
      <div class="setting">pct ${j.exhaustive.pct.toFixed(3)}% · quality ${setting.quality} · colours ${colours}</div>
      <div class="binary">binary picked ${sameAsBinary ? 'the same setting' : 'a different setting'}</div>
      <table class="metrics">
        <tr><th></th><th>today</th><th>winner</th></tr>
        <tr><td>rmse</td><td>${m.today.rmse.toFixed(3)}</td><td>${m.winner.rmse.toFixed(3)}</td></tr>
        <tr><td>ssim</td><td>${m.today.ssim.toFixed(4)}</td><td>${m.winner.ssim.toFixed(4)}</td></tr>
        <tr><td>edgeError</td><td>${m.today.edgeError.toFixed(3)}</td><td>${m.winner.edgeError.toFixed(3)}</td></tr>
      </table>
    </td>
    <td>${figure('reference', `img/${id}-reference.png`)}</td>
    <td>${figure('today', `img/${id}-today.png`)}</td>
    <td>${figure('winner', `img/${id}-winner.png`)}</td>
  </tr>`;
}

function writeHtml(rows) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>favseed search sweep — winner sheet</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #fff; color: #111; }
  h1 { font-size: 1.3rem; }
  .intro { max-width: 60rem; line-height: 1.5; }
  table.sheet { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
  table.sheet > tbody > tr { border-top: 1px solid #ccc; }
  table.sheet > tbody > tr > td { vertical-align: top; padding: 0.75rem; }
  .mark { font-weight: 600; }
  .job, .bytes, .setting, .binary { font-size: 0.85rem; color: #333; }
  table.metrics { margin-top: 0.5rem; font-size: 0.8rem; border-collapse: collapse; }
  table.metrics td, table.metrics th { padding: 0.1rem 0.4rem; text-align: right; }
  .figure-label { font-size: 0.75rem; color: #666; text-align: center; margin-bottom: 0.25rem; }
  .scales { display: flex; flex-direction: column; gap: 0.5rem; align-items: center; }
  .scale { display: flex; gap: 0.25rem; }
  .tile { display: flex; align-items: center; justify-content: center; }
</style>
</head>
<body>
<h1>favseed search sweep — winner sheet</h1>
<div class="intro">
  <p>Each row is one raster job (a mark's ICO payload, apple-touch-icon, or one of the two
  <code>icon-&lt;size&gt;.png</code>s) where the search sweep (<code>bench/search.mjs</code>)
  found a smaller passing encode than today's production default. <strong>Today's output is
  the anchor: the winner setting must never look visibly worse than it</strong>, even though
  both pass the same <code>pct &lt;= 1.0%</code> accuracy gate.</p>
  <p>Look for banding in a gradient, lost anti-aliasing on a curved edge, and colour shifts —
  the kind of error a low colour count or low quality setting can introduce that the
  pixel-distance gate alone can miss. Each image is shown at 1&times; and 4&times;
  (<code>image-rendering: pixelated</code>), on both a light and a dark tile, since an error
  in the alpha channel can hide against one ground and not the other.</p>
</div>
<table class="sheet">
<tbody>
${rows.join('\n')}
</tbody>
</table>
</body>
</html>
`;
  const path = join(OUT_DIR, 'index.html');
  writeFileSync(path, html);
  return path;
}

// ------------------------------------------------------------------------ main --

async function main() {
  const resultsPath = benchmarkPath(RESULTS);
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const selected = selectJobs(results);

  mkdirSync(IMG_DIR, { recursive: true });

  const engine = await loadEngine();
  const paths = await pathsByMark();
  const capture = markCache(paths);

  const rows = [];
  const csvLines = ['job,rmse_today,rmse_winner,ssim_today,ssim_winner,edge_today,edge_winner'];
  const summary = {
    rmse: { today: [], winner: [] },
    ssim: { today: [], winner: [] },
    edgeError: { today: [], winner: [] },
  };

  for (const j of selected) {
    process.stderr.write(`sheet: ${jobId(j)}\n`);
    const captured = await capture(j.corpus, j.name);
    if (!captured.ok) {
      process.stderr.write(`sheet: skipping ${jobId(j)}: ${captured.error}\n`);
      continue;
    }
    const matched = captured.jobs.find((cj) => cj.kind === j.kind && cj.px === j.px);
    if (!matched) {
      process.stderr.write(`sheet: skipping ${jobId(j)}: no matching captured job\n`);
      continue;
    }

    const reference = await matched.reference;
    const winnerBytes = await engine.encode(matched.raw, j.exhaustive.setting);
    const todayBytes = matched.today;

    const todayImg = decode(Buffer.from(todayBytes));
    const winnerImg = decode(Buffer.from(winnerBytes));

    const metrics = {
      today: {
        rmse: rmse(todayImg, reference),
        ssim: ssim(todayImg, reference),
        edgeError: edgeError(todayImg, reference),
      },
      winner: {
        rmse: rmse(winnerImg, reference),
        ssim: ssim(winnerImg, reference),
        edgeError: edgeError(winnerImg, reference),
      },
    };
    for (const metric of ['rmse', 'ssim', 'edgeError']) {
      summary[metric].today.push(metrics.today[metric]);
      summary[metric].winner.push(metrics.winner[metric]);
    }

    const id = safeId(j);
    writeFileSync(join(IMG_DIR, `${id}-reference.png`), encode(reference));
    writeFileSync(join(IMG_DIR, `${id}-today.png`), Buffer.from(todayBytes));
    writeFileSync(join(IMG_DIR, `${id}-winner.png`), Buffer.from(winnerBytes));

    csvLines.push(
      [
        jobId(j),
        metrics.today.rmse,
        metrics.winner.rmse,
        metrics.today.ssim,
        metrics.winner.ssim,
        metrics.today.edgeError,
        metrics.winner.edgeError,
      ].join(','),
    );

    rows.push(rowHtml(j, metrics));
  }

  writeFileSync(join(OUT_DIR, 'metrics.csv'), csvLines.join('\n') + '\n');
  const htmlPath = writeHtml(rows);

  process.stderr.write(`\nsheet: ${htmlPath} (${rows.length} rows)\n`);
  const worseDirection = { rmse: 'higher', ssim: 'lower', edgeError: 'higher' };
  for (const metric of ['rmse', 'ssim', 'edgeError']) {
    const todayValues = summary[metric].today;
    const winnerValues = summary[metric].winner;
    if (!todayValues.length) continue;
    const worstToday = metric === 'ssim' ? Math.min(...todayValues) : Math.max(...todayValues);
    const exceed = winnerValues.filter((v) => (metric === 'ssim' ? v < worstToday : v > worstToday)).length;
    process.stderr.write(
      `sheet: ${metric} — today's worst ${worstToday.toFixed(4)} (worse is ${worseDirection[metric]}), ` +
        `${exceed} of ${winnerValues.length} winner(s) exceed it\n`,
    );
  }
}

main().catch((e) => {
  process.stderr.write(`favseed sheet: ${e.stack ?? e.message}\n`);
  process.exit(1);
});
