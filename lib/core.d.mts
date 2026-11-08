import type { PlacementMetrics, RgbaImage, SvgVariables } from './types.mjs';
export type { PlacementMetrics, RgbaImage, SvgVariables } from './types.mjs';

export class FavseedError extends Error {}

export const ICO_SIZE: number;
export const APPLE_SIZE: number;
export const DEFAULT_QUALITY: number;
export const DEFAULT_COLORS: number;
/** Default numbered PNG sizes. Treat this shared array as read-only. */
export const DEFAULT_SIZES: number[];
export const DEFAULT_BG: string;
export const ZOPFLI_ITERATIONS: number;
export const FAST_ZOPFLI_ITERATIONS: number;
export const MASK_SAFE_RADIUS: number;
export const SNAP_WINDOW: number;

export interface SvgOptions {
  /** Explicit static mode: strips motion and accessibility. Default false. */
  icon?: boolean;
  /** Objects are normalized; Maps must already have --prefixed keys. Use normaliseVars. */
  vars?: SvgVariables;
  /** Filename used in errors. Default input.svg. */
  name?: string;
  /** Numeric precision for this pass. Default 1; no measured accuracy selection. */
  precision?: number;
  /** Preserve source geometry and validate its viewport; used for reference renders. */
  reference?: boolean;
  /** Dependency warnings from reference preparation. */
  onWarn?: (message: string) => void;
}

export interface SvgResult {
  data: string;
  stripped: number;
  animated: boolean;
}

export interface SvgStage {
  optimiseSvg(source: string, options?: SvgOptions): SvgResult;
}

/** Inject an SVGO-compatible optimizer; importing core does not load one. */
export function createSvgStage(optimizer: {
  optimize(source: string, config: object): { data: string };
  builtinPlugins?: readonly { name: string; plugins?: readonly { name: string }[] }[];
}): SvgStage;

/** Normalize variable names to --name and stringify values. */
export function normaliseVars(vars?: SvgVariables | null): Map<string, string>;

/** Wrap a square PNG in one ICO entry; px must match the PNG and be 1–256. */
export function icoWrap(png: Uint8Array, px: number): Uint8Array;

/** Measure nontransparent pixels; throws when the image contains no visible mark. */
export function maskableFit(image: RgbaImage): { radius: number; fullBleed: boolean; scale: number };

/** Center a box-sized SVG viewport on the given square canvas. */
export function nestForMask(iconData: string, box: number, canvas: number): string;

/** Bound active image work, retain input order and drain a failed batch before rejecting. */
export function mapImages<T, R>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  work: (item: T) => R | PromiseLike<R>,
  options?: { serial?: boolean },
): Promise<Awaited<R>[]>;

export interface SafeZonePlacement extends PlacementMetrics {
  svg: string;
}

/** canvas must be a positive even size; render supplies transparent square RGBA pixels. */
export function placeInSafeZone(
  iconData: string,
  render: (svgText: string, px: number) => RgbaImage | PromiseLike<RgbaImage>,
  canvas: number,
  padding?: number | 'auto',
): Promise<SafeZonePlacement>;

/** base is concatenated as supplied; use a trailing slash, e.g. /blog/. */
export function linkTags(base?: string, manifest?: boolean): string;
export function declaresIcon(html: string): boolean;
export function squareIconSvg(iconData: string): { data: string; warning: string | null };

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

export interface ManifestOptions {
  sizes: readonly number[];
  /** Concatenated as supplied; include a trailing slash. */
  base?: string;
  purpose?: string | null;
}

export function manifestIcons(options: ManifestOptions): ManifestIcon[];
/** Extra manifest members are preserved, except icons, which this function generates. */
export function manifestJson(options: ManifestOptions & { extra?: Record<string, unknown> | null }): string;
