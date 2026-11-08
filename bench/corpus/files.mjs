// The three corpora the search sweep runs over. Private marks are never named: only their index.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkPath } from '../path.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The two fixtures that fail to build under the sweep's default options: unresolved.svg has no
// --var fallback at all, and animvar.svg's var() is used only inside the animation, which a
// default (animation-preserving) build does not strip. Every other fixture builds.
const NEGATIVE = new Set(['unresolved', 'animvar']);

export const corpusFiles = async ({ private: privateDir, open = true, fixtures = true } = {}) => {
  const out = [];
  if (fixtures) {
    for (const f of readdirSync(join(ROOT, 'test/fixtures'))
      .filter((entry) => entry.endsWith('.svg'))
      .toSorted()) {
      const name = f.slice(0, -4);
      if (!NEGATIVE.has(name)) out.push({ corpus: 'fixtures', name, path: join(ROOT, 'test/fixtures', f) });
    }
  }
  if (open) {
    const cache = join(ROOT, 'bench/corpus/.cache');
    const { icons } = JSON.parse(readFileSync(join(ROOT, 'bench/corpus/manifest.json'), 'utf8'));
    for (const { set, name } of icons) {
      const path = join(cache, set, `${name}.svg`);
      if (!existsSync(path)) throw new Error('open corpus missing: run node bench/corpus/fetch.mjs');
      out.push({ corpus: 'open', name: `${set}/${name}`, path });
    }
  }
  if (privateDir) {
    const dir = benchmarkPath(privateDir);
    readdirSync(dir)
      .filter((entry) => entry.endsWith('.svg'))
      .toSorted()
      .forEach((entry, i) => out.push({ corpus: 'private', name: `private-${i}`, path: join(dir, entry) }));
  }
  return out;
};
