// buildSet on its own: the file set, the order and the determinism, with nothing written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { decode, header } from './lib/png.mjs';
import { score } from './lib/accuracy.mjs';
import { gridSvg } from './fixtures/small-grid.gen.mjs';
import { framingCases } from './lib/framing.mjs';

const read = (n) => readFileSync(new URL(`./fixtures/${n}.svg`, import.meta.url), 'utf8');
const engine = await loadEngine();
const opts = ({ iterations = 0, ...extra } = {}) => ({ ...normaliseOptions({ sizes: [32], ...extra }), iterations });
const run = (name, extra) => buildSet(read(name), opts(extra), { engine, optimiseSvg, name: `${name}.svg` });
const rendered = async (svg) => {
  const { width, height, rgba } = await engine.renderRgba(svg, 512);
  return { width, height, data: rgba };
};

describe('selective SVG precision', () => {
  for (const size of [1, 16, 24, .001]) {
    it(`keeps the ${size}-unit mark within the source SVG error budget`, async () => {
      const source = gridSvg(size);
      const set = await buildSet(source, opts({ padding: 20 }), { engine, optimiseSvg });
      const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
      const error = score(await rendered(icon), await rendered(source));
      assert.ok(error.pct <= 1, `SVG source error ${error.pct}% exceeds 1%`);
    });
  }

  it('keeps gradient stop rounding within the SVG error budget', async () => {
    const source = read('gradient'), set = await run('gradient', { padding: 20 });
    const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
    assert.ok(score(await rendered(icon), await rendered(source)).pct <= 1);
  });

  it('retains the compact p1 output for already-accurate marks', async () => {
    for (const mark of ['general', 'heavy']) {
      const set = await run(mark, { padding: 20 });
      const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
      assert.equal(icon, optimiseSvg(read(mark)).data);
    }
  });

  it('prepares an unrounded reference with resolved variables and requested motion', async () => {
    const source = read('gradient').replace('#E9873F', 'var(--accent, #E9873F)');
    const prepared = optimiseSvg(source, { reference: true, vars: { accent: '#112233' } });
    assert.match(prepared.data, /offset="\.42"/);
    assert.match(prepared.data, /offset="\.78"/);
    assert.match(prepared.data, /#112233/);
    assert.doesNotMatch(prepared.data, /var\(/);
    assert.match(optimiseSvg(read('animated'), { reference: true }).data, /@keyframes/);
    assert.doesNotMatch(optimiseSvg(read('animated'), { reference: true, icon: true }).data, /@keyframes/);
  });
});

describe('proportions in exported rasters', () => {
  for (const { mark, golden } of framingCases) {
    it(`${mark}: transparent PNG and ICO preserve the original shape`, async () => {
      const set = await run(mark, { bg: 'none', sizes: [32, 128], padding: 0 });
      for (const file of set.files.filter((file) => /\.(png|ico)$/.test(file.name))) {
        const actual = decode(Buffer.from(file.name.endsWith('.ico') ? file.bytes.subarray(22) : file.bytes));
        const expected = decode(Buffer.from(await engine.render(golden, actual.width)));
        assert.ok(score(actual, expected).pct <= 1, file.name + ' distorts the source');
      }
      assert.equal(new TextDecoder().decode(set.files[0].bytes), optimiseSvg(read(mark)).data);
    });
  }
});

describe('buildSet', () => {
  it('shares an unpadded48px PNG with the ICO while preserving an explicit32px PNG', async () => {
    const renderedSizes = [];
    const set = await buildSet(read('general'), opts({ bg: 'none', sizes: [32, 48], padding: 0 }), {
      optimiseSvg, engine: { ...engine, render: async (...args) => {
        renderedSizes.push(args[1]); return engine.render(...args);
      } },
    });
    const file = (name) => set.files.find((f) => f.name === name).bytes;
    const ico = file('favicon.ico'), png32 = file('icon-32.png');
    assert.deepEqual([...ico.subarray(6, 8)], [48, 48]);
    assert.deepEqual(file('icon-48.png'), ico.subarray(22));
    assert.deepEqual([header(Buffer.from(png32)).width, header(Buffer.from(png32)).height], [32, 32]);
    assert.deepEqual(renderedSizes.toSorted((a, b) => a - b), [32, 48, 180]);
  });

  it('renders padded48px output separately from the unpadded48px ICO', async () => {
    const renderedSizes = [];
    const set = await buildSet(read('general'), opts({ sizes: [48], padding: 20 }), {
      optimiseSvg, engine: { ...engine, render: async (...args) => {
        renderedSizes.push(args[1]); return engine.render(...args);
      } },
    });
    const ico = set.files.find((f) => f.name === 'favicon.ico').bytes;
    const png = set.files.find((f) => f.name === 'icon-48.png').bytes;
    assert.deepEqual([...ico.subarray(6, 8)], [48, 48]);
    assert.notDeepEqual(png, ico.subarray(22));
    assert.equal(renderedSizes.filter((size) => size === 48).length, 2);
  });

  it('returns the set in the CLI order, as bytes', async () => {
    const set = await run('general', { manifest: true });
    assert.deepEqual(set.files.map((f) => f.name),
      ['icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-32.png', 'site.webmanifest']);
    for (const f of set.files) assert.ok(f.bytes instanceof Uint8Array && f.bytes.length > 0, f.name);
    assert.equal(header(Buffer.from(set.files[2].bytes)).width, 180);
  });

  it('gives the same bytes twice', async () => {
    const a = await run('heavy', { iterations: 15 }), b = await run('heavy', { iterations: 15 });
    assert.deepEqual(a.files.map((f) => [...f.bytes]), b.files.map((f) => [...f.bytes]));
  });

  it('default quality 80 matches its explicit setting and quality 100 restores higher fidelity', async () => {
    const defaults = await run('gradient'), full = await run('gradient', { quality: 100 }), low = await run('gradient', { quality: 80 });
    assert.deepEqual(low, defaults);
    assert.deepEqual(low.fit, full.fit);
    assert.deepEqual(low.files.find((f) => f.name === 'icon.svg'), full.files.find((f) => f.name === 'icon.svg'));
    const pixels = (set) => set.files.find((f) => f.name === 'apple-touch-icon.png').bytes;
    assert.ok(pixels(low).length < pixels(full).length);
    assert.notDeepEqual(pixels(low), pixels(full));
  });

  it('emits one SVG preserving motion, style references and accessibility', async () => {
    const set = await run('animated');
    assert.equal(set.animated, true);
    assert.deepEqual(set.files.filter((f) => f.name.endsWith('.svg')).map((f) => f.name), ['icon.svg']);
    const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
    assert.match(icon, /@keyframes/);
    assert.match(icon, /prefers-reduced-motion/);
    assert.match(icon, /class="ring"/);
    assert.match(icon, /aria-label="Animated fixture"/);
    const still = await run('animated', { animation: false });
    assert.equal(still.animated, false);
    assert.doesNotMatch(new TextDecoder().decode(still.files.find((f) => f.name === 'icon.svg').bytes), /@keyframes|animation:/);
  });

  it('optimizes an already-accurate SVG once and leaves its non-square viewBox intact', async () => {
    let calls = 0;
    const set = await buildSet(read('wide'), opts(), { engine, optimiseSvg: (...args) => {
      if (!args[1]?.reference) calls++;
      return optimiseSvg(...args);
    } });
    assert.equal(calls, 1);
    const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
    assert.match(icon, /viewBox="0 0 128 64"/);
    assert.doesNotMatch(icon, /preserveAspectRatio="none"/);
  });

  it('rejects input that is not an SVG', async () => {
    await assert.rejects(buildSet('hello', opts(), { engine, optimiseSvg, name: 'x.txt' }),
      /not an SVG \(no <svg> element found\): x\.txt/);
  });

  it('rejects a translucent ground before rendering anything', async () => {
    await assert.rejects(run('flat', { bg: '#ffffff80' }), /--bg must be opaque/);
  });

  it('overlaps default raster jobs within four slots and keeps large jobs serial', async () => {
    for (const [sizes, concurrent] of [[[192, 512], true], [[1024], false]]) {
      let active = 0, peak = 0;
      const counted = { ...engine,
        render: async (...args) => {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return engine.render(...args);
        },
        finish: async (...args) => { const out = await engine.finish(...args); active--; return out; },
      };
      const set = await buildSet(read('tiles'), opts({ sizes, padding: 20 }), { engine: counted, optimiseSvg });
      assert.equal(active, 0);
      assert.ok(peak <= 4);
      assert.equal(peak > 1, concurrent);
      assert.equal(set.files.filter((f) => f.name.endsWith('.png')).length, sizes.length + 1);
    }
  });

  it('drains sibling raster jobs before reporting a failed batch', async () => {
    const finished = [];
    const failing = { ...engine,
      render: async (svg, px, bg) => {
        if (px === 180) throw new Error('raster failed');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return engine.render(svg, px, bg);
      },
      finish: async (png, options) => {
        const out = await engine.finish(png, options);
        finished.push(new DataView(png.buffer, png.byteOffset).getUint32(16));
        return out;
      },
    };
    await assert.rejects(buildSet(read('tiles'), opts({ sizes: [192, 512], padding: 20 }),
      { engine: failing, optimiseSvg }), /raster failed/);
    assert.deepEqual(finished.sort((a, b) => a - b), [48, 192, 512]);
  });

  it('reuses transparent placement renders and reports completed raster jobs', async () => {
    const calls = new Map(), events = [];
    const counted = { ...engine, renderRgba: async (svg, px) => {
      const key = `${svg}\0${px}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return engine.renderRgba(svg, px);
    } };
    const options = opts({ sizes: [180, 192] });
    const actual = await buildSet(read('general'), options,
      { engine: counted, optimiseSvg, progress: (event) => events.push(event) });
    assert.ok([...calls.values()].every((n) => n === 1), 'each placement render is reused');
    assert.equal(events[0].phase, 'placement');
    assert.deepEqual(events.at(-1), { phase: 'complete', completed: 3, total: 3 });
    assert.deepEqual(events.filter((e) => e.phase === 'raster').map((e) => e.completed), [0, 1, 2, 3]);
    const expected = await buildSet(read('general'), options, { engine, optimiseSvg });
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.files[2].bytes, actual.files[3].bytes, '180px alias matches apple');
  });

  it('reuses moderate-margin probes across output sizes', async () => {
    let calls = 0;
    await buildSet(read('flat'), opts({ sizes: [192, 512], manifest: true }), {
      optimiseSvg, engine: { ...engine, renderRgba: (...args) => {
        calls++; return engine.renderRgba(...args);
      } },
    });
    // The calibrated PR30 build uses59 callbacks, including SVG validation.
    // Wrapping every oversized probe loses shared180/192px work and needs64.
    assert.ok(calls <= 59, `${calls} callbacks: shared placement renders were lost`);
  });
});
