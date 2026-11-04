// image1.15.0 imports at least 1010 pages. Start at 1024 and retain its growable
// maximum. Cap spare preloaded workers, leaving emnapi's four async workers and
// fallback spawning intact. Measured renderer PSS matters, not just linear memory.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const vendor = new URL('../vendor/image-wasm32-wasip1/', import.meta.url);

// Keep a native/wasm upgrade from silently leaving the compatibility encoder behind.
const verifyThreadless = () => {
  const manifest = JSON.parse(readFileSync(new URL('build.json', vendor), 'utf8'));
  const fail = () => { throw new Error('Compatibility engine changed; rebuild and verify parity using bench/browser-compat/README.md'); };
  for (const name of ['@napi-rs/image', '@napi-rs/image-wasm32-wasi']) {
    if (require(`${name}/package.json`).version !== manifest.imageVersion) fail();
  }
  for (const name of ['@emnapi/core', '@emnapi/runtime', '@napi-rs/wasm-runtime']) {
    // wasm-runtime does not export package.json; its reviewed entry is at the package root.
    const metadata = name === '@napi-rs/wasm-runtime'
      ? JSON.parse(readFileSync(new URL('./package.json', pathToFileURL(require.resolve(name))), 'utf8'))
      : require(`${name}/package.json`);
    if (metadata.version !== manifest.runtime[name]) fail();
  }
  for (const name of ['image.wasip1-browser.js', 'image.wasm32-wasip1.wasm']) {
    const sha = createHash('sha256').update(readFileSync(new URL(name, vendor))).digest('hex');
    if (sha !== manifest.artifacts[name]) fail();
  }
};

export const wasiRuntime = () => ({
  name: 'favseed-wasi-runtime',
  enforce: 'pre',
  buildStart: verifyThreadless,
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
