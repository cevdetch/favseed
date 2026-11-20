import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offlineLists } from '../build/offline-lists.mjs';

const bytes = (text) => new TextEncoder().encode(text);
const urls = (names) => names.map((n) => `/_astro/${n}`).toSorted();
// The real graph's shape (site/dist/_astro after `astro build`), with short names.
const astro = () =>
  new Map([
    ['index.astro_x.A.js', bytes('import("./pipeline.B.js")')],
    ['check.astro_x.C.js', bytes('import("./pipeline.B.js")')],
    ['pipeline.B.js', bytes('new Worker(new URL("./engine-worker-D.js", import.meta.url))')],
    [
      'engine-worker-D.js',
      bytes('"./image.wasi-browser-E.js" "./image.wasip1-browser-F.js" "./rolldown-runtime-G.js" "./zopfli-H.wasm"'),
    ],
    ['image.wasi-browser-E.js', bytes('"./image.wasm32-wasi-I.wasm" "./runtime-J.js" "./wasi-worker-browser-K.js"')],
    ['image.wasip1-browser-F.js', bytes('"./image.wasm32-wasip1-L.wasm" "./runtime-J.js"')],
    ['runtime-J.js', bytes('"./rolldown-runtime-G.js"')],
    ['rolldown-runtime-G.js', bytes('')],
    ['wasi-worker-browser-K.js', bytes('')],
    ['zopfli-H.wasm', bytes('\0asm zopfli')],
    ['image.wasm32-wasi-I.wasm', bytes('\0asm threaded')],
    ['image.wasm32-wasip1-L.wasm', bytes('\0asm compat')],
  ]);
const input = (overrides = {}) => ({
  html: new Map([
    ['/', '<script type="module" src="/_astro/index.astro_x.A.js"></script>'],
    ['/docs', '<h1>Docs</h1>'],
    ['/404', '<h1>Not found</h1>'],
    ['/check', '<script type="module" src="/_astro/check.astro_x.C.js"></script>'],
  ]),
  precache: ['/', '/docs', '/404'],
  astro: astro(),
  other: new Map([['/icon.svg', bytes('<svg/>')]]),
  ...overrides,
});

test('each engine list holds its own build and the shared engine files', () => {
  const { engines } = offlineLists(input());
  const shared = ['engine-worker-D.js', 'rolldown-runtime-G.js', 'runtime-J.js', 'zopfli-H.wasm'];
  assert.deepEqual(
    engines.threaded,
    urls([...shared, 'image.wasi-browser-E.js', 'image.wasm32-wasi-I.wasm', 'wasi-worker-browser-K.js']),
  );
  assert.deepEqual(engines.compatibility, urls([...shared, 'image.wasip1-browser-F.js', 'image.wasm32-wasip1-L.wasm']));
});

test('pages hold the precached HTML, the other files and the page scripts, never an engine file', () => {
  const { pages, engines } = offlineLists(input());
  assert.deepEqual(pages, [
    '/',
    '/404',
    '/_astro/check.astro_x.C.js',
    '/_astro/index.astro_x.A.js',
    '/_astro/pipeline.B.js',
    '/docs',
    '/icon.svg',
  ]);
  for (const url of [...engines.threaded, ...engines.compatibility]) assert.ok(!pages.includes(url), url);
});

test('every /_astro/ file is listed; a file nothing references is reported', () => {
  assert.deepEqual(offlineLists(input()).unlisted, []);
  const extra = astro();
  extra.set('orphan-Z.js', bytes(''));
  assert.deepEqual(offlineLists(input({ astro: extra })).unlisted, ['/_astro/orphan-Z.js']);
});

test('engineHash moves with engine bytes only; version moves with any listed byte', () => {
  const base = offlineLists(input());
  const engine = astro();
  engine.set('image.wasm32-wasi-I.wasm', bytes('\0asm threaded v2'));
  const newEngine = offlineLists(input({ astro: engine }));
  assert.notEqual(newEngine.engineHash, base.engineHash);
  assert.notEqual(newEngine.version, base.version);
  const page = input();
  page.html.set('/docs', '<h1>Docs, edited</h1>');
  const newPage = offlineLists(page);
  assert.equal(newPage.engineHash, base.engineHash);
  assert.notEqual(newPage.version, base.version);
  assert.match(base.engineHash, /^[0-9a-f]{64}$/);
});

test('a build without exactly one engine worker or loader of each kind is refused', () => {
  const missing = astro();
  missing.delete('image.wasip1-browser-F.js');
  assert.throws(() => offlineLists(input({ astro: missing })), /wasip1-browser/);
});
