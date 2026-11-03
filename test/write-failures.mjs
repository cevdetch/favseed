import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from '../bin/favseed.mjs';

const exec = promisify(execFile);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'favseed-write-failures ')));
const cli = fileURLToPath(new URL('../bin/favseed.mjs', import.meta.url));
const preload = new URL('./lib/write-failure.mjs', import.meta.url).href;
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}.svg`, import.meta.url));
const options = { sizes: [32], manifest: true, bg: '#ffffff' };
let serial = 0, template;
before(async () => {
  template = join(scratch, 'template');
  await build({ ...options, input: fixture('flat'), out: template });
});
after(() => rmSync(scratch, { recursive: true, force: true }));

const tree = (root) => Object.fromEntries(readdirSync(root).sort().map((name) => {
  const path = join(root, name), stat = lstatSync(path);
  return [name, stat.isSymbolicLink() ? { link: readlinkSync(path) }
    : stat.isDirectory() ? tree(path) : readFileSync(path).toString('base64')];
}));
const setup = () => {
  const root = join(scratch, `case-${++serial}`), out = join(root, 'out');
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(template)) copyFileSync(join(template, name), join(out, name));
  mkdirSync(join(out, 'unrelated'));
  writeFileSync(join(out, 'unrelated', 'keep.txt'), 'keep nested assets');
  writeFileSync(join(out, 'keep.txt'), 'keep this file');
  return { root, out, trace: join(root, 'trace.jsonl') };
};
const run = async (state, faults = [], api = false) => {
  const args = api ? ['--input-type=module', '--eval', `
    import { build, FavseedError } from ${JSON.stringify(new URL('../bin/favseed.mjs', import.meta.url).href)};
    try { await build(JSON.parse(process.argv[1])); }
    catch (error) { console.error(JSON.stringify({ known: error instanceof FavseedError, message: error.message })); process.exitCode = 1; }
  `, JSON.stringify({ ...options, input: fixture('general'), out: state.out })]
    : [cli, fixture('general'), '--out', state.out, '--bg', '#fff', '--sizes', '32', '--manifest', '--html'];
  try {
    const result = await exec(process.execPath, ['--import', preload, ...args], {
      env: { ...process.env, FAVSEED_TEST_WRITE_FAILURE: JSON.stringify({ ...state, faults }) }, timeout: 30000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
};
const events = (state) => existsSync(state.trace)
  ? readFileSync(state.trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const failed = (result) => {
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /^favseed: /);
  assert.doesNotMatch(result.stderr, /\n\s+at |\bError:\s*\n/);
  assert.equal(result.stdout, '', 'failed builds must not print success or head markup');
};
const publishFault = (name) => ({ method: 'renameSync', from: 'stage', to: 'out', name, code: 'EACCES' });

describe('late output write failures', () => {
  it('preserves the previous set and cleans staging after a partial staged write', async () => {
    const state = setup(), before = tree(state.out);
    const result = await run(state, [{ method: 'writeFileSync', to: 'stage', name: 'favicon.ico', code: 'ENOSPC' }]);
    failed(result); assert.match(result.stderr, /ENOSPC/);
    assert.ok(events(state).some((event) => event.method === 'writeFileSync' && event.name === 'icon.svg'));
    assert.deepEqual(tree(state.out), before);
  });

  it('validates all staged files before replacing any output', async () => {
    const state = setup(), before = tree(state.out);
    failed(await run(state, [{ method: 'writeFileSync', to: 'stage', name: 'favicon.ico', empty: true }]));
    assert.deepEqual(tree(state.out), before);
  });

  it('backs up the entire previous set before replacing any output', async () => {
    const state = setup(), before = tree(state.out);
    const result = await run(state, [{ method: 'copyFileSync', to: 'backup', name: 'favicon.ico', code: 'ENOSPC' }]);
    failed(result); assert.match(result.stderr, /ENOSPC/);
    assert.ok(events(state).some((event) => event.method === 'copyFileSync' && event.to === 'backup' && event.failed));
    assert.deepEqual(tree(state.out), before);
  });

  for (const existed of [true, false]) {
    it(`does not roll back an unchanged ${existed ? 'existing' : 'absent'} destination when its first replacement fails`, async () => {
      const state = setup();
      if (!existed) rmSync(join(state.out, 'icon.svg'));
      const before = tree(state.out);
      const unexpectedRestore = existed
        ? { method: 'renameSync', from: 'backup', to: 'out', name: 'icon.svg', code: 'EPERM' }
        : { method: 'rmSync', to: 'out', name: 'icon.svg', code: 'EPERM' };
      const result = await run(state, [publishFault('icon.svg'), unexpectedRestore]);
      failed(result);
      assert.match(result.stderr, /EACCES/);
      assert.doesNotMatch(result.stderr, /EPERM|Could not restore|Recovery files/);
      assert.deepEqual(tree(state.out), before);
    });
  }

  for (const name of ['favicon.ico', 'site.webmanifest']) {
    it(`restores the previous set after replacement fails at ${name}`, async () => {
      const state = setup(), before = tree(state.out);
      const result = await run(state, [publishFault(name)]);
      failed(result); assert.match(result.stderr, /EACCES/);
      assert.ok(events(state).some((event) => event.method === 'renameSync' && event.from === 'stage'
        && event.to === 'out' && !event.failed), 'the failure must happen after an actual replacement');
      assert.deepEqual(tree(state.out), before);
      assert.equal((await run(state)).code, 0, 'a corrected retry must succeed');
      assert.notEqual(readFileSync(join(state.out, 'icon.svg'), 'utf8'), readFileSync(join(template, 'icon.svg'), 'utf8'));
      assert.equal(readFileSync(join(state.out, 'keep.txt'), 'utf8'), 'keep this file');
      assert.deepEqual(readdirSync(state.out).filter((file) => file.startsWith('.favseed.')), []);
    });
  }

  it('removes newly installed files on rollback while restoring existing ones', async () => {
    const state = setup();
    rmSync(join(state.out, 'favicon.ico'));
    rmSync(join(state.out, 'site.webmanifest'));
    const before = tree(state.out);
    failed(await run(state, [publishFault('site.webmanifest')]));
    assert.deepEqual(tree(state.out), before);
  });

  it('rejects an actual directory conflict without changing preceding files or directory contents', async () => {
    const state = setup();
    rmSync(join(state.out, 'site.webmanifest'));
    mkdirSync(join(state.out, 'site.webmanifest'));
    writeFileSync(join(state.out, 'site.webmanifest', 'keep'), 'a user directory');
    const before = tree(state.out);
    failed(await run(state));
    assert.deepEqual(tree(state.out), before);
  });

  it('throws FavseedError from the public API for a late replacement failure', async () => {
    const state = setup(), before = tree(state.out);
    const result = await run(state, [publishFault('site.webmanifest')], true);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).known, true);
    assert.match(JSON.parse(result.stderr).message, /EACCES/);
    assert.deepEqual(tree(state.out), before);
  });

  it('keeps recovery bytes after process exit if one restoration fails and restores the other files', async () => {
    const state = setup(), before = tree(state.out);
    const result = await run(state, [publishFault('site.webmanifest'),
      { method: 'renameSync', from: 'backup', to: 'out', name: 'favicon.ico', code: 'EPERM' }]);
    failed(result);
    assert.match(result.stderr, /EACCES[\s\S]*Could not restore previous output:[\s\S]*favicon\.ico:.*EPERM/);
    const recovery = result.stderr.match(/Recovery files kept at (.+)/)?.[1];
    assert.ok(recovery && existsSync(recovery), 'the exit sweeper must retain recoverable old output');
    assert.deepEqual(readFileSync(join(recovery, 'favicon.ico')), readFileSync(join(template, 'favicon.ico')));
    const actual = tree(state.out);
    for (const name of Object.keys(before).filter((name) => name !== 'favicon.ico')) {
      assert.deepEqual(actual[name], before[name], `${name} should still be restored`);
    }
    assert.notEqual(actual['favicon.ico'], before['favicon.ico']);
    assert.ok(events(state).some((event) => event.from === 'backup' && event.to === 'out'
      && event.name === 'icon.svg' && !event.failed), 'restoration must continue after an error');
    assert.equal((await run(state)).code, 0);
    assert.ok(existsSync(recovery), 'a later build must not sweep an earlier recovery directory');
  });

  it('preserves the original failure when staging cleanup also fails', async () => {
    const state = setup(), before = tree(state.out);
    const result = await run(state, [
      { method: 'writeFileSync', to: 'stage', name: 'favicon.ico', code: 'ENOSPC' },
      { method: 'rmSync', to: 'stage', code: 'EPERM' },
    ]);
    failed(result);
    assert.match(result.stderr, /ENOSPC[\s\S]*Cannot remove staging directory .+:.*EPERM/);
    const actual = tree(state.out), stages = Object.keys(actual).filter((name) => name.startsWith('.favseed.'));
    assert.equal(stages.length, 1, 'cleanup failure must report rather than hide its leftover directory');
    assert.ok(result.stderr.includes(join(state.out, stages[0])));
    delete actual[stages[0]];
    assert.deepEqual(actual, before);
  });

  it('reports successful publishing separately when only cleanup fails', async () => {
    const state = setup();
    const result = await run(state, [{ method: 'rmSync', to: 'stage', code: 'EPERM' }]);
    failed(result);
    assert.match(result.stderr, /Output files were written[\s\S]*Cannot remove staging directory .+:.*EPERM/);
    assert.notEqual(readFileSync(join(state.out, 'icon.svg'), 'utf8'), readFileSync(join(template, 'icon.svg'), 'utf8'));
    assert.equal(readFileSync(join(state.out, 'keep.txt'), 'utf8'), 'keep this file');
  });

  it('restores an empty destination directory after a late failure in its first build', async () => {
    const state = setup();
    for (const name of readdirSync(template)) rmSync(join(state.out, name));
    const before = tree(state.out);
    failed(await run(state, [publishFault('site.webmanifest')]));
    assert.deepEqual(tree(state.out), before);
  });

  for (const kind of ['absolute', 'relative', 'broken']) {
    it(`restores ${kind} destination symlinks without changing their targets`, async (t) => {
      const state = setup(), target = join(state.root, 'target.svg');
      if (kind !== 'broken') writeFileSync(target, 'do not modify the symlink target');
      rmSync(join(state.out, 'icon.svg'));
      try { symlinkSync(kind === 'relative' ? '../target.svg' : target, join(state.out, 'icon.svg')); }
      catch (error) { if (error.code === 'EPERM') return t.skip('host cannot create symlinks'); throw error; }
      const before = tree(state.out);
      failed(await run(state, [publishFault('site.webmanifest')]));
      assert.deepEqual(tree(state.out), before);
      if (kind === 'broken') assert.ok(!existsSync(target));
      else assert.equal(readFileSync(target, 'utf8'), 'do not modify the symlink target');
      assert.equal((await run(state)).code, 0);
      assert.ok(lstatSync(join(state.out, 'icon.svg')).isFile());
      if (kind === 'broken') assert.ok(!existsSync(target));
      else assert.equal(readFileSync(target, 'utf8'), 'do not modify the symlink target');
    });
  }
});
