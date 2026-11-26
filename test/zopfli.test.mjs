import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import reference from '@gfx/zopfli';
import { createZopfliPool } from '../bin/zopfli-pool.mjs';
import { createZopfli, ZOPFLI_VERSION } from '../lib/zopfli.mjs';

const loadWasm = () => readFile(new URL('../lib/zopfli.wasm', import.meta.url));
const compressor = createZopfli({ loadWasm });
const options = (numiterations) => ({ numiterations, blocksplitting: true, blocksplittingmax: 15 });

test('bundled compressor identity includes the actual binary hash', async () => {
  const hash = createHash('sha256')
    .update(await loadWasm())
    .digest('hex');
  assert.ok(ZOPFLI_VERSION.endsWith(hash));
});

test('matches the reference bytes at fast and release effort, including empty input', async () => {
  for (const data of [
    new Uint8Array(),
    new TextEncoder().encode('favseed '.repeat(100)),
    Uint8Array.from({ length: 2048 }, (_, i) => ((i * 31) ^ (i >>> 3)) & 255),
  ]) {
    for (const iterations of [15, 120]) {
      const actual = await compressor.zlibAsync(data, options(iterations));
      assert.deepEqual(actual, new Uint8Array(await reference.zlibAsync(data, options(iterations))));
      assert.deepEqual(new Uint8Array(inflateSync(actual)), data);
    }
  }
});

test('owns output across memory growth and simultaneous pending calls', async () => {
  let loads = 0;
  const instance = createZopfli({
    loadWasm: async () => {
      loads++;
      return loadWasm();
    },
  });
  const small = new TextEncoder().encode('owned result');
  const [first, second] = await Promise.all([
    instance.zlibAsync(small, options(15)),
    instance.zlibAsync(small, options(15)),
  ]);
  assert.equal(loads, 1);
  const snapshot = new Uint8Array(first);
  second.fill(0);
  const large = new Uint8Array(256 * 1024).fill(123);
  assert.deepEqual(new Uint8Array(inflateSync(await instance.zlibAsync(large, options(15)))), large);
  assert.deepEqual(first, snapshot);
});

test('retries a rejected initialization and validates options before loading', async () => {
  let calls = 0;
  const instance = createZopfli({
    loadWasm: () => (++calls === 1 ? Promise.reject(new Error('load failed')) : loadWasm()),
  });
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
  const outOfMemory = Uint8Array.of(
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    1,
    6,
    1,
    96,
    1,
    127,
    1,
    127,
    3,
    2,
    1,
    0,
    7,
    12,
    1,
    8,
    97,
    108,
    108,
    111,
    99,
    97,
    116,
    101,
    0,
    0,
    10,
    6,
    1,
    4,
    0,
    65,
    0,
    11,
  );
  let loads = 0;
  const instance = createZopfli({ loadWasm: () => (++loads === 1 ? outOfMemory : loadWasm()) });
  const pending = instance.zlibAsync(new Uint8Array(), options(15));
  const recovery = instance.zlibAsync(Uint8Array.of(1, 2, 3), options(15));
  await assert.rejects(pending, /allocation failed/);
  assert.deepEqual(new Uint8Array(inflateSync(await recovery)), Uint8Array.of(1, 2, 3));
  assert.equal(loads, 2);
});

test('the worker pool returns the in-thread bytes, many calls at once', async () => {
  const pool = createZopfliPool({ size: 2 });
  const inputs = Array.from({ length: 5 }, (_, n) =>
    Uint8Array.from({ length: 4096 + n * 512 }, (_, i) => ((i * (31 + n)) ^ (i >>> 3)) & 255),
  );
  for (const iterations of [15, 120]) {
    const pooled = await Promise.all(inputs.map((data) => pool.zlibAsync(data, options(iterations))));
    for (const [n, data] of inputs.entries())
      assert.deepEqual(pooled[n], await compressor.zlibAsync(data, options(iterations)));
  }
});

test('the worker pool keeps the error type and message of a rejected call', async () => {
  const pool = createZopfliPool({ size: 1 });
  await assert.rejects(pool.zlibAsync(new Uint8Array(4), options(0)), {
    name: 'RangeError',
    message: 'Zopfli iterations must be a positive 32-bit integer',
  });
  assert.equal((await pool.zlibAsync(new Uint8Array(4), options(1))).length > 0, true);
});

test('a crashed worker rejects only its own call, and the pool goes on', async () => {
  const pool = createZopfliPool({ size: 1, script: new URL('./lib/crashing-zopfli-worker.mjs', import.meta.url) });
  const crash = pool.zlibAsync(Uint8Array.of(0xff), options(1));
  const after = pool.zlibAsync(Uint8Array.of(1, 2), options(1));
  await assert.rejects(crash, /Zopfli worker stopped with exit code 3/);
  assert.deepEqual(await after, Uint8Array.of(1, 2));
});

test('an idle worker pool does not keep Node running', () => {
  const script = `
    import { createZopfliPool } from ${JSON.stringify(new URL('../bin/zopfli-pool.mjs', import.meta.url).href)};
    const out = await createZopfliPool({ size: 2 }).zlibAsync(new Uint8Array(64), { numiterations: 1 });
    console.log(out.length > 0);
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 20000 });
  assert.equal(String(stdout).trim(), 'true');
});
