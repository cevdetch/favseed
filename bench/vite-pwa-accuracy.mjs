// Grade saved encoder outputs against original SVGs, outside the timed benchmark.
// node bench/vite-pwa-accuracy.mjs /path/to/encoder-results [...more-results]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineVersions } from '../bin/favseed.mjs';
import { decode } from '../test/lib/png.mjs';
import { reference, score } from '../test/lib/accuracy.mjs';

assert.ok(process.argv[2], 'Pass encoder-result directories');
const references = new Map();
for (const directory of process.argv.slice(2)) {
  const out = resolve(directory), metadata = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8'));
  assert.deepEqual(metadata.engine, engineVersions(), 'Reference engine must match measured engine');
  const rows = JSON.parse(readFileSync(join(out, 'rows.json'), 'utf8')).filter((row) => row.rep === 0);
  const graded = [];
  for (const row of rows) {
    const mark = row.id.slice(0, row.id.lastIndexOf('-'));
    assert.ok(['tiles', 'general', 'heavy', 'gradient'].includes(mark));
    if (!references.has(row.id)) references.set(row.id, await reference({
      source: fileURLToPath(new URL(`../test/fixtures/${mark}.svg`, import.meta.url)),
      px: row.px, bg: row.px === 32 ? null : '#000000', vars: {}, fitted: row.px !== 32,
    }));
    const png = readFileSync(join(out, 'outputs', `${row.id}-${row.arm}.png`));
    graded.push({ id: row.id, arm: row.arm, px: row.px, gradient: mark === 'gradient',
      ...score(decode(png), references.get(row.id)) });
  }
  const summaries = [...new Set(graded.map((row) => row.arm))].map((arm) => {
    const selected = graded.filter((r) => r.arm === arm && r.px !== 32);
    const nonGradient = selected.filter((r) => !r.gradient);
    return { arm, worstPct: Math.max(...selected.map((r) => r.pct)),
      worstNonGradientPct: Math.max(...nonGradient.map((r) => r.pct)),
      worstIcoPct: Math.max(...graded.filter((r) => r.arm === arm && r.px === 32).map((r) => r.pct)),
      overOnePercent: selected.filter((r) => r.pct > 1).map(({ id, pct }) => ({ id, pct })),
      overOnePercentNonGradient: nonGradient.filter((r) => r.pct > 1).map(({ id, pct }) => ({ id, pct })) };
  });
  writeFileSync(join(out, 'source-accuracy.json'), JSON.stringify({
    note: 'Unquantised original SVG references; shared project safe-zone placement and black/white composite score. Report 32px ICO separately; gradient is the existing corpus exception.',
    summaries, rows: graded,
  }, null, 2) + '\n');
  console.log(out);
  console.log('arm | worst original-SVG error% | worst non-gradient% | failures');
  for (const s of summaries) console.log(`${s.arm} | ${s.worstPct.toFixed(3)} | ${s.worstNonGradientPct.toFixed(3)} | ${s.overOnePercent.map((r) => r.id).join(',') || 'none'}`);
}
