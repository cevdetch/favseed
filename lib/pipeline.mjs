// The favicon set as bytes: the svgo stage, the safe-zone placement, one raster job per
// distinct (svg, size, ground), the ICO, the manifest and the <link> block. No filesystem, no
// spawning: the host injects the engine and the svgo stage, writes the files, and owns the
// publishing and recovery. The CLI, the integrations and the website run this same file.
import {
  APPLE_SIZE,
  DEFAULT_COLORS,
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

/** A setting as a person would have asked for it: a quality, a palette size, or quality 100
 * with the full palette (what an explicit quality of 100 means). */
export const describeSetting = ({ quality, colors }) =>
  quality < 100 || colors === DEFAULT_COLORS ? `quality ${quality}` : `colors ${colors}`;

export async function buildSet(
  source,
  o,
  { engine, optimiseSvg, name = 'input.svg', warn = () => {}, progress = () => {} },
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

  const png = new Map(),
    gates = new Map();
  let completed = 0;
  const total = jobs.size;
  progress({ phase: 'raster', completed, total });
  // Bounded batches through mapImages; any size above 512 px runs serially. Beyond its render
  // canvas, a gated job holds its reference's RGBA (4 B/px) and the prepared reference
  // engine.search builds from it (two grounds of a rounded composite, float luma and float
  // edge weights: 38 B/px), so those 42 B/px count against the batch budget too.
  const list = [...jobs.values()];
  await mapImages(
    list,
    (job) => job.px,
    async (job) => {
      const raw = await engine.render(job.svg, job.px, job.bg);
      const reference = gated ? await engine.renderRgba(job.refSvg, job.px, job.bg) : null;
      const result = await engine.search(raw, reference, { effort, pinned });
      const out = await engine.finish(result.png, { iterations: o.iterations });
      for (const f of job.files) {
        png.set(f, out);
        gates.set(f, result);
      }
      progress({ phase: 'raster', completed: ++completed, total });
    },
    { serial: list.some((job) => job.px > 512), extraBytes: (job) => (gated ? job.px * job.px * 42 : 0) },
  );

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
        `${file} misses the accuracy bar at ${describeSetting(setting)} ` +
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
  progress({ phase: 'complete', completed, total });
  return { files, animated, fit, quality, links: linkTags(o.base, Boolean(o.manifest)) };
}
