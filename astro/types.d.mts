// Shared options do not require the optional Astro peer.
import type { ImageOptions } from '../lib/types.mjs';

export interface FavseedOptions extends ImageOptions {
  /** The mark, relative to the project root. Default: `src/logo.svg`. */
  input?: string;
  /**
   * `'inject'` (default) splices the tags before `</head>`, skipping any page that already
   * has a `<link rel="icon">`. `true` is an alias for `'inject'`.
   * `'component'` leaves it to `favseed/astro/Head.astro`. `false` logs the
   * block for you to paste.
   */
  head?: true | 'inject' | 'component' | false;
}
