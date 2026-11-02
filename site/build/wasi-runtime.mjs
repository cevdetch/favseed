// image1.15.0 imports at least 1010 pages. Start at 1024 and retain its growable
// maximum. Cap spare preloaded workers, leaving emnapi's four async workers and
// fallback spawning intact. Measured renderer PSS matters, not just linear memory.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export const wasiRuntime = () => ({
  name: 'favseed-wasi-runtime',
  enforce: 'pre',
  transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/@napi-rs/image-wasm32-wasi/image.wasi-browser.js')) return;
    if (require('@napi-rs/image-wasm32-wasi/package.json').version !== '1.15.0') {
      throw new Error('WASI loader version changed; remeasure memory and worker tuning before building.');
    }
    const memory = 'initial: 4000,\n  maximum: 65536,\n  shared: true,';
    const pool = 'const __workerPoolSize = Math.max(\n  2,\n  globalThis.navigator?.hardwareConcurrency ?? 4,\n)';
    if (code.split(memory).length !== 2 || code.split(pool).length !== 2 ||
        !code.includes('const __asyncWorkPoolSize = 4\n')) {
      throw new Error('WASI loader defaults changed; remeasure memory and worker tuning before building.');
    }
    return { code: code.replace(memory, memory.replace('4000', '1024'))
      .replace(pool, pool.replace('Math.max(', 'Math.min(4, Math.max(') + ')'), map: null };
  },
});
