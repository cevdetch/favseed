// Astro shares content-addressed slots with Vite. Inspect only completed managed
// sets; ownership records, staging directories and user additions are not cache trash.
import { readdir, rm, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cacheIndex, readCachedSet } from '../vite/cache.mjs';

export { generatedAsset, readCachedSet } from '../vite/cache.mjs';

/** Keep the current set and seven other most recently used complete sets. */
export const pruneCache = async (cacheDir, currentKey) => {
  const candidates = [];
  for (const entry of await readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const slot = join(cacheDir, entry.name),
      index = await cacheIndex(slot);
    if (!index?.managed) continue;
    const files = await readCachedSet(slot, index);
    if (
      !files ||
      !files.every((file) => createHash('sha256').update(file.bytes).digest('hex') === index.hashes[file.name])
    )
      continue;
    let used = index.info.mtimeMs;
    if (entry.name === currentKey) {
      const now = new Date();
      try {
        await utimes(slot, now, now);
        used = now.getTime();
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
    candidates.push({ key: entry.name, used });
  }
  candidates.sort(
    (a, b) =>
      Number(b.key === currentKey) - Number(a.key === currentKey) || b.used - a.used || a.key.localeCompare(b.key),
  );
  for (const { key } of candidates.slice(8)) await rm(join(cacheDir, key), { recursive: true, force: true });
};
