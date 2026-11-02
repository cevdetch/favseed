// node bench/bench.mjs placement: full builds against the merged PR30 pipeline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { optimize, builtinPlugins } from 'svgo';
import { engineVersions, loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { reference, score } from '../test/lib/accuracy.mjs';
import { decode } from '../test/lib/png.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = '2a0eea0cc294d54cb41ed1b85d80d03c93cab4f4';
const ORIGINAL = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
const CORPUS = [...ORIGINAL, 'grid-1', 'grid-16', 'grid-24', 'grid-tiny', 'grid-fallback',
  'aspect-wide', 'aspect-tall', 'aspect-offset', 'aspect-percent'];
const SMALL = ['small-mark', 'small-grid', 'small-offset'];
const MARKS = [...CORPUS, ...SMALL];
const generated = {
  'small-grid': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#175d8d" d="M28 28h8v8h-8z"/></svg>',
  'small-offset': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="31.3" cy="32.7" r="4" fill="#175d8d"/></svg>',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const workingPixels = (px) => px * Math.max(1000, px);

export async function placementSweep(out) {
  const before = join(out, 'before'), sourceDir = join(out, 'sources');
  for (const dir of [before, sourceDir]) mkdirSync(dir, { recursive: true });
  const beforeHashes = {};
  for (const name of ['core.mjs', 'config.mjs', 'pipeline.mjs', 'svg-precision.mjs']) {
    const source = execFileSync('git', ['show', `${BASE}:lib/${name}`], { cwd: ROOT });
    beforeHashes[name] = hash(source);
    writeFileSync(join(before, name), source);
  }
  const [{ createSvgStage }, { buildSet: oldBuild }, { normaliseOptions: oldOptions }] = await Promise.all([
    import(pathToFileURL(join(before, 'core.mjs'))), import(pathToFileURL(join(before, 'pipeline.mjs'))),
    import(pathToFileURL(join(before, 'config.mjs'))),
  ]);
  const oldSvg = createSvgStage({ optimize, builtinPlugins }).optimiseSvg, engine = await loadEngine();
  const sources = new Map(), refs = new Map();
  for (const mark of MARKS) {
    const source = generated[mark] ?? readFileSync(join(ROOT, 'test/fixtures', mark + '.svg'), 'utf8');
    sources.set(mark, source);
    const file = join(sourceDir, mark + '.svg');
    writeFileSync(file, source);
    for (const px of [48, 180, 192, 512]) refs.set(mark + '/' + px,
      await reference({ source: file, px, bg: px === 48 ? null : '#000000', vars: {}, fitted: px !== 48 }));
  }

  const rows = [], stable = new Map(), arms = ['before', 'bounded'];
  for (let rep = 0; rep < 3; rep++) for (const [index, mark] of MARKS.entries()) {
    const pair = {};
    for (const arm of (rep + index) % 2 ? arms.toReversed() : arms) {
      const old = arm === 'before', rgbaRequests = [];
      const counted = { ...engine, renderRgba: (svg, px) => {
        rgbaRequests.push(px);
        return engine.renderRgba(svg, px);
      } };
      const options = (old ? oldOptions : normaliseOptions)({ manifest: true });
      const start = performance.now();
      const result = await (old ? oldBuild : buildSet)(sources.get(mark), options,
        { engine: counted, optimiseSvg: old ? oldSvg : optimiseSvg, name: mark + '.svg' });
      const ms = performance.now() - start, dir = join(out, arm, mark);
      if (!old) assert.ok(rgbaRequests.every((px) => px <= 1024), mark + ': oversized callback');
      if (!rep) mkdirSync(dir, { recursive: true });
      const files = result.files.map(({ name, bytes }) => {
        if (!rep) writeFileSync(join(dir, name), bytes);
        const file = { name, bytes: bytes.length, sha256: hash(bytes) };
        if (/\.(png|ico)$/.test(name)) {
          const image = decode(Buffer.from(name.endsWith('.ico') ? bytes.subarray(22) : bytes));
          file.error = score(image, refs.get(mark + '/' + image.width));
          if (!old && name.endsWith('.png')) assert.ok(file.error.pct <= 1, `${mark}/${name}: ${file.error.pct}%`);
        }
        return file;
      });
      const identity = { files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
        fit: result.fit, links: result.links, animated: result.animated };
      const key = arm + '/' + mark;
      if (stable.has(key)) assert.deepEqual(identity, stable.get(key), 'Nondeterministic result: ' + key);
      else stable.set(key, identity);
      pair[arm] = identity;
      rows.push({ rep, mark, arm, ms, fit: result.fit, files, rgbaRequests,
        rgbaCalls: rgbaRequests.length, maxRgbaPx: Math.max(...rgbaRequests),
        estimatedWorkingPixels: rgbaRequests.reduce((n, px) => n + workingPixels(px), 0),
        rasterBytes: files.filter((f) => /\.(png|ico)$/.test(f.name)).reduce((n, f) => n + f.bytes, 0),
        totalBytes: files.reduce((n, f) => n + f.bytes, 0) });
    }
    assert.deepEqual(pair.bounded, pair.before, 'Result changed: ' + mark);
    if (CORPUS.includes(mark)) assert.deepEqual(rows.at(-1).rgbaRequests, rows.at(-2).rgbaRequests,
      'Ordinary probe reuse changed: ' + mark);
    process.stderr.write(`placement: repetition ${rep}, ${mark}\n`);
  }

  const summarize = (marks) => arms.map((arm) => {
    const selected = rows.filter((r) => r.arm === arm && marks.includes(r.mark));
    const first = selected.filter((r) => !r.rep);
    return { arm, marks: marks.length,
      ms: [1, 2].map((rep) => selected.filter((r) => r.rep === rep).reduce((n, r) => n + r.ms, 0)).reduce((a, b) => a + b) / 2,
      rasterBytes: first.reduce((n, r) => n + r.rasterBytes, 0), totalBytes: first.reduce((n, r) => n + r.totalBytes, 0),
      rgbaCalls: first.reduce((n, r) => n + r.rgbaCalls, 0), maxRgbaPx: Math.max(...first.map((r) => r.maxRgbaPx)),
      estimatedWorkingPixels: first.reduce((n, r) => n + r.estimatedWorkingPixels, 0),
      worstPngSourceErrorPct: Math.max(...first.flatMap((r) => r.files.filter((f) => f.name.endsWith('.png')).map((f) => f.error.pct))),
      worstIcoSourceErrorPct: Math.max(...first.flatMap((r) => r.files.filter((f) => f.name.endsWith('.ico')).map((f) => f.error.pct))),
    };
  });
  const summaries = Object.fromEntries([['original11', ORIGINAL], ['corpus20', CORPUS], ['small3', SMALL], ['all23', MARKS]]
    .map(([name, marks]) => [name, summarize(marks)]));
  const data = { metadata: { base: BASE, node: process.version, cpu: cpus()[0]?.model, engine: engineVersions(),
    beforeHashes, currentHashes: Object.fromEntries(['core.mjs', 'config.mjs', 'pipeline.mjs', 'engine.mjs', 'svg-precision.mjs']
      .map((name) => [name, hash(readFileSync(join(ROOT, 'lib', name)))])),
    sourceHashes: Object.fromEntries([...sources].map(([mark, source]) => [mark, hash(source)])),
    repetitions: 3, warmupRepetition: 0, arms, wholeResultsIdentical: true,
    note: 'Rotated native full in-memory builds at quality80, no Zopfli, manifest and default sizes. Warmup0 excluded; median averages two whole-corpus totals. Includes SVG validation, placement, rendering and encoding; excludes imports, source reads, independent references, scoring and file writes. Counters include SVG validation plus placement renderRgba callbacks, not output render calls. Estimated working pixels=sum(px*max(1000,px)) reflects the pinned renderer floor; not measured allocations, concurrency peak or process RAM. Per-probe dimensions at most twice target; searches above that threshold render probes at target. Full candidate walk retained. Original20 callback sequences identical. All files, fits, links and animation metadata identical across arms and repetitions. Source error uses independent unoptimized source with matched placement; ICO separately reported. No browser timing, peak-memory or all-size accuracy claim.' }, summaries,
    byMark: Object.fromEntries(MARKS.map((mark) => [mark, summarize([mark])])), rows };
  writeFileSync(join(out, 'results.json'), JSON.stringify(data, null, 2) + '\n');
  return { title: 'Bounded placement probe rendering', note: data.metadata.note,
    text: JSON.stringify(summaries, null, 2), summary: 'Whole results unchanged across23 fixtures; data and files: bench/out/placement/.' };
}
