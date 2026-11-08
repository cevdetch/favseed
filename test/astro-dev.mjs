import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import favseed from '../astro/index.mjs';
import { buildFiles } from '../bin/favseed.mjs';
import { cacheIndex, pruneCache, readCachedSet, writeSlot } from '../vite/cache.mjs';

const fixture = (name) => new URL(`./fixtures/${name}.svg`, import.meta.url);
const snapshot = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((name) => [name, readFileSync(join(dir, name))])
    : null;
const key = (n) => String(n).padStart(64, '0');
/** A slot as releases before content hashes wrote it: readable, never pruned. */
const writeLegacySlot = async (cache, name, files) => {
  await writeSlot(cache, name, files);
  writeFileSync(join(cache, name, 'index.json'), JSON.stringify({ files: files.map((f) => f.name) }));
};
// The integration's Vite plugin, driven as Astro's dev server drives it: Vite's base stays '/'
// in dev, and Astro's own middleware strips its base from req.url before later middleware.
const project = async (t, options = {}, root = mkdtempSync(join(tmpdir(), 'favseed astro dev '))) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pub = join(root, 'static'),
    cache = join(root, 'node_modules/.cache/favseed');
  if (!existsSync(join(root, 'logo.svg'))) copyFileSync(fixture('flat'), join(root, 'logo.svg'));
  const logs = [],
    middleware = [],
    watchers = [],
    configs = [];
  const logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) };
  const integration = favseed({ input: 'logo.svg', sizes: [48], ...options });
  await integration.hooks['astro:config:setup']({
    command: 'dev',
    config: { root: pathToFileURL(root + '/'), publicDir: pathToFileURL(pub + '/'), base: '/blog' },
    addWatchFile() {},
    addMiddleware() {},
    updateConfig: (c) => configs.push(c),
    logger,
  });
  const server = createServer((req, res) => {
    // Connect retains the incoming URL; Astro's base middleware strips /blog first.
    req.originalUrl = req.url;
    if (req.url.startsWith('/blog/')) req.url = req.url.slice('/blog'.length);
    let index = 0;
    const next = () => {
      const handler = middleware[index++];
      if (handler)
        Promise.resolve(handler(req, res, next)).catch((error) => {
          res.statusCode = 500;
          res.end(String(error));
        });
      else {
        res.statusCode = 404;
        res.end('not favseed');
      }
    };
    next();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    root,
    pub,
    cache,
    logs,
    request: (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init),
    dev: () => {
      const plugins = configs.flatMap((c) => c.vite?.plugins ?? []);
      const vite = plugins.find((p) => p.name === 'favseed');
      vite.configResolved({ root, publicDir: pub, base: '/', logger, plugins });
      vite.configureServer({
        middlewares: { use: (fn) => middleware.push(fn) },
        watcher: { add() {}, on: (event, fn) => watchers.push(fn) },
        environments: { client: { moduleGraph: { getModuleById: () => null } } },
        ws: { send() {} },
      });
    },
    /** What the Vite watcher reports when the mark changes. */
    changed: (file) => Promise.all(watchers.map((fn) => fn(file))),
  };
};

describe('Astro development assets', () => {
  it('serves every configured size in fast mode on first request, without creating public assets', async (t) => {
    const p = await project(t, { manifest: true });
    p.dev();
    assert.equal(existsSync(p.cache), false, 'the dev server built before any request');
    const expected = await buildFiles({
      input: join(p.root, 'logo.svg'),
      sizes: [48],
      mode: 'fast',
      base: '/blog/',
      manifest: true,
    });
    for (const file of expected.files) {
      const response = await p.request('/blog/' + file.name + '?v=1');
      assert.equal(response.status, 200, file.name);
      assert.equal(Number(response.headers.get('content-length')), file.bytes.length);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), Buffer.from(file.bytes)), 0, file.name);
    }
    assert.equal(existsSync(p.pub), false);
  });

  it('leaves public/ intact while serving a changed source in dev', async (t) => {
    const p = await project(t, { manifest: true });
    mkdirSync(p.pub);
    writeFileSync(join(p.pub, 'notes.txt'), 'author file');
    const before = snapshot(p.pub);
    p.dev();
    assert.equal((await p.request('/blog/favicon.ico')).status, 200);
    copyFileSync(fixture('general'), join(p.root, 'logo.svg'));
    await p.changed(join(p.root, 'logo.svg'));
    const expected = await buildFiles({
      input: join(p.root, 'logo.svg'),
      sizes: [48],
      mode: 'fast',
      manifest: true,
      base: '/blog/',
    });
    const ico = expected.files.find((f) => f.name === 'favicon.ico');
    const response = await p.request('/blog/favicon.ico');
    assert.equal(response.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), Buffer.from(ico.bytes)), 0);
    assert.deepEqual(snapshot(p.pub), before);
  });

  it('reuses the cached dev set across instances and keeps serving after its disk slot is removed', async (t) => {
    const first = await project(t);
    first.dev();
    const original = Buffer.from(await (await first.request('/blog/icon-48.png')).arrayBuffer());
    const slots = () => readdirSync(first.cache).filter((n) => /^[a-f0-9]{64}$/.test(n));
    const [slot] = slots(),
      index = join(first.cache, slot, 'index.json'),
      written = statSync(index).mtimeMs;
    const next = await project(t, {}, first.root);
    next.dev();
    assert.equal((await next.request('/blog/icon-48.png')).status, 200);
    assert.deepEqual(slots(), [slot]);
    assert.equal(statSync(index).mtimeMs, written, 'the second instance rebuilt');
    for (const name of slots()) rmSync(join(first.cache, name), { recursive: true });
    assert.equal(
      Buffer.compare(Buffer.from(await (await next.request('/blog/icon-48.png')).arrayBuffer()), original),
      0,
    );
    assert.equal(existsSync(first.pub), false);
  });

  it('handles HEAD, MIME and exact base paths without intercepting other requests', async (t) => {
    const p = await project(t, { manifest: true });
    p.dev();
    for (const [name, type] of [
      ['icon.svg', 'image/svg+xml'],
      ['favicon.ico', 'image/x-icon'],
      ['icon-48.png', 'image/png'],
      ['site.webmanifest', 'application/manifest+json'],
    ]) {
      const get = await p.request('/blog/' + name),
        head = await p.request('/blog/' + name, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-type'), type);
      assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      await get.arrayBuffer();
    }
    for (const path of [
      '/favicon.ico',
      '/blogger/favicon.ico',
      '/blog/nested/favicon.ico',
      '/blog/%2e%2e/favicon.ico',
      '/blog/icon-192.png',
      '/blog/logo.svg',
    ]) {
      assert.equal((await p.request(path)).status, 404, path);
    }
    assert.equal((await p.request('/blog/favicon.ico', { method: 'POST' })).status, 404);
  });

  it('does not shadow a foreign public icon or change it, even when added after startup', async (t) => {
    const p = await project(t);
    p.dev();
    mkdirSync(p.pub);
    writeFileSync(join(p.pub, 'favicon.ico'), 'user icon');
    assert.equal((await p.request('/blog/favicon.ico')).status, 404);
    assert.equal(readFileSync(join(p.pub, 'favicon.ico'), 'utf8'), 'user icon');
    assert.equal((await p.request('/blog/icon-48.png')).status, 200);
  });

  it('warns on an initial conflict and leaves that file to the host', async (t) => {
    const p = await project(t);
    mkdirSync(p.pub);
    writeFileSync(join(p.pub, 'favicon.ico'), 'foreign icon');
    p.dev();
    assert.equal((await p.request('/blog/favicon.ico')).status, 404);
    assert.ok(
      p.logs.some(([level, message]) => level === 'warn' && /is not the file favseed builds/.test(message)),
      JSON.stringify(p.logs),
    );
    assert.equal((await p.request('/blog/icon-48.png')).status, 200);
    assert.deepEqual(snapshot(p.pub), [['favicon.ico', Buffer.from('foreign icon')]]);
  });

  it('does not shadow a broken public symlink added after startup', async (t) => {
    const p = await project(t);
    p.dev();
    mkdirSync(p.pub);
    try {
      symlinkSync(join(p.root, 'missing.ico'), join(p.pub, 'favicon.ico'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') {
        t.skip('symlink privileges unavailable');
        return;
      }
      throw error;
    }
    assert.equal((await p.request('/blog/favicon.ico')).status, 404);
  });

  it('rejects the removed dev option, and a failed dev build leaves the host usable', async (t) => {
    assert.throws(() => favseed({ dev: 'skip' }), /unknown option 'dev'/);
    const p = await project(t, { input: 'missing.svg' });
    p.dev();
    assert.equal((await p.request('/blog/favicon.ico')).status, 404);
    assert.equal(existsSync(p.pub), false);
    assert.equal(existsSync(p.cache), false);
    assert.ok(p.logs.some(([level]) => level === 'warn'));
  });

  it('warns with configuration advice for an invalid SVG while leaving dev requests to the host', async (t) => {
    const p = await project(t);
    copyFileSync(fixture('unresolved'), join(p.root, 'logo.svg'));
    p.dev();
    assert.equal((await p.request('/blog/favicon.ico')).status, 404);
    assert.ok(
      p.logs.some(([level, message]) => level === 'warn' && /var\(--brand\)/.test(message) && /vars:/.test(message)),
    );
    assert.equal(existsSync(p.pub), false);
    assert.equal(existsSync(p.cache), false);
  });
});

describe('Astro bounded cache', () => {
  it('preserves slots whose asset bytes changed after publication', async (t) => {
    const cache = mkdtempSync(join(tmpdir(), 'favseed edited cache '));
    t.after(() => rmSync(cache, { recursive: true, force: true }));
    const bytes = Buffer.from('<svg/>');
    const hashes = { 'icon.svg': createHash('sha256').update(bytes).digest('hex') };
    for (let n = 0; n < 10; n++) {
      await writeSlot(cache, key(n), [{ name: 'icon.svg', bytes }]);
      writeFileSync(join(cache, key(n), 'index.json'), JSON.stringify({ files: ['icon.svg'], hashes }));
      utimesSync(join(cache, key(n)), new Date(1000 * n), new Date(1000 * n));
    }
    writeFileSync(join(cache, key(0), 'icon.svg'), 'user edit');
    writeFileSync(join(cache, key(1), 'icon.svg'), '');
    await pruneCache(cache, key(9));
    assert.equal(readFileSync(join(cache, key(0), 'icon.svg'), 'utf8'), 'user edit');
    assert.equal(readFileSync(join(cache, key(1), 'icon.svg'), 'utf8'), '');
  });

  it('keeps eight recently used complete slots, including current, without deleting other entries', async (t) => {
    const cache = mkdtempSync(join(tmpdir(), 'favseed prune '));
    t.after(() => rmSync(cache, { recursive: true, force: true }));
    for (let n = 0; n < 12; n++) {
      await writeSlot(cache, key(n), [{ name: 'icon.svg', bytes: Buffer.from('<svg/>') }]);
      utimesSync(join(cache, key(n)), new Date(1000 * n), new Date(1000 * n));
    }
    writeFileSync(join(cache, 'written.json'), 'ownership');
    mkdirSync(join(cache, '.tmp-active'));
    writeFileSync(join(cache, '.tmp-active', 'keep'), 'staging');
    mkdirSync(join(cache, 'notes'));
    writeFileSync(join(cache, 'notes', 'keep'), 'unrelated');
    await writeLegacySlot(cache, key(97), [{ name: 'icon.svg', bytes: Buffer.from('legacy bytes') }]);
    mkdirSync(join(cache, key(98)));
    writeFileSync(join(cache, key(98), 'index.json'), '{broken');
    await writeSlot(cache, key(99), [{ name: 'icon.svg', bytes: Buffer.from('<svg/>') }]);
    writeFileSync(join(cache, key(99), 'notes.txt'), 'user notes');
    await pruneCache(cache, key(0));
    assert.deepEqual(
      readdirSync(cache)
        .filter((name) => /^[a-f0-9]{64}$/.test(name) && ![key(97), key(98), key(99)].includes(name))
        .sort(),
      [0, 5, 6, 7, 8, 9, 10, 11].map(key),
    );
    assert.equal(readFileSync(join(cache, key(97), 'icon.svg'), 'utf8'), 'legacy bytes');
    assert.equal(readFileSync(join(cache, 'written.json'), 'utf8'), 'ownership');
    assert.equal(readFileSync(join(cache, '.tmp-active', 'keep'), 'utf8'), 'staging');
    assert.equal(readFileSync(join(cache, 'notes', 'keep'), 'utf8'), 'unrelated');
    assert.equal(readFileSync(join(cache, key(99), 'notes.txt'), 'utf8'), 'user notes');
    assert.equal(readFileSync(join(cache, key(98), 'index.json'), 'utf8'), '{broken');
    await pruneCache(cache, key(5));
    await writeSlot(cache, key(12), [{ name: 'icon.svg', bytes: Buffer.from('<svg/>') }]);
    await pruneCache(cache, key(12));
    assert.equal(existsSync(join(cache, key(6))), false, 'oldest unused set survived');
    assert.equal(existsSync(join(cache, key(0))), true, 'recently used set was removed');
  });

  it('rejects malformed indexes, paths and partial sets as misses', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'favseed cache read '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const slot = join(root, key(1));
    mkdirSync(slot);
    writeFileSync(join(root, 'outside.txt'), 'outside');
    writeFileSync(join(slot, 'icon.svg'), '<svg/>');
    for (const text of [
      '{broken',
      'null',
      JSON.stringify({ files: [] }),
      JSON.stringify({ files: ['../outside.txt'] }),
      JSON.stringify({ files: [join(root, 'outside.txt')] }),
      JSON.stringify({ files: ['icon.svg', 'icon.svg'] }),
      JSON.stringify({ files: ['icon-48.png'] }),
    ]) {
      writeFileSync(join(slot, 'index.json'), text);
      assert.equal(await readCachedSet(slot), null, text);
    }
    writeFileSync(join(slot, 'index.json'), JSON.stringify({ files: ['icon.svg'] }));
    const set = await readCachedSet(slot);
    assert.equal(set[0].name, 'icon.svg');
    assert.equal(Buffer.from(set[0].bytes).toString(), '<svg/>');
    const index = await cacheIndex(slot);
    rmSync(join(slot, 'icon.svg'));
    assert.equal(await readCachedSet(slot, index), null, 'asset disappeared after index validation');
  });

  it('neither reads nor prunes symlinked slots', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'favseed cache links '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cache = join(root, 'cache'),
      outside = join(root, 'outside');
    mkdirSync(cache);
    mkdirSync(outside);
    await writeSlot(outside, key(20), [{ name: 'icon.svg', bytes: Buffer.from('outside bytes') }]);
    try {
      symlinkSync(join(outside, key(20)), join(cache, key(20)), 'junction');
    } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') {
        t.skip('symlink privileges unavailable');
        return;
      }
      throw error;
    }
    assert.equal(await readCachedSet(join(cache, key(20))), null);
    for (let n = 0; n < 10; n++) await writeSlot(cache, key(n), [{ name: 'icon.svg', bytes: Buffer.from('<svg/>') }]);
    await pruneCache(cache, key(9));
    assert.equal(readFileSync(join(outside, key(20), 'icon.svg'), 'utf8'), 'outside bytes');
    assert.equal(existsSync(join(cache, key(20))), true);
  });

  it('rejects symlinked cache assets without reading their targets', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'favseed cache asset links '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const slot = join(root, key(1));
    mkdirSync(slot);
    writeFileSync(join(root, 'outside.svg'), 'outside bytes');
    writeFileSync(join(slot, 'index.json'), JSON.stringify({ files: ['icon.svg'] }));
    try {
      symlinkSync(join(root, 'outside.svg'), join(slot, 'icon.svg'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') {
        t.skip('symlink privileges unavailable');
        return;
      }
      throw error;
    }
    assert.equal(await readCachedSet(slot), null);
    assert.equal(readFileSync(join(root, 'outside.svg'), 'utf8'), 'outside bytes');
  });
});
