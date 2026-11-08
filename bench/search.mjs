#!/usr/bin/env node
// The search sweep: for every raster a default build produces, measure the smallest encode
// that still passes the accuracy bar, two ways — an exhaustive sweep of every candidate
// setting, and the binary search a lower-effort search would actually run.
//
// The gate is the shipped one, lib/quality.mjs's passesBar: pct <= ACCURACY_PCT (the
// pixel-distance share test/lib/accuracy.mjs's score() also reports) AND edge <= EDGE_GATE (an
// edge-weighted luma error; see lib/quality.mjs for why a second metric joins the first one).
// Every candidate also keeps a bar-only verdict (pct alone, the gate before the edge metric
// shipped), so the README can report what the edge gate costs over the bar-only winner rather
// than only what ships today.
//
// Results land in
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
// rule alone, so a ~42-minute sweep does not have to run again for it.
//
// A private mark's real name never appears anywhere here: corpusFiles() already hands back
// `private-N` labels, and that label — never the path — is what gets passed to captureJobs and
// printed to stderr. A build or measurement failure is caught per mark (never left to crash the
// whole sweep) and its message is scrubbed of the real path before it is recorded.
//
// Candidates per job: quality in SEARCH_QUALITIES (lib/core.mjs) at the default colour
// ceiling (encode ignores colours below quality 100), and quality 100 with colours in
// SEARCH_COLORS. Both lists ascend in the direction a pass gets more likely, which the binary
// searches below assume (monotone pass/fail) rather than verify — see the binary winner rule
// just below for why that assumption alone is not enough to pick the winner. These are the
// exact lists lib/engine.mjs's search() walks — not a private copy — so the sweep's candidate
// space can never drift from the shipped one.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineVersions, loadEngine } from '../bin/favseed.mjs';
import {
  ACCURACY_PCT,
  DEFAULT_COLORS,
  DEFAULT_QUALITY,
  EDGE_GATE,
  SEARCH_COLORS,
  SEARCH_QUALITIES,
} from '../lib/core.mjs';
import { passesBar, prepareReference } from '../lib/quality.mjs';
import { decode } from '../test/lib/png.mjs';
import { corpusFiles } from './corpus/files.mjs';
import { captureJobs } from './jobs.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_DIR = join(ROOT, 'bench/out/search');
const README = join(ROOT, 'bench/search/README.md');

const QUALITY_LIST = SEARCH_QUALITIES;
const COLORS_LIST = SEARCH_COLORS;

// test/lib/png.mjs's decode() returns { width, height, data }; lib/quality.mjs's passesBar
// takes { width, height, rgba } (the engine's renderRgba shape). One adapter at the call site,
// rather than teaching lib/quality.mjs a second shape it would carry forever.
const asQualityImage = ({ width, height, data }) => ({ width, height, rgba: data });

// ------------------------------------------------------------------ winners --

// The gate before the edge metric shipped: pct alone. Kept so the README can show what the
// edge gate costs over it, never used to decide what the sweep itself reports as "the" winner.
const barOnlyPasses = (c) => c.pct <= ACCURACY_PCT;
// The shipped gate, lib/quality.mjs's passesBar, recomputed from the same pct/edge numbers
// every candidate already carries rather than re-run per lookup.
const passes = (c) => c.pct <= ACCURACY_PCT && c.edge <= EDGE_GATE;

/** True if `a` is the less-lossy of a tie: the exhaustive/binary tie rule. */
const lessLossy = (a, b) =>
  a.setting.quality !== b.setting.quality ? a.setting.quality > b.setting.quality : a.setting.colors > b.setting.colors;

/** Smallest bytes passing `passFn`; ties go to the less-lossy setting. `passFn` is `passes`
 * (the shipped gate) or `barOnlyPasses` (the gate before the edge metric), so every winner
 * below is computed identically both ways. */
function exhaustiveWinner(candidates, fallback, passFn) {
  const passing = candidates.filter(passFn);
  if (!passing.length) return fallback;
  return passing.reduce((best, c) => {
    if (c.bytes !== best.bytes) return c.bytes < best.bytes ? c : best;
    return lessLossy(c, best) ? c : best;
  });
}

/**
 * Every candidate a leftmost-pass binary search actually visits on a monotone-assumed
 * (ascending-pass-likelihood) list, in probe order. `passFn` decides each probe's pass/fail,
 * so the bar-only walk and the gated walk can visit different candidates on the same list —
 * exactly as a bar-only search and the shipped search would.
 */
function binaryProbe(list, passFn) {
  let lo = 0,
    hi = list.length - 1;
  const probed = [];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    probed.push(list[mid]);
    if (passFn(list[mid])) hi = mid - 1;
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
function binaryWinner(qualityCandidates, colourCandidates, fallback, passFn) {
  const probed = [...binaryProbe(qualityCandidates, passFn), ...binaryProbe(colourCandidates, passFn)];
  const passing = probed.filter(passFn);
  const winner = passing.length
    ? passing.reduce((best, c) => {
        if (c.bytes !== best.bytes) return c.bytes < best.bytes ? c : best;
        return lessLossy(c, best) ? c : best;
      })
    : fallback;
  return { setting: winner.setting, bytes: winner.bytes, pct: winner.pct, edge: winner.edge, probes: probed.length };
}

// -------------------------------------------------------------------- jobs --

/**
 * Both gates' winners from one job's full candidate list (quality group first, colour group
 * second — the same split `measureJob` builds and the same one `candidates` is stored in).
 * Shared with `--summarise`, which recomputes only this from already-measured candidates.
 *
 * `exhaustive`/`binary` are the shipped gate (pct and edge, lib/quality.mjs's passesBar);
 * `exhaustiveBarOnly`/`binaryBarOnly` are the same two searches run against pct alone, kept so
 * the README can report what the edge gate costs over them.
 *
 * When nothing on a gate's list passes, that gate's winners are today's own encode — the
 * default setting, today's bytes, pct and edge — since a search that finds no passing
 * candidate would ship what the default build already ships, not some other failing file.
 */
function winnersFor(candidates, today) {
  const qualityCandidates = candidates.slice(0, QUALITY_LIST.length);
  const colourCandidates = candidates.slice(QUALITY_LIST.length);
  const fallback = {
    setting: { quality: DEFAULT_QUALITY, colors: DEFAULT_COLORS },
    bytes: today.bytes,
    pct: today.pct,
    edge: today.edge,
  };
  return {
    exhaustive: exhaustiveWinner(candidates, fallback, passes),
    exhaustiveBarOnly: exhaustiveWinner(candidates, fallback, barOnlyPasses),
    binary: binaryWinner(qualityCandidates, colourCandidates, fallback, passes),
    binaryBarOnly: binaryWinner(qualityCandidates, colourCandidates, fallback, barOnlyPasses),
  };
}

/** One job: today's bytes, every candidate (pct and edge both), and all four winners. */
async function measureJob(job, engine) {
  const ref = prepareReference(asQualityImage(await job.reference));
  const todayBar = passesBar(asQualityImage(decode(Buffer.from(job.today))), ref);

  const candidates = [];
  let quantiseMs = 0,
    scoreMs = 0;
  const measure = async (setting) => {
    const t0 = performance.now();
    const bytes = await engine.encode(job.raw, setting);
    quantiseMs += performance.now() - t0;
    const t1 = performance.now();
    const { pct, edge } = passesBar(asQualityImage(decode(Buffer.from(bytes))), ref);
    scoreMs += performance.now() - t1;
    candidates.push({ setting, bytes: bytes.length, pct, edge });
  };
  for (const quality of QUALITY_LIST) await measure({ quality, colors: DEFAULT_COLORS });
  for (const colors of COLORS_LIST) await measure({ quality: 100, colors });

  const today = { bytes: job.today.length, pct: todayBar.pct, edge: todayBar.edge };
  return {
    kind: job.kind,
    px: job.px,
    today,
    candidates,
    ...winnersFor(candidates, today),
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
      // in a 142-mark corpus), never a reason to lose the rest of a ~42-minute sweep.
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
    for (const job of mark.jobs) Object.assign(job, winnersFor(job.candidates, job.today));
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

const sortedOf = (values) => values.toSorted((a, b) => a - b);
const median = (values) => {
  const sorted = sortedOf(values),
    mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0;
};
const p95 = (values) => {
  if (!values.length) return 0;
  const sorted = sortedOf(values);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const pct1 = (n) => n.toFixed(1);
const ms = (n) => Math.round(n).toLocaleString();
const okMarks = (marks) => marks.filter((m) => m.ok);
const jobsOf = (marks) => okMarks(marks).flatMap((m) => m.jobs.map((j) => ({ ...j, corpus: m.corpus, name: m.name })));
const jobLabel = (j) => `${j.corpus}/${j.name} ${j.kind}-${j.px}`;
const CANDIDATES = QUALITY_LIST.length + COLORS_LIST.length;

// `exhaustiveKey`/`binaryKey` default to the shipped gate (pct and edge); pass the BarOnly
// pair to total the gate that shipped before the edge metric, for the edge-gate-cost section.
function totalsTable(jobs, { exhaustiveKey = 'exhaustive', binaryKey = 'binary' } = {}) {
  const today = jobs.reduce((n, j) => n + j.today.bytes, 0);
  const exhaustive = jobs.reduce((n, j) => n + j[exhaustiveKey].bytes, 0);
  const binary = jobs.reduce((n, j) => n + j[binaryKey].bytes, 0);
  const delta = (bytes) => (today ? pct1(((today - bytes) / today) * 100) : '0.0');
  return { n: jobs.length, today, exhaustive, binary, exhaustiveDelta: delta(exhaustive), binaryDelta: delta(binary) };
}

const TOTALS_HEAD = ['| Jobs | Today | Exhaustive | Saved | Binary | Saved |', '|---:|---:|---:|---:|---:|---:|'];
const totalsRow = (label, t) =>
  `| ${label} | ${t.n} | ${t.today.toLocaleString()} | ${t.exhaustive.toLocaleString()} | ${t.exhaustiveDelta}% | ` +
  `${t.binary.toLocaleString()} | ${t.binaryDelta}% |`;
const totalsLines = (heading, rows) => [
  `| ${heading} ${TOTALS_HEAD[0]}`,
  `|---${TOTALS_HEAD[1]}`,
  ...rows.map(([label, t]) => totalsRow(label, t)),
  '',
];

/**
 * Where a list breaks monotone pass/fail: the first passing value, and every value after it
 * that fails again. `null` when the list is monotone (or never passes).
 */
function monotoneBreak(candidates, key) {
  const first = candidates.findIndex(passes);
  if (first < 0) return null;
  const failsAfter = candidates.slice(first + 1).filter((c) => !passes(c));
  return failsAfter.length
    ? { passAt: candidates[first].setting[key], failsAt: failsAfter.map((c) => c.setting[key]) }
    : null;
}
const joinAnd = (values) =>
  values.length < 2 ? `${values[0]}` : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;

const inCorpus = (jobs, corpus) => jobs.filter((j) => j.corpus === corpus);

/** Per-corpus counts as "fixtures A, open B, private C" for the corpora present. */
const byCorpus = (corpora, jobs) => corpora.map((c) => `${c} ${jobs.filter((j) => j.corpus === c).length}`).join(', ');

function writeReadme(results) {
  const { date, engine, marks } = results;
  const allJobs = jobsOf(marks);
  const failed = marks.filter((m) => !m.ok);
  const corpora = ['fixtures', 'open', 'private'].filter((c) => marks.some((m) => m.corpus === c));

  // Today's own encode is the quality-80 candidate, so a job where it passes always has a
  // passing candidate no larger than today: those totals are pure savings. A job where today
  // misses the bar either has a passing candidate (which can cost bytes: pay to pass) or keeps
  // today's bytes, unchanged and still over the bar.
  const todayIsCandidate = allJobs.filter((j) =>
    j.candidates.some(
      (c) =>
        c.setting.quality === DEFAULT_QUALITY &&
        c.bytes === j.today.bytes &&
        c.pct === j.today.pct &&
        c.edge === j.today.edge,
    ),
  ).length;
  // "Passes" is the shipped gate throughout this file: pct <= ACCURACY_PCT AND
  // edge <= EDGE_GATE. See "The edge gate's cost" below for what it costs over pct alone.
  const todayPasses = allJobs.filter((j) => passes(j.today));
  const todayMisses = allJobs.filter((j) => !passes(j.today));
  const fixed = todayMisses.filter((j) => passes(j.exhaustive));
  const unfixed = todayMisses.filter((j) => !passes(j.exhaustive));
  const binaryFixed = todayMisses.filter((j) => passes(j.binary));
  const fixedTotals = totalsTable(fixed);

  // Today misses the gated bar for one of two reasons: pct alone already failed, or pct passed
  // and only the edge metric failed it. The second group is new work the edge gate did that a
  // bar-only build would have shipped unnoticed.
  const todayEdgeOnlyMisses = todayMisses.filter((j) => barOnlyPasses(j.today));

  const kinds = ['ico', 'apple', 'icon'].filter((k) => allJobs.some((j) => j.kind === k));
  const perKind = kinds.map((kind) => [kind, totalsTable(allJobs.filter((j) => j.kind === kind))]);

  // Monotone pass/fail, per list: the binary search assumes it, so say how often it holds.
  const breaks = (key, slice) =>
    allJobs.map((j) => ({ job: j, at: monotoneBreak(slice(j.candidates), key) })).filter((b) => b.at);
  const colourBreaks = breaks('colors', (c) => c.slice(QUALITY_LIST.length));
  const qualityBreaks = breaks('quality', (c) => c.slice(0, QUALITY_LIST.length));
  const namedColourBreaks = colourBreaks.filter((b) => b.job.corpus !== 'private');
  const privateColourBreaks = colourBreaks.length - namedColourBreaks.length;

  // Binary against exhaustive: how often it misses the smallest passing file, by how much, and
  // what it costs. Private jobs are counted, never named.
  // Only where both pass: a job binary leaves unfixed is counted with the today-misses instead.
  const gaps = allJobs
    .filter((j) => passes(j.binary) && j.binary.bytes !== j.exhaustive.bytes)
    .map((j) => ({ job: j, gap: (j.binary.bytes - j.exhaustive.bytes) / j.exhaustive.bytes }));
  const namedGaps = gaps.filter((g) => g.job.corpus !== 'private').toSorted((a, b) => b.gap - a.gap);
  const worstGap = namedGaps[0];
  const privateGaps = gaps.filter((g) => g.job.corpus === 'private');
  const privateAboveWorst = worstGap ? privateGaps.filter((g) => g.gap > worstGap.gap).length : 0;
  const gapBytes = gaps.reduce((n, g) => n + g.job.binary.bytes - g.job.exhaustive.bytes, 0);
  const probes = allJobs.map((j) => j.binary.probes);

  // Time per 512px job. results.json stores each job's summed encode and score time over all
  // its candidates, not per candidate, so one encode (today) and a binary search's probes are
  // estimated from the per-candidate mean; the exhaustive figures are measured.
  const at512 = allJobs.filter((j) => j.px === 512);
  const perCandidate = (j, key) => j.timeMs[key] / CANDIDATES;
  const timeRows = [
    ['today (1 encode, estimate)', at512.map((j) => perCandidate(j, 'quantise')), at512.map(() => 0)],
    [
      'binary (its probes, estimate)',
      at512.map((j) => perCandidate(j, 'quantise') * j.binary.probes),
      at512.map((j) => perCandidate(j, 'score') * j.binary.probes),
    ],
    [`exhaustive (all ${CANDIDATES}, measured)`, at512.map((j) => j.timeMs.quantise), at512.map((j) => j.timeMs.score)],
  ];

  // Largest relative savings: today -> exhaustive, per mark (sum over its jobs), open and
  // fixtures only, by name. Private marks are reported as a count of how many would place
  // in that top 10 by the same measure, never by name.
  const perMarkSavings = okMarks(marks).map((m) => {
    const t = totalsTable(m.jobs);
    const relative = t.today ? (t.today - t.exhaustive) / t.today : 0;
    return { corpus: m.corpus, name: m.name, today: t.today, exhaustive: t.exhaustive, relative };
  });
  const named = perMarkSavings.filter((m) => m.corpus !== 'private').toSorted((a, b) => b.relative - a.relative);
  const top10 = named.slice(0, 10);
  const threshold = top10.length ? top10.at(-1).relative : 0;
  const privateInTop = perMarkSavings.filter((m) => m.corpus === 'private' && m.relative >= threshold).length;

  // Distribution of winning settings at >= 180px: colour-mode wins (quality 100) bucketed by
  // colour count, quality-mode wins (colour budget not actually constrained) bucketed by
  // quality instead, and reported separately so a colour count is never implied where the
  // winner wasn't actually colour-limited. Jobs with no passing candidate are left out: their
  // "winner" is today's default setting, not a search result.
  const big = allJobs.filter((j) => j.px >= 180);
  const bigSearched = big.filter((j) => passes(j.exhaustive));
  const colourWins = new Map(),
    qualityWins = new Map();
  for (const j of bigSearched) {
    const s = j.exhaustive.setting;
    const target = s.quality === 100 ? colourWins : qualityWins;
    const key = s.quality === 100 ? s.colors : s.quality;
    target.set(key, (target.get(key) ?? 0) + 1);
  }

  // The fixture misses, named: they are expected to be the suite's accepted ICO exception.
  const fixtureMisses = inCorpus(todayMisses, 'fixtures');
  const acceptedIco = new Set(['grid-1', 'grid-tiny']);
  const fixtureMissesAccepted =
    fixtureMisses.length > 0 && fixtureMisses.every((j) => j.kind === 'ico' && acceptedIco.has(j.name));

  // The edge gate's own cost: totals under the shipped gate (pct and edge) against the same
  // two searches run with pct alone, and how many jobs the extra metric actually moved — a
  // winner that costs bytes, not just a different number on an unmoved one.
  const barOnlyTotals = totalsTable(allJobs, { exhaustiveKey: 'exhaustiveBarOnly', binaryKey: 'binaryBarOnly' });
  const gatedTotals = totalsTable(allJobs);
  const edgeMoved = (gatedKey, barKey) => allJobs.filter((j) => j[gatedKey].bytes !== j[barKey].bytes);
  const exhaustiveMoved = edgeMoved('exhaustive', 'exhaustiveBarOnly');
  const binaryMoved = edgeMoved('binary', 'binaryBarOnly');
  const movedCost = (moved, gatedKey, barKey) => moved.reduce((n, j) => n + (j[gatedKey].bytes - j[barKey].bytes), 0);
  const exhaustiveMovedCost = movedCost(exhaustiveMoved, 'exhaustive', 'exhaustiveBarOnly');
  const binaryMovedCost = movedCost(binaryMoved, 'binary', 'binaryBarOnly');
  const edgeDelta = (gated, bar) => (bar ? pct1(((gated - bar) / bar) * 100) : '0.0');

  const lines = [];
  lines.push('# Search sweep', '');
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
      'records the smallest one that passes the shipped accuracy bar — ' +
      `\`pct <= ${ACCURACY_PCT}%\` AND \`edge <= ${EDGE_GATE}\` (lib/quality.mjs's \`passesBar\`, ` +
      "the same gate `lib/engine.mjs`'s `search()` runs) — two ways:",
    '',
    '- **Exhaustive** — every candidate is tried; the smallest passing one wins, ties going to ' +
      'the less lossy setting (higher quality, then more colours).',
    '- **Binary** — the colour list and the quality list are each searched independently with a ' +
      'leftmost-passing binary search, assuming the list is monotone in pass/fail (a setting ' +
      'that passes is assumed to mean every less lossy setting on the same list also passes — a ' +
      'cost model for the search itself; see below for how often that holds). The winner is ' +
      '**the smallest-bytes passing candidate among every candidate either search actually ' +
      'probed** — not "the leftmost passing index" (see the quirk below for why) — tie-broken ' +
      'exactly like the exhaustive winner. `probes` counts those encodes, already measured; no ' +
      'extra encoding happens to pick the winner.',
    '',
    `The candidate space: quality in \`[${QUALITY_LIST.join(', ')}]\` at the default colour ` +
      'ceiling (encode ignores colours below quality 100), and quality 100 with colours in ' +
      `\`[${COLORS_LIST.join(', ')}]\` — lib/core.mjs's \`SEARCH_QUALITIES\`/\`SEARCH_COLORS\`, the ` +
      'exact lists the shipped search walks, not a private copy. Every candidate is ' +
      "`engine.encode`'s own output, the smaller of a quantised and a lossless encode, exactly " +
      "as a build would make it. If nothing on either list passes, both winners are today's own " +
      `encode: the default setting (quality ${DEFAULT_QUALITY}, colours ${DEFAULT_COLORS}), ` +
      "today's bytes, pct and edge, which are then above the bar. Each candidate also keeps a " +
      'bar-only verdict (`pct` alone, the gate before `edge` shipped); "the edge gate\'s cost" ' +
      'below reports what the second metric changes.',
    '',
    `Today is the production default build's own encode (quality ${DEFAULT_QUALITY}), from the ` +
      'same in-memory run the candidates are measured against, so the comparison needs no ' +
      'second build. ' +
      (todayIsCandidate === allJobs.length
        ? `It is also the quality-${DEFAULT_QUALITY} candidate, byte for byte, on all ${allJobs.length} jobs, so ` +
          'wherever today passes, the exhaustive winner is never larger than today.'
        : `It matches the quality-${DEFAULT_QUALITY} candidate on only ${todayIsCandidate} of ${allJobs.length} jobs.`),
    '',
  );

  lines.push(
    '**The colours=2 quirk.** At colours=2 the quantised (1-bit) PNG can be *larger* than the ' +
      'lossless encode, and the candidate is then the lossless file: a flat 512px icon measured ' +
      'here is 3,949 B at colours=2 against 1,427 B at colours=3, both passing the bar. The ' +
      'colour list is therefore not monotone in bytes, and "fewest passing colours" or any other ' +
      'first-match policy on it would report the colours=2 file as the win — several times the ' +
      'size of a setting right next to it on the same list. The binary winner rule above exists ' +
      'because of exactly this: it picks the smallest of what the search actually looked at, not ' +
      'the first thing that passed.',
    '',
    `**Monotone pass/fail.** The quality list is monotone on ${allJobs.length - qualityBreaks.length} ` +
      `of ${allJobs.length} jobs. The colour list is not quite: on ${colourBreaks.length} of ` +
      `${allJobs.length} jobs a colour count passes and a higher one fails again ` +
      `(${byCorpus(
        corpora,
        colourBreaks.map((b) => b.job),
      )}; private by count only):`,
    '',
    '| Job | First pass at colours | Fails again at |',
    '|---|---:|---|',
    ...namedColourBreaks.map((b) => `| ${jobLabel(b.job)} | ${b.at.passAt} | ${joinAnd(b.at.failsAt)} |`),
    '',
  );
  if (privateColourBreaks) lines.push(`…and ${privateColourBreaks} private job(s), not listed.`, '');

  lines.push('## Totals by corpus', '');
  lines.push('All jobs, in bytes:', '');
  lines.push(
    ...totalsLines(
      'Corpus',
      corpora.map((c) => [c, totalsTable(inCorpus(allJobs, c))]),
    ),
  );
  lines.push(
    `Jobs where today passes the bar (${todayPasses.length} of ${allJobs.length}) — pure savings, ` +
      'since a passing today is itself a candidate:',
    '',
  );
  lines.push(
    ...totalsLines(
      'Corpus',
      corpora.map((c) => [c, totalsTable(inCorpus(todayPasses, c))]),
    ),
  );

  lines.push("## The edge gate's cost", '');
  lines.push(
    'The totals above are the shipped gate — `pct` AND `edge`. Run the same two searches with ' +
      '`pct` alone (the gate before `edge` shipped) and the exhaustive winner totals ' +
      `${barOnlyTotals.exhaustive.toLocaleString()} B against ${gatedTotals.exhaustive.toLocaleString()} B ` +
      `gated (+${edgeDelta(gatedTotals.exhaustive, barOnlyTotals.exhaustive)}%); the binary winner totals ` +
      `${barOnlyTotals.binary.toLocaleString()} B against ${gatedTotals.binary.toLocaleString()} B gated ` +
      `(+${edgeDelta(gatedTotals.binary, barOnlyTotals.binary)}%).`,
    '',
    `\`edge\` changes the exhaustive winner on ${exhaustiveMoved.length} of ${allJobs.length} jobs ` +
      `(${byCorpus(
        corpora,
        exhaustiveMoved,
      )}; private by count only), costing ${exhaustiveMovedCost.toLocaleString()} B over the bar-only ` +
      'winner on exactly those jobs. It changes the binary winner on ' +
      `${binaryMoved.length} of ${allJobs.length} jobs, costing ${binaryMovedCost.toLocaleString()} B.`,
    '',
  );

  lines.push('## Jobs where today misses the bar', '');
  lines.push(
    `Today's default misses the gated bar on ${todayMisses.length} of ${allJobs.length} jobs ` +
      `(${byCorpus(corpora, todayMisses)}; private by count only).`,
    '',
    `- **${fixed.length} of those ${todayMisses.length}** have a passing candidate ` +
      `(${byCorpus(corpora, fixed)}). Passing costs bytes there: today ` +
      `${fixedTotals.today.toLocaleString()} B against ${fixedTotals.exhaustive.toLocaleString()} B ` +
      `for the exhaustive winners (${fixedTotals.exhaustive >= fixedTotals.today ? '+' : '−'}` +
      `${pct1(Math.abs(((fixedTotals.exhaustive - fixedTotals.today) / (fixedTotals.today || 1)) * 100))}%). ` +
      `The binary search finds a pass on ${binaryFixed.length} of them.`,
    `- **${unfixed.length} of those ${todayMisses.length}** have no passing candidate on either ` +
      `list (${byCorpus(corpora, unfixed)}) and keep today's bytes.`,
    `- **${todayEdgeOnlyMisses.length} of those ${todayMisses.length}** pass \`pct\` on their own ` +
      'but miss on `edge` alone — a miss the bar-only gate would never have reported ' +
      `(${byCorpus(corpora, todayEdgeOnlyMisses)}; private by count only).`,
    '',
  );
  if (fixtureMisses.length) {
    const described = fixtureMisses.map(
      (j) => `${j.name} ${j.kind} ${j.px}px at ${j.today.pct.toFixed(4)}% / edge ${j.today.edge.toFixed(4)}`,
    );
    lines.push(
      `The ${fixtureMisses.length} fixture miss(es): ${joinAnd(described)}.` +
        (fixtureMissesAccepted
          ? ' These are the suite’s accepted exception for those two grids (28 of 2,304 pixels, ' +
            'test/run.mjs and bench/ico-size/README.md), not a regression.'
          : ''),
      '',
    );
  }

  lines.push('## Totals by raster kind', '', 'All jobs, in bytes:', '');
  lines.push(...totalsLines('Kind', perKind));

  lines.push('## Binary against exhaustive', '');
  lines.push(
    `Where both pass, the binary winner differs in bytes from the exhaustive one on ${gaps.length} of ` +
      `${allJobs.length} jobs (${byCorpus(
        corpora,
        gaps.map((g) => g.job),
      )}), ` +
      `${gapBytes.toLocaleString()} B in all.` +
      (worstGap
        ? ` The worst relative gap outside the private corpus is ${jobLabel(worstGap.job)}: ` +
          `${worstGap.job.binary.bytes.toLocaleString()} B against ` +
          `${worstGap.job.exhaustive.bytes.toLocaleString()} B (+${pct1(worstGap.gap * 100)}%).`
        : '') +
      (privateGaps.length ? ` ${privateAboveWorst} private job(s) have a larger relative gap.` : ''),
    '',
    `Probes per job: min ${Math.min(...probes)}, median ${median(probes)}, mean ` +
      `${mean(probes).toFixed(1)}, max ${Math.max(...probes)} — against ${CANDIDATES} candidates ` +
      'for the exhaustive sweep.',
    '',
    `Time per 512px job, over ${at512.length} jobs. Encode is \`engine.encode\` alone (the zopfli ` +
      'finish every path pays once, on its winner, is not included); score is the accuracy gate, ' +
      "which today's default build never runs. results.json stores each job's summed times, so " +
      'today and binary are estimated from the per-candidate mean of the same job:',
    '',
    '| Path | Median encode ms | Median score ms | Median total ms | p95 total ms |',
    '|---|---:|---:|---:|---:|',
    ...timeRows.map(([label, encode, scoreTimes]) => {
      const total = encode.map((e, i) => e + scoreTimes[i]);
      return `| ${label} | ${ms(median(encode))} | ${ms(median(scoreTimes))} | ${ms(median(total))} | ${ms(p95(total))} |`;
    }),
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
      "wins are bucketed by quality instead, since their colour budget wasn't the constraint. " +
      `${big.length - bigSearched.length} of the ${big.length} jobs at >= 180px have no passing ` +
      "candidate and are left out: their winner is today's default setting, not a search result.",
    '',
  );
  lines.push('| Colours | Jobs |', '|---:|---:|');
  for (const colors of sortedOf([...colourWins.keys()])) lines.push(`| ${colors} | ${colourWins.get(colors)} |`);
  lines.push('', '| Quality (colour-unconstrained) | Jobs |', '|---:|---:|');
  for (const quality of sortedOf([...qualityWins.keys()])) lines.push(`| ${quality} | ${qualityWins.get(quality)} |`);
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
    '`--private` falls back to `FAVSEED_PRIVATE_CORPUS`, and `DIR` must be inside this checkout ' +
      'or the OS temporary directory (see [the corpus README](../corpus/README.md#the-private-corpus)). ' +
      'Omitting `--private` does **not** mean ' +
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
