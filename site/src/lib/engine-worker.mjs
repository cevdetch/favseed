import { Buffer } from 'buffer';
import { optimize } from 'svgo/browser';
import { createZopfli } from '../../../lib/zopfli.mjs';
import { createSvgStage } from '../../../lib/core.mjs';
import { createEngine } from '../../../lib/engine.mjs';
import { buildSet } from '../../../lib/pipeline.mjs';
import { createBuildCache, buildKey } from './build-cache.mjs';
import { zip } from './zip.mjs';
import { checkCapabilities } from './capabilities.mjs';

globalThis.Buffer ??= Buffer;
const { optimiseSvg } = createSvgStage({ optimize });
const cache = createBuildCache();
// One fetch, started as soon as a build that will run Zopfli is in sight (a warm or build
// message at an effort other than 'fast') so it overlaps the image engine's much larger load,
// rather than waiting for the first finish. Zopfli awaits that same fetch; a failure clears it
// so the next attempt fetches again.
let zopfliBytes;
const fetchZopfli = () =>
  (zopfliBytes ??= fetch(new URL('../../../lib/zopfli.wasm', import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load compression engine: HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .catch((error) => {
      zopfliBytes = undefined;
      throw error;
    }));
const zopfli = createZopfli({ loadWasm: fetchZopfli });
let loading;
const load = (parentThreaded) => {
  if (loading) return loading;
  const threaded = checkCapabilities() && parentThreaded !== false;
  const image = threaded
    ? import('@napi-rs/image-wasm32-wasi')
    : import('../../vendor/image-wasm32-wasip1/image.wasip1-browser.js');
  return (loading = image
    .then((image) =>
      createEngine({
        image,
        zopfli,
        inflate: async (bytes) =>
          new Uint8Array(
            await new Response(
              new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')),
            ).arrayBuffer(),
          ),
      }),
    )
    .catch((error) => {
      loading = undefined;
      throw error;
    }));
};

const total = (files) => files.reduce((n, f) => n + f.bytes.byteLength, 0);
// apple and icon-180 can alias. Shared WASM memory is already copied by createEngine.
const buffers = (set) => [...new Set([...set.files.map((f) => f.bytes.buffer), set.archiveBytes.buffer])];

self.onmessage = async ({ data: { id, type, threaded, source, options, effort, early } }) => {
  let initialized = false;
  // An unknown effort is the default one, which runs Zopfli; reported by the build if invalid.
  if ((type === 'build' ? options?.effort : effort) !== 'fast') fetchZopfli().catch(() => {});
  try {
    const engine = await load(threaded);
    initialized = true;
    if (type === 'warm') {
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (type !== 'build') return;
    const key = buildKey(source, options);
    let result = cache.get(key);
    if (!result) {
      const warnings = [];
      let quickBytes = null;
      const built = await buildSet(source, options, {
        engine,
        optimiseSvg,
        warn: (message) => {
          warnings.push(message);
          self.postMessage({ id, type: 'warning', message });
        },
        progress: (progress) => self.postMessage({ id, type: 'progress', progress }),
        // The quick set is the build's own copy, so its buffers can be transferred. Only its
        // total is kept: the page compares the final set with it, from the cache too.
        early: early
          ? (set) => {
              quickBytes = total(set.files);
              const message = { ...set, archiveBytes: zip(set.files) };
              self.postMessage({ id, type: 'early', result: message }, buffers(message));
            }
          : undefined,
      });
      result = { ...built, quickBytes, warnings, archiveBytes: zip(built.files) };
      cache.set(key, result);
    } else {
      for (const message of result.warnings) self.postMessage({ id, type: 'warning', message });
    }
    // Warnings belong to each request's callback; retain them only in the private
    // cache so a repeated build gives the same guidance without rebuilding bytes.
    const { warnings: _warnings, ...output } = result;
    self.postMessage({ id, type: 'result', result: output }, buffers(result));
  } catch (error) {
    self.postMessage({ id, type: 'error', fatal: !initialized, message: error?.message ?? String(error) });
  }
};
