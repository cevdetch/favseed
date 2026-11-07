// One completed build, owned by the worker. Transfer/caller mutation never reaches this copy.
import { buildIdentity } from '../../../lib/config.mjs';
export const createBuildCache = (limit = 16 * 1024 * 1024) => {
  let entry;
  return {
    get: (key) => (entry?.key === key ? structuredClone(entry.result) : undefined),
    set(key, result) {
      entry = undefined;
      const bytes = result.files.reduce((n, f) => n + f.bytes.byteLength, result.archiveBytes.byteLength);
      if (bytes + key.length * 2 <= limit) entry = { key, result: structuredClone(result) };
    },
  };
};

/** Key exactly what the shared emitter writes; the options arrive normalised (pipeline.mjs). */
export const buildKey = (source, o) => JSON.stringify([source, ...buildIdentity(o)]);
