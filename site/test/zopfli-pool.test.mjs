import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZopfliPool } from '../src/lib/zopfli-pool.mjs';

// A Web Worker stand-in: it records what it is sent and answers when the test says so.
const fakes = () => {
  const made = [];
  const spawn = () => {
    const worker = {
      sent: [],
      terminated: false,
      postMessage: (message) => worker.sent.push(message),
      terminate: () => (worker.terminated = true),
      reply: (data) => worker.onmessage({ data }),
      fail: (message) => worker.onerror({ message, preventDefault: () => {} }),
    };
    made.push(worker);
    return worker;
  };
  return { made, spawn };
};
const calls = (worker) => worker.sent.filter((m) => m.type !== 'wasm');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('starts no worker before the first call, and sends each new one the WASM', async () => {
  const { made, spawn } = fakes();
  const bytes = new ArrayBuffer(4);
  const pool = createZopfliPool({ loadWasm: async () => bytes, spawn });
  assert.equal(made.length, 0);
  const pending = pool.zlibAsync(Uint8Array.of(1), { numiterations: 1 });
  await tick();
  assert.equal(made.length, 1);
  assert.deepEqual(
    made[0].sent.filter((m) => m.type === 'wasm'),
    [{ type: 'wasm', bytes }],
  );
  made[0].reply({ result: Uint8Array.of(9) });
  assert.deepEqual(await pending, Uint8Array.of(9));
});

test('runs at most `size` calls at once and queues the rest in order', async () => {
  const { made, spawn } = fakes();
  const pool = createZopfliPool({ loadWasm: async () => new ArrayBuffer(1), spawn, size: 2 });
  const results = [1, 2, 3].map((n) => pool.zlibAsync(Uint8Array.of(n), {}));
  await tick();
  assert.equal(made.length, 2);
  assert.deepEqual(calls(made[0])[0].input, Uint8Array.of(1));
  assert.deepEqual(calls(made[1])[0].input, Uint8Array.of(2));
  made[1].reply({ result: Uint8Array.of(20) });
  assert.deepEqual(calls(made[1])[1].input, Uint8Array.of(3), 'the freed worker takes the queued call');
  made[0].reply({ result: Uint8Array.of(10) });
  made[1].reply({ result: Uint8Array.of(30) });
  assert.deepEqual(await Promise.all(results), [Uint8Array.of(10), Uint8Array.of(20), Uint8Array.of(30)]);
});

test('keeps the error type and message a worker reports', async () => {
  const { made, spawn } = fakes();
  const pool = createZopfliPool({ loadWasm: async () => new ArrayBuffer(1), spawn });
  const pending = pool.zlibAsync(Uint8Array.of(1), {});
  await tick();
  made[0].reply({ error: { name: 'RangeError', message: 'Zopfli iterations must be a positive 32-bit integer' } });
  await assert.rejects(pending, { name: 'RangeError', message: 'Zopfli iterations must be a positive 32-bit integer' });
});

test('a failed worker rejects only its own call, and a replacement takes the queue', async () => {
  const { made, spawn } = fakes();
  const pool = createZopfliPool({ loadWasm: async () => new ArrayBuffer(1), spawn, size: 1 });
  const lost = pool.zlibAsync(Uint8Array.of(1), {});
  const queued = pool.zlibAsync(Uint8Array.of(2), {});
  await tick();
  made[0].fail('out of memory');
  await assert.rejects(lost, /Zopfli worker failed: out of memory/);
  assert.ok(made[0].terminated);
  await tick();
  assert.equal(made.length, 2);
  assert.deepEqual(calls(made[1])[0].input, Uint8Array.of(2));
  made[1].reply({ result: Uint8Array.of(5) });
  assert.deepEqual(await queued, Uint8Array.of(5));
});

test('a WASM that failed to load reaches the worker as an error', async () => {
  const { made, spawn } = fakes();
  const pool = createZopfliPool({ loadWasm: async () => Promise.reject(new Error('HTTP 503')), spawn });
  pool.zlibAsync(Uint8Array.of(1), {}).catch(() => {});
  await tick();
  assert.deepEqual(
    made[0].sent.filter((m) => m.type === 'wasm'),
    [{ type: 'wasm', error: 'HTTP 503' }],
  );
});
