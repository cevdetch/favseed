// Astro shares content-addressed slots with Vite. Inspect only completed managed
// sets; ownership records, staging directories and user additions are not cache trash.
import { lstat, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const generatedAsset = (name) => typeof name === 'string'
  && (['icon.svg', 'logo.svg', 'favicon.ico', 'apple-touch-icon.png', 'site.webmanifest'].includes(name)
    || /^icon-[1-9]\d*\.png$/.test(name));

const indexFor = async (slot) => {
  try {
    const info = await lstat(slot);
    if (!info.isDirectory()) return null;
    const entries = await readdir(slot, { withFileTypes: true });
    if (!entries.some((entry) => entry.name === 'index.json' && entry.isFile())) return null;
    const { files, hashes } = JSON.parse(await readFile(join(slot, 'index.json'), 'utf8')) ?? {};
    if (!Array.isArray(files) || !files.length || !files.every(generatedAsset)
        || new Set(files).size !== files.length
        || !files.every((name) => entries.some((entry) => entry.name === name && entry.isFile()))) return null;
    // Old indexes remain readable, but cannot establish that their assets are unchanged.
    const verifiedIndex = hashes && typeof hashes === 'object' && !Array.isArray(hashes)
      && Object.keys(hashes).length === files.length
      && files.every((name) => Object.hasOwn(hashes, name) && /^[a-f0-9]{64}$/.test(hashes[name]));
    return { files, hashes, info, managed: Boolean(verifiedIndex) && entries.length === files.length + 1 };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return null;
    throw error;
  }
};

/** Own the bytes before publishing/serving, so eviction cannot interrupt either. */
export const readCachedSet = async (slot) => {
  const index = await indexFor(slot);
  if (!index) return null;
  try {
    return await Promise.all(index.files.map(async (name) => ({ name, bytes: await readFile(join(slot, name)) })));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
};

/** Keep the current set and seven other most recently used complete sets. */
export const pruneCache = async (cacheDir, currentKey) => {
  const candidates = [];
  for (const entry of await readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const slot = join(cacheDir, entry.name), index = await indexFor(slot);
    if (!index?.managed) continue;
    const files = await readCachedSet(slot);
    if (!files || !files.every((file) => createHash('sha256').update(file.bytes).digest('hex') === index.hashes[file.name])) continue;
    let used = index.info.mtimeMs;
    if (entry.name === currentKey) {
      const now = new Date();
      try { await utimes(slot, now, now); used = now.getTime(); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    }
    candidates.push({ key: entry.name, used });
  }
  candidates.sort((a, b) => Number(b.key === currentKey) - Number(a.key === currentKey)
    || b.used - a.used || a.key.localeCompare(b.key));
  for (const { key } of candidates.slice(8)) await rm(join(cacheDir, key), { recursive: true, force: true });
};
