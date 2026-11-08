// Shared options do not require the optional Astro peer.
import type { ImageOptions } from '../lib/types.mjs';

export interface FavseedOptions extends ImageOptions {
  /** The mark, relative to the project root. Default: `src/logo.svg`. */
  input?: string;
  /**
   * What to build while the dev server runs.
   * `'fast'` (default) is one 256 px size; Zopfli runs at 15 iterations only when opted in.
   * `'full'` builds the real set. Both serve from memory without changing public files
   * or their ownership record. `'skip'` builds and serves nothing.
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
