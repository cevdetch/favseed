// External-consumer checks: install the published artifact, not a workspace link.
// Kept separate from pnpm test because this suite needs npm registry access.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./astro/', import.meta.url));
const originalCwd = process.cwd();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
let workspace, installed, astro;
const restoreNodeEnv = (value) => {
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
};

const command = async (file, args, cwd) => {
  try {
    return await exec(file, args, { cwd, timeout: 180000, maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1' } });
  } catch (error) {
    error.message += `\n${error.stderr ?? ''}\n${error.stdout ?? ''}`;
    throw error;
  }
};
const deadline = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15000);
    })]);
  } finally { clearTimeout(timer); }
};
const get = (origin, path, options) => fetch(origin + path, { signal: AbortSignal.timeout(15000), ...options });
const snapshot = async (dir) => {
  try { return await Promise.all((await readdir(dir)).sort().map(async (name) => [name, hash(await readFile(join(dir, name)))])); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const slots = async (p) => (await readdir(p.cache)).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort();
const generated = ['apple-touch-icon.png', 'favicon.ico', 'icon-48.png', 'icon.svg', 'site.webmanifest'];
const checkHead = (html, present = true) => {
  for (const name of ['favicon.ico', 'icon.svg', 'apple-touch-icon.png', 'site.webmanifest']) {
    assert.equal(html.split(`href="/blog/${name}"`).length - 1, present ? 1 : 0, `${name} in ${html.slice(0, 600)}`);
  }
  if (present) assert.match(html, /sizes="48x48"/);
};

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'favseed Astro consumer '));
  const { stdout } = await command('npm', ['pack', '--json', '--pack-destination', workspace], repo);
  const parsed = JSON.parse(stdout), packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const host = await json(join(fixture, 'package.json'));
  // Same direct dependency versions as the checkout, without linking checkout code.
  for (const name of ['@napi-rs/image', 'svgo', 'vite']) {
    host.dependencies[name] = (await json(join(repo, 'node_modules', name, 'package.json'))).version;
  }
  await writeFile(join(workspace, 'package.json'), JSON.stringify(host));
  await command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
    '--save-exact', './' + packed.filename], workspace);
  installed = join(workspace, 'node_modules/favseed');
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.equal(await realpath(installed), installed);
  // Astro emits prerender chunks under cwd when root lives outside it. Keep both
  // generated chunks and their package resolution inside this external consumer.
  process.chdir(workspace);
  const require = createRequire(pathToFileURL(join(workspace, 'package.json')));
  astro = await import(pathToFileURL(require.resolve('astro')));
}, { timeout: 240000 });
after(async () => { process.chdir(originalCwd); if (workspace) await rm(workspace, { recursive: true, force: true }); });

const project = async (settings = {}) => {
  const root = await mkdtemp(join(workspace, 'project '));
  await cp(join(fixture, 'astro.config.mjs'), join(root, 'astro.config.mjs'));
  await cp(join(fixture, 'src'), join(root, 'src'), { recursive: true });
  if (settings.ssr) await cp(join(fixture, 'ssr'), join(root, 'src'), { recursive: true });
  await cp(join(repo, 'test/fixtures/flat.svg'), join(root, 'src/logo.svg'));
  await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
  const pub = join(root, 'static'), cache = join(root, 'node_modules/.cache/favseed');
  await mkdir(pub); await writeFile(join(pub, 'notes.txt'), 'author file');
  return { root, pub, cache, stamp: join(cache, 'written.json'),
    build: async () => {
      const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
      try { await astro.build({ root, logLevel: 'warn' }); }
      finally { restoreNodeEnv(previous); }
    },
  };
};
const dev = async (t, p) => {
  // The CLI starts each mode in a fresh process; programmatic calls retain NODE_ENV.
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'development';
  let server;
  try { server = await astro.dev({ root: p.root, logLevel: 'warn', server: { host: '127.0.0.1', port: 0 } }); }
  catch (error) { restoreNodeEnv(previous); throw error; }
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      try { await server.stop(); } finally { restoreNodeEnv(previous); }
    }
  };
  t.after(stop);
  return { origin: `http://127.0.0.1:${server.address.port}`, stop };
};
const cliSet = async (p, fast = false) => {
  const root = await mkdtemp(join(workspace, 'CLI project ')), out = join(root, 'icons');
  await writeFile(join(root, 'favseed.config.mjs'), `export default ${JSON.stringify({ base: '/blog/', mode: fast ? 'fast' : 'release' })};`);
  await command(process.execPath, [join(installed, 'bin/favseed.mjs'), join(p.root, 'src/logo.svg'),
    '--out', out, '--sizes', fast ? '256' : '48', '--manifest', '--bg', '#000000'], root);
  return Object.fromEntries(await Promise.all((await readdir(out)).map(async (name) => [name, await readFile(join(out, name))])));
};

describe('installed Astro integration', { concurrency: false, timeout: 240000 }, () => {
  it('builds the packed CLI bytes, resolves both head paths and reuses/prunes cache through Astro', async () => {
    const p = await project(); await p.build();
    const files = await cliSet(p);
    assert.deepEqual((await readdir(p.pub)).sort(), [...generated, 'notes.txt'].sort());
    for (const [name, bytes] of Object.entries(files)) {
      assert.deepEqual(await readFile(join(p.pub, name)), bytes, name);
      assert.deepEqual(await readFile(join(p.root, 'dist', name)), bytes, `dist ${name}`);
    }
    const manifest = await json(join(p.pub, 'site.webmanifest'));
    assert.deepEqual(manifest.icons.map((icon) => icon.src), ['/blog/icon-48.png']);
    checkHead(await readFile(join(p.root, 'dist/index.html'), 'utf8'));
    checkHead(await readFile(join(p.root, 'dist/manual/index.html'), 'utf8'));
    const shortcut = await readFile(join(p.root, 'dist/shortcut/index.html'), 'utf8');
    checkHead(shortcut, false); assert.match(shortcut, /rel="shortcut icon"/);
    const [current] = await slots(p), index = join(p.cache, current, 'index.json');
    await utimes(index, new Date(1000), new Date(1000));
    const mtime = (await stat(index)).mtimeMs;
    const stamp = await readFile(p.stamp);
    for (let n = 0; n < 9; n++) {
      const slot = join(p.cache, String(n).padStart(64, '0'));
      await mkdir(slot);
      const bytes = Buffer.from('<svg/>');
      await writeFile(join(slot, 'icon.svg'), bytes);
      await writeFile(join(slot, 'index.json'), JSON.stringify({ files: ['icon.svg'], hashes: { 'icon.svg': hash(bytes) } }));
      await utimes(slot, new Date(1000 * n), new Date(1000 * n));
    }
    await p.build();
    assert.equal((await stat(index)).mtimeMs, mtime, 'warm build rewrote its completed cache slot');
    assert.equal((await slots(p)).length, 8);
    assert.ok((await slots(p)).includes(current));
    assert.deepEqual(await readFile(p.stamp), stamp);
    assert.equal(await readFile(join(p.pub, 'notes.txt'), 'utf8'), 'author file');
  });

  it('renders Head in component mode without adding automatic tags', async () => {
    const p = await project({ head: 'component' }); await p.build();
    checkHead(await readFile(join(p.root, 'dist/index.html'), 'utf8'), false);
    checkHead(await readFile(join(p.root, 'dist/manual/index.html'), 'utf8'));
  });

  it('serves fast/full/skip dev modes with exact routes, HEAD and no public or stamp writes', async (t) => {
    for (const mode of ['fast', 'full', 'skip']) {
      const p = await project({ dev: mode }), before = await snapshot(p.pub);
      let server = await dev(t, p);
      try {
        assert.deepEqual(await snapshot(p.pub), before);
        await assert.rejects(readFile(p.stamp), { code: 'ENOENT' });
        if (mode === 'skip') {
          assert.equal((await get(server.origin, '/blog/favicon.ico')).status, 404);
          await assert.rejects(readdir(p.cache), { code: 'ENOENT' });
          continue;
        }
        const files = await cliSet(p, mode === 'fast');
        for (const [name, bytes] of Object.entries(files)) {
          const response = await get(server.origin, '/blog/' + name + '?v=1');
          assert.equal(response.status, 200, name);
          assert.equal(response.headers.get('cache-control'), 'no-cache');
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, name);
        }
        const head = await get(server.origin, '/blog/favicon.ico', { method: 'HEAD' });
        assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/x-icon');
        assert.equal(Number(head.headers.get('content-length')), files['favicon.ico'].length);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        for (const path of ['/favicon.ico', '/blogger/favicon.ico', '/blog/nested/favicon.ico']) {
          assert.equal((await get(server.origin, path)).status, 404, path);
        }
        await server.stop(); server = await dev(t, p); // Disk-cache-backed restart.
        assert.deepEqual(await snapshot(p.pub), before);
        await assert.rejects(readFile(p.stamp), { code: 'ENOENT' });
        const icon = await get(server.origin, '/blog/favicon.ico');
        assert.deepEqual(Buffer.from(await icon.arrayBuffer()), files['favicon.ico']);
        await rm(p.cache, { recursive: true }); // The active snapshot owns its bytes.
        assert.equal((await get(server.origin, '/blog/favicon.ico')).status, 200);
        await writeFile(join(p.pub, 'favicon.ico'), 'author replacement');
        // Vite's public-file allowlist updates asynchronously after an add event.
        const until = Date.now() + 15000;
        let served;
        do {
          served = await (await get(server.origin, '/blog/favicon.ico')).text();
          if (served === 'author replacement') break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < until);
        assert.equal(served, 'author replacement');
        assert.equal(await readFile(join(p.pub, 'favicon.ico'), 'utf8'), 'author replacement');
        await rm(join(p.pub, 'favicon.ico'));
      } finally { await server.stop(); }
      assert.deepEqual(await snapshot(p.pub), before);
      await assert.rejects(readFile(p.stamp), { code: 'ENOENT' });
    }
  });

  it('keeps dev separate from production ownership and refuses a foreign public asset', async (t) => {
    const p = await project(), before = await snapshot(p.pub);
    const first = await dev(t, p);
    assert.equal((await get(first.origin, '/blog/icon-256.png')).status, 200);
    await first.stop(); assert.deepEqual(await snapshot(p.pub), before);
    await p.build();
    assert.deepEqual((await readdir(p.pub)).sort(), [...generated, 'notes.txt'].sort());
    assert.equal((await readdir(join(p.root, 'dist'))).includes('icon-256.png'), false);
    assert.equal((await json(p.stamp))['icon-256.png'], undefined);
    const published = await snapshot(p.pub), stamp = await readFile(p.stamp);
    await cp(join(repo, 'test/fixtures/general.svg'), join(p.root, 'src/logo.svg'));
    const second = await dev(t, p);
    assert.equal((await get(second.origin, '/blog/icon-256.png')).status, 200);
    await second.stop();
    assert.deepEqual(await snapshot(p.pub), published); assert.deepEqual(await readFile(p.stamp), stamp);
    const foreign = await project();
    await writeFile(join(foreign.pub, 'favicon.ico'), 'foreign asset');
    const preserved = await snapshot(foreign.pub);
    await assert.rejects(foreign.build(), /cannot verify ownership/);
    assert.deepEqual(await snapshot(foreign.pub), preserved);
    await assert.rejects(readFile(foreign.stamp), { code: 'ENOENT' });
  });

  it('preserves SSR streaming, status, headers and cookies through the real Node adapter', async (t) => {
    const p = await project({ ssr: true }); await p.build();
    for (const name of generated) {
      assert.deepEqual(await readFile(join(p.root, 'dist/client', name)), await readFile(join(p.pub, name)));
    }
    const { handler } = await import(pathToFileURL(join(p.root, 'dist/server/entry.mjs')));
    const server = createServer(handler);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await get(origin, '/blog/'), html = await page.text();
    assert.equal(page.status, 200, html); checkHead(html);
    const controller = new AbortController(), pending = get(origin, '/blog/stream', { signal: controller.signal });
    try {
      const response = await deadline(pending, 'stream headers before release');
      assert.equal(response.status, 207); assert.equal(response.headers.get('x-fixture'), 'stream');
      assert.equal(response.headers.get('content-length'), null);
      assert.deepEqual(response.headers.getSetCookie().sort(), ['first=one; Path=/', 'second=two; Path=/']);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let prefix = '';
      while (!prefix.includes('</head>')) {
        const chunk = await deadline(reader.read(), 'stream head before release');
        assert.equal(chunk.done, false); prefix += decoder.decode(chunk.value, { stream: true });
      }
      checkHead(prefix); assert.equal(prefix.includes('after-release'), false);
      assert.equal(await (await get(origin, '/blog/release')).text(), 'released');
      let body = prefix;
      for (;;) {
        const chunk = await deadline(reader.read(), 'stream body after release');
        if (chunk.done) break; body += decoder.decode(chunk.value, { stream: true });
      }
      assert.ok(body.includes('before-releaseafter-release</body></html>'));
    } finally {
      await get(origin, '/blog/release').then((response) => response.text()).catch(() => {});
      controller.abort(); await pending.catch(() => {});
    }
    const response = await get(origin, '/blog/json');
    assert.equal(response.status, 201); assert.equal(response.headers.get('x-fixture'), 'json');
    assert.deepEqual(response.headers.getSetCookie(), ['json=yes; Path=/']);
    assert.equal(await response.text(), '{"ok":true}');
  });
});
