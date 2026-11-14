// favseed next to four other favicon generators, each run with its documented defaults over the
// buildable test fixtures and the open corpus.
//
//   node bench/compare/run.mjs [--install] [--inputs N] [--reps 3] [--write]
//
// --install  copies package.json and package-lock.json from this directory into
//            bench/out/compare/deps/ and runs `npm ci --ignore-scripts` there. The competitors
//            are never favseed dependencies; see deps.mjs.
// --inputs N the first N inputs only (fixtures sort first), for a smoke run.
// --reps N   timed repetitions per tool (default 3).
// --write    also copies results.json to bench/compare/results.json, the committed copy.
//
// Two measurements:
//
// Whole set: every file each tool writes by default, timed. Each tool runs in its own fresh Node
// process per repetition, so engine start-up is counted rather than amortised away: the process
// builds one warm-up input (the first), then every input in order, then the first input again to
// check it writes the same bytes twice. Tools run one at a time, never concurrently, in an order
// rotated each repetition, so no tool always runs first on a cold disk cache or last on a hot
// machine. Cold time is fork to the first finished set.
//
// Like for like: a transparent, unpadded 192 and 512 px PNG from each tool, scored with favseed's
// bar (lib/quality.mjs passesBar) against two references. resvg's render of the var()-resolved
// source (test/lib/accuracy.mjs reference) is the source as favseed's renderer draws it; sharp's
// lossless render of the raw SVG is the source as the other four tools' renderer, librsvg, draws
// it. Against the second, a difference between the two renderers is not counted as another
// tool's encoding error; against the first, it is.
//
// var(): librsvg ignores custom property definitions and draws a var() with its fallback, or
// black without one (sharp 0.33.5, 0.34.5 and 0.35.5 alike, the three copies installed here).
// Every var() in the fixtures carries a fallback and none is defined, so this corpus never shows
// the black render; the pass counts are still reported without the var() inputs, so a corpus
// that does show it shows it there.
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { corpusFiles } from '../corpus/files.mjs';
import { classify, median, setDigest, summarise } from './lib.mjs';
import { depsDir } from './deps.mjs';

const HERE = new URL('./', import.meta.url);
const OUT = new URL('../out/compare/', import.meta.url);
const TOOLS = ['favseed', 'favicons', 'astro-favicons', 'vite-pwa', 'realfavicon'];
const SIZES = [192, 512];

const { values: args } = parseArgs({
  options: {
    install: { type: 'boolean' },
    inputs: { type: 'string' },
    reps: { type: 'string', default: '3' },
    write: { type: 'boolean' },
    child: { type: 'string' },
    like: { type: 'boolean' },
    'inputs-file': { type: 'string' },
  },
});

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const now = () => performance.timeOrigin + performance.now();
const digest = (set) => (set.files ? setDigest(set.files) : null);
const loadTool = (id) => {
  if (!TOOLS.includes(id)) throw new Error(`unknown tool ${id}`);
  return import(new URL(`tools/${id}.mjs`, HERE).href);
};

// ------------------------------------------------------------------------------- child --

if (args.child) {
  const inputs = JSON.parse(readFileSync(args['inputs-file'], 'utf8'));
  const tool = await loadTool(args.child);
  if (args.like) {
    // Untimed: write each like-for-like pair where the parent scores it.
    const errors = {};
    for (const input of inputs) {
      try {
        const pair = await tool.likeForLike(input.path);
        for (const px of SIZES) {
          const file = join(input.likeDir, `${tool.id}-${px}.png`);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, pair[px]);
        }
      } catch (error) {
        errors[input.name] = error.message;
      }
    }
    process.send({ type: 'like', errors }, () => process.exit(0));
  } else {
    const build = async (input) => {
      const start = performance.now();
      try {
        const { files } = await tool.wholeSet(input.path);
        return { ms: performance.now() - start, files };
      } catch (error) {
        return { ms: performance.now() - start, error: error.message };
      }
    };
    const warm = await build(inputs[0]);
    const firstSet = now();
    const results = [];
    for (const input of inputs) {
      const { ms, files, error } = await build(input);
      results.push(
        error
          ? { name: input.name, ms, error }
          : {
              name: input.name,
              ms,
              digest: setDigest(files),
              files: files.map(({ name, bytes }) => ({ name, size: bytes.length, sha256: sha256(bytes) })),
            },
      );
    }
    const again = await build(inputs[0]);
    process.send(
      {
        type: 'timed',
        label: tool.label,
        engine: tool.engine,
        preset: tool.preset,
        firstSet,
        warmDigest: digest(warm),
        repeatDigest: digest(again),
        inputs: results,
      },
      () => process.exit(0),
    );
  }
} else {
  await main();
}

// ------------------------------------------------------------------------------ parent --

function runChild(tool, inputsFile, like) {
  return new Promise((resolve, reject) => {
    const started = now();
    const child = fork(
      import.meta.filename,
      ['--child', tool, '--inputs-file', inputsFile, ...(like ? ['--like'] : [])],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    );
    let message;
    child.on('message', (m) => (message = m));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 || !message) reject(new Error(`${tool} child exited with code ${code}`));
      else resolve({ ...message, started });
    });
  });
}

function install() {
  mkdirSync(depsDir, { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) copyFileSync(new URL(name, HERE), join(depsDir, name));
  // sharp ships its libvips binaries as optional dependencies (@img/sharp-*), so no package here
  // needs an install script, and none is run.
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', depsDir], {
    stdio: 'inherit',
  });
  // One copy per resolution, since three are installed: the reference's, favilib's, the adapter's.
  const anchors = [
    'package.json',
    'node_modules/favilib/package.json',
    'node_modules/@realfavicongenerator/image-adapter-node/package.json',
  ];
  for (const anchor of anchors) {
    try {
      execFileSync(
        process.execPath,
        ['-e', `require('node:module').createRequire(${JSON.stringify(join(depsDir, anchor))})('sharp')`],
        { stdio: 'pipe' },
      );
    } catch (error) {
      throw new Error(
        `sharp does not load from ${anchor} (no prebuilt binary for ${process.platform}-${process.arch}?):\n${error.stderr}`,
        { cause: error },
      );
    }
  }
}

// The same density favicons gives sharp (src/svgtool.ts at v7.3.1,
// https://github.com/itgalaxy/favicons/blob/v7.3.1/src/svgtool.ts#L17-L35): librsvg draws an SVG
// at its own size at 72 dpi, so rendering at the target size means raising the density, or the
// reference would be an upscaled small render.
async function sharpReference(sharp, svg, px) {
  const meta = await sharp(svg).metadata();
  const base = meta.density ?? 72;
  const density =
    meta.width && meta.height
      ? Math.min(Math.max(1, base, (base * px) / meta.width, (base * px) / meta.height), 100000)
      : undefined;
  const { data, info } = await sharp(svg, { density })
    .resize({ width: px, height: px, fit: 'contain', background: '#00000000' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: new Uint8Array(data) };
}

async function main() {
  if (args.install) install();
  const reps = Number(args.reps);
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps takes a positive integer');
  let inputs = await corpusFiles({ fixtures: true, open: true });
  if (args.inputs) {
    const n = Number(args.inputs);
    if (!Number.isInteger(n) || n < 1) throw new Error('--inputs takes a positive integer');
    inputs = inputs.slice(0, n);
  }
  const outDir = fileURLToPath(OUT);
  const likeRoot = join(outDir, 'like');
  rmSync(likeRoot, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  inputs = inputs.map((input) => ({ ...input, likeDir: join(likeRoot, input.corpus, input.name) }));
  const inputsFile = join(outDir, 'inputs.json');
  writeFileSync(inputsFile, JSON.stringify(inputs, null, 2) + '\n');

  // Whole sets, timed.
  const timed = Object.fromEntries(TOOLS.map((id) => [id, []]));
  for (let rep = 0; rep < reps; rep++) {
    const order = [...TOOLS.slice(rep % TOOLS.length), ...TOOLS.slice(0, rep % TOOLS.length)];
    for (const id of order) {
      const run = await runChild(id, inputsFile, false);
      timed[id].push({ ...run, cold: run.firstSet - run.started });
      const failed = run.inputs.filter((input) => input.error).length;
      console.error(
        `rep ${rep + 1}/${reps} ${id}: ${(run.inputs.reduce((sum, input) => sum + input.ms, 0) / 1000).toFixed(1)} s` +
          `, cold ${(run.firstSet - run.started).toFixed(0)} ms${failed ? `, ${failed} failed` : ''}`,
      );
    }
  }

  // Like-for-like pairs, untimed, one process per tool as above: the five tools between them load
  // three sharp releases, and two libvips builds should not share one process.
  const likeErrors = {};
  for (const id of TOOLS) likeErrors[id] = (await runChild(id, inputsFile, true)).errors;

  const { reference } = await import('../../test/lib/accuracy.mjs');
  const { decode } = await import('../../test/lib/png.mjs');
  const { passesBar, prepareReference } = await import('../../lib/quality.mjs');
  const { engineVersions } = await import('../../bin/favseed.mjs');
  const { requireDep } = await import('./deps.mjs');
  const sharp = requireDep('sharp');
  const score = (candidate, ref) => {
    if (!ref) return null;
    const { pass, pct, edge } = passesBar(candidate, ref);
    return { pct: Number(pct.toFixed(4)), edge: Number(edge.toFixed(4)), pass };
  };

  const hashes = {};
  const rows = [];
  for (const input of inputs) {
    const source = readFileSync(input.path);
    const row = {
      corpus: input.corpus,
      name: input.name,
      sha256: sha256(source),
      // The var() split the summary reports; see the note at the top.
      usesVar: source.toString('utf8').includes('var('),
      tools: {},
    };
    const refs = {};
    for (const px of SIZES) {
      refs[px] = { resvg: null, sharp: null };
      try {
        refs[px].resvg = prepareReference(await reference({ source: input.path, px }).then(toRgba));
      } catch (error) {
        row.referenceError = { ...row.referenceError, resvg: error.message };
      }
      try {
        refs[px].sharp = prepareReference(await sharpReference(sharp, source, px));
      } catch (error) {
        row.referenceError = { ...row.referenceError, sharp: error.message };
      }
    }
    hashes[`${input.corpus}/${input.name}`] = {};
    for (const id of TOOLS) {
      const runs = timed[id].map((run) => run.inputs.find((r) => r.name === input.name));
      const first = runs[0];
      const entry = {};
      if (first.error) entry.error = first.error;
      else {
        const bytesOf = (kind) =>
          first.files.filter((f) => classify(f.name) === kind).reduce((sum, f) => sum + f.size, 0);
        Object.assign(entry, {
          files: first.files.length,
          rasterBytes: bytesOf('raster'),
          svgBytes: bytesOf('svg'),
          otherBytes: bytesOf('other'),
          digest: first.digest,
        });
        hashes[`${input.corpus}/${input.name}`][id] = Object.fromEntries(first.files.map((f) => [f.name, f.sha256]));
      }
      entry.ms = Number(median(runs.map((r) => r.ms)).toFixed(1));
      entry.like = {};
      if (likeErrors[id][input.name]) entry.like.error = likeErrors[id][input.name];
      else
        for (const px of SIZES) {
          const bytes = readFileSync(join(input.likeDir, `${id}-${px}.png`));
          const img = toRgba(decode(bytes));
          const like = { bytes: bytes.length, sha256: sha256(bytes), transparent: hasTransparency(img) };
          if (img.width !== px || img.height !== px) like.error = `${img.width}x${img.height}, not ${px}x${px}`;
          else Object.assign(like, { resvg: score(img, refs[px].resvg), sharp: score(img, refs[px].sharp) });
          entry.like[px] = like;
        }
      row.tools[id] = entry;
    }
    rows.push(row);
  }

  const tools = TOOLS.map((id) => {
    const run = timed[id][0];
    return {
      id,
      label: run.label,
      ...(run.engine && { engine: run.engine }),
      ...(run.preset && { preset: run.preset }),
    };
  });
  const determinism = Object.fromEntries(
    TOOLS.map((id) => {
      const differing = inputs
        .filter((input) => {
          const digests = timed[id].map((run) => run.inputs.find((r) => r.name === input.name).digest);
          return new Set(digests).size > 1;
        })
        .map((input) => input.name);
      const repeats = timed[id].every(
        (run) => run.repeatDigest === run.inputs[0].digest && run.warmDigest === run.inputs[0].digest,
      );
      return [id, { deterministic: !differing.length && repeats, differing, repeatsMatch: repeats }];
    }),
  );

  const results = {
    generated: new Date().toISOString(),
    machine: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
    },
    reps,
    tools,
    references: {
      resvg: `@napi-rs/image ${engineVersions()['@napi-rs/image']}`,
      sharp: `sharp ${sharp.versions.sharp} (libvips ${sharp.versions.vips}, librsvg ${sharp.versions.rsvg})`,
    },
    summary: Object.fromEntries(TOOLS.map((id) => [id, summaryFor(id, rows, timed[id])])),
    determinism,
    inputs: rows,
  };
  // One line per input: the file is committed, and indenting 103 rows five tools deep would
  // triple its size and every diff of it.
  const { inputs: inputRows, ...head } = results;
  const text = JSON.stringify({ ...head, inputs: [] }, null, 2).replace(
    '"inputs": []',
    `"inputs": [\n${inputRows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`,
  );
  writeFileSync(join(outDir, 'results.json'), text + '\n');
  writeFileSync(join(outDir, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
  if (args.write) copyFileSync(join(outDir, 'results.json'), new URL('results.json', HERE));
  print(results);
}

function toRgba(img) {
  return { width: img.width, height: img.height, rgba: img.rgba ?? img.data };
}

function hasTransparency({ rgba }) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

// Per corpus and overall: sums of bytes, the file-count range, medians of time, pass counts with
// and without the var() inputs.
function summaryFor(id, rows, runs) {
  const groups = {
    fixtures: rows.filter((r) => r.corpus === 'fixtures'),
    open: rows.filter((r) => r.corpus === 'open'),
    all: rows,
  };
  const out = {};
  for (const [group, selected] of Object.entries(groups)) {
    if (!selected.length) continue;
    const names = new Set(selected.map((r) => r.name));
    const built = selected.filter((r) => !r.tools[id].error);
    const counts = built.map((r) => r.tools[id].files);
    const sum = (key) => built.reduce((total, r) => total + r.tools[id][key], 0);
    const timing = summarise(
      runs.map((run) => ({ cold: run.cold, inputs: run.inputs.filter((input) => names.has(input.name)) })),
    );
    const like = (subset) => {
      const scored = subset.filter((r) => !r.tools[id].like.error);
      const passes = (ref) => scored.filter((r) => SIZES.every((px) => r.tools[id].like[px][ref]?.pass)).length;
      return { inputs: subset.length, scored: scored.length, passResvg: passes('resvg'), passSharp: passes('sharp') };
    };
    out[group] = {
      inputs: selected.length,
      failed: selected.length - built.length,
      files: counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null,
      rasterBytes: sum('rasterBytes'),
      svgBytes: sum('svgBytes'),
      otherBytes: sum('otherBytes'),
      totalMs: Number(timing.totalMs.toFixed(1)),
      coldMs: Number(timing.coldMs.toFixed(1)),
      like: {
        bytes: Object.fromEntries(
          SIZES.map((px) => [px, selected.reduce((total, r) => total + (r.tools[id].like[px]?.bytes ?? 0), 0)]),
        ),
        all: like(selected),
        withoutVar: like(selected.filter((r) => !r.usesVar)),
      },
    };
  }
  return out;
}

function print({ tools, summary, determinism, references }) {
  console.log(`references: ${references.resvg}; ${references.sharp}`);
  console.log(
    'tool | files | raster B | svg B | other B | total s | cold s | like B (192+512) | pass resvg | pass sharp | pass resvg, no var() | deterministic',
  );
  for (const { id, label } of tools) {
    const s = summary[id].all;
    const files = s.files ? (s.files.min === s.files.max ? `${s.files.min}` : `${s.files.min}-${s.files.max}`) : '-';
    console.log(
      [
        label,
        files,
        s.rasterBytes,
        s.svgBytes,
        s.otherBytes,
        (s.totalMs / 1000).toFixed(2),
        (s.coldMs / 1000).toFixed(2),
        s.like.bytes[192] + s.like.bytes[512],
        `${s.like.all.passResvg}/${s.like.all.inputs}`,
        `${s.like.all.passSharp}/${s.like.all.inputs}`,
        `${s.like.withoutVar.passResvg}/${s.like.withoutVar.inputs}`,
        determinism[id].deterministic ? 'yes' : `no (${determinism[id].differing.join(', ') || 'repeat'})`,
      ].join(' | '),
    );
  }
}
