// Native compression experiment. Browser timings and byte parity are measured by
// PATH=<chromium-directory>:$PATH node site/test/cdp-check.mjs after building the site.
// --placement counts transparent renders before/after reuse.
// The default experiment changes no shipped settings: it tests an extra lossless pass on the
// selected PNG before Zopfli, and verifies that it changes no decoded pixels.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as image from '@napi-rs/image';
import { loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { decode } from '../test/lib/png.mjs';
import { APPLE_SIZE, placeInSafeZone, squareIconSvg } from '../lib/core.mjs';

const engine = await loadEngine();
if (process.argv.includes('--placement')) {
  for (const mark of ['general', 'heavy', 'tiles', 'gradient']) {
    const source = readFileSync(new URL(`../test/fixtures/${mark}.svg`, import.meta.url), 'utf8');
    for (const sizes of [
      [192, 512],
      [180, 192],
    ]) {
      const options = normaliseOptions({ sizes, mode: 'fast' });
      let before = 0,
        after = 0;
      const icon = squareIconSvg(optimiseSvg(source, { icon: true, vars: options.vars }).data).data;
      // The pre-cache pipeline measured each canvas independently, including an apple alias.
      for (const size of [APPLE_SIZE, ...sizes])
        await placeInSafeZone(
          icon,
          async (...args) => {
            before++;
            return engine.renderRgba(...args);
          },
          size,
          options.padding,
        );
      await buildSet(source, options, {
        optimiseSvg,
        engine: {
          ...engine,
          renderRgba: async (...args) => {
            after++;
            return engine.renderRgba(...args);
          },
          encode: async (png) => png,
          finish: async (png) => png,
        },
      });
      console.log(JSON.stringify({ mark, sizes, before, after }));
    }
  }
} else {
  // Initialize both image/compression runtimes before comparing build time.
  await engine.finish(
    await engine.encode(
      await engine.render(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="red"/></svg>',
        32,
        '#000000',
      ),
      { colors: 256 },
    ),
    { iterations: 15 },
  );
  const candidate = {
    ...engine,
    encode: async (png, options) => {
      const original = await engine.encode(png, options);
      const optimized = new Uint8Array(await image.losslessCompressPng(original));
      return optimized.length < original.length ? optimized : original;
    },
  };
  const options = normaliseOptions({ mode: 'fast' });
  const marks = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
  let before = 0,
    after = 0,
    baselineMs = 0,
    candidateMs = 0;
  for (const [index, mark] of marks.entries()) {
    const source = readFileSync(new URL(`../test/fixtures/${mark}.svg`, import.meta.url), 'utf8');
    const builds = {};
    for (const name of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const start = performance.now();
      const result = await buildSet(source, options, { engine: name === 'baseline' ? engine : candidate, optimiseSvg });
      builds[name] = { result, ms: performance.now() - start };
    }
    const pngs = (set) => set.result.files.filter((f) => f.name.endsWith('.png'));
    const baseline = pngs(builds.baseline),
      improved = pngs(builds.candidate);
    for (let i = 0; i < baseline.length; i++) {
      assert.deepEqual(
        decode(Buffer.from(improved[i].bytes)),
        decode(Buffer.from(baseline[i].bytes)),
        `${mark}/${baseline[i].name} pixels`,
      );
    }
    const bytes = (files) => files.reduce((n, f) => n + f.bytes.length, 0);
    const a = bytes(baseline),
      b = bytes(improved);
    before += a;
    after += b;
    baselineMs += builds.baseline.ms;
    candidateMs += builds.candidate.ms;
    console.log(
      JSON.stringify({
        mark,
        before: a,
        after: b,
        delta: b - a,
        baselineMs: Math.round(builds.baseline.ms),
        candidateMs: Math.round(builds.candidate.ms),
      }),
    );
  }
  console.log(
    JSON.stringify({
      total: true,
      before,
      after,
      delta: after - before,
      baselineMs: Math.round(baselineMs),
      candidateMs: Math.round(candidateMs),
    }),
  );
}
