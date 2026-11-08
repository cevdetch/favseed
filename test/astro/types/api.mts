// Compiled as an external packed-package consumer, also without optional peers.
import {
  CONFIG_FILES,
  FavseedError,
  buildFiles,
  defineConfig,
  loadConfigFile,
  loadEngine,
  optimiseSvg,
  icoWrap,
  linkTags,
  maskableFit,
  nestForMask,
  placeInSafeZone,
  type BuildOptions,
  type Effort,
  type Placement,
} from 'favseed';
import * as core from 'favseed/core';

const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="12"/></svg>';
const vars = new Map<string, string | number>([
  ['brand', '#123456'],
  ['width', 2],
]);
const normalized: Map<string, string> = core.normaliseVars(vars);
const options: BuildOptions = { ...defineConfig({ vars }), input: 'logo.svg' };
const result = await buildFiles(options);
const placement: Placement = result.fit.apple;
const canvas: number = placement.canvas;
// @ts-expect-error Build results carry measurements, not the wrapped SVG.
void placement.svg;
const optimized = optimiseSvg(source, { vars: normalized, precision: 2, onWarn: (message) => message.toUpperCase() });
const optimizedText: string = optimized.data;
const animated: boolean = optimized.animated;
const stripped: number = optimized.stripped;
// @ts-expect-error The optimizer is synchronous.
optimized.then(() => {});
// @ts-expect-error SVG source must be text.
optimiseSvg(new Uint8Array());
// @ts-expect-error Precision must be numeric.
optimiseSvg(source, { precision: '2' });

const engine = await loadEngine();
const raw: Uint8Array = await engine.render(source, 48, null);
const rgba = await engine.renderRgba(source, 48);
const pixels: Uint8Array = rgba.rgba;
const ground: number[] = await engine.probe('#fff');
const encoded = await engine.encode(raw, { colors: 256, quality: 80 });
const _qualityOnly: Uint8Array = await engine.encode(raw, { quality: 80 });
const finished: Uint8Array = await engine.finish(encoded, { iterations: 0 });
const ico: Uint8Array = icoWrap(finished, 48);
// @ts-expect-error ICO input must be bytes.
icoWrap('png', 48);
// @ts-expect-error Engine rendering is asynchronous.
const _immediate: Uint8Array = engine.render(source, 48);
// @ts-expect-error Engine options require a numeric iteration count.
engine.finish(raw, { iterations: '15' });
const fit = maskableFit(rgba);
const radius: number = fit.radius;
const safe = await placeInSafeZone(source, engine.renderRgba, 48);
const safeText: string = safe.svg;
const safePadding: number = safe.padding;
// @ts-expect-error Low-level placement does not return the canvas field.
void safe.canvas;
await core.placeInSafeZone(
  source,
  (_svg, px) => ({ width: px, height: px, rgba: new Uint8ClampedArray(px * px * 4) }),
  48,
  20,
);
// @ts-expect-error Renderer callbacks must return decoded pixels, not PNG bytes.
placeInSafeZone(source, engine.render, 48);
const nested: string = nestForMask(source, 32, 48);
const tags: string = linkTags('/blog/', true);
const sameWrap: typeof icoWrap = core.icoWrap;
const samePlacement: typeof placeInSafeZone = core.placeInSafeZone;
const sameError: typeof FavseedError = core.FavseedError;

const files: string[] = CONFIG_FILES;
const loaded = await loadConfigFile('.');
const configFile: string | null = loaded.file;
const ignored: string[] = loaded.ignored;
const rawQuality: unknown = loaded.config.quality;
// @ts-expect-error Config loading does not validate field values.
const _validatedQuality: number | undefined = loaded.config.quality;

const defaults: number[] = [
  core.ICO_SIZE,
  core.APPLE_SIZE,
  core.DEFAULT_QUALITY,
  core.DEFAULT_COLORS,
  core.EFFORT_ITERATIONS.fast,
  core.EFFORT_ITERATIONS.default,
  core.EFFORT_ITERATIONS.max,
  core.MASK_SAFE_RADIUS,
  core.SNAP_WINDOW,
];
const effort: Effort = core.DEFAULT_EFFORT;
// @ts-expect-error The table has the three efforts only.
void core.EFFORT_ITERATIONS.release;
const sizes: number[] = core.DEFAULT_SIZES;
const bg: string = core.DEFAULT_BG;
const squared = core.squareIconSvg(source);
const warning: string | null = squared.warning;
const hasIcon: boolean = core.declaresIcon(tags);
const icons = core.manifestIcons({ sizes, base: '/blog/', purpose: 'any maskable' });
const iconUrl: string = icons[0].src;
const manifest: string = core.manifestJson({ sizes, extra: { name: 'Example' } });
const mapped = await core.mapImages(
  [{ px: 48, name: 'small' }],
  (item) => item.px,
  async (item) => ({ name: item.name, bytes: raw }),
  { serial: true },
);
const mappedName: string = mapped[0].name;
const mappedBytes: Uint8Array = mapped[0].bytes;
const syncNames: string[] = await core.mapImages([48], (size) => size, String);
// @ts-expect-error Inferred results retain the callback's shape.
void mapped[0].missing;
// @ts-expect-error Canvas sizing must produce a number.
core.mapImages([48], String, String);
await core.mapImages([48], (size) => size, String, { serial: true, extraBytes: (size) => size * size * 42 });
// @ts-expect-error Manifest sizes are numeric.
core.manifestIcons({ sizes: ['48'] });

export {
  canvas,
  optimizedText,
  animated,
  stripped,
  pixels,
  ground,
  ico,
  radius,
  safeText,
  safePadding,
  nested,
  tags,
  sameWrap,
  samePlacement,
  sameError,
  files,
  configFile,
  ignored,
  rawQuality,
  defaults,
  bg,
  effort,
  normalized,
  warning,
  hasIcon,
  iconUrl,
  manifest,
  mappedName,
  mappedBytes,
  syncNames,
};
