#!/usr/bin/env node
// The measurement harness. Sweeps the axes the pipeline was chosen on, over test/fixtures/,
// prints a table per sweep and regenerates docs/BENCHMARKS.md.
//
//   node bench/bench.mjs                  every sweep
//   node bench/bench.mjs colors zopfli    those two alone
//   node bench/bench.mjs --write          also rewrite docs/BENCHMARKS.md
//
// Scratch output goes to bench/out/, which is gitignored. Nothing here is imported by the
// tool; it exists so that "every pipeline change arrives with a number" is a command rather
// than an aspiration.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, engineVersions } from '../bin/favseed.mjs';
import { DEFAULT_COLORS, squareIconSvg } from '../lib/core.mjs';
import { reference, score } from '../test/lib/accuracy.mjs';
import { decode } from '../test/lib/png.mjs';
import { precisionSweep } from './precision.mjs';
import { framingSweep } from './framing.mjs';
import { icoSizeSweep } from './ico-size.mjs';
import { placementSweep } from './placement.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const FIXTURES = join(ROOT, 'test', 'fixtures');
const OUT = join(HERE, 'out');

// Every fixture that builds. The negative ones do not, by design.
const MARKS = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil'];
// [label, px, file, ground, placed]: every raster a default build writes except the ICO.
// The whole set is padded into the safe zone now, so every row is placed on the ground.
const CHECKS = [
  ['180m', 180, 'apple-touch-icon.png', '#000000', true],
  ['192m', 192, 'icon-192.png', '#000000', true],
  ['512m', 512, 'icon-512.png', '#000000', true],
];

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

/** Raw, unquantised renders through the engine: the input to every PNG sweep. Rendered once. */
const rawRenders = async () => {
  const { loadEngine } = await import('../bin/favseed.mjs');
  const engine = await loadEngine();
  const dir = join(OUT, 'raw');
  mkdirSync(dir, { recursive: true });
  const made = [];
  for (const m of MARKS) {
    // Render from favseed's own icon.svg, so the sweeps measure the PNG pipeline in
    // isolation rather than re-measuring svgo on every axis.
    const built = join(OUT, 'svg', m);
    await build({ input: join(FIXTURES, `${m}.svg`), out: built, sizes: [16], bg: null, zopfli: false });
    const rasterSvg = squareIconSvg(readFileSync(join(built, 'icon.svg'), 'utf8')).data;
    for (const px of [16, 32, 180, 192, 512]) {
      const f = join(dir, `${m}-${px}.png`);
      writeFileSync(f, await engine.render(rasterSvg, px));
      made.push({ mark: m, px, file: f });
    }
  }
  return made;
};

// ------------------------------------------------------------------ sweeps --

const sweeps = {};
sweeps.precision = () => precisionSweep(join(OUT, 'precision'));
sweeps.framing = () => framingSweep(join(OUT, 'framing'));
sweeps['ico-size'] = () => icoSizeSweep(join(OUT, 'ico-size'));
sweeps.placement = () => placementSweep(join(OUT, 'placement'));

sweeps.accuracy = async () => {
  const cols = [8, 16, 32, 64, 256];
  const rows = [];
  let worst = { pct: 0 };
  for (const m of MARKS) {
    for (const [label, px, file, bg, fitted] of CHECKS) {
      const cells = [];
      for (const c of cols) {
        const out = join(OUT, 'acc', `${m}-${c}-${label}`);
        await build({
          input: join(FIXTURES, `${m}.svg`),
          out,
          sizes: [192, 512],
          colors: c,
          bg: '#000000',
          zopfli: false,
        });
        const ref = await reference({ source: join(FIXTURES, `${m}.svg`), px, bg, vars: {}, fitted });
        const s = score(decode(readFileSync(join(out, file))), ref);
        cells.push(s.pct);
        if (m !== 'gradient' && s.pct > worst.pct) worst = { pct: s.pct, at: `${m}@${label}`, colors: c };
      }
      rows.push([m, label, ...cells]);
    }
  }
  const head = `${pad('mark', 10)}${num('size', 5)}${cols.map((c) => num('c' + c, 9)).join('')}`;
  const body = rows.map(
    ([m, px, ...cs]) => `${pad(m, 10)}${num(px, 5)}${cs.map((v) => num(v.toFixed(2), 9)).join('')}`,
  );
  return {
    title: 'Accuracy: pct by mark, size and palette size',
    note: 'pct = share of pixels more than 8/255 from an unquantised reference, worse of a white and a black composite. The bar is 1.0 %. `gradient` is excluded from the worst-case line: it exists to make the lossless path win. Only at 32 colours or fewer does the quantised gradient miss the bar (up to 30.03 % at c8); at c64 and c256 it holds inside it (0.28–0.60 % and 0.00–0.01 %), with the size guard (decision 7) choosing the lossless path whenever it is smaller.',
    text: [head, ...body].join('\n'),
    summary: `worst non-gradient: ${worst.pct.toFixed(3)} % (${worst.at}, --colors ${worst.colors})`,
  };
};

sweeps.colors = async () => {
  const out = [];
  for (const c of [4, 8, 16, 32, 64, 128, 256]) {
    let bytes = 0,
      worst = 0,
      at = '';
    for (const m of MARKS) {
      if (m === 'gradient') continue;
      const dir = join(OUT, 'colors', `${m}-${c}`);
      const r = await build({
        input: join(FIXTURES, `${m}.svg`),
        out: dir,
        sizes: [192, 512],
        colors: c,
        bg: '#000000',
      });
      for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) bytes += r.bytes[f];
      for (const [label, px, file, bg, fitted] of CHECKS) {
        const ref = await reference({ source: join(FIXTURES, `${m}.svg`), px, bg, vars: {}, fitted });
        const s = score(decode(readFileSync(join(dir, file))), ref);
        if (s.pct > worst) {
          worst = s.pct;
          at = `${m}@${label}`;
        }
      }
    }
    out.push([c, bytes, worst, at]);
  }
  const base = out.find((r) => r[0] === DEFAULT_COLORS)[1];
  const text = [
    `${num('colors', 7)}${num('bytes', 9)}${num(`vs c${DEFAULT_COLORS}`, 9)}${num('worst pct', 11)}  where`,
    ...out.map(
      ([c, b, w, at]) =>
        `${num(c, 7)}${num(b, 9)}${num(((b / base - 1) * 100).toFixed(1) + '%', 9)}${num(w.toFixed(3) + '%', 11)}  ${at}${w <= 1 ? '' : '   OVER THE BAR'}`,
    ),
  ].join('\n');
  return {
    title: 'Palette size: bytes against accuracy',
    note: `${MARKS.length - 1} marks (gradient excluded), 180 + 192 + 512 px all placed, default Zopfli disabled. Passing --colors here selects quality 100, not the quality-80 default that ships when --colors is left unset; this is the sweep that set the default --colors ceiling.`,
    text,
  };
};

// The engine's finish over the default encode of every 192 and 512 px raw render.
sweeps.zopfli = async () => {
  const { loadEngine } = await import('../bin/favseed.mjs');
  const engine = await loadEngine();
  const raws = (await rawRenders()).filter((r) => r.px === 192 || r.px === 512);
  const encoded = await Promise.all(
    raws.map(async (r) => engine.encode(readFileSync(r.file), { colors: DEFAULT_COLORS })),
  );
  const rows = [];
  for (const zi of [15, 30, 60, 120, 240]) {
    let bytes = 0;
    const t0 = performance.now();
    for (const png of encoded) bytes += (await engine.finish(png, { iterations: zi })).length;
    rows.push([zi, bytes, (performance.now() - t0) / 1000]);
  }
  const base = rows[0][1];
  return {
    title: 'Zopfli iterations',
    note: "The engine's finish over the default encode of every 192 and 512 px raw render. 15 is the fast mode's count, 120 the release count.",
    text: [
      `${num('iters', 6)}${num('bytes', 10)}${num('vs 15', 9)}${num('seconds', 10)}`,
      ...rows.map(
        ([zi, b, s]) =>
          `${num(zi, 6)}${num(b, 10)}${num(((b / base - 1) * 100).toFixed(2) + '%', 9)}${num(s.toFixed(1), 10)}`,
      ),
    ].join('\n'),
  };
};

// Decision 27: does finishing the jobs in parallel worker threads beat finishing them in turn?
// WASM zopfli runs on one thread, unlike oxipng, so decision 13's reason may not hold.
sweeps.parallel = async () => {
  const { Worker } = await import('node:worker_threads');
  const { loadEngine } = await import('../bin/favseed.mjs');
  const engine = await loadEngine();
  const raws = (await rawRenders()).filter((r) => r.mark === 'general');
  const encs = await Promise.all(
    raws.map(async (r) => engine.encode(readFileSync(r.file), { colors: DEFAULT_COLORS })),
  );
  const worker = `
    const { parentPort, workerData } = require('node:worker_threads');
    import('${new URL('../bin/favseed.mjs', import.meta.url).href}').then(async ({ loadEngine }) => {
      const e = await loadEngine();
      parentPort.postMessage((await e.finish(workerData, { iterations: 120 })).length);
    });`;
  const serial = [],
    parallel = [];
  for (let rep = 0; rep < 3; rep++) {
    let t = performance.now();
    for (const enc of encs) await engine.finish(enc, { iterations: 120 });
    serial.push((performance.now() - t) / 1000);
    t = performance.now();
    await Promise.all(
      encs.map(
        (enc) =>
          new Promise((ok, bad) => {
            const w = new Worker(worker, { eval: true, workerData: enc });
            w.once('message', ok);
            w.once('error', bad);
          }),
      ),
    );
    parallel.push((performance.now() - t) / 1000);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[1];
  return {
    title: 'Finishing the jobs in turn against in parallel workers (decision 27)',
    note: `general.svg, ${encs.length} files, zopfli at 120 iterations, 3 interleaved repetitions, median shown.`,
    text: [`in turn     ${med(serial).toFixed(2)} s`, `in parallel ${med(parallel).toFixed(2)} s`].join('\n'),
  };
};

// ------------------------------------------------------------------- main --

const main = async () => {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const want = args.filter((a) => !a.startsWith('--'));
  const available = new Map(Object.entries(sweeps));
  const names = want.length ? want : [...available.keys()];
  for (const n of names)
    if (!available.has(n)) {
      process.stderr.write(`bench: no sweep '${n}'\n`);
      process.exit(1);
    }

  // A partial --write would truncate the document to whichever sweeps ran, without a warning,
  // which is worse than not writing at all: the file claims to be the current state of every axis.
  if (write && names.length !== available.size) {
    process.stderr.write('bench: --write needs every sweep; drop the sweep names or drop --write\n');
    process.exit(1);
  }

  const versions = engineVersions();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const results = [];
  for (const n of names) {
    const sweep = available.get(n);
    if (typeof sweep !== 'function') {
      process.stderr.write(`bench: no sweep '${n}'\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`bench: ${n}...\n`);
    const r = await sweep();
    results.push({ name: n, ...r });
    process.stdout.write(`\n## ${r.title}\n\n${r.text}\n${r.summary ? '\n' + r.summary + '\n' : ''}`);
  }

  if (write) {
    const doc = [
      '# Benchmarks',
      '',
      '<!-- Generated by `node bench/bench.mjs --write`. Do not edit by hand. -->',
      '',
      `Measured over \`test/fixtures/\` on ${new Date().toISOString().slice(0, 10)}, with:`,
      '',
      '```',
      ...Object.entries(versions).map(([k, v]) => `${k.padEnd(15)} ${v}`),
      `${'node'.padEnd(15)} ${process.version}`,
      '```',
      '',
      'These numbers come from the fixtures in this repository, which are not the 39-mark',
      'corpus the original decisions were taken on. Where they disagree, these are the ones',
      'to trust: they are the ones you can reproduce.',
      '',
      ...results.flatMap((r) =>
        [
          `## ${r.title}`,
          '',
          r.note ?? '',
          r.note ? '' : null,
          '```',
          r.text,
          '```',
          '',
          ...(r.summary ? [`**${r.summary}**`, ''] : []),
        ].filter((l) => l !== null),
      ),
    ].join('\n');
    writeFileSync(join(ROOT, 'docs', 'BENCHMARKS.md'), doc);
    process.stderr.write('bench: wrote docs/BENCHMARKS.md\n');
  }
};

await main();
