// The favicon set as bytes: the svgo stage, the safe-zone placement, one raster job per
// distinct (svg, size, ground), the ICO, the manifest and the <link> block. No filesystem, no
// spawning: the host injects the engine and the svgo stage, writes the files, and owns the
// publishing and recovery. The CLI, the integrations and the website run this same file.
import {
  APPLE_SIZE,
  DEFAULT_COLORS,
  EFFORT_ITERATIONS,
  FavseedError,
  ICO_SIZE,
  icoWrap,
  linkTags,
  manifestJson,
  manifestPurpose,
  mapImages,
  nestForMask,
  placeInSafeZone,
  squareIconSvg,
} from './core.mjs';
import { PRECISION_PX, selectSvg } from './svg-precision.mjs';

const text = (s) => new TextEncoder().encode(s);

// Beyond its render canvas, a gated job holds its reference's RGBA (4 B/px) and the prepared
// reference engine.search builds from it (two grounds of a rounded composite, float luma and
// float edge weights: 38 B/px), and the search's two walks gate at once, so a second decoded
// candidate is in flight (4 B/px; the first fits in the render canvas the batch already counts).
// Those 46 B/px count against mapImages' batch budget too.
const referenceBytes = (job) => job.px * job.px * 46;

/** A setting as a person would have asked for it: a quality, a palette size, or quality 100
 * with the full palette (what an explicit quality of 100 means). A pin names the control it came
 * from (`by`), so `--colors 256` echoes as colours although it is the same encode. */
export const describeSetting = ({ quality, colors, by }) =>
  quality < 100 || (colors === DEFAULT_COLORS && by !== 'colors') ? `quality ${quality}` : `colors ${colors}`;

/**
 * The set as `{ files, animated, fit, quality, links }`.
 *
 * `early(set)`, when given, is first handed the complete set an effort 'fast' build of the same
 * source and options returns, byte for byte, at effort 'default' or 'max' with nothing pinned.
 * The set is the callback's own copy: it may transfer or overwrite every buffer without touching
 * the build or the set it returns. It is not awaited, and anything it throws or rejects with is
 * ignored. Without `early` the build makes no fast set and searches exactly as it would have.
 *
 * `progress` receives, in order:
 * - `{ phase: 'placement', completed: 0, total: 0 }`;
 * - `{ phase: 'raster', completed, total }`, `total` the number of raster jobs: once with 0,
 *   then once per finished job of the returned set (a fast set's jobs are not counted);
 * - `{ phase: 'early' }`, right after `early` is called;
 * - `{ phase: 'search', file, done, total }` after each encode of a gated search: `file` is the
 *   job's first output file, `done` counts that search's encodes and `total` is the most it can
 *   make. A search can stop short of `total`, and a probe answered by the fast encode it was
 *   seeded with makes no encode and is not reported, so `done` may never reach `total`;
 * - `{ phase: 'complete', completed, total }` last.
 */
export async function buildSet(
  source,
  o,
  { engine, optimiseSvg, name = 'input.svg', warn = () => {}, progress = () => {}, early },
) {
  if (!/<svg[\s>]/i.test(source)) throw new FavseedError(`not an SVG (no <svg> element found): ${name}`);

  // One reusable SVG. Motion/style remain unless the caller explicitly opts out;
  // the still-image renderer uses the source's deterministic base appearance.
  const svgOptions = { icon: !o.animation, vars: o.vars, name };
  const initial = optimiseSvg(source, svgOptions);

  if (o.bg !== null) {
    let ground;
    try {
      ground = await engine.probe(o.bg);
    } catch {
      throw new FavseedError(
        `--bg is not a colour resvg accepts: '${o.bg}'\n` +
          `       try a hex value (#fff, #ffffff), an SVG colour name, rgb()/hsl(), or 'none'`,
      );
    }
    // Parsing proves nothing about opacity: transparent, rgba(..., 0) and 8-digit hex parse.
    // The padded icons are declared "any maskable" and the apple icon is composited by iOS, so
    // a ground with alpha would ship icons that break both.
    if (ground[3] !== 255) {
      throw new FavseedError(
        `--bg must be opaque: '${o.bg}' has transparency, and the padded icons are declared ` +
          `maskable\n       use --bg none for a transparent, unpadded set`,
      );
    }
  }

  // Adjacent safe-zone searches can ask for the same transparent raster. Keep this reuse
  // local to the build and bounded: large user-supplied sizes must not retain whole canvases.
  const renders = new Map(),
    placements = new Map();
  const budget = 16 * 1024 * 1024;
  let retained = 0;
  const renderRgba = async (svg, px) => {
    // Cropped probes include their output canvas and candidate box. Each is visited
    // once, so retaining those pixels spends cache budget without enabling reuse.
    if (svg !== iconData) return engine.renderRgba(svg, px);
    const key = `${svg}\0${px}`;
    if (renders.has(key)) return renders.get(key);
    const result = await engine.renderRgba(svg, px);
    const bytes = result.rgba.byteLength;
    if (bytes <= budget) {
      while (retained + bytes > budget) {
        const oldest = renders.keys().next().value;
        retained -= renders.get(oldest).rgba.byteLength;
        renders.delete(oldest);
      }
      renders.set(key, result);
      retained += bytes;
    }
    return result;
  };
  progress({ phase: 'placement', completed: 0, total: 0 });
  const {
    output: iconOut,
    rasterSvg: iconData,
    pixels,
    rasterReference,
  } = await selectSvg(source, svgOptions, { initial, optimiseSvg, renderRgba: engine.renderRgba, warn });
  const animated = iconOut.animated,
    warning = squareIconSvg(iconOut.data).warning;
  if (warning) warn(warning);
  // Validation already rendered the accepted 512px candidate. Only this image
  // enters the placement cache; rejected candidates and reference pixels do not.
  renders.set(`${iconData}\0${PRECISION_PX}`, pixels);
  retained = pixels.rgba.byteLength;
  // Placement is measured on transparent renders at each icon's own size.
  const place = async (canvas) => {
    if (placements.has(canvas)) return placements.get(canvas);
    const { svg, ...where } = await placeInSafeZone(iconData, renderRgba, canvas, o.padding);
    const result = { svg, fit: { ...where, canvas } };
    placements.set(canvas, result);
    return result;
  };
  const apple = await place(APPLE_SIZE);
  // --bg none keeps the set transparent and unpadded: a maskable icon must be opaque.
  const padded = o.bg !== null;
  const icons = {};
  for (const s of o.sizes) icons[s] = padded ? await place(s) : null;
  const fit = { apple: apple.fit, icons: Object.fromEntries(o.sizes.map((s) => [s, icons[s]?.fit ?? null])) };
  renders.clear(); // Placement pixels are no longer needed during compression.

  // Each raster is gated against the var-resolved source placed exactly as that raster's own
  // SVG was: the same box on the same canvas, so the gate scores pixels and never a placement
  // difference. A full-bleed mark is not nested, and neither is its reference.
  const placedReference = (where) =>
    !where || where.fullBleed ? rasterReference : nestForMask(rasterReference, where.box, where.canvas);

  // One job per distinct (svg, size, ground): a padded 48 px PNG and the unpadded ICO are
  // separate jobs; a transparent 48 px PNG aliases the ICO, and 180 px aliases the apple icon.
  // Aliased files share a placement, so they share a reference too.
  const jobs = new Map();
  const want = (px, bg, file, svg, refSvg) => {
    const key = `${svg}\0${px}\0${bg ?? ''}`;
    const job = jobs.get(key) ?? { px, bg, svg, refSvg, files: [] };
    job.files.push(file);
    jobs.set(key, job);
  };
  const ICO = '\0ico';
  want(APPLE_SIZE, o.bg, 'apple-touch-icon.png', apple.svg, placedReference(apple.fit));
  for (const s of o.sizes) want(s, o.bg, `icon-${s}.png`, icons[s]?.svg ?? iconData, placedReference(icons[s]?.fit));
  want(ICO_SIZE, null, ICO, iconData, rasterReference);

  const { effort, pinned } = o;
  // Effort 'fast' unpinned is one encode with nothing to gate, so it renders no reference: dev
  // builds and the website's Fast effort never pay for one. A pinned setting is one encode too,
  // but it needs the gate to say when the setting misses the bar.
  const gated = pinned !== null || effort !== 'fast';

  const list = [...jobs.values()];
  const serial = list.some((job) => job.px > 512);
  let completed = 0;
  const total = jobs.size;
  progress({ phase: 'raster', completed, total });
  // `raster` events count the jobs of the set the build returns, never a first pass's.
  const rasterDone = () => progress({ phase: 'raster', completed: ++completed, total });

  // Bounded batches through mapImages; any size above 512 px runs serially. `encodeOf` returns
  // a job's chosen encode, which is finished at `iterations` and filed under each of its files.
  const encodeAll = async (encodeOf, { iterations, extraBytes = () => 0, done = () => {} }) => {
    const png = new Map(),
      gates = new Map();
    await mapImages(
      list,
      (job) => job.px,
      async (job) => {
        const result = await encodeOf(job);
        const out = await engine.finish(result.png, { iterations });
        for (const f of job.files) {
          png.set(f, out);
          gates.set(f, result);
        }
        done();
      },
      { serial, extraBytes },
    );
    return { png, gates };
  };
  const reference = (job) => engine.renderRgba(job.refSvg, job.px, job.bg);
  // A search's progress names the job's first file: an aliased raster's other files share its
  // bytes, so they share its search too.
  const probed = (job) => {
    const file = job.files[0] === ICO ? 'favicon.ico' : job.files[0];
    return ({ done, total: most }) => progress({ phase: 'search', file, done, total: most });
  };

  // The set from one pass's encodes: the ICO, the manifest, the links and the quality report.
  const assemble = ({ png, gates }) => {
    // Reported in file order, not in the order concurrent jobs happened to finish.
    const quality = {};
    for (const f of [ICO, 'apple-touch-icon.png', ...o.sizes.map((s) => `icon-${s}.png`)]) {
      const { setting, pct, edge, pass } = gates.get(f),
        file = f === ICO ? 'favicon.ico' : f;
      quality[file] = { setting, pct, edge, pass };
      // Only a pinned setting can miss quietly: a search keeps a failing encode only when no
      // candidate passes, and that raster is limited by its geometry, not by its encode.
      if (pinned && pass === false) {
        warn(
          `${file} misses the accuracy bar at ${describeSetting({ ...setting, by: pinned.by })} ` +
            `(${pct.toFixed(2)} % of pixels off, edge error ${edge.toFixed(3)})`,
        );
      }
    }
    const files = [
      { name: 'icon.svg', bytes: text(iconOut.data) },
      { name: 'favicon.ico', bytes: icoWrap(png.get(ICO), ICO_SIZE) },
      { name: 'apple-touch-icon.png', bytes: png.get('apple-touch-icon.png') },
      ...o.sizes.map((s) => ({ name: `icon-${s}.png`, bytes: png.get(`icon-${s}.png`) })),
    ];
    if (o.manifest) {
      files.push({
        name: 'site.webmanifest',
        bytes: text(
          manifestJson({
            sizes: o.sizes,
            base: o.base,
            purpose: manifestPurpose(o.bg),
            extra: typeof o.manifest === 'object' ? o.manifest : null,
          }),
        ),
      });
    }
    return { files, animated, fit, quality, links: linkTags(o.base, Boolean(o.manifest)) };
  };

  // One pass unless a host asked for the fast set and a search will follow it: effort 'fast'
  // and a pinned setting are one encode per raster, and a search nobody wants a fast set from
  // runs unseeded. The fast set costs a searched build 2-5 % of its wall time (general and
  // gradient, native), because the colour walk, not the seeded quality walk, is its long pole.
  if (!gated || pinned !== null || typeof early !== 'function') {
    const set = await encodeAll(
      async (job) => {
        const raw = await engine.render(job.svg, job.px, job.bg);
        if (!gated) return engine.search(raw, null, { effort, pinned });
        return engine.search(raw, await reference(job), { effort, pinned, onProbe: probed(job) });
      },
      { iterations: o.iterations, extraBytes: gated ? referenceBytes : undefined, done: rasterDone },
    );
    progress({ phase: 'complete', completed, total });
    return assemble(set);
  }

  // The fast set first. The first pass is exactly an effort 'fast' build (no reference, and
  // effort 'fast''s iterations, which are none), handed to `early` complete so a host can offer
  // it while the search runs. Its renders and encodes are kept: the second pass renders nothing
  // again, and each search's quality-80 probe is the fast encode it was seeded with.
  //
  // Memory: what is kept between the passes is small. A raw render is a PNG, measured at 0.02 to
  // 0.23 B/px on the fixtures (a noise-like mark at 4096 px could reach about 4 B/px); a fast
  // encode is smaller still. The decoded references, the memory that matters, are made in the
  // second pass under referenceBytes as before. The encoders' own native decodes of a render
  // are covered by the 1000 px canvas floor mapImages charges at 512 px and below, and by
  // serial scheduling above it.
  const first = await encodeAll(
    async (job) => {
      job.raw = await engine.render(job.svg, job.px, job.bg);
      job.fast = await engine.search(job.raw, null, { effort: 'fast' });
      return job.fast;
    },
    { iterations: EFFORT_ITERATIONS.fast },
  );
  // The host's own deep copy. Uncopied, the fast PNGs would be the very buffers the second pass
  // seeds its searches with (finish at zero iterations returns its input), and a final PNG can
  // be that same buffer when the seed wins and Zopfli does not shrink it: a host transferring
  // the early set to another thread would detach the seeds and the build would fail.
  const fastSet = structuredClone(assemble(first));
  // An observer, like the search's onProbe: whatever the host does with it, the build goes on.
  // It is not awaited, and a promise it returns is never the build's to reject.
  try {
    Promise.resolve(early(fastSet)).catch(() => {});
  } catch {
    // The early set's failure is the host's, not the build's.
  }
  progress({ phase: 'early' });

  const final = await encodeAll(
    async (job) => {
      const result = await engine.search(job.raw, await reference(job), {
        effort,
        pinned,
        seed: { setting: job.fast.setting, png: job.fast.png },
        onProbe: probed(job),
      });
      job.raw = job.fast = null;
      return result;
    },
    { iterations: o.iterations, extraBytes: referenceBytes, done: rasterDone },
  );
  progress({ phase: 'complete', completed, total });
  return assemble(final);
}
