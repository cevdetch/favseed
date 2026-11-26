import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  builtByAll,
  classify,
  determinismOf,
  favseedMisses,
  formatResults,
  groupSummary,
  headToHead,
  likePassesOnCommon,
  median,
  outcomeKey,
  passCounts,
  passedBoth,
  rendererAgreement,
  scoreSize,
  setDigest,
  speedAgainst,
  startupImages,
  summarise,
} from '../bench/compare/lib.mjs';
import { renderReadme } from '../bench/compare/readme.mjs';

const bytes = (text) => new TextEncoder().encode(text);
// A committed text file with LF line endings, which a Windows checkout with autocrlf turns into CRLF.
const committed = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

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
    assert.deepEqual(summarise(runs), {
      coldMs: 800,
      totalMs: 40,
      repsTotalMs: [30, 40, 50],
      repsColdMs: [700, 800, 900],
      perInput: { a: 20, b: 20 },
    });
  });
});

const files = (n, raster) => ({ ...entry(raster), files: n });
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
    assert.deepEqual(s.tools.x.repsTotalMs, [5]);
    assert.match(s.scope, /common/);
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
  it('counts files over the common inputs at the top level and over its own under own', () => {
    const counted = [
      { name: 'a', usesVar: false, tools: { x: files(5, 1), y: files(7, 1) } },
      { name: 'b', usesVar: false, tools: { x: files(9, 1), y: { error: 'no', like: { error: 'no' } } } },
    ];
    const s = groupSummary(counted, runs, ['x', 'y'], [192, 512]);
    assert.deepEqual(s.tools.x.files, { min: 5, max: 5 });
    assert.deepEqual(s.tools.x.own.files, { min: 5, max: 9 });
    assert.deepEqual(s.tools.y.own.files, { min: 7, max: 7 });
  });
});

const img = { width: 1, height: 1 };
const score = (_, ref) => ({ pct: ref.pct, edge: 0, pass: ref.pct <= 1 });

describe('bench compare scoring', () => {
  it('scores a candidate against every reference', () => {
    const { like: scored, referenceErrors } = scoreSize({
      candidate: (into) => ((into.bytes = 3), img),
      references: { resvg: () => ({ pct: 0.5 }), sharp: () => ({ pct: 2 }) },
      score,
    });
    assert.deepEqual(scored, {
      bytes: 3,
      resvg: { pct: 0.5, edge: 0, pass: true },
      sharp: { pct: 2, edge: 0, pass: false },
    });
    assert.deepEqual(referenceErrors, {});
  });
  it('leaves a score null for a reference that does not exist or cannot be read, never the candidate', () => {
    const { like: scored, referenceErrors } = scoreSize({
      candidate: () => img,
      references: {
        resvg: () => null,
        sharp: () => {
          throw new Error('ENOENT');
        },
      },
      score,
    });
    assert.deepEqual(scored, { resvg: null, sharp: null });
    assert.equal(scored.error, undefined);
    assert.deepEqual(referenceErrors, { sharp: 'ENOENT' });
  });
  it("records a candidate it cannot decode as the tool's error, keeping what it read", () => {
    const { like: scored } = scoreSize({
      candidate: (into) => {
        into.bytes = 9;
        throw new Error('100x100, not 192x192');
      },
      references: { resvg: () => ({ pct: 0 }) },
      score,
    });
    assert.deepEqual(scored, { bytes: 9, error: '100x100, not 192x192' });
  });
});

describe('bench compare determinism and renderers', () => {
  it('keys a failed build by its failure alone, so a reworded libvips message is not a byte change', () => {
    assert.equal(outcomeKey({ error: 'Input buffer has corrupt header: svgload_buffer: bad dimensions' }), 'error');
    assert.equal(outcomeKey({ error: 'Input buffer has corrupt header:' }), 'error');
    assert.equal(outcomeKey({ digest: 'abc' }), 'abc');
  });
  it('counts the inputs where the two references agree at every size', () => {
    const agreeing = [
      { name: 'a', renderers: { 192: ok, 512: ok } },
      { name: 'b', renderers: { 192: ok, 512: bad } },
      { name: 'c', renderers: { 192: ok } },
      { name: 'd' },
    ];
    assert.deepEqual(rendererAgreement(agreeing, [192, 512]), { scored: 2, agree: 1 });
  });
});

describe('bench compare README', () => {
  it('is the committed results rendered by readme.mjs, so neither drifts from the other', () => {
    const results = JSON.parse(committed('../bench/compare/results.json'));
    assert.equal(
      renderReadme(results),
      committed('../bench/compare/README.md'),
      'run node bench/compare/run.mjs --readme',
    );
  });
});

const rep = (inputs, repeatsMatch = true) => ({ repeatsMatch, inputs });
const timed = (x, y) => ({ tools: { x: { ms: x }, y: { ms: y } } });
const pair = (resvg, sharp) => ({ like: { 192: { resvg, sharp }, 512: { resvg, sharp } } });
const group = (inputs, x, y) => ({ common: { inputs }, tools: { x: { totalMs: x }, y: { totalMs: y } } });
// One input with favseed's 192 px PNG scored against resvg and by its own build, and no 512 px score.
const favseedRow = (corpus, resvg, self) => ({
  corpus,
  tools: { favseed: { like: { 192: { resvg, self }, 512: {} } } },
});

describe('bench compare determinism, speed and both references', () => {
  it('flags a success that turns into a failure and two different digests, never a reworded failure', () => {
    const reps = {
      flip: [rep([{ name: 'a', digest: 'x' }]), rep([{ name: 'a', error: 'bad dimensions' }])],
      bytes: [rep([{ name: 'a', digest: 'x' }]), rep([{ name: 'a', digest: 'y' }])],
      reworded: [rep([{ name: 'a', error: 'bad dimensions' }]), rep([{ name: 'a', error: 'corrupt header:' }])],
      repeat: [rep([{ name: 'a', digest: 'x' }], false)],
    };
    const d = determinismOf(reps, Object.keys(reps), ['a']);
    assert.deepEqual(d.flip, { deterministic: false, differing: ['a'], repeatsMatch: true });
    assert.deepEqual(d.bytes, { deterministic: false, differing: ['a'], repeatsMatch: true });
    assert.deepEqual(d.reworded, { deterministic: true, differing: [], repeatsMatch: true });
    assert.deepEqual(d.repeat, { deterministic: false, differing: [], repeatsMatch: false });
  });
  it('compares two tools input by input, counting wins and the median input', () => {
    const h = headToHead(
      [timed(1, 5), timed(2, 5), timed(30, 5), timed(4, 4), { tools: { x: { ms: 1 }, y: { error: 'no' } } }],
      'x',
      'y',
    );
    assert.deepEqual(h, { inputs: 4, aFaster: 2, bFaster: 1, aMedian: 3, bMedian: 5 });
  });
  it('states the mean, the head-to-head and each corpus where the mean goes the other way', () => {
    const results = {
      summary: {
        all: { ...group(3, 30, 60), common: { inputs: 3, excluded: ['z'] } },
        fixtures: group(1, 20, 10),
        open: group(2, 10, 50),
      },
      inputs: [timed(20, 10), timed(5, 25), timed(5, 25), { name: 'z', ...timed(1, 1) }].map((row, i) => ({
        name: row.name ?? `i${i}`,
        ...row,
      })),
    };
    const s = speedAgainst(results, 'x', 'y');
    assert.deepEqual(s.mean, [10, 20]);
    assert.deepEqual([s.inputs, s.aFaster, s.bFaster, s.aMedian, s.bMedian], [3, 2, 1, 5, 25]);
    assert.deepEqual(s.flips, [{ group: 'fixtures', a: 20, b: 10 }]);
  });
  it("counts favseed's misses against resvg and the ones its own build kept at quality 80", () => {
    const scored = [
      favseedRow('fixtures', { pass: true, pct: 0.1 }, { pass: true, quality: 100 }),
      favseedRow('open', { pass: false, pct: 0.5 }, { pass: false, quality: 80 }),
      favseedRow('open', { pass: false, pct: 2 }, { pass: true, quality: 90 }),
      favseedRow('open', null, { pass: true, quality: 90 }),
    ];
    assert.deepEqual(favseedMisses(scored, 1), {
      scored: 3,
      missed: 2,
      fixtures: 0,
      open: 2,
      edgeOnly: 1,
      kept: 1,
      agree: 2,
    });
  });
  it('counts the pairs that pass against both references where the references disagree', () => {
    const disagreeing = [
      { name: 'a', renderers: { 192: ok, 512: bad }, tools: { x: pair(ok, ok), y: pair(ok, bad) } },
      { name: 'b', renderers: { 192: ok, 512: ok }, tools: { x: pair(ok, ok), y: pair(ok, ok) } },
      {
        name: 'c',
        renderers: { 192: bad, 512: bad },
        tools: { x: pair(bad, ok), y: { error: 'no', like: { error: 'no' } } },
      },
    ];
    assert.deepEqual(passedBoth(disagreeing, ['x', 'y'], [192, 512]), { inputs: 2, pairs: 3, passed: ['a:x'] });
  });
  it('counts passes over the inputs every tool built a pair for, leaving out the ones only some built', () => {
    const results = {
      summary: { all: { likeCommon: { excluded: ['c'] } } },
      inputs: [
        { name: 'a', tools: { x: pair(ok, bad) } },
        { name: 'b', tools: { x: pair(bad, ok) } },
        { name: 'c', tools: { x: pair(ok, ok) } },
      ],
    };
    assert.deepEqual(likePassesOnCommon(results, 'x', 'resvg'), { scored: 2, pass: 1 });
    assert.deepEqual(likePassesOnCommon(results, 'x', 'sharp'), { scored: 2, pass: 1 });
  });
  it('counts Apple startup images and their longest side from the file names', () => {
    const names = [
      'apple-touch-icon.png',
      'apple-touch-startup-image-640x1136.png',
      'apple-touch-startup-image-2796x1290.png',
    ];
    assert.deepEqual(startupImages(names), { count: 2, longest: 2796 });
    assert.deepEqual(startupImages(['icon.svg']), { count: 0, longest: 0 });
  });
  it('writes results.json with one compact line per input and survives a round trip', () => {
    const results = { generated: 'now', summary: { all: { inputs: 2 } }, inputs: [{ name: 'a' }, { name: 'b' }] };
    const text = formatResults(results);
    assert.deepEqual(JSON.parse(text), results);
    assert.match(text, /\n {4}\{"name":"a"\},\n {4}\{"name":"b"\}\n {2}\]\n\}\n$/);
  });
});
