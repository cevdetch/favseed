import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkReleasePolicy, compareManifests, formatDifferences, parseVersion,
  previousRelease, validateManifest } from './lib/bytes.mjs';

const manifest = () => ({
  schema: 1,
  engines: { '@napi-rs/image': '1.15.0', svgo: '4.1.0', '@gfx/zopfli': '1.0.15+wasm.example' },
  profiles: { default: { marks: ['general'], options: { bg: '#000000', manifest: true } } },
  files: {
    'default/general/icon.svg': { bytes: 100, sha256: '1'.repeat(64) },
    'default/general/favicon.ico': { bytes: 200, sha256: '2'.repeat(64) },
  },
});
const changed = () => {
  const value = manifest(); value.files['default/general/icon.svg'].sha256 = '3'.repeat(64); return value;
};
const prior = (value = manifest(), version = '0.8.0') => ({ tag: 'v' + version, version, manifest: value });

describe('byte manifest comparison', () => {
  it('accepts a complete manifest and ignores object key ordering', () => {
    const before = manifest(), after = manifest(); validateManifest(before);
    after.engines = Object.fromEntries(Object.entries(after.engines).reverse());
    after.files = Object.fromEntries(Object.entries(after.files).reverse());
    assert.equal(formatDifferences(compareManifests(before, after)), '');
  });

  it('reports same-size changes, additions and removals with filenames and byte deltas', () => {
    const after = changed();
    delete after.files['default/general/favicon.ico'];
    after.files['default/general/icon-192.png'] = { bytes: 300, sha256: '4'.repeat(64) };
    const report = formatDifferences(compareManifests(manifest(), after));
    assert.match(report, /changed default\/general\/icon\.svg: 100 → 100 B \(\+0 B\)/);
    assert.match(report, /removed default\/general\/favicon\.ico: 200 B/);
    assert.match(report, /added default\/general\/icon-192\.png: 300 B/);
    assert.match(report, /11111111 → 33333333/);
  });

  it('reports changed sizes, encoder identity and profile definitions', () => {
    const after = manifest(); after.files['default/general/icon.svg'].bytes = 80;
    after.engines.svgo = '4.2.0'; after.profiles.default.options.bg = '#ffffff';
    const report = formatDifferences(compareManifests(manifest(), after));
    assert.match(report, /100 → 80 B \(-20 B\)/);
    assert.match(report, /encoder svgo: 4\.1\.0 → 4\.2\.0/);
    assert.match(report, /Build profiles changed/);
  });

  it('refuses malformed, empty, unsupported or incomplete baselines', () => {
    for (const value of [null, [], {}, { ...manifest(), schema: 2 }, { ...manifest(), files: {} },
      { ...manifest(), engines: {} }, { ...manifest(), profiles: {} }]) {
      assert.throws(() => validateManifest(value), /manifest|schema|encoder|profile|file/i);
    }
    for (const file of [{ bytes: -1, sha256: '1'.repeat(64) }, { bytes: 100, sha256: 'wrong' },
      { bytes: 100, sha256: ['1'.repeat(64)] }]) {
      const value = manifest(); value.files['default/general/icon.svg'] = file;
      assert.throws(() => validateManifest(value), /file/i);
    }
    const value = manifest(); value.files['../escape'] = { bytes: 1, sha256: '1'.repeat(64) };
    assert.throws(() => validateManifest(value), /file/i);
  });
});

describe('byte release policy', () => {
  it('accepts unchanged patch output and rejects a changed patch even with an updated current baseline', () => {
    assert.match(checkReleasePolicy({ current: manifest(), version: '0.8.1', previous: prior() }), /unchanged/i);
    assert.throws(() => checkReleasePolicy({ current: changed(), version: '0.8.1', previous: prior() }),
      /patch.*0\.8\.1.*[\s\S]*icon\.svg/i);
  });

  it('blocks patch encoder/profile changes even when the sampled files are identical', () => {
    for (const mutate of [(m) => { m.engines.svgo = '4.2.0'; },
      (m) => { m.profiles.default.options.manifest = false; }]) {
      const current = manifest(); mutate(current);
      assert.throws(() => checkReleasePolicy({ current, version: '0.8.1', previous: prior() }), /patch/i);
    }
  });

  it('allows reviewed changes in minor/major releases and establishes an initial release baseline', () => {
    for (const version of ['0.9.0', '1.0.0', '0.9.0-rc.1']) {
      assert.match(checkReleasePolicy({ current: changed(), version, previous: prior() }), /minor|major/i);
    }
    assert.match(checkReleasePolicy({ current: manifest(), version: '0.8.0' }), /first.*baseline/i);
  });

  it('fails closed for a patch whose previous stable release has no byte baseline', () => {
    assert.throws(() => checkReleasePolicy({ current: manifest(), version: '0.8.1', previous: prior(null) }), /missing.*baseline|no.*baseline/i);
    assert.match(checkReleasePolicy({ current: manifest(), version: '0.9.0', previous: prior(null) }), /establish/i);
  });

  it('requires version advancement and applies patch policy to prerelease candidates', () => {
    for (const version of ['0.8.0', '0.7.9', '0.8.0-rc.1']) {
      assert.throws(() => checkReleasePolicy({ current: manifest(), version, previous: prior() }), /advance/i);
    }
    assert.throws(() => checkReleasePolicy({ current: changed(), version: '0.8.1-rc.1', previous: prior() }), /patch/i);
    assert.equal(parseVersion('0.8.1-rc.1+build.2').prerelease, 'rc.1');
    for (const version of ['v0.8.0', '01.8.0', '0.8', '0.8.1-01', '0.8.1+']) {
      assert.throws(() => parseVersion(version), /version/i);
    }
  });
});

const repository = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'favseed-byte-history '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Byte tests'); git('config', 'user.email', 'bytes@example.invalid');
  git('config', 'commit.gpgSign', 'false'); git('config', 'tag.gpgSign', 'false');
  mkdirSync(join(root, '.git/empty-hooks'));
  git('config', 'core.hooksPath', join(root, '.git/empty-hooks'));
  const commit = (value = manifest()) => {
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test/bytes.json'), JSON.stringify(value));
    git('add', '.'); git('commit', '--quiet', '--allow-empty', '-m', 'fixture baseline');
  };
  return { root, git, commit };
};

describe('previous stable byte baseline from Git', () => {
  it('recognizes a first release without tags', (t) => {
    const { root, commit } = repository(t); commit();
    assert.equal(previousRelease(root, '0.8.0'), null);
  });

  it('reads an annotated stable ancestor and ignores prerelease, unrelated and current candidate tags', (t) => {
    const { root, git, commit } = repository(t);
    commit(); git('tag', '-a', 'v0.8.0', '-m', 'stable');
    git('switch', '--quiet', '-c', 'unrelated'); commit(); git('tag', 'v9.0.0');
    git('switch', '--quiet', 'main'); commit(changed()); git('tag', 'v0.9.0-rc.1'); git('tag', 'not-a-version');
    git('tag', 'v0.9.0');
    assert.deepEqual(previousRelease(root, '0.9.0'), prior());
  });

  it('does not hide a previous tag with a non-advancing version on an ancestor', (t) => {
    const { root, git, commit } = repository(t); commit(); git('tag', 'v0.8.0'); commit(changed());
    const previous = previousRelease(root, '0.8.0');
    assert.equal(previous.tag, 'v0.8.0');
    assert.throws(() => checkReleasePolicy({ current: changed(), version: '0.8.0', previous }), /advance/i);
  });

  it('distinguishes absent old baselines from invalid old baselines', (t) => {
    const { root, git, commit } = repository(t);
    writeFileSync(join(root, 'README'), 'old release'); git('add', '.'); git('commit', '--quiet', '-m', 'before baselines'); git('tag', 'v0.7.0');
    commit();
    assert.equal(previousRelease(root, '0.8.0').manifest, null);
    commit({ schema: 2 }); git('tag', 'v0.8.0'); commit();
    assert.throws(() => previousRelease(root, '0.8.1'), /schema|manifest/i);
  });

  it('rejects shallow history before deciding that no previous release exists', (t) => {
    const { root, git, commit } = repository(t); commit();
    writeFileSync(join(root, '.git/shallow'), git('rev-parse', 'HEAD') + '\n');
    assert.throws(() => previousRelease(root, '0.8.0'), /shallow|full history/i);
  });
});
