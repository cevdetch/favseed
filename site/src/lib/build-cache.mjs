// One completed build, owned by the worker. Transfer/caller mutation never reaches this copy.
import { DEFAULT_QUALITY, manifestJson } from '../../../lib/core.mjs';
export const createBuildCache = (limit = 16 * 1024 * 1024) => {
  let entry;
  return {
    get: (key) => entry?.key === key ? structuredClone(entry.result) : undefined,
    set(key, result) {
      entry = undefined;
      const bytes = result.files.reduce((n, f) => n + f.bytes.byteLength, result.archiveBytes.byteLength);
      if (bytes + key.length * 2 <= limit) entry = { key, result: structuredClone(result) };
    },
  };
};

export const buildKey = (source, o) => {
  // Key exactly what the shared emitter writes. JSON.stringify(options) can discard
  // accepted members such as undefined and conflate builds with different file bytes.
  const manifest = o.manifest ? manifestJson({ sizes: o.sizes, base: o.base,
    purpose: o.bg !== null ? 'any maskable' : null,
    extra: typeof o.manifest === 'object' ? o.manifest : null }) : null;
  return JSON.stringify([source, o.colors, o.quality ?? DEFAULT_QUALITY, o.sizes, o.padding,
    o.bg, [...o.vars].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), o.animation,
    manifest, o.base, o.iterations]);
};
