export * from './favseed.mjs';
import type { FavseedOptions } from '../astro/types.mjs';

/** Astro's installer factory. The structural return keeps ordinary library
 * imports independent of the optional Astro peer. For typed hooks, use favseed/astro. */
export default function favseed(options?: FavseedOptions): { name: string; hooks: object };
