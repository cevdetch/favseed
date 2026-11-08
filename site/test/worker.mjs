import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuildCache, buildKey } from '../src/lib/build-cache.mjs';
import { createWorkerClient } from '../src/lib/worker-client.mjs';
import { normaliseOptions } from '../../lib/config.mjs';
import { zip } from '../src/lib/zip.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { wasiRuntime } from '../build/wasi-runtime.mjs';
import { checkCapabilities } from '../src/lib/capabilities.mjs';

const browserCapabilities = () => ({
  WebAssembly,
  SharedArrayBuffer,
  MessageChannel,
  DecompressionStream,
  crossOriginIsolated: true,
});

test('capability checks select compatibility when shared memory cannot be used', () => {
  const scope = browserCapabilities();
  assert.equal(checkCapabilities(scope), true);
  for (const override of [
    { crossOriginIsolated: false },
    { SharedArrayBuffer: undefined },
    { MessageChannel: undefined },
    {
      WebAssembly: {
        compile: WebAssembly.compile,
        Memory: class {
          constructor() {
            throw new Error('blocked');
          }
        },
      },
    },
  ])
    assert.equal(checkCapabilities({ ...scope, ...override }), false);
  let closed = 0;
  assert.equal(
    checkCapabilities({
      ...scope,
      MessageChannel: class {
        port1 = {
          postMessage() {
            throw new DOMException('blocked', 'DataCloneError');
          },
          close() {
            closed++;
          },
        };
        port2 = {
          close() {
            closed++;
          },
        };
      },
    }),
    false,
  );
  assert.equal(closed, 2, 'probe ports close even when sharing fails');
});

test('missing common browser APIs keep actionable errors in either mode', () => {
  for (const crossOriginIsolated of [true, false]) {
    const scope = { ...browserCapabilities(), crossOriginIsolated };
    assert.throws(() => checkCapabilities({ ...scope, WebAssembly: undefined }), /WebAssembly.*favseed CLI/);
    assert.throws(
      () => checkCapabilities({ ...scope, DecompressionStream: undefined }),
      /DecompressionStream.*favseed CLI/,
    );
  }
});

test('worker requests retain the document decision to disable threads', async () => {
  let message;
  const worker = {
    terminate() {},
    postMessage(value) {
      message = value;
    },
  };
  const client = createWorkerClient({ checkCapabilities: () => false, createWorker: () => worker });
  const warming = client.warm();
  assert.equal(message.threaded, false);
  worker.onmessage({ data: { id: message.id, type: 'ready' } });
  await warming;
  client.dispose();
});

test('WASI tuning accepts only the pinned loader and refuses unexpected defaults', () => {
  const require = createRequire(import.meta.url);
  const id = require.resolve('@napi-rs/image-wasm32-wasi/image.wasi-browser.js');
  const source = readFileSync(id, 'utf8');
  const plugin = wasiRuntime();
  const result = plugin.transform(source, id);
  assert.ok(result.code.includes('initial: 1024'));
  assert.ok(result.code.includes('Math.min(4, Math.max('));
  assert.equal(plugin.transform(source, '/unrelated/image.wasi-browser.js'), undefined);
  assert.equal(plugin.transform(source, '/unrelated/index.js'), undefined);
  assert.throws(() => plugin.transform(source.replace('initial: 4000', 'initial: 4096'), id), /WASI loader/);
  assert.throws(
    () => plugin.transform(source.replace('const __workerPoolSize', 'const __otherPoolSize'), id),
    /WASI loader/,
  );
  assert.deepEqual(plugin.transform(source, id.replaceAll('/', '\\')), result);
});

test('ZIP entries use a valid fixed DOS epoch date', () => {
  const files = [{ name: 'x.svg', bytes: Uint8Array.of(1, 2) }];
  const bytes = zip(files),
    view = new DataView(bytes.buffer);
  // DOS packs the year since 1980, month, and day: Jan 1 1980 is 0x0021.
  assert.equal(view.getUint16(12, true), 0x0021);
  assert.deepEqual(zip(files), bytes);
});

const result = () => ({
  files: [{ name: 'x.png', bytes: Uint8Array.of(1, 2) }],
  archiveBytes: Uint8Array.of(3, 4),
  fit: { apple: { box: 2 } },
  links: 'links',
  animated: false,
});

test('result cache owns its bytes, metadata and byte budget', () => {
  const cache = createBuildCache(8),
    input = result();
  cache.set('a', input);
  input.files[0].bytes[0] = 99;
  const hit = cache.get('a');
  assert.equal(hit.files[0].bytes[0], 1);
  hit.fit.apple.box = 90;
  structuredClone(hit, { transfer: [hit.files[0].bytes.buffer, hit.archiveBytes.buffer] });
  assert.deepEqual(cache.get('a'), result());
  cache.set('b', result());
  assert.equal(cache.get('a'), undefined, 'one entry only');
  cache.set('large', { ...result(), archiveBytes: new Uint8Array(9) });
  assert.equal(cache.get('large'), undefined);
  assert.equal(cache.get('b'), undefined, 'oversize result drops old source');
});

test('cache key includes all output options and normalizes vars order', () => {
  const key = (extra = {}, source = '<svg/>') => buildKey(source, normaliseOptions(extra));
  for (const extra of [
    { effort: 'fast' },
    { effort: 'max' },
    { quality: 80 },
    { base: '/app/' },
    { manifest: { name: 'test' } },
    { vars: { x: 'red' } },
    { bg: 'none' },
    { padding: 20 },
    { colors: 8 },
    { quality: 100 },
    { sizes: [32, 180] },
    { animation: false },
  ])
    assert.notEqual(key(extra), key());
  assert.notEqual(key({}, '<svg />'), key());
  assert.equal(key({ effort: 'default' }), key());
  assert.equal(key({ colors: 32 }), key({ quality: 100, colors: 32 }));
  assert.equal(key({ quality: '80' }), key({ quality: 80 }));
  assert.notEqual(key({ colors: 16, effort: 'fast' }), key({ colors: 16, effort: 'max' }), 'a pin keeps its effort');
  assert.equal(key({ vars: { a: 'red', b: 'blue' } }), key({ vars: { b: 'blue', a: 'red' } }));
});

test('cache distinguishes manifest members omitted by JSON.stringify', () => {
  const key = (manifest) => buildKey('<svg/>', normaliseOptions({ manifest }));
  assert.notEqual(key({}), key({ name: undefined }));
  assert.notEqual(key({ name: null }), key({ name: undefined }));
});

const setup = () => {
  const workers = [];
  const client = createWorkerClient({
    checkCapabilities: () => {},
    createWorker: () => {
      const w = {
        messages: [],
        terminated: false,
        postMessage(message) {
          this.messages.push(message);
        },
        terminate() {
          this.terminated = true;
        },
        reply(message) {
          this.onmessage?.({ data: message });
        },
      };
      workers.push(w);
      return w;
    },
  });
  return { client, workers };
};

test('worker client forwards progress and ignores stale replies', async () => {
  const { client, workers } = setup(),
    events = [];
  const pending = client.build('svg', {}, { onProgress: (e) => events.push(e) });
  const w = workers[0],
    { id } = w.messages[0];
  w.reply({ id: id + 99, type: 'result', result: 'stale' });
  w.reply({ id, type: 'progress', progress: { phase: 'raster', completed: 1, total: 2 } });
  w.reply({ id, type: 'result', result: result() });
  assert.deepEqual(await pending, result());
  assert.deepEqual(events, [{ phase: 'raster', completed: 1, total: 2 }]);
  client.dispose();
  assert.ok(w.terminated);
});

test('worker warnings reach the callback without settling the build or accepting stale replies', async () => {
  const { client, workers } = setup(),
    warnings = [];
  const pending = client.build('svg', {}, { onWarn: (w) => warnings.push(w) });
  const w = workers[0],
    { id } = w.messages[0];
  w.reply({ id: id + 99, type: 'warning', message: 'stale' });
  w.reply({ id, type: 'warning', message: 'outline text' });
  w.reply({ id, type: 'result', result: result() });
  assert.deepEqual(await pending, result());
  assert.deepEqual(warnings, ['outline text']);
  client.dispose();
  w.reply({ id, type: 'warning', message: 'late' });
  assert.deepEqual(warnings, ['outline text']);
});

test('abort during warmup terminates worker and retry starts a fresh one', async () => {
  const { client, workers } = setup(),
    controller = new AbortController();
  const warming = client.warm();
  const pending = client.build('svg', {}, { signal: controller.signal });
  const rejected = Promise.all([
    assert.rejects(warming, { name: 'AbortError' }),
    assert.rejects(pending, { name: 'AbortError' }),
  ]);
  controller.abort();
  await rejected;
  assert.ok(workers[0].terminated);
  const retry = client.build('svg', {}),
    w = workers[1];
  workers[0].reply({ id: 2, type: 'result', result: 'stale' });
  w.reply({ id: w.messages[0].id, type: 'result', result: result() });
  assert.deepEqual(await retry, result());
  client.dispose();
});

test('worker failure rejects pending requests and can be retried', async () => {
  const { client, workers } = setup();
  const first = client.warm();
  workers[0].onerror({ message: 'initialization failed', preventDefault() {} });
  await assert.rejects(first, /initialization failed/);
  assert.ok(workers[0].terminated);
  const retry = client.warm(),
    w = workers[1];
  w.reply({ id: w.messages[0].id, type: 'ready' });
  await retry;
  client.dispose();
});

test('failed engine initialization resets every pending request', async () => {
  const { client, workers } = setup();
  const first = client.warm(),
    second = client.build('svg', {});
  const rejected = Promise.all([assert.rejects(first, /load failed/), assert.rejects(second, /load failed/)]);
  workers[0].reply({ id: workers[0].messages[0].id, type: 'error', fatal: true, message: 'load failed' });
  await rejected;
  assert.ok(workers[0].terminated);
});

test('pre-aborted and unsupported requests do not start workers', async () => {
  const { client, workers } = setup(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(client.build('svg', {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(workers.length, 0);
  const unsupported = createWorkerClient({
    checkCapabilities() {
      throw new Error('Cross-origin isolation required');
    },
    createWorker() {
      assert.fail('must not start');
    },
  });
  await assert.rejects(unsupported.warm(), /Cross-origin isolation/);
});
