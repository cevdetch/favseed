// Full-pipeline timing, identical options and native image engine. The old compressor
// remains a dev dependency solely for this comparison and exact-byte regression tests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import reference from '@gfx/zopfli';
import { inflateSync } from 'node:zlib';
import * as image from '@napi-rs/image';
import { loadEngine, optimiseSvg, engineVersions } from '../bin/favseed.mjs';
import { createEngine } from '../lib/engine.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';

const engines = { baseline: createEngine({ image, zopfli: reference, inflate: inflateSync }), candidate: await loadEngine() };
const mode = process.argv.includes('--fast') ? 'fast' : 'release';
const marks = ['tiles', 'general', 'heavy', 'gradient'];
const samples = new Map();
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, mode, versions: engineVersions() }));
for (let rep = 0; rep < 3; rep++) {
  for (const mark of marks) {
    const source = await readFile(new URL(`../test/fixtures/${mark}.svg`, import.meta.url), 'utf8');
    const results = {};
    for (const name of rep % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const start = performance.now();
      const result = await buildSet(source, normaliseOptions({ mode, zopfli: true }), { optimiseSvg, engine: engines[name] });
      const ms = performance.now() - start;
      results[name] = { result, ms };
      if (rep > 0) {
        const key = `${mark}/${name}`, values = samples.get(key) ?? [];
        values.push(ms); samples.set(key, values);
      }
    }
    assert.deepEqual(results.candidate.result, results.baseline.result, `${mark}: output changed`);
    console.log(JSON.stringify({ rep, mark, baselineMs: Math.round(results.baseline.ms), candidateMs: Math.round(results.candidate.ms),
      bytes: results.candidate.result.files.reduce((n, f) => n + f.bytes.length, 0) }));
  }
}
const median = (values) => values.toSorted((a, b) => a - b).reduce((a, b) => a + b) / values.length;
for (const mark of marks) {
  const baselineMs = median(samples.get(`${mark}/baseline`)), candidateMs = median(samples.get(`${mark}/candidate`));
  console.log(JSON.stringify({ mark, warmBaselineMs: Math.round(baselineMs), warmCandidateMs: Math.round(candidateMs),
    improvementPercent: +(100 * (1 - candidateMs / baselineMs)).toFixed(1) }));
}
