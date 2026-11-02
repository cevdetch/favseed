// Controlled encoder comparison, not a comparison of different icon presets.
// Install @vite-pwa/assets-generator@2.0.0 in a separate directory, then:
// node bench/vite-pwa-encode.mjs /path/to/deps /path/to/results [low-effort] [qualities] [arms]
// Pass e.g. 60,80,90,100 as qualities for a separate Vite-only quality sweep.
// All arms receive identical already-placed, unquantised PNG pixels. Vite's
// resize/padding are held at identity; its actual API and PNG defaults are used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineVersions, icoWrap, loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { DEFAULT_QUALITY, ICO_SIZE } from '../lib/core.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { decode } from '../test/lib/png.mjs';
import { score } from '../test/lib/accuracy.mjs';
import { benchmarkPath } from './path.mjs';

assert.ok(process.argv[2] && process.argv[3], 'Pass isolated dependency directory and result directory');
const dependencyDirectory = benchmarkPath(process.argv[2]);
const out = benchmarkPath(process.argv[3]), lowEffort = Number(process.argv[4] ?? 3);
const deps = createRequire(join(dependencyDirectory, 'package.json'));
const packagePath = deps.resolve('@vite-pwa/assets-generator/package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
assert.equal(packageJson.version, '2.0.0');
const { generateTransparentAsset, generateFavicon, defaultPngCompressionOptions } = await import(pathToFileURL(deps.resolve('@vite-pwa/assets-generator/api')));
assert.deepEqual(defaultPngCompressionOptions, { compressionLevel: 9, quality: 60 });
const sharpRequire = createRequire(packagePath);
const sharp = sharpRequire('sharp');
assert.ok(Number.isInteger(lowEffort) && lowEffort > 0 && lowEffort < 15);
mkdirSync(out, { recursive: true });
assert.equal(readdirSync(out).length, 0, 'Use a fresh result directory');
mkdirSync(join(out, 'inputs'), { recursive: true });
mkdirSync(join(out, 'outputs'), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(values.length / 2);
  return values.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const engine = await loadEngine(), samples = [];
for (const mark of ['tiles', 'general', 'heavy', 'gradient']) {
  const source = readFileSync(new URL(`../test/fixtures/${mark}.svg`, import.meta.url), 'utf8');
  await buildSet(source, normaliseOptions({ mode: 'release', zopfli: true }), { optimiseSvg, engine: {
    ...engine,
    encode: async (png) => {
      const raw = Buffer.from(png), px = new DataView(raw.buffer, raw.byteOffset).getUint32(16);
      samples.push({ id: `${mark}-${px}`, raw, px, reference: decode(raw) });
      return png;
    },
    finish: async (png) => png,
  } });
}
const defaultArms = [
  { name: 'favseed-default', run: async (sample) => engine.finish(
    await engine.encode(sample.raw, { quality: DEFAULT_QUALITY }), { iterations: 0 }) },
  { name: 'vite-default', run: async (sample) => (await generateTransparentAsset('png', sample.raw, sample.px,
    { padding: 0, resizeOptions: { fit: 'fill' }, outputOptions: defaultPngCompressionOptions })).toBuffer() },
  { name: 'vite-palette-off', run: async (sample) => (await generateTransparentAsset('png', sample.raw, sample.px,
    { padding: 0, resizeOptions: { fit: 'fill' }, outputOptions: { compressionLevel: 9, palette: false } })).toBuffer() },
  ...[0, lowEffort, 15, 120].map((iterations) => ({ name: `favseed-${iterations}`, run: async (sample) =>
    engine.finish(await engine.encode(sample.raw, { colors: 256 }), { iterations }) })),
];
const qualityLevels = process.argv[5] ? process.argv[5].split(',').map(Number) : [];
assert.ok(new Set(qualityLevels).size === qualityLevels.length && qualityLevels.every((q) => Number.isInteger(q) && q >= 0 && q <= 100), 'Invalid qualities');
const qualityArms = qualityLevels.map((quality) => ({ name: `vite-quality-${quality}`,
  run: async (sample) => (await generateTransparentAsset('png', sample.raw, sample.px,
    { padding: 0, resizeOptions: { fit: 'fill' }, outputOptions: { ...defaultPngCompressionOptions, quality } })).toBuffer(),
}));
const availableArms = [...defaultArms, ...qualityArms];
const selectedArms = process.argv[6]?.split(',');
assert.ok(!selectedArms || new Set(selectedArms).size === selectedArms.length && selectedArms.every((name) => availableArms.some((arm) => arm.name === name)), 'Invalid arm selection');
const arms = selectedArms ? selectedArms.map((name) => availableArms.find((arm) => arm.name === name))
  : qualityLevels.length ? qualityArms : defaultArms;
const metadata = { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length,
  engine: engineVersions(), vitePwa: packageJson.version, sharp: sharp.versions,
  sourceSha256: Object.fromEntries(['lib/core.mjs', 'lib/config.mjs', 'lib/engine.mjs', 'lib/pipeline.mjs', 'lib/svg-precision.mjs'].map((name) => [name, hash(readFileSync(new URL('../' + name, import.meta.url)))])),
  inputSha256: Object.fromEntries(samples.map((sample) => [sample.id, hash(sample.raw)])),
  favseedQuality: 100, // Explicit colors256 path; independent of the public default.
  icoSize: ICO_SIZE, favseedDefaultQuality: DEFAULT_QUALITY, // favseed-default uses the current public default and skips Zopfli.
  arms: arms.map((arm) => arm.name), lowEffort, qualityLevels, repetitions: 2, options: defaultPngCompressionOptions,
  note: `Encoding only on fixed already-placed pixels, no SVG/raster/placement/file-count difference. Vite API with padding0/identity resize. Pixel error is vs raw rendered pixels, not original SVG. ${ICO_SIZE}px ICO is reported separately from the default 1% accuracy gate.` };
writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
for (const { id, raw } of samples) writeFileSync(join(out, 'inputs', `${id}.png`), raw);
const warm = samples.find((s) => s.id === 'general-512');
for (const arm of arms) await arm.run(warm);
const rows = [];
for (let rep = 0; rep < 2; rep++) for (const [index, sample] of samples.entries()) {
  const offset = index % arms.length, order = [...arms.slice(offset), ...arms.slice(0, offset)];
  if (rep % 2) order.reverse();
  for (const arm of order) {
    const start = performance.now(), png = Buffer.from(await arm.run(sample));
    const ms = performance.now() - start;
    const accuracy = score(decode(png), sample.reference), sha256 = hash(png);
    const previous = rows.find((r) => r.id === sample.id && r.arm === arm.name);
    if (previous) assert.equal(sha256, previous.sha256, 'Output changed between repetitions');
    rows.push({ rep, id: sample.id, px: sample.px, arm: arm.name, ms, bytes: png.length, sha256, ...accuracy });
    writeFileSync(join(out, 'outputs', `${sample.id}-${arm.name}.png`), png);
  }
  writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(JSON.stringify({ rep, sample: sample.id, completed: rows.length, total: 2 * samples.length * arms.length }));
}
const summaries = arms.map(({ name }) => {
  const selected = rows.filter((r) => r.arm === name), first = selected.filter((r) => r.rep === 0);
  const gated = first.filter((r) => r.px !== ICO_SIZE);
  return { arm: name, bytes: first.reduce((n, r) => n + r.bytes, 0),
    medianMs: median([0, 1].map((rep) => selected.filter((r) => r.rep === rep).reduce((n, r) => n + r.ms, 0))),
    worstPct: Math.max(...gated.map((r) => r.pct)), worstIcoPct: Math.max(...first.filter((r) => r.px === ICO_SIZE).map((r) => r.pct)),
    overOnePercent: gated.filter((r) => r.pct > 1).map(({ id, pct }) => ({ id, pct })) };
});
writeFileSync(join(out, 'summary.json'), JSON.stringify({ metadata, summaries, rows }, null, 2) + '\n');
console.log('arm | PNG bytes | encode/finish seconds | worst pixel error% (non-ICO) | files over1%');
for (const s of summaries) console.log(`${s.arm} | ${s.bytes} | ${(s.medianMs / 1000).toFixed(3)} | ${s.worstPct.toFixed(3)} | ${s.overOnePercent.map((r) => r.id).join(',') || 'none'}`);

// Also report an equal raster preset, including each generator's actual ICO route.
const matchedRows = [];
for (const row of rows.filter((item) => item.rep === 0)) {
  const png = readFileSync(join(out, 'outputs', `${row.id}-${row.arm}.png`));
  let bytes = png;
  if (row.px === ICO_SIZE) {
    // Vite re-encodes before wrapping. Verify that this changes no decoded pixels.
    bytes = Buffer.from(row.arm.startsWith('vite-') ? await generateFavicon('png', png) : icoWrap(png, ICO_SIZE));
    assert.equal(bytes.readUInt16LE(2), 1);
    assert.equal(bytes.readUInt16LE(4), 1);
    assert.equal(bytes[6], ICO_SIZE);
    assert.equal(bytes[7], ICO_SIZE);
    const offset = bytes.readUInt32LE(18), length = bytes.readUInt32LE(14);
    assert.deepEqual(decode(bytes.subarray(offset, offset + length)), decode(png), 'ICO repacking changed pixels');
  }
  const [mark] = row.id.split('-');
  const name = row.px === ICO_SIZE ? 'favicon.ico' : row.px === 180 ? 'apple-touch-icon.png' : `icon-${row.px}.png`;
  const dir = join(out, 'matched-files', row.arm, mark);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
  matchedRows.push({ ...row, mark, name, bytes: bytes.length, sha256: hash(bytes) });
}
const matchedSummaries = arms.map(({ name: arm }) => {
  const selected = matchedRows.filter((row) => row.arm === arm);
  assert.equal(selected.length, 16);
  return { arm, rasterBytes: selected.reduce((sum, row) => sum + row.bytes, 0),
    byMark: Object.fromEntries(['tiles', 'general', 'heavy', 'gradient'].map((mark) => [mark,
      selected.filter((row) => row.mark === mark).reduce((sum, row) => sum + row.bytes, 0)])) };
});
writeFileSync(join(out, 'matched-summary.json'), JSON.stringify({
  note: `16 matched raster files:${ICO_SIZE}px ICO plus180/192/512px PNG for each of4fixtures. Same raw pixels, dimensions, backgrounds and placement. Real Vite generateFavicon route; Favseed ICO wrapper. SVG/manifest excluded. ICO pixels verified unchanged after repacking.`,
  summaries: matchedSummaries, rows: matchedRows,
}, null, 2) + '\n');
console.log(JSON.stringify(matchedSummaries, null, 2));
