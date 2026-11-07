// Exercise the inputs reported by CodeQL through their real entry points.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { optimiseSvg } from '../bin/favseed.mjs';
import { benchmarkPath } from '../bench/path.mjs';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('benchmark path boundaries', () => {
  // Passing a filesystem root must fail validation before a script reads it or
  // creates its result directory. Removing any entry-point guard breaks this.
  const outside = parse(ROOT).root;
  for (const [script, outputOnly] of [
    ['default-performance.mjs', false],
    ['pipeline-concurrency.mjs', true],
    ['png-lossless-screen.mjs', false],
    ['png-quality.mjs', false],
    ['png-quantize-screen.mjs', true],
    ['vite-pwa-encode.mjs', false],
    ['vite-pwa-pipeline.mjs', false],
    ['zopfli/build.mjs', false],
    ['browser-compat/build.mjs', false],
  ]) {
    it(`${script} rejects paths outside the checkout and temporary directory before doing I/O`, async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'favseed-bench-path-test.'));
      const output = join(scratch, 'results');
      try {
        await assert.rejects(
          execFileAsync(process.execPath, [join(ROOT, 'bench', script), outside, ...(outputOnly ? [] : [output])], {
            cwd: ROOT,
            timeout: 10000,
          }),
          (error) => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /Benchmark path must be inside/);
            return true;
          },
        );
        assert.equal(existsSync(output), false, 'Rejected input must not create results');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }

  it('accepts checkout and temporary paths without creating them', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'favseed-bench-path-test.'));
    try {
      const output = join(realpathSync(scratch), 'new', 'results');
      assert.equal(benchmarkPath(output), output);
      assert.equal(existsSync(output), false);
      assert.equal(benchmarkPath('bench/out/path-test/results'), join(ROOT, 'bench/out/path-test/results'));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects malformed values and paths sharing only the temporary prefix', () => {
    for (const value of ['', '\0', undefined, null, 12, realpathSync(tmpdir()) + '-outside/results']) {
      assert.throws(() => benchmarkPath(value), /Benchmark path must be inside/);
    }
  });

  it('rejects symlinks escaping the workspace, including parents of new results', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'favseed-bench-path-test.'));
    try {
      const escape = join(scratch, 'escape');
      symlinkSync(outside, escape, 'junction');
      assert.throws(() => benchmarkPath(escape), /Benchmark path must be inside/);
      assert.throws(() => benchmarkPath(join(escape, 'new-favseed-results')), /Benchmark path must be inside/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('validates an overridden Cargo home before reading archives or starting build tools', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'favseed-cargo-path-test.'));
    try {
      const archive = join(scratch, 'unreviewed.tar.gz');
      writeFileSync(archive, 'must not reach archive verification');
      const escape = join(scratch, 'escape');
      symlinkSync(outside, escape, 'junction');
      for (const cargoHome of [outside, escape]) {
        await assert.rejects(
          execFileAsync(process.execPath, [join(ROOT, 'bench/browser-compat/build.mjs'), archive, archive], {
            cwd: ROOT,
            env: { ...process.env, CARGO_HOME: cargoHome },
            timeout: 10000,
          }),
          (error) => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /Benchmark path must be inside/);
            return true;
          },
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('SVG viewport validation', () => {
  it('rejects long invalid whitespace separators without stalling', async () => {
    const script = `
      import assert from 'node:assert/strict';
      import { optimiseSvg } from './bin/favseed.mjs';
      const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 '
        + ' '.repeat(200000) + 'x"><circle cx="32" cy="32" r="20"/></svg>';
      assert.throws(() => optimiseSvg(source, { reference: true }), /viewBox/);
      console.log('finished');
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      timeout: 5000,
    });
    assert.equal(stdout.trim(), 'finished');
  });
});

describe('CSS comment scanning', () => {
  it('keeps selectors needed by animation rules when comments surround the rules', () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<style>/* before */.mark{fill:#123456}/* between */' +
      '@media(prefers-reduced-motion:no-preference){.mark{animation:pulse 1s}}/* after */' +
      '</style><path class="mark" d="M0 0h10v10H0z"/></svg>';
    const icon = optimiseSvg(source, { icon: true }).data;
    assert.match(icon, /fill="#123456"/);
    assert.doesNotMatch(icon, /<style/);
    const logo = optimiseSvg(source, { icon: false }).data;
    assert.match(logo, /class="mark"/);
    assert.match(logo, /prefers-reduced-motion/);
    assert.match(logo, /animation:/);
  });

  for (const icon of [true, false]) {
    it(`handles repeated unclosed comments in the ${icon ? 'icon' : 'logo'} pass without stalling`, async () => {
      // A child bounds the test even if synchronous regexp backtracking blocks the event loop.
      const script = `
        import assert from 'node:assert/strict';
        import { optimiseSvg } from './bin/favseed.mjs';
        const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
          + '<style>/*' + 'a/*'.repeat(500000) + '</style><path d="M0 0h10v10H0z"/></svg>';
        const { data } = optimiseSvg(source, { icon: ${icon} });
        assert.match(data, /<path/);
        assert.doesNotMatch(data, /<style/);
        console.log('finished');
      `;
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        timeout: 5000,
      });
      assert.equal(stdout.trim(), 'finished');
    });
  }
});

describe('benchmark sweep selection', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'no-such-sweep']) {
    it(`rejects ${name} as an unknown sweep`, async () => {
      await assert.rejects(
        execFileAsync(process.execPath, [join(ROOT, 'bench/bench.mjs'), name], { cwd: ROOT, timeout: 5000 }),
        (error) => {
          assert.equal(error.code, 1);
          assert.equal(error.stderr, `bench: no sweep '${name}'\n`);
          assert.equal(error.stdout, '');
          return true;
        },
      );
    });
  }
});

describe('browser executable selection', () => {
  it('rejects an executable outside the supported browsers before starting the check', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [join(ROOT, 'site/test/cdp-check.mjs')], {
        cwd: ROOT,
        env: { ...process.env, CHROME: process.execPath },
        timeout: 5000,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /^cdp-check: CHROME must be chromium or google-chrome\n$/);
        assert.equal(error.stdout, '');
        return true;
      },
    );
  });
});
