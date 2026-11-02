// The favicon set as bytes: the svgo stage, the safe-zone placement, one raster job per
// distinct (svg, size, ground), the ICO, the manifest and the <link> block. No filesystem, no
// spawning: the host injects the engine and the svgo stage, writes the files, and owns the
// atomic move. The CLI, the integrations and the website run this same file.
import {
  APPLE_SIZE, FavseedError, ICO_SIZE, icoWrap, linkTags, manifestJson, mapImages, placeInSafeZone, squareIconSvg,
} from './core.mjs';
import { selectSvg } from './svg-precision.mjs';

const text = (s) => new TextEncoder().encode(s);

export async function buildSet(source, o, { engine, optimiseSvg, name = 'input.svg', warn = () => {}, progress = () => {} }) {
  if (!/<svg[\s>]/i.test(source)) throw new FavseedError(`not an SVG (no <svg> element found): ${name}`);

  // One reusable SVG. Motion/style remain unless the caller explicitly opts out;
  // the still-image renderer uses the source's deterministic base appearance.
  const svgOptions = { icon: !o.animation, vars: o.vars, name };
  const initial = optimiseSvg(source, svgOptions);

  if (o.bg !== null) {
    let ground;
    try { ground = await engine.probe(o.bg); } catch {
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
  const renders = new Map(), placements = new Map();
  const budget = 16 * 1024 * 1024;
  let retained = 0;
  const renderRgba = async (svg, px) => {
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
  const { output: iconOut, rasterSvg: iconData, pixels } = await selectSvg(source, svgOptions,
    { initial, optimiseSvg, renderRgba: engine.renderRgba, warn });
  const animated = iconOut.animated, warning = squareIconSvg(iconOut.data).warning;
  if (warning) warn(warning);
  // Validation already rendered the accepted 512px candidate. Only this image
  // enters the placement cache; rejected candidates and reference pixels do not.
  renders.set(`${iconData}\0${512}`, pixels);
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

  // One job per distinct (svg, size, ground): a padded48px PNG and the unpadded ICO
  // are separate jobs. A transparent48px PNG aliases the ICO;180px aliases apple.
  const jobs = new Map();
  const want = (px, bg, file, svg) => {
    const key = `${svg}\0${px}\0${bg ?? ''}`;
    const job = jobs.get(key) ?? { px, bg, svg, files: [] };
    job.files.push(file);
    jobs.set(key, job);
  };
  const ICO = '\0ico';
  want(APPLE_SIZE, o.bg, 'apple-touch-icon.png', apple.svg);
  for (const s of o.sizes) want(s, o.bg, `icon-${s}.png`, icons[s]?.svg ?? iconData);
  want(ICO_SIZE, null, ICO, iconData);

  const png = new Map();
  let completed = 0;
  const total = jobs.size;
  progress({ phase: 'raster', completed, total });
  // Share the existing engine/pool. Large user sizes retain serial scheduling.
  const list = [...jobs.values()];
  await mapImages(list, (job) => job.px, async (job) => {
    const raw = await engine.render(job.svg, job.px, job.bg);
    const out = await engine.finish(await engine.encode(raw, { colors: o.colors, quality: o.quality }), { iterations: o.iterations });
    for (const f of job.files) png.set(f, out);
    progress({ phase: 'raster', completed: ++completed, total });
  }, { serial: list.some((job) => job.px > 512) });

  const files = [
    { name: 'icon.svg', bytes: text(iconOut.data) },
    { name: 'favicon.ico', bytes: icoWrap(png.get(ICO), ICO_SIZE) },
    { name: 'apple-touch-icon.png', bytes: png.get('apple-touch-icon.png') },
    ...o.sizes.map((s) => ({ name: `icon-${s}.png`, bytes: png.get(`icon-${s}.png`) })),
  ];
  if (o.manifest) {
    files.push({
      name: 'site.webmanifest',
      bytes: text(manifestJson({
        sizes: o.sizes, base: o.base, purpose: padded ? 'any maskable' : null,
        extra: typeof o.manifest === 'object' ? o.manifest : null,
      })),
    });
  }
  progress({ phase: 'complete', completed, total });
  return { files, animated, fit, links: linkTags(o.base, Boolean(o.manifest)) };
}
