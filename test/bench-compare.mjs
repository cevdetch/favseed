import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, median, setDigest, summarise } from '../bench/compare/lib.mjs';

const bytes = (text) => new TextEncoder().encode(text);

describe('bench compare helpers', () => {
  it('digests a set independently of file order', () => {
    const a = { name: 'a.png', bytes: bytes('one') },
      b = { name: 'b.svg', bytes: bytes('two') };
    assert.match(setDigest([a, b]), /^[0-9a-f]{64}$/);
    assert.equal(setDigest([a, b]), setDigest([b, a]));
  });
  it('changes the digest when any byte or name changes', () => {
    const base = [
      { name: 'a.png', bytes: bytes('one') },
      { name: 'b.svg', bytes: bytes('two') },
    ];
    const digest = setDigest(base);
    assert.notEqual(setDigest([base[0], { name: 'b.svg', bytes: bytes('twp') }]), digest);
    assert.notEqual(setDigest([base[0], { name: 'c.svg', bytes: bytes('two') }]), digest);
    assert.notEqual(setDigest([base[0]]), digest);
  });
  it('classifies PNG and ICO as raster, SVG as svg, the rest as other', () => {
    assert.equal(classify('icon-192.png'), 'raster');
    assert.equal(classify('favicon.ico'), 'raster');
    assert.equal(classify('LOGO.PNG'), 'raster');
    assert.equal(classify('icon.svg'), 'svg');
    assert.equal(classify('site.webmanifest'), 'other');
    assert.equal(classify('browserconfig.xml'), 'other');
    assert.equal(classify('png'), 'other');
  });
  it('takes the median of odd and even lists without reordering the input', () => {
    const odd = [3, 1, 2];
    assert.equal(median(odd), 2);
    assert.deepEqual(odd, [3, 1, 2]);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([7]), 7);
    assert.throws(() => median([]));
  });
  it('summarises repetitions as medians per input, of totals and of cold starts', () => {
    const runs = [
      {
        cold: 900,
        inputs: [
          { name: 'a', ms: 10 },
          { name: 'b', ms: 30 },
        ],
      },
      {
        cold: 700,
        inputs: [
          { name: 'a', ms: 20 },
          { name: 'b', ms: 10 },
        ],
      },
      {
        cold: 800,
        inputs: [
          { name: 'a', ms: 30 },
          { name: 'b', ms: 20 },
        ],
      },
    ];
    assert.deepEqual(summarise(runs), { coldMs: 800, totalMs: 40, perInput: { a: 20, b: 20 } });
  });
});
