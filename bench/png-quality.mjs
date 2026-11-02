// Compare public quality settings with the saved pre-quality engine/pipeline.
// node bench/png-quality.mjs /saved/before /fresh/results
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as image from '@napi-rs/image';
import { optimize, builtinPlugins } from 'svgo';
import { engineVersions, loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { decode } from '../test/lib/png.mjs';
import { score } from '../test/lib/accuracy.mjs';
import { benchmarkPath } from './path.mjs';

assert.ok(process.argv[2] && process.argv[3], 'Pass pre-quality modules and a fresh results directory');
const before = benchmarkPath(process.argv[2]), out = benchmarkPath(process.argv[3]);
mkdirSync(out, { recursive: true });
assert.equal(readdirSync(out).length, 0, 'Use a fresh results directory');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const [{ createEngine }, { buildSet: oldBuild }, { normaliseOptions: oldOptions }, oldCore] = await Promise.all([
  import(pathToFileURL(join(before, 'engine.mjs'))), import(pathToFileURL(join(before, 'pipeline.mjs'))),
  import(pathToFileURL(join(before, 'config.mjs'))), import(pathToFileURL(join(before, 'core.mjs'))),
]);
const oldEngine = createEngine({ image }); // Zopfli is disabled throughout this benchmark.
const oldSvg = oldCore.createSvgStage({ optimize, builtinPlugins }).optimiseSvg;
const engine = await loadEngine(), marks = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
const qualities = [100, 80, 60], baselines = new Map(), references = new Map();
const metadata = { node: process.version, cpu: cpus()[0]?.model, engine: engineVersions(), marks, qualities, repetitions: 3,
  sourceSha256: Object.fromEntries(['core.mjs', 'config.mjs', 'pipeline.mjs', 'engine.mjs'].map((name) =>
    [name, hash(readFileSync(new URL('../lib/' + name, import.meta.url)))])),
  beforeSha256: Object.fromEntries(['core.mjs', 'config.mjs', 'pipeline.mjs', 'engine.mjs'].map((name) =>
    [name, hash(readFileSync(join(before, name)))])),
  note: 'Full in-memory buildSet generation; source read/optimize/place/encode/artifact creation timed. Imports, baseline preparation, validation and output writes excluded. Three rotated/reversed repetitions, first excluded. No Zopfli. All quality100 outputs/metadata match saved pre-quality modules. Error vs unquantised already-placed render, not original SVG; original-SVG accuracy reported separately.' };
writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
for (const mark of marks) {
  const source = readFileSync(new URL('../test/fixtures/' + mark + '.svg', import.meta.url), 'utf8');
  baselines.set(mark, await oldBuild(source, oldOptions({ manifest: true }), { engine: oldEngine, optimiseSvg: oldSvg }));
  await buildSet(source, normaliseOptions({ manifest: true }), { engine, optimiseSvg, name: mark + '.svg' });
  await buildSet(source, normaliseOptions({ manifest: true }), { optimiseSvg, engine: { ...engine,
    encode: async (png) => {
      const bytes = Buffer.from(png), px = bytes.readUInt32BE(16);
      references.set(mark + '-' + px, decode(bytes));
      return png;
    }, finish: async (png) => png,
  } });
}
const rows = [], stable = new Map();
for (let rep = 0; rep < 3; rep++) for (const [index, mark] of marks.entries()) {
  let order = [...qualities.slice(index % 3), ...qualities.slice(0, index % 3)];
  if (rep % 2) order.reverse();
  for (const quality of order) {
    const start = performance.now(), source = readFileSync(new URL('../test/fixtures/' + mark + '.svg', import.meta.url), 'utf8');
    const result = await buildSet(source, normaliseOptions({ quality, manifest: true }), { engine, optimiseSvg, name: mark + '.svg' });
    const ms = performance.now() - start, baseline = baselines.get(mark);
    if (quality === 100) assert.deepEqual(result, baseline, mark + ': default bytes/metadata changed');
    assert.deepEqual(result.fit, baseline.fit);
    for (const name of ['icon.svg', 'site.webmanifest']) assert.deepEqual(result.files.find((f) => f.name === name), baseline.files.find((f) => f.name === name));
    const directory = join(out, 'q' + quality, mark);
    mkdirSync(directory, { recursive: true });
    const files = result.files.map(({ name, bytes }) => {
      writeFileSync(join(directory, name), bytes);
      const file = { name, bytes: bytes.length, sha256: hash(bytes) };
      if (/\.(png|ico)$/.test(name)) {
        const png = name.endsWith('.ico') ? bytes.subarray(22) : bytes;
        const decoded = decode(Buffer.from(png));
        file.error = score(decoded, references.get(mark + '-' + decoded.width));
      }
      return file;
    });
    const key = quality + '/' + mark;
    if (stable.has(key)) assert.deepEqual(files, stable.get(key), key + ': repeat output changed');
    else stable.set(key, files);
    rows.push({ rep, mark, quality, ms, rasterBytes: files.filter((f) => /\.(png|ico)$/.test(f.name)).reduce((n, f) => n + f.bytes, 0), files });
    writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
  }
  console.log(JSON.stringify({ rep, mark, completed: rows.length }));
}
const summaries = qualities.map((quality) => ({ quality, repetitions: [0, 1, 2].map((rep) => {
  const selected = rows.filter((row) => row.rep === rep && row.quality === quality);
  return { rep, ms: selected.reduce((n, row) => n + row.ms, 0), rasterBytes: selected.reduce((n, row) => n + row.rasterBytes, 0) };
}) }));
writeFileSync(join(out, 'summary.json'), JSON.stringify(summaries, null, 2) + '\n');
console.log(JSON.stringify(summaries, null, 2));
