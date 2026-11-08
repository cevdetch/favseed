import type { ImageOptions, Placement, RgbaImage } from '../lib/types.mjs';
import type { SvgStage } from '../lib/core.mjs';
export type { Effort, ImageOptions, Placement, RgbaImage, SvgVariables } from '../lib/types.mjs';
export type { SvgOptions, SvgResult, SafeZonePlacement } from '../lib/core.mjs';
export { FavseedError, icoWrap, linkTags, maskableFit, nestForMask, placeInSafeZone } from '../lib/core.mjs';

/** Every key favseed.config.js, .mjs or .ts may set. Flags win over it. */
export interface FavseedConfig extends ImageOptions {
  /** The mark. Relative to the working directory. */
  input?: string;
  /** Output directory. Default: the working directory. */
  out?: string;
  /** Prefix of every href in the links and every src in the manifest, e.g. `'/blog/'`. Default: `'/'`. */
  base?: string;
}

/** Returns its argument, typed. */
export function defineConfig(config: FavseedConfig): FavseedConfig;

export interface BuildOptions extends FavseedConfig {
  input: string;
  /** Called with each warning's text, without the `favseed: warning:` prefix. */
  onWarn?: (message: string) => void;
}

/** How one raster was encoded, and how it scored against the accuracy bar. */
export interface RasterQuality {
  setting: { quality: number; colors: number };
  /** Share of pixels off by more than 8/255, worse of the black and white composites. */
  pct: number | null;
  /** Edge-weighted luma error, worse of the two composites. */
  edge: number | null;
  pass: boolean | null;
}

export interface BuildResult {
  /** File names, in the order they were written. */
  files: string[];
  /** Size in bytes of each file, by name. */
  bytes: Record<string, number>;
  /** Whether icon.svg preserves an animation. */
  animated: boolean;
  /** Placement per padded icon; an icon is `null` under `bg: null`. */
  fit: { apple: Placement; icons: Record<number, Placement | null> };
  /**
   * Per raster file (favicon.ico, apple-touch-icon.png, icon-<size>.png): the encode setting
   * chosen and its accuracy-bar measurement. `pct`, `edge` and `pass` are `null` when the
   * build had no reason to gate (effort 'fast' with no pinned setting).
   */
  quality: Record<string, RasterQuality>;
  /** The output directory, resolved. */
  dir: string;
  /** The `<link>` block, with `base` applied. */
  links: string;
}

/** Builds the set into `out`. Throws FavseedError with a finished message; never exits. */
export function build(options: BuildOptions): Promise<BuildResult>;

export interface BuildFilesResult {
  /** Generated files in output order, with their encoded contents. */
  files: { name: string; bytes: Uint8Array }[];
  animated: BuildResult['animated'];
  fit: BuildResult['fit'];
  quality: BuildResult['quality'];
  links: BuildResult['links'];
}

/** Reads input from disk and returns the generated set without writing output files. */
export function buildFiles(options: BuildOptions): Promise<BuildFilesResult>;

/** The CLI on an argv array. Resolves to the exit code; exits the process on an error. */
export function cli(argv: string[]): Promise<number>;

/** The engine's package versions, which the output bytes depend on. */
export function engineVersions(): { '@napi-rs/image': string; zopfli: string; svgo: string };

/** One synchronous SVG pass; does not run the full build's measured accuracy selection. */
export const optimiseSvg: SvgStage['optimiseSvg'];

/** The lazily loaded Node engine. Inputs are square SVGs with a valid viewBox or PNG bytes. */
export interface RasterEngine {
  render(svgText: string, px: number, background?: string | null): Promise<Uint8Array>;
  renderRgba(svgText: string, px: number): Promise<RgbaImage & { rgba: Uint8Array }>;
  probe(background: string): Promise<number[]>;
  encode(png: Uint8Array, options: { colors?: number; quality?: number }): Promise<Uint8Array>;
  finish(png: Uint8Array, options: { iterations: number }): Promise<Uint8Array>;
}

/** Loads and caches the native image engine on first use. */
export function loadEngine(): Promise<RasterEngine>;

/** Config filenames in discovery order. Treat this shared array as read-only. */
export const CONFIG_FILES: string[];

/** Loading checks the object shape and option names, not the values or input file. */
export interface LoadedConfig {
  config: Partial<Record<keyof FavseedConfig, unknown>>;
  /** Basename of the selected config, or null when none exists. */
  file: string | null;
  /** Other config basenames present in the same directory. */
  ignored: string[];
}

/** Imports the first config in dir (default cwd); does not build or normalize it. */
export function loadConfigFile(dir?: string): Promise<LoadedConfig>;
