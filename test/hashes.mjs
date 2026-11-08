// CI compares this deterministic manifest on Linux, macOS and Windows, as well as
// against the reviewed baseline. Updating that baseline is always explicit.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, engineVersions } from '../bin/favseed.mjs';
import {
  checkReleasePolicy,
  compareManifests,
  formatDifferences,
  previousRelease,
  validateManifest,
} from './lib/bytes.mjs';

const MARKS = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
const baseline = new URL('./bytes.json', import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
let dir;
try {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== undefined && !['--check', '--write', '--release'].includes(mode))) {
    throw new Error('Usage: node test/hashes.mjs [--check|--write|--release]');
  }
  const options = { bg: '#000000', manifest: true };
  const current = {
    schema: 1,
    engines: engineVersions(),
    profiles: {
      default: { marks: MARKS, options },
      max: { marks: ['general', 'gradient'], options: { ...options, effort: 'max' } },
    },
    files: {},
  };
  dir = mkdtempSync(join(tmpdir(), 'favseed-hashes.'));
  for (const [profile, { marks, options }] of Object.entries(current.profiles)) {
    for (const mark of marks) {
      const out = join(dir, profile, mark);
      const input = fileURLToPath(new URL(`./fixtures/${mark}.svg`, import.meta.url));
      const result = await build({ ...options, input, out });
      for (const file of [...result.files].sort()) {
        const bytes = readFileSync(join(out, file));
        current.files[`${profile}/${mark}/${file}`] = {
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
    }
  }
  validateManifest(current);
  const json = JSON.stringify(current, null, 2) + '\n';
  if (mode === '--write') {
    writeFileSync(baseline, json);
    process.stderr.write(
      `Updated test/bytes.json (${Object.keys(current.files).length} files); review size, accuracy and release version before committing.\n`,
    );
  } else {
    process.stdout.write(json);
    if (mode) {
      const report = formatDifferences(compareManifests(JSON.parse(readFileSync(baseline, 'utf8')), current));
      if (report)
        throw new Error(
          `Generated files differ from test/bytes.json:\n${report}\nReview size/accuracy before explicitly accepting with node test/hashes.mjs --write.`,
        );
      if (mode === '--release') {
        const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const message = checkReleasePolicy({ current, version, previous: previousRelease(root, version) });
        process.stderr.write(message + '\n');
      }
    }
  }
} catch (error) {
  process.stderr.write(`favseed bytes: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
