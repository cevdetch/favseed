import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const worker = readFileSync(new URL('../src/sw/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://favseed.cevdet.ch';
const lists = {
  pages: ['/', '/404', '/_astro/index.A.js', '/docs', '/icon.svg'],
  engines: { threaded: ['/_astro/e.js', '/_astro/t.wasm'], compatibility: ['/_astro/c.wasm', '/_astro/e.js'] },
  engineHash: 'new',
  version: 'v2',
};

// A Cache Storage stand-in keyed by path, enough for the worker's own calls.
const fakeCaches = () => {
  const store = new Map();
  const keyOf = (k) => (typeof k === 'string' ? k : new URL(k.url).pathname);
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const map = store.get(name);
    return {
      match: async (k) => map.get(keyOf(k))?.clone(),
      put: async (k, v) => void map.set(keyOf(k), v),
      addAll: async (requests) => {
        for (const r of requests) map.set(keyOf(r), new Response(keyOf(r)));
      },
      keys: async () => [...map.keys()],
    };
  };
  return { store, open, keys: async () => [...store.keys()], delete: async (n) => store.delete(n) };
};

// Each load imports its own copy of the worker from a fresh file, because Bun caches query-string
// imports; the worker reads every global through `self` once, so copies never share a stand-in.
let copies = 0;
const load = async ({ caches = fakeCaches(), fetch = async () => new Response('net') } = {}) => {
  const listeners = {};
  const self = {
    FAVSEED_OFFLINE: lists,
    location: { origin: ORIGIN },
    caches,
    fetch,
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: () => {
      self.skipped = true;
      return Promise.resolve();
    },
    clients: { claim: async () => {} },
  };
  const dir = mkdtempSync(join(tmpdir(), 'favseed-sw-'));
  copies += 1;
  const file = join(dir, `sw-${copies}.mjs`);
  writeFileSync(file, worker);
  globalThis.self = self;
  try {
    await import(pathToFileURL(file).href);
  } finally {
    delete globalThis.self;
    rmSync(dir, { recursive: true, force: true });
  }
  return { self, api: self.favseedWorker, listeners, caches };
};
const at = (path) => new URL(path, ORIGIN);

test('routes: engine files, navigations, listed pages, never sw.js or version.json, nothing cross-origin', async () => {
  const { api } = await load();
  assert.equal(api.route(at('/_astro/t.wasm'), 'cors'), 'engine');
  assert.equal(api.route(at('/docs'), 'navigate'), 'navigate');
  assert.equal(api.route(at('/check'), 'navigate'), 'navigate');
  assert.equal(api.route(at('/_astro/index.A.js'), 'cors'), 'page');
  assert.equal(api.route(at('/icon.svg'), 'no-cors'), 'page');
  assert.equal(api.route(at('/sw.js'), 'same-origin'), 'network');
  assert.equal(api.route(at('/version.json'), 'cors'), 'network');
  assert.equal(api.route(at('/llms.txt'), 'cors'), 'pass');
  assert.equal(api.route(new URL('https://example.com/docs'), 'navigate'), 'pass');
});

test('a page path keys the cache the way the site serves it, without its query', async () => {
  const { api } = await load();
  assert.equal(api.keyOf('/'), '/');
  assert.equal(api.keyOf('/index.html'), '/');
  assert.equal(api.keyOf('/docs.html'), '/docs');
  assert.equal(api.keyOf('/docs/'), '/docs');
  assert.equal(api.keyOf(at('/?utm_source=x').pathname), '/');
});

test('install precaches every page and never activates itself', async () => {
  const { self, listeners, caches } = await load();
  let wait;
  listeners.install({ waitUntil: (p) => (wait = p) });
  await wait;
  assert.deepEqual((await (await caches.open('pages-v2')).keys()).toSorted(), lists.pages.toSorted());
  assert.equal(self.skipped, undefined);
});

test('offline, an uncached navigation gets the cached 404 page with status 404', async () => {
  const caches = fakeCaches();
  await (
    await caches.open('pages-v2')
  ).put('/404', new Response('not found page', { headers: { 'content-type': 'text/html' } }));
  const { api } = await load({ caches, fetch: async () => Promise.reject(new TypeError('offline')) });
  const response = await api.respond('navigate', new Request(at('/check')), at('/check'));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'not found page');
});

test('an older engine is deleted only once the current one is complete', async () => {
  const caches = fakeCaches();
  await (await caches.open('engine-old')).put('/__complete/threaded', new Response(''));
  const fetched = [];
  const { api } = await load({
    caches,
    fetch: async (request) => {
      fetched.push(new URL(typeof request === 'string' ? at(request) : request.url).pathname);
      return new Response('bytes', { status: 200 });
    },
  });
  const current = await caches.open('engine-new');
  await current.put('/_astro/e.js', new Response('e'));
  await api.markIfComplete();
  assert.ok(caches.store.has('engine-old'), 'old engine kept while the new one is partial');
  await api.download('threaded');
  assert.deepEqual(fetched, ['/_astro/t.wasm']);
  assert.ok(await current.match('/__complete/threaded'));
  assert.ok(!caches.store.has('engine-old'), 'old engine dropped once the new one is complete');
});

test('a failed completion marker does not fail the engine response it follows', async () => {
  const caches = fakeCaches();
  const open = caches.open;
  caches.open = async (name) => {
    const cache = await open(name);
    return {
      ...cache,
      put: async (key, value) => {
        if (String(key).startsWith('/__complete/')) throw new DOMException('quota exceeded', 'QuotaExceededError');
        return cache.put(key, value);
      },
    };
  };
  const engine = await caches.open('engine-new');
  await engine.put('/_astro/t.wasm', new Response('t'));
  await engine.put('/_astro/c.wasm', new Response('c'));
  const { api } = await load({ caches, fetch: async () => new Response('net') });
  const response = await api.respond('engine', new Request(at('/_astro/e.js')), at('/_astro/e.js'));
  assert.equal(await response.text(), 'net');
});

test('get-version answers on the message port', async () => {
  const { listeners } = await load();
  const reply = await new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      channel.port1.close();
      resolve(data);
    };
    listeners.message({ data: { type: 'get-version' }, ports: [channel.port2], waitUntil: () => {} });
  });
  assert.deepEqual(reply, { engineHash: 'new', version: 'v2' });
});

const netFetch =
  (fetched, fail = false) =>
  async (request) => {
    const path = new URL(typeof request === 'string' ? at(request) : request.url).pathname;
    fetched.push(path);
    return fail ? new Response('no', { status: 503 }) : new Response('bytes', { status: 200 });
  };
const message = (listeners, data) => {
  let wait;
  listeners.message({ data, ports: [], waitUntil: (p) => (wait = p) });
  return wait;
};

test('asking for the engine records the variant in a cache no deploy drops', async () => {
  const fetched = [];
  const { listeners, caches } = await load({ fetch: netFetch(fetched) });
  await message(listeners, { type: 'cache-engine', variant: 'compatibility' });
  const flag = await (await caches.open('favseed-state')).match('/__installed');
  assert.deepEqual(await flag.json(), { variant: 'compatibility' });
  assert.deepEqual(fetched.toSorted(), ['/_astro/c.wasm', '/_astro/e.js']);
});

test('the flag is written before the download, so a failed download still leaves it', async () => {
  const { listeners, caches } = await load({ fetch: netFetch([], true) });
  await message(listeners, { type: 'cache-engine', variant: 'threaded' });
  assert.deepEqual(await (await (await caches.open('favseed-state')).match('/__installed')).json(), {
    variant: 'threaded',
  });
});

test('a new worker of an installed app downloads its engine while it installs', async () => {
  const caches = fakeCaches();
  await (await caches.open('favseed-state')).put('/__installed', new Response('{"variant":"threaded"}'));
  await (await caches.open('engine-old')).put('/__complete/threaded', new Response(''));
  const fetched = [];
  const { listeners } = await load({ caches, fetch: netFetch(fetched) });
  let wait;
  listeners.install({ waitUntil: (p) => (wait = p) });
  await wait;
  assert.deepEqual(fetched.toSorted(), ['/_astro/e.js', '/_astro/t.wasm']);
  assert.ok(await (await caches.open('engine-new')).match('/__complete/threaded'));
  assert.ok(caches.store.has('engine-old'), 'the old worker still serves open tabs from the older engine');
  listeners.activate({ waitUntil: (p) => (wait = p) });
  await wait;
  assert.ok(!caches.store.has('engine-old'), 'the older engine goes once the new worker takes over');
});

test('a worker that finds no flag installs without downloading an engine', async () => {
  const fetched = [];
  const { listeners, caches } = await load({ fetch: netFetch(fetched) });
  let wait;
  listeners.install({ waitUntil: (p) => (wait = p) });
  await wait;
  assert.deepEqual(fetched, []);
  assert.ok(!caches.store.has('engine-new'));
});

test('an installed app whose engine download fails does not install the new worker', async () => {
  const caches = fakeCaches();
  await (await caches.open('favseed-state')).put('/__installed', new Response('{"variant":"threaded"}'));
  await (await caches.open('engine-old')).put('/__complete/threaded', new Response(''));
  const { listeners } = await load({ caches, fetch: netFetch([], true) });
  let wait;
  listeners.install({ waitUntil: (p) => (wait = p) });
  await assert.rejects(wait);
  assert.ok(caches.store.has('engine-old'), 'the old engine keeps serving the old pages');
});
