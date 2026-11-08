#!/usr/bin/env node
// The search sweep: for every raster a default build produces, measure the smallest encode
// that still passes the accuracy bar, two ways — an exhaustive sweep of every candidate
// setting, and the binary search a lower-effort search would actually run. Results land in
// bench/out/search/results.json (gitignored); --write regenerates the committed
// bench/search/README.md from them.
//
//   node bench/search.mjs                         fixtures + open corpus
//   node bench/search.mjs --no-open                fixtures only (fast sanity check)
//   node bench/search.mjs --private DIR --write    + a private corpus, written to the README
//
// --private falls back to FAVSEED_PRIVATE_CORPUS. A private mark's real name never appears
// anywhere here: corpusFiles() already hands back `private-N` labels, and that label — never
// the path — is what gets passed to captureJobs and printed to stderr.
//
// Candidates per job: quality in [40, 50, 60, 70, 80, 90, 95, 98, 99] at the default colour
// ceiling (encode ignores colours below quality 100), and quality 100 with colours in
// [2..256]. Both lists ascend in the direction a pass gets more likely, which is what the
// binary searches below assume (monotone pass/fail) rather than verify.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineVersions, loadEngine } from '../bin/favseed.mjs';
import { DEFAULT_COLORS } from '../lib/core.mjs';
import { score, THRESHOLD_PCT } from '../test/lib/accuracy.mjs';
import { decode } from '../test/lib/png.mjs';
import { corpusFiles } from './corpus/files.mjs';
import { captureJobs } from './jobs.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_DIR = join(ROOT, 'bench/out/search');
const README = join(ROOT, 'bench/search/README.md');

export const QUALITY_LIST = [40, 50, 60, 70, 80, 90, 95, 98, 99];
export const COLORS_LIST = [2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

// ------------------------------------------------------------------ winners --

const passes = (c) => c.pct <= THRESHOLD_PCT;

/** True if `a` is the less-lossy of a tie: the exhaustive/binary tie rule. */
const lessLossy = (a, b) =>
  a.setting.quality !== b.setting.quality ? a.setting.quality > b.setting.quality : a.setting.colors > b.setting.colors;

/** Smallest bytes with pct <= THRESHOLD_PCT; ties go to the less-lossy setting. */
function exhaustiveWinner(candidates, fallback) {
  const passing = candidates.filter(passes);
  if (!passing.length) return fallback;
  return passing.reduce((best, c) => {
    if (c.bytes !== best.bytes) return c.bytes < best.bytes ? c : best;
    return lessLossy(c, best) ? c : best;
  });
}

/** Leftmost passing index in a monotone-assumed (ascending-pass-likelihood) list. */
function binaryLeftmost(list) {
  let lo = 0,
    hi = list.length - 1,
    index = -1,
    probes = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    probes++;
    if (passes(list[mid])) {
      index = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return { winner: index >= 0 ? list[index] : null, probes };
}

/**
 * Binary-search the colour list and the quality list independently (each assumed monotone),
 * then take the smaller of the two winners. Neither search passing falls back to the same
 * lossless candidate the exhaustive search falls back to.
 */
function binaryWinner(qualityCandidates, colourCandidates, fallback) {
  const q = binaryLeftmost(qualityCandidates);
  const c = binaryLeftmost(colourCandidates);
  const probes = q.probes + c.probes;
  let winner;
  if (q.winner && c.winner) {
    winner =
      q.winner.bytes !== c.winner.bytes
        ? q.winner.bytes < c.winner.bytes
          ? q.winner
          : c.winner
        : lessLossy(c.winner, q.winner)
          ? c.winner
          : q.winner;
  } else {
    winner = q.winner ?? c.winner ?? fallback;
  }
  return { setting: winner.setting, bytes: winner.bytes, pct: winner.pct, probes };
}

// -------------------------------------------------------------------- jobs --

/** One job: today's bytes, every candidate, and both winners. */
async function measureJob(job, engine) {
  const ref = await job.reference;
  const todayPct = score(decode(Buffer.from(job.today)), ref).pct;

  const qualityCandidates = [];
  const colourCandidates = [];
  let quantiseMs = 0,
    scoreMs = 0;

  for (const quality of QUALITY_LIST) {
    const t0 = performance.now();
    const bytes = await engine.encode(job.raw, { quality, colors: DEFAULT_COLORS });
    quantiseMs += performance.now() - t0;
    const t1 = performance.now();
    const pct = score(decode(Buffer.from(bytes)), ref).pct;
    scoreMs += performance.now() - t1;
    qualityCandidates.push({ setting: { quality, colors: DEFAULT_COLORS }, bytes: bytes.length, pct });
  }
  for (const colors of COLORS_LIST) {
    const t0 = performance.now();
    const bytes = await engine.encode(job.raw, { quality: 100, colors });
    quantiseMs += performance.now() - t0;
    const t1 = performance.now();
    const pct = score(decode(Buffer.from(bytes)), ref).pct;
    scoreMs += performance.now() - t1;
    colourCandidates.push({ setting: { quality: 100, colors }, bytes: bytes.length, pct });
  }

  // The colour list's last entry, quality 100 / colors 256, is the "lossless" fallback both
  // winners retreat to when no candidate on either list passes.
  const fallback = colourCandidates[colourCandidates.length - 1];
  const candidates = [...qualityCandidates, ...colourCandidates];

  return {
    kind: job.kind,
    px: job.px,
    today: { bytes: job.today.length, pct: todayPct },
    candidates,
    exhaustive: exhaustiveWinner(candidates, fallback),
    binary: binaryWinner(qualityCandidates, colourCandidates, fallback),
    timeMs: { quantise: Math.round(quantiseMs), score: Math.round(scoreMs) },
  };
}

// --------------------------------------------------------------------- CLI --

function parseArgs(argv) {
  let privateDir = process.env.FAVSEED_PRIVATE_CORPUS || null;
  let open = true;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--private') {
      privateDir = argv[++i];
      if (privateDir === undefined) throw new Error('--private needs a directory');
    } else if (a === '--no-open') {
      open = false;
    } else if (a === '--write') {
      write = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { privateDir, open, write };
}

async function main() {
  const { privateDir, open, write } = parseArgs(process.argv.slice(2));
  const engine = await loadEngine();
  const files = await corpusFiles({ private: privateDir, open, fixtures: true });
  const marks = [];
  const started = Date.now();
  for (const [i, file] of files.entries()) {
    process.stderr.write(`search: ${i + 1}/${files.length} ${file.corpus}/${file.name}\n`);
    const captured = await captureJobs(file.path, { name: file.name });
    if (!captured.ok) {
      marks.push({ corpus: file.corpus, name: file.name, ok: false, error: captured.error });
      continue;
    }
    const jobs = [];
    for (const job of captured.jobs) jobs.push(await measureJob(job, engine));
    marks.push({ corpus: file.corpus, name: file.name, ok: true, jobs });
  }
  const results = { date: new Date().toISOString().slice(0, 10), engine: engineVersions(), marks };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  process.stderr.write(`search: ${files.length} marks in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  if (write) writeReadme(results);
}

// ---------------------------------------------------------------- README --

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0;
};
const p95 = (values) => {
  if (!values.length) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};
const pct1 = (n) => n.toFixed(1);
const okMarks = (marks) => marks.filter((m) => m.ok);
const jobsOf = (marks) => okMarks(marks).flatMap((m) => m.jobs.map((j) => ({ ...j, corpus: m.corpus, name: m.name })));

function totalsTable(jobs) {
  const today = jobs.reduce((n, j) => n + j.today.bytes, 0);
  const exhaustive = jobs.reduce((n, j) => n + j.exhaustive.bytes, 0);
  const binary = jobs.reduce((n, j) => n + j.binary.bytes, 0);
  const delta = (bytes) => (today ? pct1(((today - bytes) / today) * 100) : '0.0');
  return { today, exhaustive, binary, exhaustiveDelta: delta(exhaustive), binaryDelta: delta(binary) };
}

function writeReadme(results) {
  const { date, engine, marks } = results;
  const allJobs = jobsOf(marks);
  const failed = marks.filter((m) => !m.ok);

  const corpora = ['fixtures', 'open', 'private'].filter((c) => marks.some((m) => m.corpus === c));
  const perCorpus = corpora.map((corpus) => [corpus, totalsTable(allJobs.filter((j) => j.corpus === corpus))]);
  const kinds = ['ico', 'apple', 'icon'];
  const perKind = kinds
    .filter((k) => allJobs.some((j) => j.kind === k))
    .map((kind) => [kind, totalsTable(allJobs.filter((j) => j.kind === kind))]);

  const noPassCount = allJobs.filter((j) => j.exhaustive.pct > THRESHOLD_PCT).length;

  const encode512 = allJobs.filter((j) => j.px === 512).map((j) => j.timeMs.quantise);

  // Largest relative savings: today -> exhaustive, per mark (sum over its jobs), open and
  // fixtures only, by name. Private marks are reported as a count of how many would place
  // in that top 10 by the same measure, never by name.
  const perMarkSavings = okMarks(marks).map((m) => {
    const t = totalsTable(m.jobs.map((j) => ({ ...j, corpus: m.corpus, name: m.name })));
    const relative = t.today ? (t.today - t.exhaustive) / t.today : 0;
    return { corpus: m.corpus, name: m.name, today: t.today, exhaustive: t.exhaustive, relative };
  });
  const named = perMarkSavings.filter((m) => m.corpus !== 'private').toSorted((a, b) => b.relative - a.relative);
  const top10 = named.slice(0, 10);
  const threshold = top10.length ? top10[top10.length - 1].relative : 0;
  const privateInTop = perMarkSavings.filter((m) => m.corpus === 'private' && m.relative >= threshold).length;

  // Distribution of winning settings at >= 180px: colour-mode wins (quality 100) bucketed by
  // colour count, quality-mode wins (colour budget not actually constrained) bucketed by
  // quality instead, and reported separately so a colour count is never implied where the
  // winner wasn't actually colour-limited.
  const big = allJobs.filter((j) => j.px >= 180);
  const colourWins = new Map(),
    qualityWins = new Map();
  for (const j of big) {
    const s = j.exhaustive.setting;
    const target = s.quality === 100 ? colourWins : qualityWins;
    const key = s.quality === 100 ? s.colors : s.quality;
    target.set(key, (target.get(key) ?? 0) + 1);
  }

  const lines = [];
  lines.push('# Search sweep');
  lines.push('');
  lines.push(
    `Measured ${date}, with:`,
    '',
    '```',
    `@napi-rs/image  ${engine['@napi-rs/image']}`,
    `zopfli          ${engine.zopfli}`,
    `svgo            ${engine.svgo}`,
    '```',
    '',
  );
  lines.push(
    'For every raster a default build produces (ICO payload, apple-touch-icon, and the two ' +
      '`icon-<size>.png` sizes), this sweep tries every candidate in the search space and ' +
      'records the smallest one that passes the accuracy bar ' +
      `(\`pct <= ${THRESHOLD_PCT}%\`, test/lib/accuracy.mjs) two ways:`,
    '',
    '- **Exhaustive** — every candidate is tried; the smallest passing one wins, ties going to ' +
      'the less lossy setting (higher quality, then more colours).',
    '- **Binary** — the colour list and the quality list are each searched independently for ' +
      'the fewest colours / lowest quality that passes, assuming the list is monotone (a ' +
      'setting that passes is assumed to mean every less lossy setting on the same list also ' +
      'passes). The smaller of the two results wins; `probes` counts the encodes either ' +
      'search actually needed.',
    '',
    'The candidate space: quality in `[40, 50, 60, 70, 80, 90, 95, 98, 99]` at the default ' +
      'colour ceiling (encode ignores colours below quality 100), and quality 100 with colours ' +
      'in `[2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]`. If nothing on ' +
      'either list passes, both winners fall back to quality 100 / colours 256 (the lossless ' +
      'candidate) and report its measured `pct`, which is then above the bar.',
    '',
    'Today is the production default build’s own encode (quality 80), from the same ' +
      'in-memory run the candidates are measured against, so the comparison needs no second ' +
      'build.',
    '',
  );

  lines.push('## Totals by corpus', '');
  lines.push('| Corpus | Jobs | Today | Exhaustive | Δ | Binary | Δ |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const [corpus, t] of perCorpus) {
    const n = allJobs.filter((j) => j.corpus === corpus).length;
    lines.push(
      `| ${corpus} | ${n} | ${t.today.toLocaleString()} | ${t.exhaustive.toLocaleString()} | ${t.exhaustiveDelta}% | ${t.binary.toLocaleString()} | ${t.binaryDelta}% |`,
    );
  }
  lines.push('');

  lines.push('## Totals by raster kind', '');
  lines.push('| Kind | Jobs | Today | Exhaustive | Δ | Binary | Δ |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const [kind, t] of perKind) {
    const n = allJobs.filter((j) => j.kind === kind).length;
    lines.push(
      `| ${kind} | ${n} | ${t.today.toLocaleString()} | ${t.exhaustive.toLocaleString()} | ${t.exhaustiveDelta}% | ${t.binary.toLocaleString()} | ${t.binaryDelta}% |`,
    );
  }
  lines.push('');

  lines.push(
    `${noPassCount} of ${allJobs.length} jobs have no passing candidate on either list (the ` +
      'exhaustive winner is the quality-100/colours-256 fallback, scored above the bar).',
    '',
  );

  lines.push(
    `Encode time per 512px job (sum of its ${QUALITY_LIST.length + COLORS_LIST.length} candidate encodes): ` +
      `median ${Math.round(median(encode512))} ms, p95 ${Math.round(p95(encode512))} ms, over ${encode512.length} jobs.`,
    '',
  );

  lines.push('## Largest relative savings (today → exhaustive)', '');
  lines.push('| Mark | Today | Exhaustive | Saved |', '|---|---:|---:|---:|');
  for (const m of top10) {
    lines.push(
      `| ${m.corpus}/${m.name} | ${m.today.toLocaleString()} | ${m.exhaustive.toLocaleString()} | ${pct1(m.relative * 100)}% |`,
    );
  }
  lines.push(
    '',
    `${privateInTop} private mark(s) would also place in this top 10 by the same relative-savings measure.`,
    '',
  );

  lines.push('## Winning colour counts at >= 180px', '');
  lines.push(
    'Colour-mode wins (quality 100) are bucketed by their winning colour count; quality-mode ' +
      "wins are bucketed by quality instead, since their colour budget wasn't the constraint.",
    '',
  );
  lines.push('| Colours | Jobs |', '|---:|---:|');
  for (const colors of [...colourWins.keys()].toSorted((a, b) => a - b))
    lines.push(`| ${colors} | ${colourWins.get(colors)} |`);
  lines.push('', '| Quality (colour-unconstrained) | Jobs |', '|---:|---:|');
  for (const quality of [...qualityWins.keys()].toSorted((a, b) => a - b))
    lines.push(`| ${quality} | ${qualityWins.get(quality)} |`);
  lines.push('');

  if (failed.length) {
    lines.push('## Marks excluded (failed to build)', '');
    lines.push('| Mark | Error |', '|---|---|');
    for (const m of failed) lines.push(`| ${m.corpus}/${m.name} | ${m.error} |`);
    lines.push('');
  }

  lines.push(
    '## Reproduce',
    '',
    '```sh',
    'node bench/corpus/fetch.mjs',
    'node bench/search.mjs --private DIR --write',
    '```',
    '',
    '`--private` falls back to `FAVSEED_PRIVATE_CORPUS`; omit it (or pass `--no-open`) for a ' +
      'fixtures-only run. Raw per-candidate results are in the gitignored ' +
      '`bench/out/search/results.json`; this file is the committed summary.',
    '',
  );

  writeFileSync(README, lines.join('\n'));
}

main().catch((e) => {
  process.stderr.write(`favseed search: ${e.message}\n`);
  process.exit(1);
});
