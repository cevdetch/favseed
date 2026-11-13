// A small page-side adapter. All SVG/raster/compression/archive work lives in the worker.
import { normaliseOptions } from '../../../lib/config.mjs';
import { createWorkerClient } from './worker-client.mjs';
import { checkCapabilities } from './capabilities.mjs';

const client = createWorkerClient({
  createWorker: () => new Worker(new URL('./engine-worker.mjs', import.meta.url), { type: 'module' }),
  checkCapabilities,
});

export const warm = (effort) => client.warm(effort);
export const dispose = () => client.dispose();

const withArchive = ({ archiveBytes, ...result }) => ({ ...result, archive: () => new Uint8Array(archiveBytes) });

/**
 * Resolves with the final set. `onEarly(set)`, when given, receives the quick set first (the
 * set effort 'fast' builds, in the same shape) whenever a search follows it; an identical
 * rebuild answered from the worker's cache resolves with the final set alone.
 */
export async function buildInBrowser(source, options = {}, { onEarly, ...controls } = {}) {
  const normalized = normaliseOptions({ ...options, manifest: options.manifest ?? true });
  const early = typeof onEarly === 'function' ? (set) => onEarly(withArchive(set)) : undefined;
  return withArchive(await client.build(source, normalized, { ...controls, onEarly: early }));
}
