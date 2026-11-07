// The options layer on its own (lib/config.mjs), then the CLI reading a config file, then the
// types a config file sees.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { FavseedError } from '../lib/core.mjs';
import {
  buildIdentity,
  checkConfig,
  CONFIG_KEYS,
  defineConfig,
  normaliseOptions,
  resolveOptions,
} from '../lib/config.mjs';

const fails = (fn, re) => assert.throws(fn, (e) => e instanceof FavseedError && re.test(e.message));

describe('normaliseOptions', () => {
  it('fills the defaults', () => {
    const o = normaliseOptions({});
    assert.equal(o.colors, 256);
    assert.equal(o.quality, 80);
    assert.deepEqual(o.sizes, [192, 512]);
    assert.equal(o.bg, '#000000');
    assert.equal(o.padding, 'auto');
    assert.equal(o.base, '/');
    assert.equal(o.iterations, 0);
    assert.equal(o.out, '.');
  });

  it('keeps the existing messages', () => {
    fails(() => normaliseOptions({ colors: '0x10' }), /^--colors must be an integer 2-256, got '0x10'$/);
    fails(() => normaliseOptions({ sizes: '33' }), /^--sizes takes even pixel sizes, got '33'$/);
    fails(() => normaliseOptions({ padding: 50 }), /^--padding must be 'auto' or a percentage 0-45$/);
    fails(() => normaliseOptions({ mode: 'slow' }), /^mode must be 'release' or 'fast', got 'slow'$/);
  });

  it('requires an explicit opt-in before either mode runs Zopfli', () => {
    assert.equal(normaliseOptions({ mode: 'fast' }).iterations, 0);
    assert.equal(normaliseOptions({ zopfli: true }).iterations, 120);
    assert.equal(normaliseOptions({ mode: 'fast', zopfli: true }).iterations, 15);
    assert.equal(normaliseOptions({ zopfli: false }).iterations, 0);
    for (const zopfli of ['yes', 1, null]) fails(() => normaliseOptions({ zopfli }), /^zopfli must be true or false/);
  });

  it('validates PNG quality and refuses a palette that would override it', () => {
    for (const quality of [1, 60, 80, 100, '80']) assert.equal(normaliseOptions({ quality }).quality, Number(quality));
    for (const quality of [0, 101, 1.5, true, null, '', '0x50', '80px', [80], 80n, new Number(80), Symbol(80)]) {
      fails(() => normaliseOptions({ quality }), /^--quality must be an integer 1-100/);
    }
    fails(() => normaliseOptions({ quality: 80, colors: 256 }), /quality.*colors/);
    fails(() => normaliseOptions({ quality: 80, colors: 32 }), /quality.*colors/);
    assert.equal(normaliseOptions({ quality: 100, colors: 32 }).colors, 32);
    assert.equal(normaliseOptions({ colors: 32 }).quality, 100);
    assert.equal(normaliseOptions({ colors: 256 }).quality, 100);
  });

  it('turns bg none and bg null into a transparent set', () => {
    assert.equal(normaliseOptions({ bg: 'none' }).bg, null);
    assert.equal(normaliseOptions({ bg: null }).bg, null);
  });

  it('normalises base to a path with a slash at each end', () => {
    for (const [given, want] of [
      ['/', '/'],
      ['', '/'],
      ['blog', '/blog/'],
      ['/blog', '/blog/'],
      ['/blog/', '/blog/'],
      ['a/b', '/a/b/'],
      ['/a//b/', '/a/b/'],
    ]) {
      assert.equal(normaliseOptions({ base: given }).base, want, `base '${given}'`);
    }
  });

  it('refuses a base that is a URL, not a path', () => {
    fails(
      () => normaliseOptions({ base: 'https://cdn.example.com/' }),
      /^base must be a path such as '\/' or '\/blog\/', got 'https:\/\/cdn\.example\.com\/'$/,
    );
    fails(() => normaliseOptions({ base: '//cdn.example.com' }), /^base must be a path/);
    fails(() => normaliseOptions({ base: 42 }), /^base must be a path/);
  });

  it('refuses an animation or manifest of the wrong type', () => {
    fails(() => normaliseOptions({ animation: 'no' }), /^animation must be true or false, got 'no'$/);
    fails(
      () => normaliseOptions({ manifest: 'yes' }),
      /^manifest must be true, false or an object of manifest members, got 'yes'$/,
    );
  });
});

describe('buildIdentity', () => {
  const id = (options) => JSON.stringify(buildIdentity(normaliseOptions(options)));
  it('is equal for spellings of the same build', () => {
    assert.equal(id({ vars: { brand: '#fff' } }), id({ vars: new Map([['--brand', '#fff']]) }));
    assert.equal(id({}), id({ bg: '#000000', sizes: [192, 512], padding: 'auto' }));
  });
  it('differs when the bytes would', () => {
    assert.notEqual(id({}), id({ bg: 'none' }));
    assert.notEqual(id({ sizes: [192, 512] }), id({ sizes: [512, 192] })); // manifest order
    assert.notEqual(id({}), id({ zopfli: true }));
    assert.notEqual(id({ manifest: true }), id({ manifest: { name: 'x' } }));
    assert.notEqual(id({}), id({ base: '/blog/', manifest: true }));
  });
});

describe('resolveOptions', () => {
  it('layers defaults, then the file, then the inline options', () => {
    const r = resolveOptions({ out: '.', colors: 8 }, { colors: 16, sizes: [32] }, { colors: 64 });
    assert.deepEqual({ out: r.out, colors: r.colors, sizes: r.sizes }, { out: '.', colors: 64, sizes: [32] });
  });

  it('skips undefined, so an absent flag never hides the file', () => {
    assert.equal(resolveOptions({}, { bg: '#fff' }, { bg: undefined }).bg, '#fff');
  });

  it('merges vars by name, the inline value winning, with or without the dashes', () => {
    const r = resolveOptions(
      {},
      { vars: { ground: '#111111', ink: '#222222' } },
      { vars: new Map([['--ground', '#333333']]) },
    );
    assert.deepEqual(
      [...r.vars],
      [
        ['--ground', '#333333'],
        ['--ink', '#222222'],
      ],
    );
  });

  it('keeps a manifest object from the file when the inline value is only true', () => {
    const obj = { name: 'Example' };
    assert.equal(resolveOptions({}, { manifest: obj }, { manifest: true }).manifest, obj);
    const other = { name: 'Other' };
    assert.equal(resolveOptions({}, { manifest: obj }, { manifest: other }).manifest, other);
  });
});

describe('checkConfig', () => {
  it('lists the keys it knows', () => {
    assert.deepEqual(CONFIG_KEYS, [
      'input',
      'out',
      'colors',
      'quality',
      'sizes',
      'bg',
      'padding',
      'vars',
      'animation',
      'manifest',
      'mode',
      'zopfli',
      'base',
    ]);
  });

  it('refuses a default export that is not an object', () => {
    for (const bad of [undefined, null, 3, 'x', [1]]) {
      fails(
        () => checkConfig(bad, 'favseed.config.mjs'),
        /^favseed\.config\.mjs must export an object as its default export$/,
      );
    }
  });

  it('names every unknown key and the keys it accepts', () => {
    fails(
      () => checkConfig({ colours: 8, quiet: true }, 'favseed.config.mjs'),
      /^favseed\.config\.mjs: unknown options 'colours', 'quiet'; the options are input, out, colors, quality, sizes, bg, padding, vars, animation, manifest, mode, zopfli, base$/,
    );
  });

  it('defineConfig returns what it was given', () => {
    const c = { sizes: [32] };
    assert.equal(defineConfig(c), c);
  });
});

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'favseed.mjs');
const execFileAsync = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'favseed-config.'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** A project directory holding logo.svg (general.svg) and the given files. */
const project = (files) => {
  const dir = join(scratch, `p${++n}`);
  mkdirSync(dir);
  copyFileSync(join(ROOT, 'test', 'fixtures', 'general.svg'), join(dir, 'logo.svg'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};

/** The CLI, run in `cwd`. Never throws; tests assert on the exit code. */
const run = async (cwd, args = []) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd, timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

const FAST = "input: 'logo.svg', out: 'public', sizes: [32], mode: 'fast', bg: '#000000'";
const read = (dir, f) => readFileSync(join(dir, 'public', f), 'utf8');
const noStack = (r) => assert.ok(!/at .*\.m?[jt]s:\d+/.test(r.stderr), `a stack trace leaked:\n${r.stderr}`);

describe('CLI argument boundaries', () => {
  it('rejects a missing option value before loading config or writing output', async () => {
    for (const flag of ['-o', '--out', '--colors', '--quality', '--sizes', '--bg', '--padding', '--var']) {
      const dir = project({ 'favseed.config.mjs': "throw new Error('config must not load');" });
      const r = await run(dir, [flag, '--manifest', 'logo.svg']);
      assert.equal(r.code, 1, flag);
      assert.match(r.stderr, new RegExp(`^favseed: ${flag} needs an argument$`, 'm'));
      assert.ok(!existsSync(join(dir, '--manifest')), 'a flag became an output directory');
      assert.ok(!existsSync(join(dir, 'public')));
      noStack(r);
    }
  });

  it('recognizes every existing flag, inline long flags and the option delimiter as a missing value', async () => {
    const dir = project({ 'favseed.config.mjs': "throw new Error('config must not load');" });
    for (const next of [
      '-o',
      '--out',
      '--colors',
      '--quality',
      '--sizes',
      '--bg',
      '--padding',
      '--var',
      '--no-animation',
      '--zopfli',
      '--no-zopfli',
      '--manifest',
      '--html',
      '-q',
      '--quiet',
      '-V',
      '--version',
      '-h',
      '--help',
      '--quality=80',
      '--bg=none',
      '--',
    ]) {
      const r = await run(dir, ['--out', next, 'logo.svg']);
      assert.equal(r.code, 1, next);
      assert.match(r.stderr, /^favseed: --out needs an argument$/m, next);
      noStack(r);
    }
  });

  it('accepts literal flag-like output names through inline syntax and unknown dash-prefixed values', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST} };` });
    for (const args of [['--out=--manifest'], ['--out', '--custom-output']]) {
      const r = await run(dir, args);
      assert.equal(r.code, 0, r.stderr);
    }
    for (const name of ['--manifest', '--custom-output']) {
      assert.ok(existsSync(join(dir, name, 'favicon.ico')), name);
    }
    assert.ok(!existsSync(join(dir, 'public')));
  });

  it('accepts CSS assignments whose names match known options', async () => {
    const dir = project({
      'favseed.config.mjs': `export default { ${FAST} };`,
      'logo.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="24" y="24" width="var(--quality)" height="80" fill="var(--bg)"/></svg>',
    });
    const r = await run(dir, ['--var', '--bg=#654321', '--var', '--quality=80']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(read(dir, 'icon.svg'), /#654321/);
    assert.doesNotMatch(read(dir, 'icon.svg'), /var\(/);
  });

  it('leaves negative values to normal option validation', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST} };` });
    for (const flag of ['--padding', '--quality']) {
      const r = await run(dir, [flag, '-1']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`^favseed: ${flag} must be`, 'm'));
      assert.doesNotMatch(r.stderr, /needs an argument/);
      noStack(r);
    }
    assert.ok(!existsSync(join(dir, 'public')));
  });

  it('treats a flag after the option delimiter as an input filename', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST} };` });
    copyFileSync(join(dir, 'logo.svg'), join(dir, '--help'));
    const r = await run(dir, ['--', '--help']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'public', 'favicon.ico')));
  });

  it('warns under quiet when explicit transparent padding affects only the apple icon', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST.replace("bg: '#000000'", 'bg: null')} };` });
    const baseline = await run(dir, ['--quiet']);
    assert.equal(baseline.code, 0, baseline.stderr);
    assert.doesNotMatch(baseline.stderr, /--padding/);
    const before = Object.fromEntries(
      ['apple-touch-icon.png', 'favicon.ico', 'icon-32.png'].map((name) => [
        name,
        readFileSync(join(dir, 'public', name)),
      ]),
    );
    const r = await run(dir, ['--bg', 'none', '--padding', '20', '--quiet']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(
      r.stderr,
      /^favseed: warning: --padding only affects apple-touch-icon\.png with --bg none; size icons and favicon\.ico stay unpadded$/m,
    );
    assert.notDeepEqual(readFileSync(join(dir, 'public/apple-touch-icon.png')), before['apple-touch-icon.png']);
    for (const name of ['favicon.ico', 'icon-32.png']) {
      assert.deepEqual(readFileSync(join(dir, 'public', name)), before[name], name);
    }
  });

  it('uses effective config and CLI values for the transparent padding warning', async () => {
    const dir = project({
      'favseed.config.mjs': `export default { ${FAST.replace("bg: '#000000'", 'bg: null')}, padding: 20 };`,
    });
    const configured = await run(dir, ['--quiet']);
    assert.equal(configured.code, 0, configured.stderr);
    assert.match(configured.stderr, /warning: --padding only affects apple-touch-icon\.png/);
    const opaque = await run(dir, ['--bg', '#fff', '--quiet']);
    assert.equal(opaque.code, 0, opaque.stderr);
    assert.doesNotMatch(opaque.stderr, /warning: --padding/);
    const invalid = await run(dir, ['--padding', '99']);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /--padding must be/);
    assert.doesNotMatch(invalid.stderr, /warning: --padding/);
    noStack(invalid);
  });
});

describe('the CLI with a config file', () => {
  it('accepts PNG quality from config and lets the CLI override it', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST}, quality: 60 };` });
    copyFileSync(join(ROOT, 'test/fixtures/gradient.svg'), join(dir, 'logo.svg'));
    const low = await run(dir);
    assert.equal(low.code, 0, low.stderr);
    const before = readFileSync(join(dir, 'public/apple-touch-icon.png'));
    const higher = await run(dir, ['--quality=80']);
    assert.equal(higher.code, 0, higher.stderr);
    assert.notDeepEqual(readFileSync(join(dir, 'public/apple-touch-icon.png')), before);
    const bad = await run(dir, ['--quality', '101']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--quality must be an integer 1-100/);
    noStack(bad);
  });

  it('builds from the config alone and names the mode', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST} };` });
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    for (const f of ['icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-32.png']) {
      assert.ok(existsSync(join(dir, 'public', f)), f);
    }
    assert.match(r.stdout, /^standard build \(Zopfli disabled\)$/m);
    assert.ok(!/--bg not given/.test(r.stderr), 'the config gave bg, so no warning');
  });

  it('lets a flag win over the config', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST.replace('[32]', '[64]')} };` });
    const r = await run(dir, ['--sizes', '32']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'public', 'icon-32.png')));
    assert.ok(!existsSync(join(dir, 'public', 'icon-64.png')));
  });

  it('merges --var over the config vars by name', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST}, vars: { ground: '#123456' } };` });
    assert.equal((await run(dir)).code, 0);
    assert.match(read(dir, 'icon.svg'), /#123456/i);
    assert.equal((await run(dir, ['--var', 'ground=#654321'])).code, 0);
    assert.match(read(dir, 'icon.svg'), /#654321/i);
    assert.ok(!/#123456/i.test(read(dir, 'icon.svg')));
  });

  it('puts base into --html and the manifest', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST}, base: 'blog' };` });
    const r = await run(dir, ['--html', '--manifest']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /<link rel="icon" href="\/blog\/favicon\.ico" sizes="48x48">/);
    assert.match(r.stdout, /<link rel="manifest" href="\/blog\/site\.webmanifest">/);
    assert.equal(JSON.parse(read(dir, 'site.webmanifest')).icons[0].src, '/blog/icon-32.png');
  });

  it('keeps the config manifest members under --manifest', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST}, manifest: { name: 'Example' } };` });
    assert.equal((await run(dir, ['--manifest'])).code, 0);
    const m = JSON.parse(read(dir, 'site.webmanifest'));
    assert.equal(m.name, 'Example');
    assert.equal(m.icons.length, 1);
  });

  it('loads a .js config written as ESM in a project with no package.json type', async () => {
    const dir = project({ 'favseed.config.js': `export default { ${FAST} };` });
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
  });

  it('loads a .ts config through type stripping', async () => {
    const dir = project({
      'favseed.config.ts': `const sizes: number[] = [32];\nexport default { input: 'logo.svg', out: 'public', sizes, mode: 'fast' as const, bg: '#000000' };`,
    });
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'public', 'icon-32.png')));
  });

  it('names favseed.config.mjs when Node cannot load a .ts config', async () => {
    const dir = project({
      'favseed.config.ts': `enum Size { Small = 32 }\nexport default { input: 'logo.svg', sizes: [Size.Small] };`,
    });
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favseed: favseed\.config\.ts could not be loaded: /m);
    assert.match(r.stderr, /write favseed\.config\.mjs instead/);
    noStack(r);
  });

  it('refuses an unknown key, naming it', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST}, colours: 8 };` });
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favseed: favseed\.config\.mjs: unknown option 'colours'; the options are /m);
    assert.ok(!existsSync(join(dir, 'public')), 'a failed run wrote output');
    noStack(r);
  });

  it('refuses a config that does not export an object', async () => {
    const dir = project({ 'favseed.config.mjs': 'export default 42;' });
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favseed: favseed\.config\.mjs must export an object as its default export$/m);
  });

  it('reports a config that throws, without a stack trace', async () => {
    const dir = project({ 'favseed.config.mjs': "throw new Error('broken on purpose');" });
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favseed: favseed\.config\.mjs could not be loaded: broken on purpose$/m);
    noStack(r);
  });

  it('uses the first config file and warns about the others', async () => {
    const dir = project({
      'favseed.config.js': `export default { ${FAST} };`,
      'favseed.config.mjs': 'export default { colours: 8 };',
    });
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stderr,
      /^favseed: warning: favseed\.config\.mjs ignored: favseed\.config\.js is the config file in use$/m,
    );
  });

  it('still prints the usage and fails with no input from flags or config', async () => {
    for (const files of [{}, { 'favseed.config.mjs': "export default { out: 'public' };" }]) {
      const dir = project(files);
      const r = await run(dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^Usage:/m);
      assert.match(r.stderr, /^favseed: no input file given$/m);
      assert.ok(!existsSync(join(dir, 'public')));
      noStack(r);
    }
  });

  it('skips Zopfli in the summary by default', async () => {
    const dir = project({});
    const r = await run(dir, ['--sizes', '32', '--bg', '#000', '-o', 'public', 'logo.svg']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^standard build \(Zopfli disabled\)$/m);
  });

  it('lets --zopfli opt in and --no-zopfli override an enabled config', async () => {
    const dir = project({ 'favseed.config.mjs': `export default { ${FAST}, zopfli: true };` });
    const enabled = await run(dir, ['--zopfli']);
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.match(enabled.stdout, /fast build \(zopfli at 15 iterations/);
    const disabled = await run(dir, ['--no-zopfli']);
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.match(disabled.stdout, /standard build \(Zopfli disabled\)/);
  });
});

describe('defineConfig from favseed', () => {
  it('works in a config file the CLI is loading', async () => {
    // The config imports the very module the CLI is running. With a top-level await on cli()
    // that module is still evaluating, the import waits for it, and it waits for the import.
    const url = pathToFileURL(CLI).href;
    const dir = project({
      'favseed.config.mjs': `import { defineConfig } from '${url}';\nexport default defineConfig({ ${FAST} });`,
    });
    const r = await run(dir);
    assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr}`);
    assert.ok(existsSync(join(dir, 'public', 'icon-32.png')));
  });

  it('declares its types through the package exports', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.exports['.'], { types: './bin/index.d.mts', default: './bin/index.mjs' });
    assert.ok(existsSync(join(ROOT, 'bin', 'index.d.mts')));
  });

  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  it('type-checks a config, and catches a misspelt key', () => {
    assert.ok(existsSync(tsc), 'TypeScript compiler missing; run pnpm install');
    const dir = join(scratch, `tsc${++n}`);
    mkdirSync(dir);
    const spec = JSON.stringify(CLI.replace(/\\/g, '/'));
    writeFileSync(
      join(dir, 'good.mts'),
      `import { defineConfig } from ${spec};\nexport default defineConfig({ input: 'logo.svg', sizes: [192, 512], bg: null, mode: 'fast', base: '/blog/', manifest: { name: 'x' } });\n`,
    );
    writeFileSync(
      join(dir, 'bad.mts'),
      `import { defineConfig } from ${spec};\nexport default defineConfig({ colours: 8 });\n`,
    );
    const check = (f) =>
      spawnSync(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--strict',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--skipLibCheck',
          join(dir, f),
        ],
        { encoding: 'utf8', timeout: 30000 },
      );
    const good = check('good.mts');
    assert.equal(good.status, 0, good.stdout + good.stderr);
    const bad = check('bad.mts');
    assert.notEqual(bad.status, 0, 'a misspelt key type-checked');
    assert.match(bad.stdout, /colours/);
  });
});
