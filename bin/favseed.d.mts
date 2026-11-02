// Hand-written, like astro/index.d.ts: the options are a smaller surface than argv.

/** Every key favseed.config.js, .mjs or .ts may set. Flags win over it. */
export interface FavseedConfig {
  /** The mark. Relative to the working directory. */
  input?: string;
  /** Output directory. Default: the working directory. */
  out?: string;
  /** Explicit palette ceiling, 2-256. Selects quality 100 when quality is omitted. */
  colors?: number;
  /** PNG quality target, integer 1-100. Default 80, or 100 when colors is supplied alone. Below 100 cannot combine with colors; not an error percentage or a file-size guarantee. */
  quality?: number;
  /** Padded "any maskable" PNG sizes, even pixel counts. Default: `[192, 512]`. */
  sizes?: number[];
  /** Ground of the padded icons. `null` (or `'none'`) keeps the set transparent and unpadded, declared `"any"` only. Default: `'#000000'`. */
  bg?: string | null;
  /** Margin of each padded icon, as a percentage per side. Default: `'auto'`, measured per mark. */
  padding?: number | 'auto';
  /** CSS custom properties, with or without the leading `--`. */
  vars?: Record<string, string | number>;
  /** `false` explicitly removes animation from icon.svg. Default: preserve it. */
  animation?: boolean;
  /** `true` writes an icons-only site.webmanifest; an object's members are merged in ahead of the icons. */
  manifest?: boolean | Record<string, unknown>;
  /** Zopfli effort when enabled: `'release'` uses 120 iterations; `'fast'` uses 15. */
  mode?: 'release' | 'fast';
  /** Extra lossless PNG compression. Slower; disabled by default. */
  zopfli?: boolean;
  /** Prefix of every href in the links and every src in the manifest, e.g. `'/blog/'`. Default: `'/'`. */
  base?: string;
}

/** Returns its argument, typed. */
export function defineConfig(config: FavseedConfig): FavseedConfig;

/** How the mark was placed in one padded icon. */
export interface Placement {
  box: number;
  canvas: number;
  scale: number;
  snapped: boolean;
  radius: number | null;
  fullBleed: boolean;
  padding: number;
}

export interface BuildOptions extends FavseedConfig {
  input: string;
  /** Called with each warning's text, without the `favseed: warning:` prefix. */
  onWarn?: (message: string) => void;
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
  /** The output directory, resolved. */
  dir: string;
  /** The `<link>` block, with `base` applied. */
  links: string;
}

/** Builds the set into `out`. Throws FavseedError with a finished message; never exits. */
export function build(options: BuildOptions): Promise<BuildResult>;

/** The CLI on an argv array. Resolves to the exit code; exits the process on an error. */
export function cli(argv: string[]): Promise<number>;

export class FavseedError extends Error {}

/** The engine's package versions, which the output bytes depend on. */
export function engineVersions(): { '@napi-rs/image': string; '@gfx/zopfli': string };

/** The `<link>` block for a set served under `base`. */
export function linkTags(base?: string, manifest?: boolean): string;
