// Explore palette/speed choices; never relax production's accuracy policy from these results alone.
// node bench/png-quantize-screen.mjs /fresh/results
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as image from '@napi-rs/image';
import { engineVersions, loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { decode } from '../test/lib/png.mjs';
import { reference, score } from '../test/lib/accuracy.mjs';
import { benchmarkPath } from './path.mjs';

assert.ok(process.argv[2], 'Pass a fresh result directory');
const out = benchmarkPath(process.argv[2]); mkdirSync(out, { recursive: true }); assert.ok(!readdirSync(out).length);
const engine = await loadEngine(), samples = [];
const marks = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const mark of marks) {
  const source = readFileSync(new URL(`../test/fixtures/${mark}.svg`, import.meta.url), 'utf8');
  await buildSet(source, normaliseOptions({}), { optimiseSvg, engine: { ...engine,
    encode: async (png) => {
      const raw = Buffer.from(png), px = raw.readUInt32BE(16);
      samples.push({ id: `${mark}-${px}`, mark, px, raw }); return raw;
    }, finish: async (png) => png,
  } });
}
const choices = [
  ...[1, 3, 5].map((speed) => ({ name: `c256-s${speed}`, options: { colors: 256, speed, minQuality: 0, maxQuality: 100 } })),
  ...[128, 64, 32].map((colors) => ({ name: `c${colors}-s1`, options: { colors, speed: 1, minQuality: 0, maxQuality: 100 } })),
  { name: 'quality99-merge', options: { speed: 1, minQuality: 95, maxQuality: 99, mergeDown: true } },
];
for (const { name } of choices) mkdirSync(join(out, name));
mkdirSync(join(out, 'inputs'));
const rows = [];
for (const sample of samples) {
  writeFileSync(join(out, 'inputs', `${sample.id}.png`), sample.raw);
  const ref = await reference({ source: fileURLToPath(new URL(`../test/fixtures/${sample.mark}.svg`, import.meta.url)),
    px: sample.px, bg: sample.px === 32 ? null : '#000000', vars: {}, fitted: sample.px !== 32 });
  const lossless = Buffer.from(await image.losslessCompressPng(sample.raw)), rawPixels = decode(sample.raw);
  for (const { name, options } of choices) {
    try {
      const start = performance.now(), quantised = Buffer.from(await image.pngQuantize(sample.raw, options));
      const quantiseMs = performance.now() - start;
      const png = lossless.length < quantised.length ? lossless : quantised, pixels = decode(png);
      const sourceAccuracy = score(pixels, ref), rawAccuracy = score(pixels, rawPixels);
      const baseline = rows.find((r) => r.id === sample.id && r.name === 'c256-s1');
      const row = { id: sample.id, name, px: sample.px, mark: sample.mark, bytes: png.length, sha256: hash(png),
        quantiseMs, sourceAccuracy, rawAccuracy,
        sourceNoWorse: !baseline || (sourceAccuracy.pct <= baseline.sourceAccuracy.pct && sourceAccuracy.rmse <= baseline.sourceAccuracy.rmse),
        exactBaselinePixels: !baseline || baseline.pixels === hash(pixels.data), pixels: hash(pixels.data) };
      rows.push(row); writeFileSync(join(out, name, `${sample.id}.png`), png);
    } catch (error) { rows.push({ id: sample.id, name, error: String(error) }); }
  }
  writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(sample.id);
}
const summaries = choices.map(({ name, options }) => {
  const selected = rows.filter((r) => r.name === name), good = selected.filter((r) => !r.error);
  const nonIco = good.filter((r) => r.px !== 32), nonGradient = nonIco.filter((r) => r.mark !== 'gradient');
  return { name, options, errors: selected.filter((r) => r.error), bytes: good.reduce((n, r) => n + r.bytes, 0),
    sourceWorse: good.filter((r) => !r.sourceNoWorse).map((r) => r.id), exactBaselinePixels: good.filter((r) => r.exactBaselinePixels).length,
    worstSourcePct: Math.max(...nonIco.map((r) => r.sourceAccuracy.pct)),
    worstNonGradientSourcePct: Math.max(...nonGradient.map((r) => r.sourceAccuracy.pct)),
    quantiseMs: good.reduce((n, r) => n + r.quantiseMs, 0) };
});
writeFileSync(join(out, 'summary.json'), JSON.stringify({ engine: engineVersions(),
  note: 'Palette exploration; times cover quantization only, not lossless candidate/placement/finish. Single screening run, not controlled performance claims. SourceNoWorse requires both source error percentage and RMSE no higher than c256/speed1 baseline per file. Do not conceal existing gradient/ICO exceptions.',
  summaries, rows }, null, 2) + '\n');
console.log(JSON.stringify(summaries));
