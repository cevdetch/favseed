// Called by `node bench/bench.mjs precision`; source accuracy and full-build cost.
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
import { ICO_SIZE, squareIconSvg } from '../lib/core.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { reference, score } from '../test/lib/accuracy.mjs';
import { decode } from '../test/lib/png.mjs';
import { resolveVars } from '../test/lib/resolve.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = '94278661a8f2842a9fd06b2c1e19dd35b68e591a';
const MARKS = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark',
  'grid-1', 'grid-16', 'grid-24', 'grid-tiny'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export async function precisionSweep(out) {
  mkdirSync(out, { recursive: true });
  const before = join(out, 'before');
  mkdirSync(before);
  const beforeHashes = {};
  for (const name of ['core.mjs', 'config.mjs', 'pipeline.mjs']) {
    const source = execFileSync('git', ['show', `${BASE}:lib/${name}`], { cwd: ROOT });
    beforeHashes[name] = hash(source);
    writeFileSync(join(before, name), source);
  }
  const [{ createSvgStage }, { buildSet: beforeBuild }, { normaliseOptions: beforeOptions }] = await Promise.all([
    import(pathToFileURL(join(before, 'core.mjs'))), import(pathToFileURL(join(before, 'pipeline.mjs'))),
    import(pathToFileURL(join(before, 'config.mjs'))),
  ]);
  const beforeSvg = createSvgStage({ optimize, builtinPlugins }).optimiseSvg;
  const engine = await loadEngine();
  const arms = ['before-q80', 'selective-q80', 'selective-q100'];
  const sources = new Map(), refs = new Map();
  // Prepare independent original-source references outside the timed builds.
  for (const mark of MARKS) {
    const file = join(ROOT, 'test/fixtures', mark + '.svg'), source = readFileSync(file, 'utf8');
    sources.set(mark, source);
    const rgba = await engine.renderRgba(squareIconSvg(resolveVars(source, {})).data, 512);
    refs.set(mark + '/svg', { width: rgba.width, height: rgba.height, data: rgba.rgba });
    for (const px of new Set([32, ICO_SIZE, 180, 192, 512])) refs.set(mark + '/' + px, await reference({ source: file, px,
      bg: px === 32 || px === ICO_SIZE ? null : '#000000', vars: {}, fitted: px !== 32 && px !== ICO_SIZE }));
  }

  const rows = [], stable = new Map();
  for (let rep = 0; rep < 3; rep++) for (const [index, mark] of MARKS.entries()) {
    const offset = index % arms.length, order = [...arms.slice(offset), ...arms.slice(0, offset)];
    if (rep % 2) order.reverse();
    for (const arm of order) {
      const steps = [], old = arm === 'before-q80';
      const options = (old ? beforeOptions : normaliseOptions)({ manifest: true, quality: arm === 'selective-q100' ? 100 : 80 });
      const svg = (source, o) => {
        const output = (old ? beforeSvg : optimiseSvg)(source, o);
        steps.push({ data: output.data, precision: o.reference ? 'source' : o.precision ?? 1 });
        return output;
      };
      const start = performance.now();
      let result;
      try { result = await (old ? beforeBuild : buildSet)(sources.get(mark), options, { engine, optimiseSvg: svg }); }
      catch (error) {
        if (!old || mark !== 'grid-tiny') throw error;
        rows.push({ rep, mark, arm, error: error.message });
        continue;
      }
      const ms = performance.now() - start;
      const dir = join(out, arm, mark);
      if (!rep) mkdirSync(dir, { recursive: true });
      const files = result.files.map(({ name, bytes }) => {
        if (!rep) writeFileSync(join(dir, name), bytes);
        const file = { name, bytes: bytes.length, sha256: hash(bytes) };
        if (/\.(png|ico)$/.test(name)) {
          const decoded = decode(Buffer.from(name.endsWith('.ico') ? bytes.subarray(22) : bytes));
          file.error = score(decoded, refs.get(mark + '/' + decoded.width));
        }
        return file;
      });
      const output = new TextDecoder().decode(result.files[0].bytes);
      const rendered = await engine.renderRgba(squareIconSvg(output).data, 512);
      const svgError = score({ width: rendered.width, height: rendered.height, data: rendered.rgba }, refs.get(mark + '/svg'));
      if (!old) assert.ok(svgError.pct <= 1, `${mark}: SVG error ${svgError.pct}%`);
      const key = mark + '/' + arm;
      const bytes = files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
      if (stable.has(key)) assert.deepEqual(bytes, stable.get(key), key + ': nondeterministic files');
      else stable.set(key, bytes);
      rows.push({ rep, mark, arm, ms, precision: steps.findLast((step) => step.data === output).precision, svgError,
        rasterBytes: files.filter((f) => /\.(png|ico)$/.test(f.name)).reduce((n, f) => n + f.bytes, 0),
        svgBytes: files[0].bytes, files });
    }
    process.stderr.write(`precision: repetition ${rep}, ${mark}\n`);
  }
  const summaries = {};
  for (const [name, marks] of [['original11', MARKS.slice(0, 11)], ['common14', MARKS.slice(0, 14)]]) {
    summaries[name] = arms.map((arm) => {
      const selected = rows.filter((row) => row.arm === arm && marks.includes(row.mark) && !row.error);
      const first = selected.filter((row) => row.rep === 0);
      return { arm, marks: marks.length,
        ms: median([1, 2].map((rep) => selected.filter((row) => row.rep === rep).reduce((n, row) => n + row.ms, 0))),
        rasterBytes: first.reduce((n, row) => n + row.rasterBytes, 0), svgBytes: first.reduce((n, row) => n + row.svgBytes, 0),
        worstSvgErrorPct: Math.max(...first.map((row) => row.svgError.pct)),
        worstPngSourceErrorPct: Math.max(...first.flatMap((row) => row.files.filter((f) => f.name.endsWith('.png')).map((f) => f.error.pct))),
        worstIcoSourceErrorPct: Math.max(...first.flatMap((row) => row.files.filter((f) => f.name.endsWith('.ico')).map((f) => f.error.pct))),
      };
    });
  }
  const data = { metadata: { node: process.version, cpu: cpus()[0]?.model, engine: engineVersions(), base: BASE, beforeHashes,
    currentHashes: Object.fromEntries(['core.mjs', 'config.mjs', 'pipeline.mjs', 'engine.mjs', 'svg-precision.mjs']
      .map((name) => [name, hash(readFileSync(join(ROOT, 'lib', name)))])),
    sourceHashes: Object.fromEntries([...sources].map(([name, svg]) => [name, hash(svg)])),
    repetitions: 3, arms, icoSizes: { before: 32, current: ICO_SIZE },
    comparisonScope: 'Whole pipelines: current also includes subsequent framing and ICO-size changes; not an isolated precision effect.',
    svgErrorBudget: '1% at512px; threshold8/255 on black and white composites',
    note: 'Rotated/reversed full in-memory builds; warmup repetition0 excluded from median totals. Imports, input reads, independent grading references, output writes and post-build grading excluded; runtime reference preparation and SVG validation included. No Zopfli. Original11 is the prior corpus; common14 adds small grids; grid-tiny has no successful old build and is excluded from timing/byte comparisons. PNG source error includes placement/quantization; ICO separately reported. Native-only timing, not a browser runtime claim.' }, summaries, rows };
  writeFileSync(join(out, 'results.json'), JSON.stringify(data, null, 2) + '\n');
  return { title: 'Selective SVG precision: source accuracy, output bytes and full-build overhead',
    note: data.metadata.note, text: JSON.stringify(summaries, null, 2),
    summary: `Raw results and first-repetition files: bench/out/precision/ (control ${BASE.slice(0, 7)}).` };
}
