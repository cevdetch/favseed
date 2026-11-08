#!/usr/bin/env node
// The search sweep: for every raster a default build produces, measure the smallest encode
// that still passes the accuracy bar, two ways — an exhaustive sweep of every candidate
// setting, and the binary search a lower-effort search would actually run. Results land in
// bench/out/search/results.json (gitignored); --write regenerates the committed
// bench/search/README.md from them.
//
//   node bench/search.mjs                         fixtures + open corpus (+ FAVSEED_PRIVATE_CORPUS, if set)
//   node bench/search.mjs --no-open                fixtures only, unless a private corpus is set
//   node bench/search.mjs --private DIR --write    + a private corpus, written to the README
//   node bench/search.mjs --summarise --write      recompute winners from the stored candidates
//                                                   in results.json, no encoding — see below
//
// --private falls back to FAVSEED_PRIVATE_CORPUS; omitting both flags does not mean
// "fixtures only" if that variable is set. --summarise never touches a corpus or an engine: it
// rereads bench/out/search/results.json, recomputes `exhaustive` and `binary` from each job's
// already-stored `candidates` (the costly part — encoding and scoring every candidate — is not
// repeated), and rewrites results.json and the README. Useful after a change to the winner
// rule alone, so a 15-minute sweep does not have to run again for it.
//
// A private mark's real name never appears anywhere here: corpusFiles() already hands back
// `private-N` labels, and that label — never the path — is what gets passed to captureJobs and
// printed to stderr. A build or measurement failure is caught per mark (never left to crash the
// whole sweep) and its message is scrubbed of the real path before it is recorded.
//
// Candidates per job: quality in [40, 50, 60, 70, 80, 90, 95, 98, 99] at the default colour
// ceiling (encode ignores colours below quality 100), and quality 100 with colours in
// [2..256]. Both lists ascend in the direction a pass gets more likely, which the binary
// searches below assume (monotone pass/fail) rather than verify — see the binary winner rule
// just below for why that assumption alone is not enough to pick the winner.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

const QUALITY_LIST = [40, 50, 60, 70, 80, 90, 95, 98, 99];
const COLORS_LIST = [2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

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

/**
 * Every candidate a leftmost-pass binary search actually visits on a monotone-assumed
 * (ascending-pass-likelihood) list, in probe order.
 */
function binaryProbe(list) {
  let lo = 0,
    hi = list.length - 1;
  const probed = [];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    probed.push(list[mid]);
    if (passes(list[mid])) hi = mid - 1;
    else lo = mid + 1;
  }
  return probed;
}

/**
 * The binary winner is NOT "the leftmost passing index", because the search space is not
 * actually monotone in bytes. At colours=2 the quantiser can produce a 1-bit PNG far larger
 * than colours=3 (a flat icon at 512px: colours=2 at 3,949 B vs colours=3 at 1,427 B —
 * `engine.encode` falls back to its lossless path there, which trivially passes the accuracy
 * bar). "Fewest passing colours" then names colours=2, the bigger file —
 * exactly backwards for a search that exists to find the smaller one. Any "first setting that
 * passes" policy on this list inherits the same quirk.
 *
 * So the winner is the smallest-bytes passing candidate among every candidate EITHER binary
 * search actually probed (same two searches, same probe count — no extra encodes), tie-broken
 * exactly like the exhaustive winner. Both searches still run to find the probes; this only
 * changes which of those already-measured candidates gets reported as the pick.
 */
function binaryWinner(qualityCandidates, colourCandidates, fallback) {
  const probed = [...binaryProbe(qualityCandidates), ...binaryProbe(colourCandidates)];
  const passing = probed.filter(passes);
  const winner = passing.length
    ? passing.reduce((best, c) => {
        if (c.bytes !== best.bytes) return c.bytes < best.bytes ? c : best;
        return lessLossy(c, best) ? c : best;
      })
    : fallback;
  return { setting: winner.setting, bytes: winner.bytes, pct: winner.pct, probes: probed.length };
}

// -------------------------------------------------------------------- jobs --

/**
 * Both winners from one job's full candidate list (quality group first, colour group second —
 * the same split `measureJob` builds and the same one `candidates` is stored in). Shared with
 * `--summarise`, which recomputes only this from already-measured candidates.
 */
function winnersFor(candidates) {
  const qualityCandidates = candidates.slice(0, QUALITY_LIST.length);
  const colourCandidates = candidates.slice(QUALITY_LIST.length);
  // The colour list's last entry, quality 100 / colors 256, is the "lossless" fallback both
  // winners retreat to when no candidate on either list passes.
  const fallback = colourCandidates[colourCandidates.length - 1];
  return {
    exhaustive: exhaustiveWinner(candidates, fallback),
    binary: binaryWinner(qualityCandidates, colourCandidates, fallback),
  };
}

/** One job: today's bytes, every candidate, and both winners. */
async function measureJob(job, engine) {
  const ref = await job.reference;
  const todayPct = score(decode(Buffer.from(job.today)), ref).pct;

  const candidates = [];
  let quantiseMs = 0,
    scoreMs = 0;
  const measure = async (setting) => {
    const t0 = performance.now();
    const bytes = await engine.encode(job.raw, setting);
    quantiseMs += performance.now() - t0;
    const t1 = performance.now();
    const pct = score(decode(Buffer.from(bytes)), ref).pct;
    scoreMs += performance.now() - t1;
    candidates.push({ setting, bytes: bytes.length, pct });
  };
  for (const quality of QUALITY_LIST) await measure({ quality, colors: DEFAULT_COLORS });
  for (const colors of COLORS_LIST) await measure({ quality: 100, colors });

  return {
    kind: job.kind,
    px: job.px,
    today: { bytes: job.today.length, pct: todayPct },
    candidates,
    ...winnersFor(candidates),
    timeMs: { quantise: Math.round(quantiseMs), score: Math.round(scoreMs) },
  };
}

// --------------------------------------------------------------------- CLI --

function parseArgs(argv) {
  let privateDir = process.env.FAVSEED_PRIVATE_CORPUS || null;
  let open = true;
  let write = false;
  let doSummarise = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--private') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--private needs a directory');
      privateDir = value;
      i++;
    } else if (a === '--no-open') {
      open = false;
    } else if (a === '--write') {
      write = true;
    } else if (a === '--summarise') {
      doSummarise = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { privateDir, open, write, summarise: doSummarise };
}

/** First line of an error, with every occurrence of a real path swapped for its corpus label. */
const sanitiseError = (error, file) =>
  String(error?.message ?? error)
    .split('\n')[0]
    .split(file.path)
    .join(file.name);

async function sweep({ privateDir, open }) {
  const engine = await loadEngine();
  const files = await corpusFiles({ private: privateDir, open, fixtures: true });
  const marks = [];
  const started = Date.now();
  for (const [i, file] of files.entries()) {
    process.stderr.write(`search: ${i + 1}/${files.length} ${file.corpus}/${file.name}\n`);
    try {
      const captured = await captureJobs(file.path, { name: file.name });
      if (!captured.ok) {
        // captureJobs already scrubs its own error; sanitise again here as a
        // second line of defence, since nothing about results.json or the README should ever
        // have to trust a single call site to have gotten that right.
        marks.push({ corpus: file.corpus, name: file.name, ok: false, error: sanitiseError(captured.error, file) });
        continue;
      }
      const jobs = [];
      for (const job of captured.jobs) jobs.push(await measureJob(job, engine));
      marks.push({ corpus: file.corpus, name: file.name, ok: true, jobs });
    } catch (error) {
      // A rejected reference render or an encode failure is a per-mark problem (one bad SVG
      // in a 142-mark corpus), never a reason to lose the rest of a 15-minute sweep.
      marks.push({ corpus: file.corpus, name: file.name, ok: false, error: sanitiseError(error, file) });
    }
  }
  process.stderr.write(`search: ${files.length} marks in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  return { date: new Date().toISOString().slice(0, 10), engine: engineVersions(), marks };
}

/**
 * Recompute `exhaustive` and `binary` for every job from its already-stored `candidates`, with
 * no engine and no corpus — for a winner-rule change that does not need the encodes repeated.
 */
function summarise(results) {
  for (const mark of results.marks) {
    if (!mark.ok) continue;
    for (const job of mark.jobs) Object.assign(job, winnersFor(job.candidates));
  }
  return results;
}

async function main() {
  const resultsPath = join(OUT_DIR, 'results.json');
  const args = parseArgs(process.argv.slice(2));
  const results = args.summarise ? summarise(JSON.parse(readFileSync(resultsPath, 'utf8'))) : await sweep(args);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
  // --summarise exists to rewrite the README from a corrected winner rule without re-running
  // the sweep, so it always rewrites it, --write or not.
  if (args.write || args.summarise) writeReadme(results);
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

  // Today's own (quality 80) encode can miss the bar on more rasters than "no candidate on
  // either list passes" — some other setting the default build doesn't choose still passes.
  // Private is reported as a count only, like everywhere else a mark could be singled out.
  const todayMissByCorpus = {};
  for (const j of allJobs)
    if (j.today.pct > THRESHOLD_PCT) todayMissByCorpus[j.corpus] = (todayMissByCorpus[j.corpus] ?? 0) + 1;
  const todayMissTotal = Object.values(todayMissByCorpus).reduce((a, b) => a + b, 0);

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
    '- **Binary** — the colour list and the quality list are each searched independently with a ' +
      'leftmost-passing binary search, assuming the list is monotone (a setting that passes is ' +
      'assumed to mean every less lossy setting on the same list also passes — a cost model for ' +
      'the search itself, not a claim either list is actually sorted by file size). The winner ' +
      'is **the smallest-bytes passing candidate among every candidate either search actually ' +
      'probed** — not "the leftmost passing index" (see the quirk below for why) — tie-broken ' +
      'exactly like the exhaustive winner. `probes` counts those encodes, already measured; no ' +
      'extra encoding happens to pick the winner.',
    '',
    'The candidate space: quality in `[40, 50, 60, 70, 80, 90, 95, 98, 99]` at the default ' +
      'colour ceiling (encode ignores colours below quality 100), and quality 100 with colours ' +
      'in `[2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]`. If nothing on ' +
      'either list passes, both winners fall back to quality 100 / colours 256 (the lossless ' +
      'candidate) and report its measured `pct`, which is then above the bar.',
    '',
    '**The colours=2 quirk.** `engine.encode` keeps the smaller of a quantised and a lossless ' +
      'encode, and at colours=2 the quantised (1-bit) PNG can be *several times larger* than ' +
      'colours=3 — a flat 512px icon measured here: colours=2 is 3,949 B (the lossless path won, ' +
      'because the 1-bit quantised file was bigger still) against colours=3 at 1,427 B, both ' +
      'passing the bar. The colour list is therefore not monotone in bytes, only in pass/fail, ' +
      'and "fewest passing colours" or any other first-match policy on it would report the ' +
      'colours=2 file as the win — several times the size of a setting right next to it on the ' +
      'same list. The binary winner rule above exists because of exactly this: it picks the ' +
      'smallest of what the search actually looked at, not the first thing that passed.',
    '',
    'Today is the production default build’s own encode (quality 80), from the same ' +
      'in-memory run the candidates are measured against, so the comparison needs no second ' +
      'build.',
    '',
  );

  lines.push('## Totals by corpus', '');
  lines.push('| Corpus | Jobs | Today | Exhaustive | Saved | Binary | Saved |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const [corpus, t] of perCorpus) {
    const n = allJobs.filter((j) => j.corpus === corpus).length;
    lines.push(
      `| ${corpus} | ${n} | ${t.today.toLocaleString()} | ${t.exhaustive.toLocaleString()} | ${t.exhaustiveDelta}% | ${t.binary.toLocaleString()} | ${t.binaryDelta}% |`,
    );
  }
  lines.push('');

  lines.push('## Totals by raster kind', '');
  lines.push('| Kind | Jobs | Today | Exhaustive | Saved | Binary | Saved |', '|---|---:|---:|---:|---:|---:|---:|');
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
    `Today's default (quality 80) itself misses the bar outright on ${todayMissTotal} of ${allJobs.length} ` +
      `rasters — fixtures ${todayMissByCorpus.fixtures ?? 0}, open ${todayMissByCorpus.open ?? 0}, ` +
      `private ${todayMissByCorpus.private ?? 0} (count only). ${noPassCount} of those ${allJobs.length} ` +
      'rasters also have no passing candidate anywhere on either list (the line above); the ' +
      "remainder pass under a setting the default build doesn't choose.",
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
    '`--private` falls back to `FAVSEED_PRIVATE_CORPUS`. Omitting `--private` does **not** mean ' +
      'fixtures-only: the open corpus still runs by default, and `FAVSEED_PRIVATE_CORPUS` (if ' +
      'set in the environment) is still picked up with no flag at all. A fixtures-only run ' +
      'needs `--no-open` *and* no private corpus available either way (no `--private`, and ' +
      '`FAVSEED_PRIVATE_CORPUS` unset). Raw per-candidate results are in the gitignored ' +
      '`bench/out/search/results.json`; this file is the committed summary. ' +
      '`node bench/search.mjs --summarise --write` rewrites both of those from the stored ' +
      'candidates alone — no corpus, no engine, no re-encoding — for when only the winner ' +
      'rule changes.',
    '',
  );

  writeFileSync(README, lines.join('\n'));
}

/**
 * True when this file is the program, false when it was imported, so the module stays
 * importable without running a sweep. Mirrors
 * bin/favseed.mjs's isEntryPoint: realpath on both sides so a symlinked invocation still
 * matches, and no import.meta.main (arrived after this repo's Node floor).
 */
const isEntryPoint = (url) => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
};

if (isEntryPoint(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`favseed search: ${e.message}\n`);
    process.exit(1);
  });
}
