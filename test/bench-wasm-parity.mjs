import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareEngines, isHostDependent, loadImage } from '../bench/wasm-engine/parity.mjs';

test('an engine compared with itself has no mismatches', async () => {
  const native = await loadImage();
  const r = await compareEngines(native, native, { fixtures: ['flat.svg'], sizes: [32] });
  assert.ok(r.total > 0);
  assert.deepEqual(r.mismatches, []);
});

test('a changed byte is reported with its case', async () => {
  const native = await loadImage();
  const broken = {
    ...native,
    pngQuantize: async (...a) => {
      const out = new Uint8Array(await native.pngQuantize(...a));
      out[out.length - 13] ^= 1;
      return out;
    },
  };
  const r = await compareEngines(native, broken, { fixtures: ['flat.svg'], sizes: [32] });
  assert.ok(r.mismatches.length > 0);
  assert.match(r.mismatches[0].case, /flat\.svg/);
});

test('the host-dependency rule flags a text fixture and keeps a plain one', () => {
  const dependent = readFileSync(new URL('./fixtures/dependent.svg', import.meta.url), 'utf8');
  const flat = readFileSync(new URL('./fixtures/flat.svg', import.meta.url), 'utf8');
  assert.equal(isHostDependent(dependent), true);
  assert.equal(isHostDependent(flat), false);
});

test('compareEngines skips a host-dependent fixture instead of comparing it', async () => {
  const native = await loadImage();
  const r = await compareEngines(native, native, { fixtures: ['dependent.svg', 'flat.svg'], sizes: [32] });
  assert.equal(r.hostDependent, 1);
  assert.ok(r.total > 0);
  assert.deepEqual(r.mismatches, []);
});
