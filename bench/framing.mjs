// node bench/bench.mjs framing: compare against merged PR27 without changing HEAD.
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
import { ICO_SIZE } from '../lib/core.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { reference, score } from '../test/lib/accuracy.mjs';
import { decode } from '../test/lib/png.mjs';
import { framingCases } from '../test/lib/framing.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = 'deaba2b18d27467f6443adc9e6bab11c2e77d92a';
const ORIGINAL = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
const MARKS = [...ORIGINAL, ...framingCases.map(({ mark }) => mark), 'near-wide', 'near-tall'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export async function framingSweep(out) {
  const before = join(out, 'before'), sourcesDir = join(out, 'sources'), goldDir = join(out, 'goldens');
  for (const dir of [before, sourcesDir, goldDir]) mkdirSync(dir, { recursive: true });
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
  const goldens = new Map(framingCases.map(({ mark, golden }) => [mark, golden]));
  // Independent, hand-derived goldens pin geometry instead of grading against our wrapper.
  goldens.set('wide', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<path fill="#243B53" d="M8 76 32 48 56 76z M72 48h48v28H72z"/></svg>');
  const nearGolden = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 101 101"><circle cx="50.5" cy="50.5" r="32" fill="#175d8d"/></svg>';
  for (const mark of ['near-wide', 'near-tall']) goldens.set(mark, nearGolden);
  for (const mark of MARKS) {
    let source;
    if (mark.startsWith('near-')) {
      const [w, h, cx, cy] = mark === 'near-wide' ? [101, 100, 50.5, 50] : [100, 101, 50, 50.5];
      source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><circle cx="${cx}" cy="${cy}" r="32" fill="#175d8d"/></svg>`;
    } else source = readFileSync(join(ROOT, 'test/fixtures', mark + '.svg'), 'utf8');
    sources.set(mark, source);
    const file = join(sourcesDir, mark + '.svg'), golden = join(goldDir, mark + '.svg');
    writeFileSync(file, source); writeFileSync(golden, goldens.get(mark) ?? source);
    for (const px of new Set([32, ICO_SIZE, 180, 192, 512])) {
      refs.set(mark + '/' + px, await reference({ source: golden, px, bg: px === 32 || px === ICO_SIZE ? null : '#000000',
        vars: {}, fitted: px !== 32 && px !== ICO_SIZE }));
    }
  }

  const rows = [], stable = new Map(), arms = ['before', 'preserved'];
  for (let rep = 0; rep < 3; rep++) for (const [index, mark] of MARKS.entries()) {
    const order = (rep + index) % 2 ? arms.toReversed() : arms;
    for (const arm of order) {
      const old = arm === 'before', options = (old ? oldOptions : normaliseOptions)({ manifest: true });
      const start = performance.now();
      let result;
      try { result = await (old ? oldBuild : buildSet)(sources.get(mark), options, { engine, optimiseSvg: old ? oldSvg : optimiseSvg }); }
      catch (error) {
        if (!old || mark !== 'aspect-percent' || !/renders nothing/.test(error.message)) throw error;
        rows.push({ rep, mark, arm, error: error.message }); continue;
      }
      const ms = performance.now() - start, dir = join(out, arm, mark);
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
      const hashes = files.map(({ name, sha256 }) => ({ name, sha256 })), key = arm + '/' + mark;
      if (stable.has(key)) assert.deepEqual(hashes, stable.get(key), 'Nondeterministic output: ' + key);
      else stable.set(key, hashes);
      rows.push({ rep, mark, arm, ms, fit: result.fit, files,
        rasterBytes: files.filter(({ name }) => /\.(png|ico)$/.test(name)).reduce((n, f) => n + f.bytes, 0),
        svgBytes: files.find(({ name }) => name === 'icon.svg').bytes });
    }
    process.stderr.write(`framing: repetition ${rep}, ${mark}\n`);
  }
  const squares = ORIGINAL.filter((mark) => mark !== 'wide');
  const nonIco = (arm, mark) => stable.get(arm + '/' + mark).filter((f) => f.name !== 'favicon.ico');
  for (const mark of squares) assert.deepEqual(nonIco('before', mark), nonIco('preserved', mark), 'Square non-ICO files changed: ' + mark);
  for (const mark of MARKS.filter((mark) => mark !== 'aspect-percent')) {
    assert.equal(stable.get('before/' + mark).find((f) => f.name === 'icon.svg').sha256,
      stable.get('preserved/' + mark).find((f) => f.name === 'icon.svg').sha256, 'SVG changed: ' + mark);
  }
  const summaries = {};
  for (const [group, marks] of [['original11', ORIGINAL], ['paired16', MARKS.filter((m) => m !== 'aspect-percent')]]) {
    summaries[group] = arms.map((arm) => {
      const selected = rows.filter((r) => r.arm === arm && marks.includes(r.mark) && !r.error);
      const first = selected.filter((r) => !r.rep);
      return { arm, marks: marks.length,
        ms: median([1, 2].map((rep) => selected.filter((r) => r.rep === rep).reduce((n, r) => n + r.ms, 0))),
        rasterBytes: first.reduce((n, r) => n + r.rasterBytes, 0), svgBytes: first.reduce((n, r) => n + r.svgBytes, 0),
        worstPngSourceErrorPct: Math.max(...first.flatMap((r) => r.files.filter((f) => f.name.endsWith('.png')).map((f) => f.error.pct))),
        worstIcoSourceErrorPct: Math.max(...first.flatMap((r) => r.files.filter((f) => f.name.endsWith('.ico')).map((f) => f.error.pct))),
      };
    });
  }
  const data = { metadata: { base: BASE, node: process.version, cpu: cpus()[0]?.model, engine: engineVersions(),
    beforeHashes, currentHashes: Object.fromEntries(['core.mjs', 'config.mjs', 'pipeline.mjs', 'engine.mjs', 'svg-precision.mjs']
      .map((name) => [name, hash(readFileSync(join(ROOT, 'lib', name)))])),
    sourceHashes: Object.fromEntries([...sources].map(([name, svg]) => [name, hash(svg)])),
    repetitions: 3, warmup: 0, arms, squareNonIcoFilesUnchanged: squares, icoSizes: { before: 32, current: ICO_SIZE },
    comparisonScope: 'Whole pipelines: current also includes the subsequent ICO-size change; not an isolated framing effect.',
    note: 'Rotated native full in-memory builds; warmup excluded. Timed optimization, runtime validation, placement and encoding; excluded imports, input reads, independent grading references, post-build scoring and file writes. Default quality80, no Zopfli. Literal square goldens for non-square sources; independent source placement for PNGs; ICO separately reported. Previous percent-source build fails and is excluded from paired totals. No browser timing or peak-memory claim.' }, summaries, rows };
  writeFileSync(join(out, 'results.json'), JSON.stringify(data, null, 2) + '\n');
  return { title: 'Preserved non-square raster proportions', note: data.metadata.note,
    text: JSON.stringify(summaries, null, 2), summary: `Ten square sets have byte-identical non-ICO files; data and files: bench/out/framing/ (control ${BASE.slice(0, 7)}).` };
}
