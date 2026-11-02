import { Buffer } from 'buffer';
import { builtinPlugins, optimize } from 'svgo/browser';
import { createZopfli } from '../../../lib/zopfli.mjs';
import { createSvgStage } from '../../../lib/core.mjs';
import { createEngine } from '../../../lib/engine.mjs';
import { buildSet } from '../../../lib/pipeline.mjs';
import { createBuildCache, buildKey } from './build-cache.mjs';
import { zip } from './zip.mjs';
import { checkCapabilities } from './capabilities.mjs';

globalThis.Buffer ??= Buffer;
const { optimiseSvg } = createSvgStage({ optimize, builtinPlugins });
const cache = createBuildCache();
const zopfli = createZopfli({ loadWasm: async () => {
  const response = await fetch(new URL('../../../lib/zopfli.wasm', import.meta.url));
  if (!response.ok) throw new Error(`Could not load compression engine: HTTP ${response.status}`);
  return response.arrayBuffer();
} });
let loading;
const load = () => {
  checkCapabilities();
  return (loading ??= import('@napi-rs/image-wasm32-wasi').then((image) => createEngine({
    image, zopfli,
    inflate: async (bytes) => new Uint8Array(await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()),
  })).catch((error) => { loading = undefined; throw error; }));
};

self.onmessage = async ({ data: { id, type, source, options } }) => {
  let initialized = false;
  try {
    const engine = await load();
    initialized = true;
    if (type === 'warm') { self.postMessage({ id, type: 'ready' }); return; }
    if (type !== 'build') return;
    const key = buildKey(source, options);
    let result = cache.get(key);
    if (!result) {
      const warnings = [];
      const built = await buildSet(source, options, { engine, optimiseSvg,
        warn: (message) => { warnings.push(message); self.postMessage({ id, type: 'warning', message }); },
        progress: (progress) => self.postMessage({ id, type: 'progress', progress }) });
      result = { ...built, warnings, archiveBytes: zip(built.files) };
      cache.set(key, result);
    } else {
      for (const message of result.warnings) self.postMessage({ id, type: 'warning', message });
    }
    // Warnings belong to each request's callback; retain them only in the private
    // cache so a repeated build gives the same guidance without rebuilding bytes.
    const { warnings, ...output } = result;
    // apple and icon-180 can alias. Shared WASM memory is already copied by createEngine.
    const buffers = [...new Set([...result.files.map((f) => f.bytes.buffer), result.archiveBytes.buffer])];
    self.postMessage({ id, type: 'result', result: output }, buffers);
  } catch (error) {
    self.postMessage({ id, type: 'error', fatal: !initialized, message: error?.message ?? String(error) });
  }
};
