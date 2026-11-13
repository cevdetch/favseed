// buildSet on its own: the file set, the order and the determinism, with nothing written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { EFFORT_ITERATIONS, maskableFit, MASK_SAFE_RADIUS } from '../lib/core.mjs';
import { decode, header } from './lib/png.mjs';
import { reference as suiteReference, score } from './lib/accuracy.mjs';
import { passesBar } from '../lib/quality.mjs';
import { gridSvg } from './fixtures/small-grid.gen.mjs';
import { framingCases } from './lib/framing.mjs';

const read = (n) => readFileSync(new URL(`./fixtures/${n}.svg`, import.meta.url), 'utf8');
const engine = await loadEngine();
// Effort 'fast' and no Zopfli unless a test asks: most tests here are about the set, not the
// search, and zero iterations leave finish() returning the search's own bytes.
const opts = ({ iterations = 0, effort = 'fast', ...extra } = {}) => ({
  ...normaliseOptions({ sizes: [32], effort, ...extra }),
  iterations,
});
const run = (name, extra) => buildSet(read(name), opts(extra), { engine, optimiseSvg, name: `${name}.svg` });
const rendered = async (svg) => {
  const { width, height, rgba } = await engine.renderRgba(svg, 512);
  return { width, height, data: rgba };
};

describe('opaque extent', () => {
  it('measures outer pixel corners, including sparse rows and odd rectangular canvases', () => {
    for (const [width, height, points] of [
      [
        7,
        5,
        [
          [1, 0],
          [5, 1],
          [3, 4],
        ],
      ],
      [
        6,
        8,
        [
          [2, 1],
          [0, 5],
          [5, 6],
        ],
      ],
      [5, 3, [[2, 1]]],
      [1, 1, [[0, 0]]],
      [
        4,
        4,
        [
          [0, 0],
          [3, 0],
          [0, 3],
          [3, 3],
        ],
      ],
    ]) {
      const rgba = new Uint8Array(width * height * 4);
      for (const [x, y] of points) rgba[(y * width + x) * 4 + 3] = 1; // Any visible alpha counts.
      const distance2 = points.flatMap(([x, y]) =>
        [0, 1].flatMap((dx) => [0, 1].map((dy) => (x + dx - width / 2) ** 2 + (y + dy - height / 2) ** 2)),
      );
      const radius = Math.sqrt(Math.max(...distance2)) / width;
      const fullBleed = [
        [0, 0],
        [width - 1, 0],
        [0, height - 1],
        [width - 1, height - 1],
      ].every(([x, y]) => points.some(([px, py]) => x === px && y === py));
      assert.deepEqual(maskableFit({ width, height, rgba }), {
        radius,
        fullBleed,
        scale: fullBleed ? 1 : MASK_SAFE_RADIUS / radius,
      });
    }
  });

  it('rejects an entirely transparent canvas', () => {
    assert.throws(() => maskableFit({ width: 7, height: 5, rgba: new Uint8Array(7 * 5 * 4) }), /renders nothing/);
  });
});

describe('selective SVG precision', () => {
  for (const size of [1, 16, 24, 0.001]) {
    it(`keeps the ${size}-unit mark within the source SVG error budget`, async () => {
      const source = gridSvg(size);
      const set = await buildSet(source, opts({ padding: 20 }), { engine, optimiseSvg });
      const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
      const error = score(await rendered(icon), await rendered(source));
      assert.ok(error.pct <= 1, `SVG source error ${error.pct}% exceeds 1%`);
    });
  }

  it('keeps gradient stop rounding within the SVG error budget', async () => {
    const source = read('gradient'),
      set = await run('gradient', { padding: 20 });
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
      optimiseSvg,
      engine: {
        ...engine,
        render: async (...args) => {
          renderedSizes.push(args[1]);
          return engine.render(...args);
        },
      },
    });
    const file = (name) => set.files.find((f) => f.name === name).bytes;
    const ico = file('favicon.ico'),
      png32 = file('icon-32.png');
    assert.deepEqual([...ico.subarray(6, 8)], [48, 48]);
    assert.deepEqual(file('icon-48.png'), ico.subarray(22));
    assert.deepEqual([header(Buffer.from(png32)).width, header(Buffer.from(png32)).height], [32, 32]);
    assert.deepEqual(
      renderedSizes.toSorted((a, b) => a - b),
      [32, 48, 180],
    );
  });

  it('renders padded48px output separately from the unpadded48px ICO', async () => {
    const renderedSizes = [];
    const set = await buildSet(read('general'), opts({ sizes: [48], padding: 20 }), {
      optimiseSvg,
      engine: {
        ...engine,
        render: async (...args) => {
          renderedSizes.push(args[1]);
          return engine.render(...args);
        },
      },
    });
    const ico = set.files.find((f) => f.name === 'favicon.ico').bytes;
    const png = set.files.find((f) => f.name === 'icon-48.png').bytes;
    assert.deepEqual([...ico.subarray(6, 8)], [48, 48]);
    assert.notDeepEqual(png, ico.subarray(22));
    assert.equal(renderedSizes.filter((size) => size === 48).length, 2);
  });

  it('returns the set in the CLI order, as bytes', async () => {
    const set = await run('general', { manifest: true });
    assert.deepEqual(
      set.files.map((f) => f.name),
      ['icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-32.png', 'site.webmanifest'],
    );
    for (const f of set.files) assert.ok(f.bytes instanceof Uint8Array && f.bytes.length > 0, f.name);
    assert.equal(header(Buffer.from(set.files[2].bytes)).width, 180);
  });

  it('gives the same bytes twice', async () => {
    const a = await run('heavy', { iterations: 15 }),
      b = await run('heavy', { iterations: 15 });
    assert.deepEqual(
      a.files.map((f) => [...f.bytes]),
      b.files.map((f) => [...f.bytes]),
    );
  });

  it("effort 'fast' encodes as a pinned quality 80 does, and quality 100 restores higher fidelity", async () => {
    const defaults = await run('gradient'),
      full = await run('gradient', { quality: 100 }),
      low = await run('gradient', { quality: 80 });
    // The same bytes; only the pin is scored against the bar.
    const { quality: scored, ...pinned } = low,
      { quality: unscored, ...fast } = defaults;
    assert.deepEqual(pinned, fast);
    for (const [file, q] of Object.entries(scored)) {
      assert.deepEqual(q.setting, unscored[file].setting, file);
      assert.equal(unscored[file].pass, null, file);
      assert.equal(typeof q.pass, 'boolean', file);
    }
    assert.deepEqual(low.fit, full.fit);
    assert.deepEqual(
      low.files.find((f) => f.name === 'icon.svg'),
      full.files.find((f) => f.name === 'icon.svg'),
    );
    const pixels = (set) => set.files.find((f) => f.name === 'apple-touch-icon.png').bytes;
    assert.ok(pixels(low).length < pixels(full).length);
    assert.notDeepEqual(pixels(low), pixels(full));
  });

  it('emits one SVG preserving motion, style references and accessibility', async () => {
    const set = await run('animated');
    assert.equal(set.animated, true);
    assert.deepEqual(
      set.files.filter((f) => f.name.endsWith('.svg')).map((f) => f.name),
      ['icon.svg'],
    );
    const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
    assert.match(icon, /@keyframes/);
    assert.match(icon, /prefers-reduced-motion/);
    assert.match(icon, /class="ring"/);
    assert.match(icon, /aria-label="Animated fixture"/);
    const still = await run('animated', { animation: false });
    assert.equal(still.animated, false);
    assert.doesNotMatch(
      new TextDecoder().decode(still.files.find((f) => f.name === 'icon.svg').bytes),
      /@keyframes|animation:/,
    );
  });

  it('optimizes an already-accurate SVG once and leaves its non-square viewBox intact', async () => {
    let calls = 0;
    const set = await buildSet(read('wide'), opts(), {
      engine,
      optimiseSvg: (...args) => {
        if (!args[1]?.reference) calls++;
        return optimiseSvg(...args);
      },
    });
    assert.equal(calls, 1);
    const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
    assert.match(icon, /viewBox="0 0 128 64"/);
    assert.doesNotMatch(icon, /preserveAspectRatio="none"/);
  });

  it('rejects input that is not an SVG', async () => {
    await assert.rejects(
      buildSet('hello', opts(), { engine, optimiseSvg, name: 'x.txt' }),
      /not an SVG \(no <svg> element found\): x\.txt/,
    );
  });

  it('rejects a translucent ground before rendering anything', async () => {
    await assert.rejects(run('flat', { bg: '#ffffff80' }), /--bg must be opaque/);
  });

  it('overlaps default raster jobs within four slots and keeps large jobs serial', async () => {
    for (const [sizes, concurrent] of [
      [[192, 512], true],
      [[1024], false],
    ]) {
      let active = 0,
        peak = 0;
      const counted = {
        ...engine,
        render: async (...args) => {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return engine.render(...args);
        },
        finish: async (...args) => {
          const out = await engine.finish(...args);
          active--;
          return out;
        },
      };
      const set = await buildSet(read('tiles'), opts({ sizes, padding: 20 }), { engine: counted, optimiseSvg });
      assert.equal(active, 0);
      assert.ok(peak <= 4);
      assert.equal(peak > 1, concurrent);
      assert.equal(set.files.filter((f) => f.name.endsWith('.png')).length, sizes.length + 1);
    }
  });

  it("counts a gated job's reference memory against the batch budget", async () => {
    const peakFor = async (extra) => {
      let active = 0,
        peak = 0;
      const counted = {
        ...engine,
        render: async (...args) => {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return engine.render(...args);
        },
        finish: async (...args) => {
          const out = await engine.finish(...args);
          active--;
          return out;
        },
      };
      await buildSet(read('tiles'), opts({ sizes: [192, 512], padding: 20, ...extra }), {
        engine: counted,
        optimiseSvg,
      });
      return peak;
    };
    // Ungated, the four jobs' canvases fit one batch. Gated, the 512 px job's 46 B/px of
    // reference (12 MB) leaves room for one sibling in each batch of the 16 MB budget.
    assert.equal(await peakFor({}), 4);
    assert.equal(await peakFor({ quality: 80 }), 2);
  });

  it('drains sibling raster jobs before reporting a failed batch', async () => {
    const finished = [];
    const failing = {
      ...engine,
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
    await assert.rejects(
      buildSet(read('tiles'), opts({ sizes: [192, 512], padding: 20 }), { engine: failing, optimiseSvg }),
      /raster failed/,
    );
    assert.deepEqual(
      finished.sort((a, b) => a - b),
      [48, 192, 512],
    );
  });

  it('reuses transparent placement renders and reports completed raster jobs', async () => {
    const calls = new Map(),
      events = [];
    const counted = {
      ...engine,
      renderRgba: async (svg, px) => {
        const key = `${svg}\0${px}`;
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return engine.renderRgba(svg, px);
      },
    };
    const options = opts({ sizes: [180, 192] });
    const actual = await buildSet(read('general'), options, {
      engine: counted,
      optimiseSvg,
      progress: (event) => events.push(event),
    });
    assert.ok(
      [...calls.values()].every((n) => n === 1),
      'each placement render is reused',
    );
    assert.equal(events[0].phase, 'placement');
    assert.deepEqual(events.at(-1), { phase: 'complete', completed: 3, total: 3 });
    assert.deepEqual(
      events.filter((e) => e.phase === 'raster').map((e) => e.completed),
      [0, 1, 2, 3],
    );
    const expected = await buildSet(read('general'), options, { engine, optimiseSvg });
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.files[2].bytes, actual.files[3].bytes, '180px alias matches apple');
  });

  it('reuses moderate-margin probes across output sizes', async () => {
    let calls = 0;
    await buildSet(read('flat'), opts({ sizes: [192, 512], manifest: true }), {
      optimiseSvg,
      engine: {
        ...engine,
        renderRgba: (...args) => {
          calls++;
          return engine.renderRgba(...args);
        },
      },
    });
    // The calibrated PR30 build uses59 callbacks, including SVG validation.
    // Wrapping every oversized probe loses shared180/192px work and needs64.
    assert.ok(calls <= 59, `${calls} callbacks: shared placement renders were lost`);
  });
});

const rgba = (img) => ({ width: img.width, height: img.height, rgba: img.data });
const pngOf = (file) => Buffer.from(file.name.endsWith('.ico') ? file.bytes.subarray(22) : file.bytes);
const rasters = (set) => set.files.filter((f) => /\.(png|ico)$/.test(f.name));
// Every reference engine.search is handed, by the PNG it chose: finish() returns its input
// unchanged at zero iterations, so the shipped bytes identify the search that made them.
const recording = () => {
  const seen = [];
  return {
    seen,
    engine: {
      ...engine,
      search: async (raw, reference, options) => {
        const result = await engine.search(raw, reference, options);
        seen.push({ reference, options, png: Buffer.from(result.png) });
        return result;
      },
    },
  };
};

describe('raster search', () => {
  it("renders no reference at effort 'fast' when nothing is pinned", async () => {
    const { seen, engine: recorder } = recording();
    let grounded = 0;
    const counted = {
      ...recorder,
      renderRgba: (svg, px, bg) => {
        if (bg !== undefined) grounded++;
        return engine.renderRgba(svg, px, bg);
      },
    };
    const set = await buildSet(read('general'), opts({ sizes: [192] }), { engine: counted, optimiseSvg });
    assert.equal(grounded, 0, 'a reference was rendered for an ungated build');
    assert.ok(seen.length > 0);
    for (const { reference, options } of seen) {
      assert.equal(reference, null);
      assert.deepEqual(options, { effort: 'fast', pinned: null });
    }
    assert.deepEqual(Object.keys(set.quality), ['favicon.ico', 'apple-touch-icon.png', 'icon-192.png']);
    for (const q of Object.values(set.quality)) {
      assert.deepEqual(q, { setting: { quality: 80, colors: 256 }, pct: null, edge: null, pass: null });
    }
  });

  for (const name of ['general', 'gradient', 'heavy', 'tiles']) {
    it(`${name}: effort 'default' ships rasters inside the bar against the suite's own reference`, async () => {
      const { seen, engine: recorder } = recording();
      const fast = await run(name, { sizes: [192, 512] });
      const set = await buildSet(read(name), opts({ sizes: [192, 512], effort: 'default' }), {
        engine: recorder,
        optimiseSvg,
        name: `${name}.svg`,
      });
      for (const file of rasters(set)) {
        const png = pngOf(file),
          image = rgba(decode(png));
        // The first pass's fast encodes are searched without a reference; the final ones with.
        const searched = seen.find((s) => s.reference && s.png.equals(png));
        assert.ok(searched, `${name}/${file.name}: no search produced these bytes`);
        // The pipeline's reference is a render of the job's own placement: it is the raster's
        // size, and it scores nothing against itself.
        const self = passesBar(searched.reference, searched.reference);
        assert.deepEqual([self.pct, self.edge, self.pass], [0, 0, true], `${name}/${file.name}: reference`);
        const own = passesBar(image, searched.reference);
        assert.deepEqual(set.quality[file.name], {
          setting: set.quality[file.name].setting,
          pct: own.pct,
          edge: own.edge,
          pass: true,
        });

        const fitted = file.name !== 'favicon.ico';
        const suite = rgba(
          await suiteReference({
            source: `test/fixtures/${name}.svg`,
            px: image.width,
            bg: fitted ? '#000000' : undefined,
            vars: {},
            fitted,
          }),
        );
        const independent = passesBar(image, suite);
        assert.ok(
          independent.pass,
          `${name}/${file.name}: pct ${independent.pct.toFixed(4)} %, edge ${independent.edge.toFixed(4)}`,
        );
        const before = rasters(fast).find((f) => f.name === file.name);
        if (passesBar(rgba(decode(pngOf(before))), suite).pass) {
          assert.ok(
            file.bytes.length <= before.bytes.length,
            `${name}/${file.name}: ${file.bytes.length} B against fast's ${before.bytes.length} B`,
          );
        }
      }
    });
  }

  it('warns once per file when a pinned setting misses the bar, and still builds', async () => {
    const warnings = [];
    const set = await buildSet(read('gradient'), opts({ sizes: [48, 192], bg: 'none', colors: 2 }), {
      engine,
      optimiseSvg,
      warn: (message) => warnings.push(message),
    });
    const missed = Object.entries(set.quality).filter(([, q]) => q.pass === false);
    assert.deepEqual(
      missed.map(([file]) => file),
      ['favicon.ico', 'apple-touch-icon.png', 'icon-48.png', 'icon-192.png'],
    );
    const misses = warnings.filter((w) => w.includes('misses the accuracy bar'));
    assert.equal(misses.length, missed.length);
    for (const [file, q] of missed) {
      assert.deepEqual(q.setting, { quality: 100, colors: 2 });
      assert.equal(misses.filter((w) => w.startsWith(`${file} `)).length, 1, file);
      assert.ok(
        misses.includes(
          `${file} misses the accuracy bar at colors 2 (${q.pct.toFixed(2)} % of pixels off, edge error ${q.edge.toFixed(3)})`,
        ),
        file,
      );
    }
  });

  it('names a pinned quality below 100 by its quality', async () => {
    const warnings = [];
    const set = await buildSet(read('gradient'), opts({ quality: 1 }), {
      engine,
      optimiseSvg,
      warn: (message) => warnings.push(message),
    });
    const q = set.quality['apple-touch-icon.png'];
    assert.equal(q.pass, false);
    assert.ok(
      warnings.includes(
        `apple-touch-icon.png misses the accuracy bar at quality 1 (${q.pct.toFixed(2)} % of pixels off, edge error ${q.edge.toFixed(3)})`,
      ),
    );
  });

  it('stays quiet when a pinned setting clears the bar', async () => {
    const warnings = [];
    const set = await buildSet(read('tiles'), opts({ quality: 90 }), {
      engine,
      optimiseSvg,
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(warnings, []);
    for (const q of Object.values(set.quality)) {
      assert.deepEqual(q.setting, { quality: 90, colors: 256 });
      assert.equal(q.pass, true);
    }
  });
});

// A default build with Zopfli on, so the early set only matches a separate fast build if it
// is finished at effort 'fast''s own iterations rather than the build's.
const defaultBuild = (extra) => opts({ effort: 'default', iterations: EFFORT_ITERATIONS.default, ...extra });

describe('the fast set first', () => {
  it("hands the set a separate effort 'fast' build gives to early, once, before the final set", async () => {
    const early = [],
      events = [];
    let renders = 0;
    const counted = {
      ...engine,
      render: (...args) => {
        renders++;
        return engine.render(...args);
      },
    };
    const options = defaultBuild({ manifest: true });
    const final = await buildSet(read('general'), options, {
      engine: counted,
      optimiseSvg,
      early: (set) => early.push({ set, eventsSoFar: events.length }),
      progress: (event) => events.push(event),
    });
    assert.equal(early.length, 1);
    const fast = await buildSet(read('general'), opts({ manifest: true }), { engine, optimiseSvg });
    assert.deepEqual(early[0].set, fast);
    // Called during the build: the 'early' event follows it at once, and the final search after.
    assert.deepEqual(events[early[0].eventsSoFar], { phase: 'early' });
    assert.ok(events.slice(early[0].eventsSoFar).some((e) => e.phase === 'search'));
    // One render per job: the final search reuses the first pass's render.
    assert.equal(renders, 3);

    // Without early the build is one pass, searching unseeded as it always did, and the final
    // set is the same.
    const seen = [];
    let plainRenders = 0;
    const plain = {
      ...engine,
      render: (...args) => {
        plainRenders++;
        return engine.render(...args);
      },
      search: (raw, reference, searchOptions) => {
        seen.push(searchOptions);
        return engine.search(raw, reference, searchOptions);
      },
    };
    const today = await buildSet(read('general'), options, { engine: plain, optimiseSvg });
    assert.deepEqual(final, today);
    assert.equal(plainRenders, 3);
    assert.equal(seen.length, 3);
    for (const searchOptions of seen) {
      assert.equal(searchOptions.effort, 'default');
      assert.equal(searchOptions.seed, undefined);
    }
  });

  for (const effort of ['default', 'max']) {
    it(`gives early its own buffers at effort '${effort}': transferring or zeroing them changes nothing`, async () => {
      const options = defaultBuild({ effort, manifest: true });
      const today = await buildSet(read('general'), options, { engine, optimiseSvg });
      const hosts = {
        transfer: (set) => structuredClone(set, { transfer: set.files.map((f) => f.bytes.buffer) }),
        zero: (set) => {
          for (const f of set.files) f.bytes.fill(0);
        },
      };
      for (const [host, use] of Object.entries(hosts)) {
        let handed;
        const final = await buildSet(read('general'), options, {
          engine,
          optimiseSvg,
          early: (set) => {
            handed = set.files.map((f) => f.bytes);
            use(set);
          },
        });
        assert.deepEqual(final, today, host);
        for (const f of final.files) assert.ok(!handed.includes(f.bytes), `${host}: ${f.name} is an early buffer`);
      }
    });
  }

  it("is not built at effort 'fast' or for a pinned setting", async () => {
    for (const extra of [{}, { effort: 'default', quality: 90 }, { effort: 'max', colors: 64 }]) {
      const events = [];
      let called = 0;
      await buildSet(read('general'), opts(extra), {
        engine,
        optimiseSvg,
        early: () => called++,
        progress: (event) => events.push(event),
      });
      assert.equal(called, 0, JSON.stringify(extra));
      assert.ok(!events.some((e) => e.phase === 'early'), JSON.stringify(extra));
    }
  });

  it('survives an early callback that throws or rejects, and builds the same set', async () => {
    const options = defaultBuild();
    const today = await buildSet(read('general'), options, { engine, optimiseSvg });
    for (const early of [
      () => {
        throw new Error('host failed');
      },
      () => Promise.reject(new Error('host failed later')),
    ]) {
      assert.deepEqual(await buildSet(read('general'), options, { engine, optimiseSvg, early }), today);
    }
  });

  it('reports each search probe per file, between the raster events', async () => {
    const events = [];
    await buildSet(read('general'), defaultBuild(), {
      engine,
      optimiseSvg,
      progress: (event) => events.push(event),
    });
    const searches = events.filter((e) => e.phase === 'search');
    const byFile = Map.groupBy(searches, (e) => e.file);
    assert.deepEqual([...byFile.keys()].toSorted(), ['apple-touch-icon.png', 'favicon.ico', 'icon-32.png']);
    for (const [file, list] of byFile) {
      assert.deepEqual(
        list.map((e) => e.done),
        list.map((_, i) => i + 1),
        file,
      );
      for (const e of list) {
        assert.deepEqual(Object.keys(e), ['phase', 'file', 'done', 'total'], file);
        assert.equal(e.total, 9, file);
      }
    }
    const first = events.findIndex((e) => e.phase === 'search'),
      last = events.findLastIndex((e) => e.phase === 'search');
    assert.ok(events.slice(0, first).some((e) => e.phase === 'raster'));
    assert.deepEqual(events.at(-1), { phase: 'complete', completed: 3, total: 3 });
    assert.ok(last < events.length - 1);
    assert.deepEqual(
      events.filter((e) => e.phase === 'raster').map((e) => e.completed),
      [0, 1, 2, 3],
    );
  });
});
