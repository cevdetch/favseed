// Astro's automatic installer imports the package root. Keep the executable
// independent of the integration while preserving all existing named imports.
export * from './favseed.mjs';
export { default } from '../astro/index.mjs';
