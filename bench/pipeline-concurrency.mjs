// Compare bounded production batches with a measurement-only serial control.
// node bench/pipeline-concurrency.mjs /fresh/results [iterations=0]
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEngine, optimiseSvg, engineVersions } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { benchmarkPath } from './path.mjs';

assert.ok(process.argv[2], 'Pass fresh output directory');
const out = benchmarkPath(process.argv[2]), iterations = Number(process.argv[3] ?? 0);
assert.ok([0, 5, 15, 120].includes(iterations));
mkdirSync(out, { recursive: true }); assert.ok(!readdirSync(out).length);
const source = readFileSync(new URL('../lib/pipeline.mjs', import.meta.url), 'utf8');
const core = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8');
const search = 'const serial = canvas > 512 || exact > 1024, step = serial ? 1 : 4;';
const jobs = '{ serial: list.some((job) => job.px > 512) }';
assert.equal(core.split(search).length, 2); assert.equal(source.split(jobs).length, 2);
const serialCore = 'data:text/javascript,' + encodeURIComponent(core.replace(search, 'const serial = true, step = 1;'));
const serialSource = source.replace("'./core.mjs'", JSON.stringify(serialCore)).replace(jobs, '{ serial: true }');
const { buildSet: serial } = await import(`data:text/javascript,${encodeURIComponent(serialSource)}`);
const engine = await loadEngine(), rows = [];
for (let rep = 0; rep < 3; rep++) for (const mark of ['tiles', 'general', 'heavy', 'gradient']) {
  const svg = readFileSync(new URL(`../test/fixtures/${mark}.svg`, import.meta.url), 'utf8');
  const options = normaliseOptions({}); options.iterations = iterations;
  let reference;
  for (const arm of rep % 2 ? ['parallel', 'serial'] : ['serial', 'parallel']) {
    const events = [], start = performance.now();
    const result = await (arm === 'serial' ? serial : buildSet)(svg, options,
      { engine, optimiseSvg, progress: (event) => events.push(event) });
    const ms = performance.now() - start;
    if (reference) assert.deepEqual(result, reference, `${mark}: bytes/metadata differ`);
    reference = result;
    const completed = events.filter((e) => e.phase === 'raster').map((e) => e.completed);
    assert.deepEqual(completed, [0, 1, 2, 3, 4]);
    rows.push({ rep, mark, arm, ms, bytes: result.files.reduce((n, f) => n + f.bytes.length, 0) });
    writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
    console.log(JSON.stringify(rows.at(-1)));
  }
}
writeFileSync(join(out, 'metadata.json'), JSON.stringify({ node: process.version, engine: engineVersions(), iterations,
  note: 'Native-only comparison: current bounded output/alignment batches versus serial output/search control. Exact whole-result equality and monotonic progress checked; first repetition is warmup. No browser memory/cancellation/growth validation and no production change.' }, null, 2) + '\n');
