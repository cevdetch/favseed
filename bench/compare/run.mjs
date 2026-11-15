// favseed next to four other favicon generators, each run with its documented defaults over the
// buildable test fixtures and the open corpus.
//
//   node bench/compare/run.mjs [--install] [--only a,b] [--inputs N] [--reps 3] [--write]
//   node bench/compare/run.mjs --readme
//
// --install  copies package.json and package-lock.json from this directory into
//            bench/out/compare/deps/ and runs `npm ci --ignore-scripts` there. The competitors
//            are never favseed dependencies; see deps.mjs.
// --only     the named inputs only (comma-separated corpus names, e.g. grid-tiny,logos/vite),
//            for a smoke run that has to include a particular input.
// --inputs N the first N inputs only (fixtures sort first), for a smoke run.
// --reps N   timed repetitions per tool (default 3).
// --write    also copies results.json to bench/compare/results.json, the committed copy, and
//            regenerates bench/compare/README.md from it (readme.mjs).
// --readme   regenerates README.md from the committed results.json, running nothing.
//
// Two measurements:
//
// Whole set: every file each tool writes by default, timed. Each tool runs in its own fresh Node
// process per repetition, so engine start-up is counted rather than amortised away. The process
// first builds a warm-up mark that is not one of the inputs (WARMUP below, written next to the
// results), so no timed input runs on the back of an identical earlier build; then every input
// in order; then the first input again, to check it writes the same bytes twice. Tools run one
// at a time, never concurrently, in an order rotated each repetition, so no tool always runs
// first on a cold disk cache or last on a hot machine. Cold time is fork to the end of the
// warm-up set.
//
// Like for like: a transparent, unpadded 192 and 512 px PNG from each tool, scored with favseed's
// bar (lib/quality.mjs passesBar) against two references. resvg's render of the var()-resolved
// source (test/lib/accuracy.mjs reference) is the source as favseed's renderer draws it; sharp's
// lossless render of the raw SVG is the source as librsvg, the other four tools' renderer, draws
// it, each tool's reference rendered by the sharp copy that tool itself resolves (three releases
// are installed, with three librsvg builds), and favseed's by the root copy. Against the second,
// a difference between the renderers is not counted as another tool's encoding error; against
// the first, it is.
//
// Totals compare like with like: bytes and time are summed over the inputs every tool built, and
// the inputs left out are listed (lib.mjs groupSummary).
//
// var(): librsvg ignores custom property definitions and draws a var() with its fallback, or
// black without one (sharp 0.33.5, 0.34.5 and 0.35.5 alike, the three copies installed here).
// Every var() in the fixtures carries a fallback and none is defined, so this corpus never shows
// the black render; the pass counts are still reported without the var() inputs, so a corpus
// that does show it shows it there.
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, totalmem, type } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { corpusFiles } from '../corpus/files.mjs';
import {
  classify,
  determinismOf,
  formatResults,
  groupSummary,
  median,
  outcomeKey,
  scoreSize,
  setDigest,
} from './lib.mjs';
import { varCheck } from './var-check.mjs';
import { writeReadme } from './readme.mjs';
import { depsDir, requireDep } from './deps.mjs';

const HERE = new URL('./', import.meta.url);
const OUT = new URL('../out/compare/', import.meta.url);
const TOOLS = ['favseed', 'favicons', 'astro-favicons', 'vite-pwa', 'realfavicon'];
const SIZES = [192, 512];
// A plain filled circle: every tool builds it, and it shares nothing with any input.
const WARMUP =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1F3A5F"/></svg>\n';

const { values: args } = parseArgs({
  options: {
    install: { type: 'boolean' },
    only: { type: 'string' },
    inputs: { type: 'string' },
    reps: { type: 'string', default: '3' },
    write: { type: 'boolean' },
    readme: { type: 'boolean' },
    child: { type: 'string' },
    like: { type: 'boolean' },
    'inputs-file': { type: 'string' },
    warmup: { type: 'string' },
  },
});

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const now = () => performance.timeOrigin + performance.now();
const loadTool = (id) => {
  if (!TOOLS.includes(id)) throw new Error(`unknown tool ${id}`);
  return import(new URL(`tools/${id}.mjs`, HERE).href);
};
// What a build produced, comparable whether it succeeded or failed.
const outcome = (set) => outcomeKey(set.error ? set : { digest: setDigest(set.files) });
const ratio = ({ pass, scored }) => `${pass}/${scored}`;
const git = (...argv) => execFileSync('git', argv, { cwd: fileURLToPath(HERE), encoding: 'utf8' }).trim();
const sharpLabel = (sharp) =>
  `sharp ${sharp.versions.sharp} (libvips ${sharp.versions.vips}, librsvg ${sharp.versions.rsvg})`;

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
  if (info.width !== px || info.height !== px || info.channels !== 4) throw new Error('unexpected reference shape');
  return data;
}

// ------------------------------------------------------------------------------- child --

if (args.child) {
  const inputs = JSON.parse(readFileSync(args['inputs-file'], 'utf8'));
  const tool = await loadTool(args.child);
  if (args.like) {
    // Untimed: write each like-for-like pair, and the sharp reference rendered by this tool's
    // own sharp copy as raw RGBA, where the parent scores them.
    const sharp = requireDep('sharp', tool.sharpFrom);
    const errors = {},
      referenceErrors = {},
      settings = {};
    for (const input of inputs) {
      mkdirSync(input.likeDir, { recursive: true });
      try {
        const pair = await tool.likeForLike(input.path);
        for (const px of SIZES) writeFileSync(join(input.likeDir, `${tool.id}-${px}.png`), pair[px]);
        if (pair.self) settings[input.name] = pair.self;
      } catch (error) {
        errors[input.name] = error.message;
      }
      // One message per size: a reference that fails at one size can still exist at the other.
      const svg = readFileSync(input.path);
      for (const px of SIZES)
        try {
          writeFileSync(join(input.likeDir, `${tool.id}-${px}.sharp.rgba`), await sharpReference(sharp, svg, px));
        } catch (error) {
          (referenceErrors[input.name] ??= {})[px] = error.message;
        }
    }
    process.send({ type: 'like', errors, referenceErrors, settings, sharp: sharpLabel(sharp) }, () => process.exit(0));
  } else {
    const build = async (path) => {
      const start = performance.now();
      try {
        const { files } = await tool.wholeSet(path);
        return { ms: performance.now() - start, files };
      } catch (error) {
        return { ms: performance.now() - start, error: error.message };
      }
    };
    const warm = await build(args.warmup);
    const firstSet = now();
    const results = [];
    let first;
    for (const input of inputs) {
      const set = await build(input.path);
      first ??= set;
      results.push(
        set.error
          ? { name: input.name, ms: set.ms, error: set.error }
          : {
              name: input.name,
              ms: set.ms,
              digest: setDigest(set.files),
              files: set.files.map(({ name, bytes }) => ({ name, size: bytes.length, sha256: sha256(bytes) })),
            },
      );
    }
    const again = await build(inputs[0].path);
    process.send(
      {
        type: 'timed',
        label: tool.label,
        versions: tool.versions,
        engine: tool.engine,
        preset: tool.preset,
        pngQuality: tool.pngQuality,
        firstSet,
        warmError: warm.error,
        repeatsMatch: outcome(again) === outcome(first),
        inputs: results,
      },
      () => process.exit(0),
    );
  }
} else {
  await main();
}

// ------------------------------------------------------------------------------ parent --

function runChild(tool, inputsFile, extra) {
  return new Promise((resolve, reject) => {
    const started = now();
    const child = fork(import.meta.filename, ['--child', tool, '--inputs-file', inputsFile, ...extra], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
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
  // One copy per resolution, since three are installed: the root's, favilib's, the adapter's.
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

// favseed's version is 0.0.0 until its first release, so the commit names the build measured,
// and `dirty` says whether the working tree had uncommitted changes on top of it. Taken here in
// the parent, so no timed process spends its start-up spawning git.
//
// A branch commit does not survive a squash merge, so the build is also named by what does: the
// last commit that touched bin/ or lib/, the git tree hashes of bin/ and lib/ (equal trees are
// equal code, whichever commit holds them), and pnpm-lock.yaml's blob hash, which pins the
// engines. `buildDirty` says whether bin/, lib/ or the lockfile had uncommitted changes, in which
// case the hashes name the committed code, not the code that ran.
function checkout() {
  return {
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
    buildCommit: git('log', '-1', '--format=%h', '--', ':/bin', ':/lib'),
    trees: { bin: git('rev-parse', 'HEAD:bin'), lib: git('rev-parse', 'HEAD:lib') },
    lockfile: git('rev-parse', 'HEAD:pnpm-lock.yaml'),
    buildDirty: git('status', '--porcelain', '--', ':/bin', ':/lib', ':/pnpm-lock.yaml').length > 0,
  };
}

async function main() {
  if (args.readme) {
    writeReadme(JSON.parse(readFileSync(new URL('results.json', HERE), 'utf8')));
    return;
  }
  if (args.install) install();
  const started = new Date();
  // The machine's load before the run and after it: a busy machine slows every tool, but not
  // equally, so the numbers are only worth what this says about the conditions.
  const loadBefore = loadavg();
  const reps = Number(args.reps);
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps takes a positive integer');
  let inputs = await corpusFiles({ fixtures: true, open: true });
  if (args.only) {
    const names = args.only.split(',');
    const unknown = names.filter((name) => !inputs.some((input) => input.name === name));
    if (unknown.length) throw new Error(`--only: no input named ${unknown.join(', ')}`);
    inputs = inputs.filter((input) => names.includes(input.name));
  }
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
  const warmupFile = join(outDir, 'warmup.svg');
  writeFileSync(warmupFile, WARMUP);

  // Whole sets, timed.
  const timed = Object.fromEntries(TOOLS.map((id) => [id, []]));
  for (let rep = 0; rep < reps; rep++) {
    const order = [...TOOLS.slice(rep % TOOLS.length), ...TOOLS.slice(0, rep % TOOLS.length)];
    for (const id of order) {
      const run = await runChild(id, inputsFile, ['--warmup', warmupFile]);
      if (run.warmError) throw new Error(`${id} cannot build the warm-up mark: ${run.warmError}`);
      timed[id].push({ ...run, cold: run.firstSet - run.started });
      const failed = run.inputs.filter((input) => input.error).length;
      console.error(
        `rep ${rep + 1}/${reps} ${id}: ${(run.inputs.reduce((sum, input) => sum + input.ms, 0) / 1000).toFixed(1)} s` +
          `, cold ${(run.firstSet - run.started).toFixed(0)} ms${failed ? `, ${failed} failed` : ''}`,
      );
    }
  }

  // Like-for-like pairs and sharp references, untimed, one process per tool as above: the five
  // tools between them load three sharp releases, and two libvips builds should not share one
  // process.
  const liked = {};
  for (const id of TOOLS) liked[id] = await runChild(id, inputsFile, ['--like']);

  const { reference } = await import('../../test/lib/accuracy.mjs');
  const { decode } = await import('../../test/lib/png.mjs');
  const { passesBar, prepareReference } = await import('../../lib/quality.mjs');
  const { engineVersions } = await import('../../bin/favseed.mjs');
  const score = (candidate, ref) => {
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
    const resvg = {};
    for (const px of SIZES) {
      try {
        resvg[px] = prepareReference(await reference({ source: input.path, px }).then(toRgba));
      } catch (error) {
        resvg[px] = null;
        ((row.referenceError ??= {}).resvg ??= {})[px] = error.message;
      }
    }
    // The two renderers against each other: the root sharp copy's render (favseed's sharp
    // reference) scored against resvg's, losslessly on both sides. Where these disagree, a PNG
    // passes against both only if it sits between them; summary renderers.passedBoth counts those.
    for (const px of SIZES) {
      if (!resvg[px] || liked.favseed.referenceErrors[input.name]?.[px]) continue;
      const rgba = new Uint8Array(readFileSync(join(input.likeDir, `favseed-${px}.sharp.rgba`)));
      (row.renderers ??= {})[px] = score({ width: px, height: px, rgba }, resvg[px]);
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
      // The child's failures to render this tool's sharp reference, then the parent's failures to
      // read or prepare one, per size: either leaves the sharp score null, never the tool's file.
      const sharpErrors = { ...liked[id].referenceErrors[input.name] };
      if (liked[id].errors[input.name]) entry.like.error = liked[id].errors[input.name];
      else
        for (const px of SIZES) {
          const { like, referenceErrors } = scoreSize({
            candidate: (into) => {
              const bytes = readFileSync(join(input.likeDir, `${id}-${px}.png`));
              Object.assign(into, { bytes: bytes.length, sha256: sha256(bytes) });
              const img = toRgba(decode(bytes));
              into.transparent = hasTransparency(img);
              if (img.width !== px || img.height !== px) throw new Error(`${img.width}x${img.height}, not ${px}x${px}`);
              return img;
            },
            references: {
              resvg: () => resvg[px],
              sharp: () =>
                sharpErrors[px]
                  ? null
                  : prepareReference({
                      width: px,
                      height: px,
                      rgba: new Uint8Array(readFileSync(join(input.likeDir, `${id}-${px}.sharp.rgba`))),
                    }),
            },
            score,
          });
          if (referenceErrors.sharp) sharpErrors[px] = referenceErrors.sharp;
          // favseed's own verdict and the setting its search kept, from the same build.
          const self = liked[id].settings[input.name]?.[px];
          entry.like[px] = self ? { ...like, self } : like;
        }
      if (Object.keys(sharpErrors).length) entry.like.referenceError = { sharp: sharpErrors };
      row.tools[id] = entry;
    }
    rows.push(row);
  }

  const revision = checkout();
  const tools = TOOLS.map((id) => {
    const run = timed[id][0];
    // The names one set holds, from the first input the tool built: every tool here writes the
    // same names for every input (summary files.min equals files.max when that holds).
    const built = run.inputs.find((input) => !input.error);
    return {
      id,
      label: run.label,
      versions: run.versions,
      fileNames: built ? built.files.map((f) => f.name).toSorted() : [],
      ...(id === 'favseed' && revision),
      ...(run.pngQuality && { pngQuality: run.pngQuality }),
      ...(run.engine && { engine: run.engine }),
      ...(run.preset && { preset: run.preset }),
      sharpReference: liked[id].sharp,
    };
  });
  const determinism = determinismOf(
    timed,
    TOOLS,
    inputs.map((input) => input.name),
  );

  const groups = {
    fixtures: rows.filter((r) => r.corpus === 'fixtures'),
    open: rows.filter((r) => r.corpus === 'open'),
    all: rows,
  };
  const summary = {};
  for (const [group, selected] of Object.entries(groups))
    if (selected.length) summary[group] = groupSummary(selected, timed, TOOLS, SIZES, liked.favseed.sharp);

  const results = {
    generated: started.toISOString(),
    durationS: Math.round((Date.now() - started) / 1000),
    machine: {
      node: process.version,
      os: `${osName()} (${type()} ${release()})`,
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      ramGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
      load: { before: loadBefore.map(round2), after: loadavg().map(round2) },
      ...power(),
    },
    reps,
    tools,
    references: {
      resvg: `@napi-rs/image ${engineVersions()['@napi-rs/image']}`,
      sharp: 'per tool: tools[].sharpReference',
    },
    // How librsvg draws var() in each sharp copy (var-check.mjs), next to the results it explains.
    varCheck: varCheck(),
    summary,
    determinism,
    inputs: rows,
  };
  writeFileSync(join(outDir, 'results.json'), formatResults(results));
  writeFileSync(join(outDir, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
  if (args.write) {
    copyFileSync(join(outDir, 'results.json'), new URL('results.json', HERE));
    writeReadme(results);
  }
  print(results);
}

function round2(n) {
  return Number(n.toFixed(2));
}

// The distribution's own name, from /etc/os-release where there is one.
function osName() {
  try {
    return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? process.platform;
  } catch {
    return process.platform;
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

// The CPU power settings, where Linux exposes them: they move every timing, and a laptop on a
// low-power profile runs every tool slower than the same machine set to performance.
function power() {
  const cpu = '/sys/devices/system/cpu/cpu0/cpufreq/';
  const found = {
    platformProfile: readOptional('/sys/firmware/acpi/platform_profile'),
    governor: readOptional(`${cpu}scaling_governor`),
    energyPreference: readOptional(`${cpu}energy_performance_preference`),
  };
  return Object.values(found).some(Boolean) ? { power: found } : {};
}

function toRgba(img) {
  return { width: img.width, height: img.height, rgba: img.rgba ?? img.data };
}

function hasTransparency({ rgba }) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

function print({ tools, summary, determinism }) {
  const all = summary.all;
  console.log(
    `totals over the ${all.common.inputs} of ${all.inputs} inputs every tool built` +
      (all.common.excluded.length ? ` (left out: ${all.common.excluded.join(', ')})` : ''),
  );
  console.log(
    'tool | sharp reference | files | failed | raster B | svg B | other B | total s | cold s | like B (192+512) | pass resvg | pass sharp | pass resvg, no var() | deterministic',
  );
  for (const { id, label, sharpReference: sharpRef } of tools) {
    const s = all.tools[id];
    const files = s.files ? (s.files.min === s.files.max ? `${s.files.min}` : `${s.files.min}-${s.files.max}`) : '-';
    console.log(
      [
        label,
        sharpRef,
        files,
        s.failed.length,
        s.rasterBytes,
        s.svgBytes,
        s.otherBytes,
        (s.totalMs / 1000).toFixed(2),
        (s.coldMs / 1000).toFixed(2),
        s.like.bytes[192] + s.like.bytes[512],
        ratio(s.like.resvg),
        ratio(s.like.sharp),
        ratio(s.like.withoutVar.resvg),
        determinism[id].deterministic ? 'yes' : `no (${determinism[id].differing.join(', ') || 'repeat'})`,
      ].join(' | '),
    );
  }
}
