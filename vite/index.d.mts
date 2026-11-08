// Hand-written, like bin/favseed.d.mts: the plugin takes the config keys minus `out`.
import type { Plugin } from 'vite';
import type { FavseedConfig } from '../bin/favseed.d.mts';
import type { ManifestIcon } from '../lib/core.mjs';
export type { ManifestIcon } from '../lib/core.mjs';

/** favseed.config.* keys, minus `out`: Vite's build.outDir decides where the files go. */
export type FavseedViteOptions = Omit<FavseedConfig, 'out'>;

/**
 * The favicon set as a Vite plugin. Dev serves it from memory (effort `'fast'`); a build emits it
 * at the output root and links it in index.html. Options win over favseed.config.* in the
 * Vite root. Default input: `src/logo.svg`.
 */
export default function favseed(options?: FavseedViteOptions): Plugin;

/** The icon entries favseed's manifest lists, for vite-plugin-pwa's `manifest.icons`. */
export function favseedIcons(options?: Pick<FavseedConfig, 'sizes' | 'bg' | 'base'>): ManifestIcon[];
