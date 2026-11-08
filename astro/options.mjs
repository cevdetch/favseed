// Host-specific validation and wording; the shared validator remains the authority
// for build values, without loading SVG/native engines during Astro configuration.
import { FavseedError } from '../lib/core.mjs';
import { CONFIG_KEYS, configurationError, normaliseOptions, REPLACED_BY_EFFORT } from '../lib/config.mjs';

const keys = [...CONFIG_KEYS.filter((key) => key !== 'out' && key !== 'base'), 'head'];

/** Validate original options, before the Vite plugin's dev overrides or hook side effects can hide errors. */
export const validateOptions = (options) => {
  const fail = (message) => {
    throw new FavseedError(`favseed: ${message}`);
  };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('options must be an object');
  const unknown = Object.keys(options).filter((key) => !keys.includes(key));
  if (unknown.length) {
    const hints = [];
    if (unknown.includes('out')) hints.push("out is controlled by Astro's build output (outDir, build.client)");
    if (unknown.includes('base')) hints.push('base is controlled by Astro config.base');
    if (unknown.includes('zopfli') || unknown.includes('mode')) hints.push(REPLACED_BY_EFFORT);
    fail(
      `unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `'${key}'`).join(', ')}; ` +
        `the options are ${keys.join(', ')}` +
        (hints.length ? `. ${hints.join('; ')}` : ''),
    );
  }
  const { input = 'src/logo.svg', head = 'inject', bg, vars } = options;
  if (typeof input !== 'string' || !input.trim()) fail('input must be a non-empty string');
  if (![true, false, 'inject', 'component'].includes(head))
    fail(`head must be true, 'inject', 'component' or false, got ${JSON.stringify(head)}`);
  if (bg !== undefined && bg !== null && (typeof bg !== 'string' || !bg.trim()))
    fail('bg must be a non-empty string or null');
  if (vars !== undefined && (vars === null || typeof vars !== 'object' || Array.isArray(vars)))
    fail('vars must be an object or Map');
  try {
    normaliseOptions(options);
  } catch (error) {
    if (!(error instanceof FavseedError)) throw error;
    fail(configurationError(error).message);
  }
};
