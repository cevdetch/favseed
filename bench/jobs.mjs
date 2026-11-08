// Every raster job of a real default build, with the bytes today's pipeline gives it and the
// suite's reference for scoring. The engine is wrapped, not modified, so the jobs are exactly
// the production ones (placement, ICO payload, grounds).
//
// Matching encode's input to render's output by object identity (`j.raw === raw`) is safe here:
// lib/pipeline.mjs's raster loop calls `engine.render` exactly once per job and passes its
// result straight into `engine.encode` with no copy in between
// (`const raw = await engine.render(...); ... await engine.encode(raw, ...)`), and
// lib/engine.mjs's `render` returns a freshly allocated Uint8Array (`copy(...)`) on every call,
// never a pooled or reused buffer. So each job's `raw` is a distinct object, and the `find` below
// never matches the wrong job. `engine.render` is only called from that raster loop: the safe-zone
// search (placement) measures with `engine.renderRgba` instead, which this wrapper leaves alone.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { APPLE_SIZE, ICO_SIZE } from '../lib/core.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { reference } from '../test/lib/accuracy.mjs';

/**
 * `name` is what a build failure's FavseedError message names (lib/core.mjs's "unresolved
 * var(...) in ${name}", "svgo failed on ${name}", lib/pipeline.mjs's "not an SVG: ${name}"), and
 * that message becomes `error` below. It defaults to the real file's basename, which is correct
 * for the open and fixture corpora, but callers iterating the private corpus (bench/corpus/
 * files.mjs's `private-N` entries) MUST pass their corpus label here instead — otherwise a
 * private mark's actual file name leaks into a build error.
 */
export const captureJobs = async (path, { name = basename(path) } = {}) => {
  const engine = await loadEngine();
  const jobs = [];
  const wrapped = {
    ...engine,
    render: async (svg, px, bg) => {
      const raw = await engine.render(svg, px, bg);
      jobs.push({ svg, px, bg: bg ?? null, raw });
      return raw;
    },
    encode: async (raw, options) => {
      const out = await engine.encode(raw, options);
      const job = jobs.find((j) => j.raw === raw);
      if (job) job.today = out;
      return out;
    },
  };
  let set;
  try {
    set = await buildSet(readFileSync(path, 'utf8'), normaliseOptions({ input: path, manifest: false }), {
      engine: wrapped,
      optimiseSvg,
      name,
    });
  } catch (error) {
    // buildSet's own errors already say `name` (it was passed the override above), but
    // readFileSync's ENOENT (and any other fs error) fires before buildSet ever runs, and
    // embeds the real `path` Node was asked to open. Scrub both the full path and its bare
    // basename — never trust the caller's error message to already be safe.
    const message = String(error?.message ?? error).split('\n')[0];
    return { ok: false, error: message.split(path).join(name).split(basename(path)).join(name) };
  }
  for (const job of jobs) {
    job.kind = job.bg === null && job.px === ICO_SIZE ? 'ico' : job.px === APPLE_SIZE ? 'apple' : 'icon';
    job.reference =
      job.kind === 'ico'
        ? reference({ source: path, px: job.px, bg: null, vars: {}, fitted: false })
        : reference({ source: path, px: job.px, bg: job.bg, vars: {}, fitted: true });
    // Created eagerly, for every job, before any caller awaits it: without a handler attached
    // now, a rejection (a bad reference render) would surface as an unhandled rejection and
    // crash an unattended sweep. The original promise is still what callers await below.
    job.reference.catch(() => {});
  }
  return { ok: true, jobs, files: set.files.map((f) => ({ name: f.name, bytes: f.bytes.length })) };
};
