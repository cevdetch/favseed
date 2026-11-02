// Pairwise final-compression check for lossless filter-screen winners.
// node bench/png-filter-finish.mjs /effort-results /filter-screen /fresh/results
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as image from '@napi-rs/image';
import { engineVersions } from '../bin/favseed.mjs';
import { createEngine } from '../lib/engine.mjs';
import { createZopfli } from '../lib/zopfli.mjs';
import { decode } from '../test/lib/png.mjs';

assert.ok(process.argv[2] && process.argv[3] && process.argv[4]);
const [input, screen, out] = process.argv.slice(2, 5).map((p) => resolve(p));
mkdirSync(out, { recursive: true }); assert.ok(!readdirSync(out).length);
const screened = JSON.parse(readFileSync(join(screen, 'rows.json')));
const selected = screened.filter((r) => r.name === 'filter-1' && r.candidateBytes < r.inputBytes);
assert.ok(selected.length);
// Counterfactual control: bypass finish's palette recoding in both arms. The
// candidate below performs exactly one real pass, timed with final compression.
const engine = createEngine({
  image: { losslessCompressPng: async png => png },
  zopfli: createZopfli({ loadWasm: () => readFileSync(new URL('../lib/zopfli.wasm', import.meta.url)) }),
  inflate: inflateSync,
}), rows = [];
await engine.finish(readFileSync(join(input, 'inputs', `${selected[0].id}.png`)), { iterations: 1 });
for (let rep = 0; rep < 2; rep++) for (const sample of selected) for (const iterations of [5, 120]) {
  const png = readFileSync(join(input, 'inputs', `${sample.id}.png`));
  for (const arm of rep % 2 ? ['sub-filter', 'original'] : ['original', 'sub-filter']) {
    const start = performance.now();
    let chosen = png;
    if (arm === 'sub-filter') {
      const candidate = Buffer.from(await image.losslessCompressPng(png, { strip: false, filter: [1] }));
      if (candidate.length < png.length) chosen = candidate;
    }
    const result = Buffer.from(await engine.finish(chosen, { iterations }));
    const ms = performance.now() - start;
    if (arm === 'original') assert.deepEqual(result,
      readFileSync(join(input, 'outputs', `${sample.id}-i${iterations}.png`)),
      'Control must reproduce retained pre-palette output');
    assert.deepEqual(decode(result), decode(png), 'Lossless filter candidate changed pixels');
    const previous = rows.find((r) => r.id === sample.id && r.arm === arm && r.iterations === iterations);
    if (previous) assert.deepEqual(result, readFileSync(join(out, `${sample.id}-${arm}-i${iterations}.png`)));
    writeFileSync(join(out, `${sample.id}-${arm}-i${iterations}.png`), result);
    rows.push({ rep, id: sample.id, arm, iterations, ms, bytes: result.length });
    writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
    console.log(JSON.stringify(rows.at(-1)));
  }
}
writeFileSync(join(out, 'metadata.json'), JSON.stringify({ node: process.version, engine: engineVersions(),
  note: 'Both finish arms bypass palette recoding; the candidate applies one real lossless pass before finish. Original bytes must match retained pre-palette outputs. Only pre-compression filter-1 winners from screening; this is a targeted experiment, not an unbiased whole-corpus speed claim. Timings include extra lossless filtering and final compression. All dimensions/pixels and repeated output bytes checked.' }, null, 2) + '\n');
