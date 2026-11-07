// The content-addressed cache every host shares: node_modules/.cache/favseed/<sha256>/. A slot
// is written to a temp directory and renamed into place, so an interrupted build cannot leave
// a half-populated slot that later reads as a hit.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveQuality } from '../lib/config.mjs';
import { DEFAULT_BG, normaliseVars } from '../lib/core.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

let version = null;
/** favseed's own version: a changed default is a minor release at least, so it is in the key. */
export const favseedVersion = () =>
  (version ??= JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

/**
 * The cache key, and the reason the cache is safe to trust.
 *
 * favseed's own version, the input bytes, the canonicalised options, and the versions of
 * @napi-rs/image, SVGO and the Zopfli build, because they change output bytes across releases, so a
 * cache keyed only on the SVG hands back stale files after an upgrade. vars are canonical
 * whether they arrive as an object or a Map (the merged options are a Map), and with or
 * without their leading dashes: Object.entries of a Map is empty, which would drop every
 * --var from the key and serve one var's bytes for another's.
 */
export const cacheKey = ({ version, source, options, engine }) =>
  sha256(
    JSON.stringify({
      // Discard older slots whose keys conflated omitted bg with transparent bg: null.
      schema: 2,
      version,
      source: sha256(source),
      engine,
      // Preserve size order because the manifest uses it. Resolve quality and background
      // with shared defaults. Other omitted values retain a sentinel; `version`
      // covers changes to their build defaults.
      options: {
        colors: options.colors ?? null,
        quality: Number(resolveQuality(options)),
        sizes: options.sizes ? [...options.sizes].map(Number) : null,
        bg: options.bg === undefined ? DEFAULT_BG : options.bg,
        padding: options.padding ?? null,
        vars: [...normaliseVars(options.vars)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        animation: options.animation !== false,
        manifest: options.manifest ?? false,
        mode: options.zopfli ? (options.mode ?? 'release') : null,
        zopfli: options.zopfli ?? false,
        // The manifest's bytes depend on it, so a changed base must not hit an old slot.
        base: options.base ?? '/',
      },
    }),
  );

const generatedAsset = (name) =>
  typeof name === 'string' &&
  (['icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'site.webmanifest'].includes(name) ||
    /^icon-[1-9]\d*\.png$/.test(name));

export const cacheIndex = async (slot) => {
  try {
    const info = await lstat(slot);
    if (!info.isDirectory()) return null;
    const entries = await readdir(slot, { withFileTypes: true });
    if (!entries.some((entry) => entry.name === 'index.json' && entry.isFile())) return null;
    const { files, hashes } = JSON.parse(await readFile(join(slot, 'index.json'), 'utf8')) ?? {};
    if (
      !Array.isArray(files) ||
      !files.length ||
      !files.every(generatedAsset) ||
      new Set(files).size !== files.length ||
      !files.every((name) => entries.some((entry) => entry.name === name && entry.isFile()))
    )
      return null;
    // Old indexes remain readable, but cannot establish that their assets are unchanged.
    const verifiedIndex =
      hashes &&
      typeof hashes === 'object' &&
      !Array.isArray(hashes) &&
      Object.keys(hashes).length === files.length &&
      files.every((name) => Object.hasOwn(hashes, name) && /^[a-f0-9]{64}$/.test(hashes[name]));
    return { files, hashes, info, managed: Boolean(verifiedIndex) && entries.length === files.length + 1 };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return null;
    throw error;
  }
};

/** Own the bytes before publishing/serving; pruning can reuse its validated index. */
export const readCachedSet = async (slot, index) => {
  if (index === undefined) index = await cacheIndex(slot);
  if (!index) return null;
  try {
    return await Promise.all(index.files.map(async (name) => ({ name, bytes: await readFile(join(slot, name)) })));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
};

/** The slot's files, or null on a miss. */
export const readSlot = (cacheDir, key) => readCachedSet(join(cacheDir, key));

/** Writes the files whole or not at all, with their hashes so pruning can trust the slot. */
export const writeSlot = async (cacheDir, key, files) => {
  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(join(cacheDir, '.tmp-'));
  try {
    for (const f of files) await writeFile(join(staging, f.name), f.bytes);
    const hashes = Object.fromEntries(files.map((f) => [f.name, sha256(f.bytes)]));
    await writeFile(join(staging, 'index.json'), JSON.stringify({ files: files.map((f) => f.name), hashes }));
    const slot = join(cacheDir, key);
    await rm(slot, { recursive: true, force: true });
    await rename(staging, slot);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

/**
 * Keep the current set and the seven most recently used other complete sets. Only slots whose
 * index names every file with a matching hash are candidates: staging directories, legacy
 * slots and anything a user put in the cache directory are not cache trash.
 */
export const pruneCache = async (cacheDir, currentKey) => {
  const candidates = [];
  for (const entry of await readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const slot = join(cacheDir, entry.name),
      index = await cacheIndex(slot);
    if (!index?.managed) continue;
    const files = await readCachedSet(slot, index);
    if (!files || !files.every((file) => sha256(file.bytes) === index.hashes[file.name])) continue;
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
