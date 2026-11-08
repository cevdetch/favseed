#!/usr/bin/env node
// Fetches the pinned open-icon-set corpus bench/search-measurement is measured on: `npm pack`
// each Iconify JSON package, extract icons.json alone (the rest of the tarball is unused
// JS/types the corpus has no use for), and write the selected icons as standalone SVGs into
// bench/corpus/.cache/<prefix>/<name>.svg. The cache is gitignored and re-created by this
// script; manifest.json is the committed record of which icons and which bytes.
//
//   node bench/corpus/fetch.mjs            fetch + verify every file against manifest.json
//   node bench/corpus/fetch.mjs --update   re-select icons and rewrite manifest.json
//   node bench/corpus/fetch.mjs <dir>      use <dir> instead of bench/corpus/.cache
//
// Only a maintainer running --update changes what's measured; every other run reproduces
// exactly the bytes the manifest already names, which is why it verifies rather than trusts.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkPath } from '../path.mjs';
import { iconSvg, selectIcons } from './sets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Pinned exactly: versions checked on npm on 2026-11-08 (see README.md). A version bump is
// a deliberate --update, never a silent drift under the fixed table every number is measured
// against.
const SETS = [
  { prefix: 'logos', package: '@iconify-json/logos', version: '1.2.19', license: 'CC0-1.0', count: 30 },
  { prefix: 'simple-icons', package: '@iconify-json/simple-icons', version: '1.2.101', license: 'CC0-1.0', count: 20 },
  { prefix: 'fluent-emoji', package: '@iconify-json/fluent-emoji', version: '1.2.7', license: 'MIT', count: 20 },
  {
    prefix: 'flat-color-icons',
    package: '@iconify-json/flat-color-icons',
    version: '1.2.3',
    license: 'MIT',
    count: 10,
  },
];

function die(message) {
  process.stderr.write(`favseed corpus: ${message}\n`);
  process.exit(1);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** `npm pack` one pinned set into its own scratch subdir and return its parsed icons.json. */
function fetchSet({ package: pkg, version }, scratch) {
  const dir = join(scratch, pkg.replace('@', '').replace('/', '-'));
  mkdirSync(dir, { recursive: true });
  execFileSync('npm', ['pack', `${pkg}@${version}`, '--pack-destination', dir], { stdio: 'pipe' });
  // Read back whichever single .tgz landed here rather than predicting npm's naming
  // convention for the scope: it is scoped-dependent and has changed across npm majors.
  const [tgz] = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  if (!tgz) die(`npm pack produced no tarball for ${pkg}@${version}`);
  execFileSync('tar', ['-xzf', join(dir, tgz), '-C', dir, 'package/icons.json'], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(dir, 'package', 'icons.json'), 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const dirArg = args.find((a) => a !== '--update');
  const cache = dirArg ? benchmarkPath(dirArg) : join(HERE, '.cache');
  mkdirSync(cache, { recursive: true });

  const manifestPath = join(HERE, 'manifest.json');
  const manifest = update ? null : JSON.parse(readFileSync(manifestPath, 'utf8'));
  const next = { schema: 1, sets: {}, icons: [] };

  const scratch = mkdtempSync(join(tmpdir(), 'favseed-corpus-'));
  let total = 0;
  try {
    for (const spec of SETS) {
      const set = fetchSet(spec, scratch);
      const dir = join(cache, spec.prefix);
      mkdirSync(dir, { recursive: true });

      // In the default run the manifest names which icons to reproduce; aliases are excluded
      // from selection (they would just duplicate a parent's bytes under another name), but
      // iconSvg still resolves one if the manifest ever names one by hand.
      const names = update
        ? selectIcons(Object.keys(set.icons), spec.count)
        : manifest.icons.filter((icon) => icon.set === spec.prefix).map((icon) => icon.name);

      if (update) next.sets[spec.prefix] = { package: spec.package, version: spec.version, license: spec.license };

      for (const name of names) {
        const svg = iconSvg(set, name);
        const hash = sha256(svg);
        if (update) {
          next.icons.push({ set: spec.prefix, name, sha256: hash });
        } else {
          const entry = manifest.icons.find((icon) => icon.set === spec.prefix && icon.name === name);
          if (!entry) die(`'${spec.prefix}/${name}' is not in manifest.json; run --update first`);
          if (entry.sha256 !== hash) die(`sha256 mismatch for '${spec.prefix}/${name}'`);
        }
        writeFileSync(join(dir, `${name}.svg`), svg);
        total++;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (update) {
    next.icons.sort((a, b) => (a.set === b.set ? a.name.localeCompare(b.name) : a.set.localeCompare(b.set)));
    next.sets = Object.fromEntries(Object.entries(next.sets).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');
  }

  process.stdout.write(`corpus: ${total} icons in bench/corpus/.cache\n`);
}

await main();
