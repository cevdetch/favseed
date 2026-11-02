// Measure effort on the actual winning encodes, without changing production defaults.
// node bench/zopfli-effort.mjs --out=/tmp/effort [--resume]
// --marks=tiles,general and --repetitions=1 are useful for a quick check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { engineVersions, loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { decode } from '../test/lib/png.mjs';

const MARKS = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
const ITERATIONS = [0, 1, 3, 5, 10, 15, 30, 60, 120];
const args = new Map(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf('=');
  return index < 0 ? [arg, true] : [arg.slice(0, index), arg.slice(index + 1)];
}));
for (const key of args.keys()) assert.ok(['--out', '--marks', '--repetitions', '--resume'].includes(key), `Unknown option ${key}`);
const marks = args.has('--marks') ? String(args.get('--marks')).split(',') : MARKS;
assert.ok(marks.length && new Set(marks).size === marks.length && marks.every((mark) => MARKS.includes(mark)), 'Invalid marks');
const repetitions = Number(args.get('--repetitions') ?? 2);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10, 'Invalid repetitions');
const out = resolve(String(args.get('--out') ?? 'bench/out/zopfli-effort'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
mkdirSync(join(out, 'inputs'), { recursive: true });
mkdirSync(join(out, 'outputs'), { recursive: true });
const engine = await loadEngine(), samples = [];
const prepStart = performance.now();
for (const mark of marks) {
  const source = readFileSync(new URL(`../test/fixtures/${mark}.svg`, import.meta.url), 'utf8');
  await buildSet(source, normaliseOptions({ mode: 'release' }), { optimiseSvg, engine: {
    ...engine,
    finish: async (png) => {
      const px = new DataView(png.buffer, png.byteOffset).getUint32(16);
      const id = `${mark}-${px}`, owned = Buffer.from(png), decoded = decode(owned);
      samples.push({ id, mark, px, png: owned, pixels: hash(decoded.data) });
      return png;
    },
  } });
}
assert.equal(samples.length, marks.length * 4, 'Expected ICO, Apple, 192px and 512px payloads');
assert.equal(new Set(samples.map((s) => s.id)).size, samples.length);
const configuration = { engine: engineVersions(), iterations: ITERATIONS, repetitions,
  runtime: { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, platform: process.platform, arch: process.arch },
  samples: samples.map(({ id, png, pixels }) => ({ id, sha256: hash(png), pixels, bytes: png.length })) };
const fingerprint = hash(JSON.stringify(configuration));
const metadata = { fingerprint, ...configuration, node: process.version, cpu: cpus()[0]?.model,
  cores: cpus().length, prepMs: performance.now() - prepStart,
  note: 'Fixed default-option PNG winners; 32px PNG is the ICO payload. No SVG/header bytes. Times cover finish only. Decode/hash checks run after timing.' };
const metadataPath = join(out, 'metadata.json'), rowsPath = join(out, 'rows.jsonl');
let rows = [];
if (existsSync(metadataPath)) {
  assert.ok(args.has('--resume'), 'Output already exists; use --resume or another --out');
  assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).fingerprint, fingerprint, 'Cannot resume a different engine/corpus/configuration');
  rows = existsSync(rowsPath) ? readFileSync(rowsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
} else {
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
}
for (const { id, png } of samples) writeFileSync(join(out, 'inputs', `${id}.png`), png);
const key = ({ rep, id, iterations }) => `${rep}/${id}/${iterations}`;
const completed = new Set(rows.map(key));
assert.equal(completed.size, rows.length, 'Duplicate measurement rows');
// Warm the real large-image paths before collecting timings. No other CPU-heavy
// task should run alongside this process. Reversing/rotating effort order avoids
// consistently assigning hot/cold positions or machine drift to one effort.
const warm = samples.find((sample) => sample.px === 512);
await engine.finish(warm.png, { iterations: 15 });
await engine.finish(warm.png, { iterations: 15 });
console.log(JSON.stringify({ phase: 'prepared', samples: samples.length, repetitions, iterations: ITERATIONS, out, resumedRows: rows.length }));
for (let rep = 0; rep < repetitions; rep++) {
  for (const [index, sample] of samples.entries()) {
    const offset = index % ITERATIONS.length;
    const order = [...ITERATIONS.slice(offset), ...ITERATIONS.slice(0, offset)];
    if (rep % 2) order.reverse();
    for (const iterations of order) {
      if (completed.has(key({ rep, id: sample.id, iterations }))) continue;
      const start = performance.now();
      const png = await engine.finish(sample.png, { iterations });
      const ms = performance.now() - start;
      const owned = Buffer.from(png), decoded = decode(owned);
      assert.deepEqual([decoded.width, decoded.height], [sample.px, sample.px]);
      assert.equal(hash(decoded.data), sample.pixels, `Pixels changed: ${sample.id}/${iterations}`);
      const row = { rep, id: sample.id, iterations, ms, bytes: png.length, sha256: hash(png) };
      const previous = rows.find((r) => r.id === row.id && r.iterations === iterations);
      if (previous) assert.equal(row.sha256, previous.sha256, 'Nondeterministic compression');
      writeFileSync(join(out, 'outputs', `${sample.id}-i${iterations}.png`), png);
      appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      rows.push(row); completed.add(key(row));
    }
    console.log(JSON.stringify({ phase: 'progress', rep, sample: sample.id, completed: rows.length,
      total: repetitions * samples.length * ITERATIONS.length }));
  }
}
const perFile = samples.map(({ id }) => {
  const arms = ITERATIONS.map((iterations) => {
    const selected = rows.filter((r) => r.id === id && r.iterations === iterations);
    assert.equal(selected.length, repetitions);
    return { iterations, bytes: selected[0].bytes, sha256: selected[0].sha256, ms: median(selected.map((r) => r.ms)) };
  });
  const minBytes = Math.min(...arms.map((arm) => arm.bytes));
  return { id, minBytes, cheapestMinimum: arms.find((arm) => arm.bytes === minBytes).iterations, arms };
});
const summaries = ITERATIONS.map((iterations) => {
  let totalBytes = 0, minimumTies = 0, matches120Size = 0, matches120Bytes = 0, worseThan120 = 0, maxExtraBytes = 0;
  for (const file of perFile) {
    const arm = file.arms.find((a) => a.iterations === iterations), baseline = file.arms.find((a) => a.iterations === 120);
    totalBytes += arm.bytes;
    minimumTies += Number(arm.bytes === file.minBytes);
    matches120Size += Number(arm.bytes === baseline.bytes);
    matches120Bytes += Number(arm.sha256 === baseline.sha256);
    worseThan120 += Number(arm.bytes > baseline.bytes);
    maxExtraBytes = Math.max(maxExtraBytes, arm.bytes - baseline.bytes);
  }
  const totals = Array.from({ length: repetitions }, (_, rep) => rows.filter((r) => r.rep === rep && r.iterations === iterations).reduce((n, r) => n + r.ms, 0));
  return { iterations, totalBytes, medianMs: median(totals), minMs: Math.min(...totals), maxMs: Math.max(...totals),
    minimumTies, cheapestMinimum: perFile.filter((file) => file.cheapestMinimum === iterations).length,
    matches120Size, matches120Bytes, worseThan120, maxExtraBytes };
});
const baseline = summaries.find((s) => s.iterations === 120);
for (const summary of summaries) {
  summary.extraBytesVs120 = summary.totalBytes - baseline.totalBytes;
  summary.extraPercentVs120 = 100 * (summary.totalBytes / baseline.totalBytes - 1);
  summary.speedupVs120 = baseline.medianMs / summary.medianMs;
}
writeFileSync(join(out, 'summary.json'), JSON.stringify({ metadata, summaries, perFile }, null, 2) + '\n');
console.log('iterations | PNG bytes | extra vs120 | finish seconds | min ties | cheapest min | exact120 | worst extra/file');
for (const s of summaries) console.log(`${s.iterations} | ${s.totalBytes} | ${s.extraBytesVs120} (${s.extraPercentVs120.toFixed(3)}%) | ${(s.medianMs / 1000).toFixed(3)} | ${s.minimumTies}/${samples.length} | ${s.cheapestMinimum} | ${s.matches120Bytes}/${samples.length} | ${s.maxExtraBytes}`);
