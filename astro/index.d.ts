import type { AstroIntegration } from 'astro';
import type { FavseedOptions } from './types.mjs';

export type { FavseedOptions } from './types.mjs';

export default function favseed(options?: FavseedOptions): AstroIntegration;
