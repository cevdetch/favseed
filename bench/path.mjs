// Benchmarks may read snapshots/dependencies and write results only below the
// checkout or the OS temporary directory. Keep this out of the shipped engine.
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const temporary = realpathSync(tmpdir());
const message = 'Benchmark path must be inside the checkout or system temporary directory';

export function benchmarkPath(value) {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) throw new Error(message);
  const path = resolve(value);
  const prefix = (path.startsWith(checkout + sep) ? checkout : temporary) + sep;
  if (!path.startsWith(prefix)) throw new Error(message);

  // Check the nearest existing ancestor before mkdir/read/import. A lexical
  // prefix alone would allow an existing symlink to escape either workspace.
  let ancestor = path;
  for (;;) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  const physical = realpathSync(ancestor);
  if (physical !== checkout && !physical.startsWith(checkout + sep)
      && physical !== temporary && !physical.startsWith(temporary + sep)) throw new Error(message);
  return path;
}
