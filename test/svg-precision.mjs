import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { selectSvg, withinSvgBudget } from '../lib/svg-precision.mjs';
import { score } from './lib/accuracy.mjs';
import { gridSvg } from './fixtures/small-grid.gen.mjs';

const engine = await loadEngine();
const pixels = (rgba) => ({ width: rgba.length / 4, height: 1, rgba: Uint8Array.from(rgba) });
const solid = () => pixels(Array.from({ length: 100 }, () => [128, 128, 128, 255]).flat());
const options = { icon: false, vars: {}, name: 'precision.svg' };
const select = (source, extra = {}, svgOptions = options) => selectSvg(source, svgOptions, {
  initial: optimiseSvg(source, svgOptions), optimiseSvg, renderRgba: engine.renderRgba, ...extra,
});

describe('SVG input diagnostics', () => {
  it('reports parsed text and external image dependencies once without removing them', () => {
    const warnings = [];
    const source = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">'
      + '<text>first</text><text>second</text><image xlink:href="m&#105;ssing.png"/>'
      + '<filter><feImage href="other.png"/></filter></svg>';
    const out = optimiseSvg(source, { reference: true, onWarn: (w) => warnings.push(w) });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /text.*font.*paths/i);
    assert.match(warnings[1], /external image.*embed/i);
    assert.match(out.data, /<text>first<\/text>/);
    assert.match(out.data, /xlink:href="missing.png"/);
    assert.match(out.data, /<feImage href="other.png"/);
  });

  it('ignores comment/CDATA lookalikes, embedded images and fragment references', () => {
    const warnings = [];
    const source = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">'
      + '<!-- <text>fake</text><image href="external.png"/> -->'
      + '<desc><![CDATA[<text>fake</text><image href="external.png"/>]]></desc>'
      + '<image href=" DATA:image/png;base64,AA== "/><image href=" #local "/><image href=""/>'
      + '<image href="#local" xlink:href="ignored.png"/><circle cx="32" cy="32" r="20"/></svg>';
    optimiseSvg(source, { reference: true, onWarn: (w) => warnings.push(w) });
    assert.deepEqual(warnings, []);
  });

  it('rejects unusable root dimensions with guidance before rendering source pixels', async () => {
    for (const attrs of ['', 'width="100%" height="100%"', 'width="0" height="64"',
      'viewBox="0 0 0 64"', 'viewBox="0 0 -1 64"', 'viewBox="0 0 64"',
      'viewBox="NaN 0 64 64"', 'viewBox="0 0 1e309 64"']) {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><circle cx="32" cy="32" r="20"/></svg>`;
      await assert.rejects(select(source, { renderRgba: () => { throw new Error('source renderer reached'); } }),
        /precision\.svg.*viewBox.*width.*height/i);
    }
  });

  it('emits dependency guidance once even when accuracy needs multiple SVG candidates', async () => {
    const warnings = [], precisions = [];
    const source = gridSvg(1).replace('</svg>', '<defs><text>unused font</text><image href="missing.png"/></defs></svg>');
    await selectSvg(source, options, {
      optimiseSvg: (svg, opts) => { if (!opts.reference) precisions.push(opts.precision ?? 1); return optimiseSvg(svg, opts); },
      renderRgba: engine.renderRgba, warn: (w) => warnings.push(w),
    });
    assert.ok(precisions.length > 1, 'fixture must exercise precision retries');
    assert.equal(warnings.filter((w) => /font/i.test(w)).length, 1);
    assert.equal(warnings.filter((w) => /external image/i.test(w)).length, 1);
  });
});

describe('SVG error comparison', () => {
  it('accepts exactly one percent bad pixels, counts values above eight only', () => {
    const ref = solid(), candidate = solid();
    candidate.rgba[0] += 9;
    candidate.rgba[4] += 8;
    assert.equal(withinSvgBudget(candidate, ref), true);
    candidate.rgba[4]++;
    assert.equal(withinSvgBudget(candidate, ref), false);
  });

  it('counts the two composites independently rather than combining their bad pixels', () => {
    const ref = solid(), candidate = solid();
    ref.rgba.set([0, 0, 0, 0, 0, 0, 0, 0]);
    candidate.rgba.set([0, 0, 0, 255, 255, 255, 255, 255]);
    assert.equal(score({ ...candidate, data: candidate.rgba }, { ...ref, data: ref.rgba }).pct, 1);
    assert.equal(withinSvgBudget(candidate, ref), true);
  });

  it('detects alpha errors hidden on a white composite', () => {
    const ref = solid(), candidate = solid();
    ref.rgba.set([255, 255, 255, 255, 255, 255, 255, 255]);
    candidate.rgba.set([255, 255, 255, 127, 255, 255, 255, 127]);
    assert.equal(withinSvgBudget(candidate, ref), false);
  });

  it('rejects disappearance even when the source occupies only one percent', () => {
    const ref = pixels(new Array(400).fill(0)), candidate = pixels(new Array(400).fill(0));
    ref.rgba.set([0, 0, 0, 255]);
    assert.equal(withinSvgBudget(candidate, ref), false);
  });

  it('ignores invisible RGB and rejects incomplete image data', () => {
    assert.equal(withinSvgBudget(pixels([255, 255, 255, 0]), pixels([0, 0, 0, 0])), true);
    assert.throws(() => withinSvgBudget({ width: 1, height: 1, rgba: new Uint8Array(3) }, pixels([0, 0, 0, 0])), /dimensions|RGBA/);
  });
});

describe('bounded SVG precision selection', () => {
  it('tries each precision from the original source and stops at the first pass', async () => {
    const source = gridSvg(1), tried = [];
    const tracked = (input, o) => {
      assert.equal(input, source);
      if (!o.reference) tried.push(o.precision ?? 1);
      return optimiseSvg(input, o);
    };
    const first = tracked(source, options);
    const selected = await select(source, { initial: first, optimiseSvg: tracked });
    assert.deepEqual(tried, [1, 2, 3]);
    const ref = await engine.renderRgba(source, 512);
    assert.ok(score({ ...selected.pixels, data: selected.pixels.rgba }, { ...ref, data: ref.rgba }).pct <= 1);
  });

  it('does not render rounded-zero viewports while finding a usable precision', async () => {
    const selected = await select(gridSvg(.001), { renderRgba: async (svg, px) => {
      assert.doesNotMatch(svg, /viewBox="0 0 0 0"/);
      return engine.renderRgba(svg, px);
    } });
    assert.match(selected.output.data, /viewBox="0 0 0\.001 0\.001"/);
  });

  it('retains tiny marks even when their loss falls below the canvas error allowance', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32.0625" cy="32.0625" r=".04"/></svg>';
    const original = await engine.renderRgba(source, 512);
    assert.ok(original.rgba.some((value, index) => index % 4 === 3 && value > 0), 'fixture must render a visible mark');
    const selected = await select(source);
    assert.ok(selected.pixels.rgba.some((value, index) => index % 4 === 3 && value > 0));
    assert.notEqual(selected.output.data, optimiseSvg(source).data);
  });

  it('falls back to unrounded source geometry and retains styling, motion, references and variables', async () => {
    const source = gridSvg(1e-12).replace('<circle ', '<title id="label">Tiny</title><style>.mark{fill:var(--tone,#17365d);animation:pulse 1s}@keyframes pulse{to{opacity:.5}}</style><circle class="mark" ')
      .replace('viewBox=', 'role="img" aria-labelledby="label" viewBox=');
    const warnings = [], svgOptions = { ...options, vars: { tone: '#112233' } };
    const selected = await select(source, { warn: (warning) => warnings.push(warning) }, svgOptions);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /preserv.*source|source.*geometr/i);
    assert.match(selected.output.data, /1e-12/);
    assert.match(selected.output.data, /aria-labelledby="label"/);
    assert.match(selected.output.data, /id="label"/);
    assert.match(selected.output.data, /@keyframes/);
    assert.match(selected.output.data, /#112233/);
    assert.equal(selected.output.animated, true);
    assert.doesNotMatch(selected.output.data, /var\(/);
    const still = await select(source, {}, { ...svgOptions, icon: true });
    assert.doesNotMatch(still.output.data, /@keyframes|aria-labelledby|role="img"/);
    assert.doesNotMatch(still.output.data, /<title|<desc/);
    assert.equal(still.output.animated, false);
  });

  it('preserves magnified tiny coordinates when all rounded candidates erase the mark', async () => {
    const source = gridSvg(1e-12).replace('viewBox="0 0 1e-12 1e-12">', 'viewBox="0 0 512 512"><g transform="scale(512000000000000)">')
      .replace('</svg>', '</g></svg>');
    const warnings = [], selected = await select(source, { warn: (warning) => warnings.push(warning) });
    assert.equal(warnings.length, 1);
    assert.match(selected.output.data, /scale\(512000000000000\)/);
    const reference = await engine.renderRgba(source, 512);
    assert.equal(score({ ...selected.pixels, data: selected.pixels.rgba }, { ...reference, data: reference.rgba }).pct, 0);
  });

  it('prepares exact viewBoxes for sources that only declare dimensions', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="24.014" height="24.014"><circle cx="12.007" cy="12.007" r="10.456"/></svg>';
    const prepared = optimiseSvg(source, { reference: true });
    assert.match(prepared.data, /viewBox="0 0 24\.014 24\.014"/);
    const selected = await select(source);
    assert.ok(selected.pixels.rgba.some((value, index) => index % 4 === 3 && value > 0));
  });

  it('supports pixel and physical root dimensions without rounding source geometry', async () => {
    for (const [width, height, box] of [['24.014px', '24.014px', '0 0 24.014 24.014'], ['1in', '72pt', '0 0 96 96']]) {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="12.007" cy="12.007" r="10.456"/></svg>`;
      const prepared = optimiseSvg(source, { reference: true });
      assert.ok(prepared.data.includes(`viewBox="${box}"`));
      assert.match(prepared.data, /r="10\.456"/);
      const selected = await select(source);
      assert.ok(selected.pixels.rgba.some((value, index) => index % 4 === 3 && value > 0));
    }
  });

  it('keeps nested SVG viewports out of reference preparation', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><svg width="32" height="32" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/></svg></svg>';
    const prepared = optimiseSvg(source, { reference: true });
    const image = await engine.renderRgba(prepared.data, 512), original = await engine.renderRgba(source, 512);
    assert.equal(score({ ...image, data: image.rgba }, { ...original, data: original.rgba }).pct, 0);
    const selected = await select(source);
    assert.equal(score({ ...selected.pixels, data: selected.pixels.rgba }, { ...original, data: original.rgba }).pct, 0);
  });

  it('accepts document comments and processing instructions in selection and source fallback', async () => {
    for (const size of [64, 1e-12]) {
      const source = gridSvg(size);
      const annotated = `<!-- exported <svg> --><?export metadata?>${source}<!-- exported logo --><?export done?>`;
      const plain = await select(source), selected = await select(annotated);
      assert.equal(selected.output.data, plain.output.data);
      assert.deepEqual(selected.pixels, plain.pixels);
    }
  });

  it('propagates renderer failures instead of silently falling back', async () => {
    const error = new RangeError('renderer memory failure');
    await assert.rejects(select(gridSvg(1), { renderRgba: async () => { throw error; } }), (caught) => caught === error);
  });
});
