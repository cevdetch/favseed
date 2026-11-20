import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEngine, registerOffline, saveResume, takeResume } from '../src/lib/offline.mjs';

const storage = () => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
};
const controller = (engineHash) => ({
  postMessage: (message, [port]) => port.postMessage({ engineHash, version: 'v' }),
});
const versionJson = (engine) => async () => new Response(JSON.stringify({ engine, version: 'v' }));
const registration = ({ waiting = null } = {}) => ({
  waiting,
  installing: null,
  update: async () => {},
  addEventListener: () => {},
});

test('without a controlling worker, nothing cached can be stale', async () => {
  assert.deepEqual(await checkEngine({ sw: { controller: null }, fetch: versionJson('a'), storage: storage() }), {
    status: 'current',
  });
  assert.deepEqual(await checkEngine({ sw: undefined, fetch: versionJson('a'), storage: storage() }), {
    status: 'current',
  });
});

test('the same engine is current; an unreachable version.json leaves the build unchecked', async () => {
  const sw = { controller: controller('a') };
  assert.equal((await checkEngine({ sw, fetch: versionJson('a'), storage: storage() })).status, 'current');
  const offline = async () => Promise.reject(new TypeError('offline'));
  assert.equal((await checkEngine({ sw, fetch: offline, storage: storage() })).status, 'unchecked');
  const failing = async () => new Response('', { status: 503 });
  assert.equal((await checkEngine({ sw, fetch: failing, storage: storage() })).status, 'unchecked');
});

test('a newer engine with a waiting worker asks for an update that applies once', async () => {
  const posted = [];
  const waiting = { postMessage: (m) => posted.push(m) };
  const s = storage();
  const sw = { controller: controller('a'), getRegistration: async () => registration({ waiting }) };
  const result = await checkEngine({ sw, fetch: versionJson('b'), storage: s });
  assert.equal(result.status, 'update');
  result.apply();
  assert.deepEqual(posted, [{ type: 'skip-waiting' }]);
  assert.equal(s.getItem('favseed:engine-reloaded'), '1');
  assert.equal((await checkEngine({ sw, fetch: versionJson('b'), storage: s })).status, 'stale');
});

test('a newer engine whose worker never installs is stale, not a hang', async () => {
  const sw = { controller: controller('a'), getRegistration: async () => registration() };
  const result = await checkEngine({ sw, fetch: versionJson('b'), storage: storage(), installTimeoutMs: 20 });
  assert.equal(result.status, 'stale');
});

test('the resume state round-trips once, and a full storage says so instead of throwing', () => {
  const s = storage();
  assert.equal(saveResume(s, { source: '<svg/>', name: 'a.svg' }), true);
  assert.deepEqual(takeResume(s), { source: '<svg/>', name: 'a.svg' });
  assert.equal(takeResume(s), null);
  const full = {
    setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError');
    },
  };
  assert.equal(saveResume(full, { source: 'x'.repeat(10) }), false);
});

test('registration asks for the engine as an installed app, on install, and never with data saver', async () => {
  const posted = [];
  const active = { postMessage: (m) => posted.push(m) };
  let installed;
  const sw = { register: async () => ({}), ready: Promise.resolve({ active }) };
  await registerOffline({
    sw,
    isStandalone: () => true,
    onInstalled: (fn) => (installed = fn),
    variant: () => 'threaded',
    saveData: () => false,
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posted, [{ type: 'cache-engine', variant: 'threaded' }]);
  await installed();
  assert.equal(posted.length, 2);
  posted.length = 0;
  await registerOffline({
    sw,
    isStandalone: () => true,
    onInstalled: () => {},
    variant: () => 'threaded',
    saveData: () => true,
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posted, []);
  assert.equal(
    registerOffline({
      sw: undefined,
      isStandalone: () => true,
      onInstalled: () => {},
      variant: () => null,
      saveData: () => false,
    }),
    null,
  );
});

test('blocked site data: a newer engine is stale without storage, and the resume helpers tolerate null', async () => {
  const waiting = { postMessage: () => {} };
  const sw = { controller: controller('a'), getRegistration: async () => registration({ waiting }) };
  assert.equal((await checkEngine({ sw, fetch: versionJson('b'), storage: null })).status, 'stale');
  assert.equal((await checkEngine({ sw, fetch: versionJson('a'), storage: null })).status, 'current');
  assert.equal(takeResume(null), null);
  assert.equal(saveResume(null, { source: '<svg/>' }), false);
});
