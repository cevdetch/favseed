// Pins lib/quality.mjs to the two independent implementations it replaces inside the
// pipeline: test/lib/accuracy.mjs's score() (pct) and bench/lib/metrics.mjs's edgeError().
// Both stay exactly as they are — accuracy.mjs is the suite's own oracle and must not import
// lib/quality, and bench/lib/metrics.mjs is the sheet's second-gate signal — so this file only
// proves the ported arithmetic agrees with them, fixture by fixture, before anything in the
// pipeline is allowed to depend on the port.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFiles } from '../bin/favseed.mjs';
import { ACCURACY_PCT, EDGE_GATE, SEARCH_COLORS, SEARCH_QUALITIES } from '../lib/core.mjs';
import { edgeError, passesBar, pctOff, prepareReference } from '../lib/quality.mjs';
import { edgeError as edgeErrorBench } from '../bench/lib/metrics.mjs';
import { reference, score } from './lib/accuracy.mjs';
import { decode } from './lib/png.mjs';

const dec = (bytes) => decode(Buffer.from(bytes));
const toRgba = (img) => ({ width: img.width, height: img.height, rgba: img.data });

const FIXTURES = ['general', 'gradient', 'heavy', 'tiles'];

describe('lib/quality: pinned to the independent implementations', () => {
  for (const name of FIXTURES) {
    it(`matches score().pct and bench edgeError on icon-192.png for ${name}`, async () => {
      const source = `test/fixtures/${name}.svg`;
      const set = await buildFiles({ input: source });
      const file = set.files.find((f) => f.name === 'icon-192.png');
      assert.ok(file, 'icon-192.png missing from the build');
      const candidate = dec(file.bytes);
      const ref = await reference({ source, px: 192, bg: '#000000', vars: {}, fitted: true });

      const expectedPct = score(candidate, ref).pct;
      const expectedEdge = edgeErrorBench(candidate, ref);

      const candidateRgba = toRgba(candidate),
        refRgba = toRgba(ref);
      const gotPct = pctOff(candidateRgba, refRgba);
      const gotEdge = edgeError(candidateRgba, refRgba);
      assert.ok(Math.abs(gotPct - expectedPct) < 1e-9, `${name}: pctOff ${gotPct} vs score().pct ${expectedPct}`);
      assert.ok(
        Math.abs(gotEdge - expectedEdge) < 1e-9,
        `${name}: edgeError ${gotEdge} vs bench edgeError ${expectedEdge}`,
      );

      // prepareReference precomputes the reference side once; engine.search relies on it giving
      // the exact same numbers a fresh (raw-reference) call would, not an approximation.
      const prepared = prepareReference(refRgba);
      assert.equal(pctOff(candidateRgba, prepared), gotPct, `${name}: prepared pctOff disagrees with raw`);
      assert.equal(edgeError(candidateRgba, prepared), gotEdge, `${name}: prepared edgeError disagrees with raw`);
      assert.deepEqual(
        passesBar(candidateRgba, prepared),
        passesBar(candidateRgba, refRgba),
        `${name}: passesBar disagrees between prepared and raw`,
      );
    });
  }
});

describe('lib/quality: unit cases', () => {
  const image = (w, h, f) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([...f(x, y), 255], (y * w + x) * 4);
    return { width: w, height: h, rgba };
  };
  // Same shapes as test/bench-metrics.mjs's `edge`/`ramp`, so the two suites agree on what
  // "collapsed to two levels" means.
  const edge = image(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255]));
  const ramp = image(16, 16, (x) => [x * 16, x * 16, x * 16]);

  it('scores identical images as perfect on both metrics', () => {
    assert.equal(pctOff(edge, edge), 0);
    assert.equal(edgeError(edge, edge), 0);
  });

  it('flags a ramp collapsed to two levels on both metrics', () => {
    assert.ok(pctOff(edge, ramp) > ACCURACY_PCT);
    assert.ok(edgeError(edge, ramp) > EDGE_GATE);
  });

  it('passesBar combines both metrics', () => {
    assert.deepEqual(passesBar(edge, edge), { pass: true, pct: 0, edge: 0 });
    const bad = passesBar(edge, ramp);
    assert.equal(bad.pass, false);
    assert.ok(bad.pct > ACCURACY_PCT);
    assert.ok(bad.edge > EDGE_GATE);
  });

  it('exposes the search lists the effort modes probe', () => {
    assert.deepEqual(SEARCH_QUALITIES, [40, 50, 60, 70, 80, 90, 95, 98, 99]);
    assert.deepEqual(SEARCH_COLORS, [2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]);
  });
});
