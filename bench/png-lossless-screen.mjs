// Screen lossless PNG filter choices on retained real winning encodes.
// node bench/png-lossless-screen.mjs /effort-results /fresh-screen-results
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as image from '@napi-rs/image';
import { engineVersions } from '../bin/favseed.mjs';
import { decode } from '../test/lib/png.mjs';
import { benchmarkPath } from './path.mjs';

assert.ok(process.argv[2] && process.argv[3], 'Pass effort inputs and fresh output directory');
const input = benchmarkPath(process.argv[2]), out = benchmarkPath(process.argv[3]);
mkdirSync(out, { recursive: true }); assert.ok(!readdirSync(out).length);
const metadata = JSON.parse(readFileSync(join(input, 'metadata.json')));
assert.deepEqual(metadata.engine, engineVersions());
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const choices = [{ name: 'default', options: { strip: true } },
  ...[0, 1, 2, 3, 4].map((filter) => ({ name: `filter-${filter}`, options: { strip: true, filter: [filter] } })),
  { name: 'filter-all', options: { strip: true, filter: [0, 1, 2, 3, 4] } }];
const rows = [];
for (const { name } of choices) mkdirSync(join(out, name));
for (const sample of metadata.samples) {
  const png = readFileSync(join(input, 'inputs', `${sample.id}.png`));
  assert.equal(hash(png), sample.sha256);
  for (const { name, options } of choices) {
    const start = performance.now();
    const candidate = Buffer.from(await image.losslessCompressPng(png, options));
    const ms = performance.now() - start, decoded = decode(candidate);
    assert.equal(hash(decoded.data), sample.pixels, `${sample.id}/${name}: pixels changed`);
    const original = decode(png);
    assert.deepEqual([decoded.width, decoded.height], [original.width, original.height]);
    const selected = candidate.length < png.length ? candidate : png;
    writeFileSync(join(out, name, `${sample.id}.png`), selected);
    rows.push({ id: sample.id, name, inputBytes: png.length, candidateBytes: candidate.length,
      selectedBytes: selected.length, sha256: hash(selected), ms });
  }
  writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(sample.id);
}
const summaries = choices.map(({ name, options }) => {
  const selected = rows.filter((r) => r.name === name);
  return { name, options, inputBytes: selected.reduce((n, r) => n + r.inputBytes, 0),
    selectedBytes: selected.reduce((n, r) => n + r.selectedBytes, 0),
    changed: selected.filter((r) => r.candidateBytes < r.inputBytes).length,
    screenMs: selected.reduce((n, r) => n + r.ms, 0) };
});
writeFileSync(join(out, 'summary.json'), JSON.stringify({ engine: engineVersions(),
  note: 'Exploratory filter screening on selected encodes, not a statistically controlled timing benchmark. A byte-size guard keeps original PNG when candidate is larger; all candidates preserve exact dimensions/RGBA.',
  summaries, rows }, null, 2) + '\n');
console.log(JSON.stringify(summaries));
