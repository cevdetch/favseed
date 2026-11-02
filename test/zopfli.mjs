import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import reference from '@gfx/zopfli';
import { createZopfli, ZOPFLI_VERSION } from '../lib/zopfli.mjs';

const loadWasm = () => readFile(new URL('../lib/zopfli.wasm', import.meta.url));
const compressor = createZopfli({ loadWasm });
const options = (numiterations) => ({ numiterations, blocksplitting: true, blocksplittingmax: 15 });

test('bundled compressor identity includes the actual binary hash', async () => {
  const hash = createHash('sha256').update(await loadWasm()).digest('hex');
  assert.ok(ZOPFLI_VERSION.endsWith(hash));
});

test('matches the reference bytes at fast and release effort, including empty input', async () => {
  for (const data of [new Uint8Array(), new TextEncoder().encode('favseed '.repeat(100)),
    Uint8Array.from({ length: 2048 }, (_, i) => (i * 31 ^ i >>> 3) & 255)]) {
    for (const iterations of [15, 120]) {
      const actual = await compressor.zlibAsync(data, options(iterations));
      assert.deepEqual(actual, new Uint8Array(await reference.zlibAsync(data, options(iterations))));
      assert.deepEqual(new Uint8Array(inflateSync(actual)), data);
    }
  }
});

test('owns output across memory growth and simultaneous pending calls', async () => {
  let loads = 0;
  const instance = createZopfli({ loadWasm: async () => { loads++; return loadWasm(); } });
  const small = new TextEncoder().encode('owned result');
  const [first, second] = await Promise.all([instance.zlibAsync(small, options(15)), instance.zlibAsync(small, options(15))]);
  assert.equal(loads, 1);
  const snapshot = new Uint8Array(first);
  second.fill(0);
  const large = new Uint8Array(256 * 1024).fill(123);
  assert.deepEqual(new Uint8Array(inflateSync(await instance.zlibAsync(large, options(15)))), large);
  assert.deepEqual(first, snapshot);
});

test('retries a rejected initialization and validates options before loading', async () => {
  let calls = 0;
  const instance = createZopfli({ loadWasm: () => ++calls === 1 ? Promise.reject(new Error('load failed')) : loadWasm() });
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(instance.zlibAsync(new Uint8Array(), options(value)), /iterations/);
  }
  await assert.rejects(instance.zlibAsync(new Uint8Array(), { ...options(15), blocksplitting: false }), /block/);
  assert.equal(calls, 0);
  await assert.rejects(instance.zlibAsync(new Uint8Array(), options(15)), /load failed/);
  assert.equal(inflateSync(await instance.zlibAsync(new Uint8Array(), options(15))).length, 0);
  assert.equal(calls, 2);
});

test('discards a failed allocator, including calls waiting on the same initialization', async () => {
  // (module (func (export "allocate") (param i32) (result i32) i32.const 0))
  // A real WASM export returns allocation failure; later loads use the bundled module.
  const outOfMemory = Uint8Array.of(0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,127,
    3,2,1,0,7,12,1,8,97,108,108,111,99,97,116,101,0,0,10,6,1,4,0,65,0,11);
  let loads = 0;
  const instance = createZopfli({ loadWasm: () => ++loads === 1 ? outOfMemory : loadWasm() });
  const pending = instance.zlibAsync(new Uint8Array(), options(15));
  const recovery = instance.zlibAsync(Uint8Array.of(1, 2, 3), options(15));
  await assert.rejects(pending, /allocation failed/);
  assert.deepEqual(new Uint8Array(inflateSync(await recovery)), Uint8Array.of(1, 2, 3));
  assert.equal(loads, 2);
});
