import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { builtByAll, classify, groupSummary, median, passCounts, setDigest, summarise } from '../bench/compare/lib.mjs';

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

// Rows as run.mjs builds them: one per input, one entry per tool.
const like = (size, resvg, sharp) => ({ bytes: size, resvg, sharp });
const ok = { pct: 0, edge: 0, pass: true },
  bad = { pct: 2, edge: 3, pass: false };
const entry = (raster, likeEntry = { 192: like(10, ok, ok), 512: like(20, ok, ok) }) => ({
  files: 2,
  rasterBytes: raster,
  svgBytes: 1,
  otherBytes: 0,
  like: likeEntry,
});
const rows = [
  { name: 'a', usesVar: false, tools: { x: entry(100), y: entry(10) } },
  {
    name: 'b',
    usesVar: true,
    tools: {
      x: entry(200, { 192: like(10, bad, ok), 512: like(20, ok, ok) }),
      y: { error: 'bad dimensions', like: { error: 'bad dimensions' } },
    },
  },
  {
    name: 'c',
    usesVar: false,
    tools: { x: entry(300, { 192: like(10, null, ok), 512: like(20, null, ok) }), y: entry(30) },
  },
];
const runs = {
  x: [
    {
      cold: 50,
      inputs: [
        { name: 'a', ms: 1 },
        { name: 'b', ms: 2 },
        { name: 'c', ms: 4 },
      ],
    },
  ],
  y: [
    {
      cold: 60,
      inputs: [
        { name: 'a', ms: 10 },
        { name: 'b', ms: 0.5 },
        { name: 'c', ms: 30 },
      ],
    },
  ],
};

describe('bench compare totals', () => {
  it('totals bytes and time over the inputs every tool built, and lists the rest', () => {
    const s = groupSummary(rows, runs, ['x', 'y'], [192, 512]);
    assert.deepEqual(s.common, { inputs: 2, excluded: ['b'] });
    assert.equal(s.tools.x.rasterBytes, 400);
    assert.equal(s.tools.y.rasterBytes, 40);
    assert.equal(s.tools.x.totalMs, 5);
    assert.equal(s.tools.y.totalMs, 40);
    assert.deepEqual(s.tools.y.failed, ['b']);
    assert.deepEqual(s.tools.x.failed, []);
    // Each tool's own totals stay available, named as such.
    assert.equal(s.tools.x.own.rasterBytes, 600);
    assert.equal(s.tools.x.own.totalMs, 7);
    assert.equal(s.tools.y.own.totalMs, 40);
    assert.deepEqual(s.likeCommon, { inputs: 2, excluded: ['b'] });
    assert.deepEqual(s.tools.x.like.bytes, { 192: 20, 512: 40 });
  });
  it('counts passes per reference over the inputs that reference and the candidate both exist for', () => {
    assert.deepEqual(passCounts(rows, 'x', [192, 512], 'resvg'), { scored: 2, pass: 1 });
    assert.deepEqual(passCounts(rows, 'x', [192, 512], 'sharp'), { scored: 3, pass: 3 });
    assert.deepEqual(passCounts(rows, 'y', [192, 512], 'sharp'), { scored: 2, pass: 2 });
    const s = groupSummary(rows, runs, ['x', 'y'], [192, 512]);
    assert.deepEqual(s.tools.x.like.withoutVar.resvg, { scored: 1, pass: 1 });
  });
  it('finds the inputs every tool built', () => {
    assert.deepEqual(
      builtByAll(rows, ['x', 'y']).map((r) => r.name),
      ['a', 'c'],
    );
  });
});
