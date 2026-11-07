// Fresh processes make eager imports observable without timing thresholds or
// replacing the optimizer: reject only loads these entry paths must not need.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = new URL('../bin/favseed.mjs', import.meta.url).href;
const ASTRO = new URL('../astro/index.mjs', import.meta.url).href;
const probe = (source) => exec(process.execPath, ['--input-type=module', '--eval', source], { cwd: ROOT, timeout: 15000 });
const guard = (blockBuild = false) => `
  import assert from 'node:assert/strict';
  import { registerHooks } from 'node:module';
  const engines = new Set();
  registerHooks({ resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (specifier === 'svgo' || specifier === 'svgo/browser' || specifier === '@napi-rs/image') engines.add(resolved.url);
    ${blockBuild ? `assert.notEqual(resolved.url, ${JSON.stringify(CLI)}, 'Astro configuration loaded the Node build module');` : ''}
    return resolved;
  }, load(url, context, next) {
    assert.ok(!engines.has(url), 'Build engine loaded on a non-building path');
    return next(url, context);
  }});
`;

describe('lazy build dependencies', () => {
  it('includes the installed SVG optimizer in cache identity without loading it', async () => {
    await probe(guard() + `
      import { createRequire } from 'node:module';
      import { readFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      const require = createRequire(import.meta.url);
      const version = JSON.parse(readFileSync(join(dirname(require.resolve('svgo')), '../package.json'), 'utf8')).version;
      const api = await import(${JSON.stringify(CLI)});
      assert.equal(api.engineVersions().svgo, version);
    `);
  });

  it('exposes the Astro factory and existing library API at the package root without loading engines', async () => {
    await probe(guard() + `
      const api = await import('favseed');
      const { default: favseed } = await import('favseed/astro');
      const cli = await import(${JSON.stringify(CLI)});
      assert.equal(api.default, favseed, 'package root must expose the Astro integration');
      assert.equal(api.default().name, 'favseed');
      assert.throws(() => api.default({imput:'logo.svg'}), /input/);
      for (const name of Object.keys(cli)) assert.equal(api[name], cli[name], name);
      assert.deepEqual(Object.keys(api).filter((name) => name !== 'default'), Object.keys(cli));
    `);
  });

  it('runs help and version without loading SVG or native engines', async () => {
    const { stdout } = await probe(guard() + `
      const api = await import(${JSON.stringify(CLI)});
      assert.equal(await api.cli(['--help']), 0);
      assert.equal(await api.cli(['--version']), 0);
    `);
    assert.match(stdout, /Usage:\s+favseed/);
    assert.match(stdout, /favseed \d+\.\d+\.\d+ \(@napi-rs\/image 1\.15\.0/);
  });

  it('rejects invalid build options and non-SVG input without loading build engines', async () => {
    await probe(guard() + `
      const api = await import(${JSON.stringify(CLI)});
      await assert.rejects(api.buildFiles({input:'test/fixtures/flat.svg', colors:1}), /--colors/);
      await assert.rejects(api.buildFiles({input:'test/fixtures/notsvg.txt'}), /not an SVG/);
    `);
  });

  it('loads Astro configuration, sync, preview and dev:skip without the Node build module', async () => {
    await probe(guard(true) + `
      const { default: favseed } = await import(${JSON.stringify(ASTRO)});
      const root = new URL(${JSON.stringify(new URL('../unused/', import.meta.url).href)});
      for (const command of ['sync', 'preview', 'dev', 'build']) {
        const integration = favseed({dev:'skip'});
        integration.hooks['astro:config:setup']({command,
          config:{root,publicDir:new URL('public/',root),base:'/blog'},
          addWatchFile(){},addMiddleware(){},updateConfig(){},logger:{info(){}}
        });
        await integration.hooks['astro:server:setup']({logger:{warn(){}}});
      }
    `);
  });

  it('keeps SVG results and errors synchronous, including repeated calls during an external ESM import', async () => {
    await probe(`
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const api = await import(${JSON.stringify(CLI)});
      const pending = import('svgo');
      const source = readFileSync('test/fixtures/flat.svg','utf8');
      const first = api.optimiseSvg(source);
      assert.equal(typeof first.data, 'string');
      assert.equal(first.then, undefined);
      assert.deepEqual(api.optimiseSvg(source), first);
      assert.throws(() => api.optimiseSvg(readFileSync('test/fixtures/unresolved.svg','utf8')), api.FavseedError);
      await pending;
    `);
  });

  it('builds concurrently with the bundled optimizer and keeps later SVG calls synchronous', async () => {
    await probe(`
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { readFileSync } from 'node:fs';
      registerHooks({ resolve(specifier, context, next) {
        assert.notEqual(specifier, 'svgo', 'full builds loaded the Node optimizer dependency tree');
        return next(specifier, context);
      }});
      const api = await import(${JSON.stringify(CLI)});
      const options = {input:'test/fixtures/flat.svg',bg:'none',sizes:[48]};
      const [first, second] = await Promise.all([api.buildFiles(options), api.buildFiles(options)]);
      assert.deepEqual(first, second);
      assert.ok(first.files.length > 0);
      const svg = api.optimiseSvg(readFileSync(options.input, 'utf8'));
      assert.equal(typeof svg.data, 'string');
      assert.equal(svg.then, undefined);
      assert.throws(() => api.optimiseSvg(readFileSync('test/fixtures/unresolved.svg','utf8')), api.FavseedError);
    `);
  });

  it('preserves a synchronous SVG stage initialized while a first build is pending', async () => {
    await probe(`
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const api = await import(${JSON.stringify(CLI)});
      const options = {input:'test/fixtures/flat.svg',bg:'none',sizes:[48]};
      const pending = api.buildFiles(options);
      const source = readFileSync(options.input, 'utf8');
      const svg = api.optimiseSvg(source);
      const first = await pending;
      assert.deepEqual(api.optimiseSvg(source), svg);
      assert.deepEqual(await api.buildFiles(options), first);
    `);
  });

  it('retries a first build after a transient optimizer resolution failure', async () => {
    await probe(`
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      let fail = true;
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'svgo/browser' && fail) {
          fail = false;
          throw Error('temporary optimizer resolution failure');
        }
        return next(specifier, context);
      }});
      const api = await import(${JSON.stringify(CLI)});
      const options = {input:'test/fixtures/flat.svg',bg:'none',sizes:[48]};
      await assert.rejects(api.buildFiles(options), {name:'FavseedError', message:'temporary optimizer resolution failure'});
      assert.ok((await api.buildFiles(options)).files.length > 0);
    `);
  });

  it('validates Astro configuration before sync, preview or skipped dev without loading build engines', async () => {
    await probe(guard(true) + `
      const {default:favseed} = await import(${JSON.stringify(ASTRO)});
      for (const options of [{imput:'logo.svg'}, {dev:'fast',sizes:[33]}, {dev:'skip',quality:0}, {mode:'slow'}]) {
        assert.throws(() => favseed(options), /favseed:/);
      }
      const root = new URL('../', ${JSON.stringify(ASTRO)});
      for (const command of ['sync','preview']) {
        const integration = favseed({vars:{brand:'#123456'}, manifest:{name:'Example'}});
        integration.hooks['astro:config:setup']({command,
          config:{root,publicDir:new URL('public/',root),base:'/blog'},
          addWatchFile(){throw Error('unexpected watch')},addMiddleware(){throw Error('unexpected middleware')},
          updateConfig(){throw Error('unexpected config')},logger:{info(){}}
        });
      }
    `);
  });
});
