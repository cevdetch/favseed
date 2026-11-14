// image 1.16.0 needs at least 993 WASM pages threaded, 992 compatibility (bench/wasm-engine's
// native-parity harness). Both loaders are already built with initial: 1024 and a growable
// maximum (napi.wasm.threadlessInitialMemory and its threaded counterpart; see build.json), so
// this plugin no longer touches memory. Cap spare preloaded workers, leaving emnapi's four
// async workers and fallback spawning intact. Measured renderer PSS matters, not just linear
// memory.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const defaultVendor = new URL('../vendor/image/', import.meta.url);
const defaultRecipe = new URL('../../bench/wasm-engine/', import.meta.url);

// Keep the native CLI engine, the browser engines and their shared runtime from silently
// drifting apart: all three are rebuilt and reverified together (bench/wasm-engine/README.md).
// vendor/recipe are parameters, not closed-over constants, so a test can point them at a
// tampered copy without touching the committed vendor files or recipe inputs.
export const verifyEngines = ({ vendor = defaultVendor, recipe = defaultRecipe } = {}) => {
  const manifest = JSON.parse(readFileSync(new URL('build.json', vendor), 'utf8'));
  const fail = (check) => {
    throw new Error(
      `Browser engine check failed (${check}); rebuild and verify parity using bench/wasm-engine/README.md`,
    );
  };
  if (require('@napi-rs/image/package.json').version !== manifest.imageVersion) fail('imageVersion');
  for (const name of ['@emnapi/core', '@emnapi/runtime', '@napi-rs/wasm-runtime']) {
    // wasm-runtime does not export package.json; its reviewed entry is at the package root.
    const metadata =
      name === '@napi-rs/wasm-runtime'
        ? JSON.parse(readFileSync(new URL('./package.json', pathToFileURL(require.resolve(name))), 'utf8'))
        : require(`${name}/package.json`);
    if (metadata.version !== manifest.runtime[name]) fail(`runtime.${name}`);
  }
  for (const [name, sha] of Object.entries(manifest.artifacts)) {
    const actual = createHash('sha256')
      .update(readFileSync(new URL(name, vendor)))
      .digest('hex');
    if (actual !== sha) fail(`artifacts.${name}`);
  }
  // The manifest also pins the recipe's own inputs, so editing the patch or either lock
  // without rebuilding fails here instead of silently shipping an engine the inputs no longer
  // describe.
  for (const [key, file] of [
    ['patchSha256', 'slim.patch'],
    ['cargoLockSha256', 'Cargo.lock'],
    ['toolingLockSha256', 'package-lock.json'],
  ]) {
    const actual = createHash('sha256')
      .update(readFileSync(new URL(file, recipe)))
      .digest('hex');
    if (actual !== manifest[key]) fail(key);
  }
};

export const wasiRuntime = () => ({
  name: 'favseed-wasi-runtime',
  enforce: 'pre',
  buildStart: () => verifyEngines(),
  transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/vendor/image/image.wasi-browser.js')) return;
    const pool = 'const __workerPoolSize = Math.max(\n  2,\n  globalThis.navigator?.hardwareConcurrency ?? 4,\n)';
    const asyncPool = 'const __asyncWorkPoolSize = 4\n';
    if (code.split(pool).length !== 2 || code.split(asyncPool).length !== 2) {
      throw new Error('WASI loader defaults changed; remeasure memory and worker tuning before building.');
    }
    return {
      code: code.replace(pool, pool.replace('Math.max(', 'Math.min(4, Math.max(') + ')'),
      map: null,
    };
  },
});
