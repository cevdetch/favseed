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
  registerHooks({ resolve(specifier, context, next) {
    assert.notEqual(specifier, 'svgo', 'SVGO loaded on a non-building path');
    assert.notEqual(specifier, '@napi-rs/image', 'native engine loaded on a non-building path');
    const resolved = next(specifier, context);
    ${blockBuild ? `assert.notEqual(resolved.url, ${JSON.stringify(CLI)}, 'Astro configuration loaded the Node build module');` : ''}
    return resolved;
  }});
`;

describe('lazy build dependencies', () => {
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
});
