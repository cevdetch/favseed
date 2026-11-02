// Hand-written, because the options are a smaller surface than the CLI's argv by design,
// and a generated type would describe the argv shape instead.

import type { AstroIntegration } from 'astro';

export interface FavseedOptions {
  /** The mark, relative to the project root. Default: `src/logo.svg`. */
  input?: string;
  /** Padded PNG sizes, the manifest's "any maskable" icons. A real array: the CLI's string form exists only because argv is strings. Default: `[192, 512]`. */
  sizes?: number[];
  /** Explicit palette ceiling, 2-256. Selects quality 100 when quality is omitted. */
  colors?: number;
  /** PNG quality target, integer 1-100. Default 80, or 100 when colors is supplied alone. Below 100 cannot combine with colors; not an error percentage or a file-size guarantee. */
  quality?: number;
  /** Ground of the padded icons. `null` keeps the set transparent and unpadded, declared `"any"` only. Default: `#000000`. */
  bg?: string | null;
  /** Margin of each padded icon, as a percentage per side. `'auto'` measures the mark's own extent and snaps it to whole pixels; a number overrides it. Default: `'auto'`. */
  padding?: number | 'auto';
  /** CSS custom properties, with or without the leading `--`. */
  vars?: Record<string, string | number>;
  /** `false` explicitly removes animation from icon.svg. Default: preserve it. */
  animation?: boolean;
  /** Extra lossless PNG compression. Slower; disabled by default. */
  zopfli?: boolean;
  /** Compression effort when Zopfli is enabled. Default: 'release' (120); 'fast' uses 15. */
  mode?: 'release' | 'fast';
  /**
   * `true` writes an icons-only site.webmanifest. An object is merged in ahead of the
   * icons. The CLI cannot know your app's name; an integration can.
   */
  manifest?: boolean | Record<string, unknown>;
  /**
   * What to build while the dev server runs.
   * `'fast'` (default) is one 256 px size; Zopfli runs at 15 iterations only when opted in.
   * `'full'` builds the real set. `'skip'`
   * builds nothing.
   */
  dev?: 'fast' | 'skip' | 'full';
  /**
   * `'inject'` (default) splices the tags before `</head>`, skipping any page that already
   * has a `<link rel="icon">`. `true` is an alias for `'inject'`.
   * `'component'` leaves it to `favseed/astro/Head.astro`. `false` logs the
   * block for you to paste.
   */
  head?: true | 'inject' | 'component' | false;
}

export default function favseed(options?: FavseedOptions): AstroIntegration;
