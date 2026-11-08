import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { corpusFiles } from '../bench/corpus/files.mjs';
import { iconSvg, selectIcons } from '../bench/corpus/sets.mjs';

const set = {
  prefix: 't',
  width: 24,
  height: 24,
  icons: {
    a: { body: '<path d="M0 0h24v24z"/>' },
    wide: { body: '<rect width="48" height="24"/>', width: 48, left: 0, top: 0 },
  },
  aliases: { b: { parent: 'a' } },
};

describe('bench corpus sets', () => {
  it('wraps an icon body in an svg with the set or icon viewBox', () => {
    assert.equal(
      iconSvg(set, 'a'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>',
    );
    assert.match(iconSvg(set, 'wide'), /viewBox="0 0 48 24"/);
  });
  it('resolves aliases to their parent body', () => {
    assert.equal(iconSvg(set, 'b'), iconSvg(set, 'a'));
  });
  it('rejects an unknown icon', () => {
    assert.throws(() => iconSvg(set, 'nope'), /nope/);
  });
  it('selects evenly spaced names, deterministically and sorted', () => {
    const names = Array.from({ length: 100 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const pick = selectIcons([...names].reverse(), 4);
    assert.deepEqual(pick, ['n000', 'n025', 'n050', 'n075']);
    assert.deepEqual(selectIcons(names, 4), pick);
    assert.deepEqual(selectIcons(names.slice(0, 3), 4), names.slice(0, 3));
  });
});

describe('bench corpus files', () => {
  it('lists the positive fixtures and hides private names', async () => {
    const files = await corpusFiles({ private: undefined, open: false });
    const names = files.map((f) => f.name);
    assert.ok(names.includes('general'));
    assert.ok(!names.includes('unresolved') && !names.includes('animvar'));
    assert.ok(files.every((f) => f.corpus === 'fixtures'));
  });
  it('names private files by index only', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'favseed-private-'));
    writeFileSync(join(dir, 'Secret Brand.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
    const files = await corpusFiles({ private: dir, open: false, fixtures: false });
    assert.deepEqual(
      files.map((f) => [f.corpus, f.name]),
      [['private', 'private-0']],
    );
  });
});
