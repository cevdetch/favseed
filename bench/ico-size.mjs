// node bench/bench.mjs ico-size: compare the merged 32px pipeline with 48px.
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
import { squareIconSvg } from '../lib/core.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { reference, score } from '../test/lib/accuracy.mjs';
import { decode } from '../test/lib/png.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = 'f526aff07fd28aa7e97f93aef6eef66a10f7dc26';
const ORIGINAL = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
const MARKS = [...ORIGINAL, 'grid-1', 'grid-16', 'grid-24', 'grid-tiny', 'grid-fallback',
  'aspect-wide', 'aspect-tall', 'aspect-offset', 'aspect-percent'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function icoSizeSweep(out) {
  const before = join(out, 'before');
  mkdirSync(before, { recursive: true });
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
    const file = join(ROOT, 'test/fixtures', mark + '.svg');
    sources.set(mark, readFileSync(file, 'utf8'));
    for (const px of [32, 48]) refs.set(mark + '/' + px,
      await reference({ source: file, px, bg: null, vars: {}, fitted: false }));
  }
  const rows = [], stable = new Map(), arms = ['before32', 'current48'];
  for (let rep = 0; rep < 3; rep++) for (const [index, mark] of MARKS.entries()) {
    for (const arm of (rep + index) % 2 ? arms.toReversed() : arms) {
      const old = arm === 'before32', px = old ? 32 : 48;
      const options = (old ? oldOptions : normaliseOptions)({ manifest: true });
      const start = performance.now();
      const result = await (old ? oldBuild : buildSet)(sources.get(mark), options, { engine, optimiseSvg: old ? oldSvg : optimiseSvg });
      const ms = performance.now() - start, dir = join(out, arm, mark);
      if (!rep) mkdirSync(dir, { recursive: true });
      const files = result.files.map(({ name, bytes }) => {
        if (!rep) writeFileSync(join(dir, name), bytes);
        return { name, bytes: bytes.length, sha256: hash(bytes) };
      });
      const ico = Buffer.from(result.files.find((f) => f.name === 'favicon.ico').bytes);
      assert.equal(ico.readUInt16LE(4), 1);
      assert.deepEqual([...ico.subarray(6, 8)], [px, px]);
      const offset = ico.readUInt32LE(18), length = ico.readUInt32LE(14);
      const image = decode(ico.subarray(offset, offset + length));
      assert.deepEqual([image.width, image.height], [px, px]);
      const sourceError = score(image, refs.get(mark + '/' + px));
      const svg = new TextDecoder().decode(result.files.find((f) => f.name === 'icon.svg').bytes);
      const raw = decode(Buffer.from(await engine.render(squareIconSvg(svg).data, px)));
      const encodingError = score(image, raw);
      const hashes = files.map(({ name, sha256 }) => ({ name, sha256 })), key = arm + '/' + mark;
      if (stable.has(key)) assert.deepEqual(hashes, stable.get(key), 'Nondeterministic output: ' + key);
      else stable.set(key, hashes);
      rows.push({ rep, mark, arm, px, ms, icoBytes: ico.length, sourceError, encodingError, files,
        rasterBytes: files.filter((f) => /\.(png|ico)$/.test(f.name)).reduce((n, f) => n + f.bytes, 0),
        totalBytes: files.reduce((n, f) => n + f.bytes, 0) });
    }
    const nonIco = (arm) => stable.get(arm + '/' + mark).filter((f) => f.name !== 'favicon.ico');
    assert.deepEqual(nonIco('before32'), nonIco('current48'), 'Non-ICO files changed: ' + mark);
    process.stderr.write(`ico-size: repetition ${rep}, ${mark}\n`);
  }
  const summaries = {};
  for (const [group, marks] of [['original11', ORIGINAL], ['all20', MARKS]]) {
    summaries[group] = arms.map((arm) => {
      const selected = rows.filter((r) => r.arm === arm && marks.includes(r.mark));
      const first = selected.filter((r) => !r.rep);
      return { arm, marks: marks.length,
        ms: [1, 2].map((rep) => selected.filter((r) => r.rep === rep).reduce((n, r) => n + r.ms, 0)).reduce((a, b) => a + b) / 2,
        icoBytes: first.reduce((n, r) => n + r.icoBytes, 0),
        rasterBytes: first.reduce((n, r) => n + r.rasterBytes, 0), totalBytes: first.reduce((n, r) => n + r.totalBytes, 0),
        worstIcoSourceErrorPct: Math.max(...first.map((r) => r.sourceError.pct)),
        worstIcoEncodingErrorPct: Math.max(...first.map((r) => r.encodingError.pct)),
        icoOverOnePercent: first.filter((r) => r.sourceError.pct > 1).map(({ mark, sourceError }) => ({ mark, pct: sourceError.pct })),
      };
    });
  }
  const data = { metadata: { base: BASE, node: process.version, cpu: cpus()[0]?.model, engine: engineVersions(),
    beforeHashes, currentHashes: Object.fromEntries(['core.mjs', 'config.mjs', 'pipeline.mjs', 'engine.mjs', 'svg-precision.mjs']
      .map((name) => [name, hash(readFileSync(join(ROOT, 'lib', name)))])),
    sourceHashes: Object.fromEntries([...sources].map(([mark, svg]) => [mark, hash(svg)])),
    repetitions: 3, warmupRepetition: 0, arms, nonIcoFilesByteIdentical: true,
    note: 'Alternating native full in-memory builds at quality80, default no Zopfli, manifest enabled. Warmup repetition0 excluded; median of two whole-corpus totals. Includes SVG validation, placement, render and encoding; excludes imports, source reads, independent references, post-build scoring and file writes. ICO source error against unoptimized source at its own resolution; encoding error against raw selected-SVG pixels. All non-ICO files asserted byte-identical across arms; all files deterministic across repetitions. No browser timing, downsampling quality or all-size 1% guarantee.' }, summaries, rows };
  writeFileSync(join(out, 'results.json'), JSON.stringify(data, null, 2) + '\n');
  return { title: 'Single 48px ICO fallback', note: data.metadata.note,
    text: JSON.stringify(summaries, null, 2), summary: 'All non-ICO files unchanged across20 fixtures; raw data and files: bench/out/ico-size/.' };
}
