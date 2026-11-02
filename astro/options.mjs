// Host-specific validation and wording; the shared validator remains the authority
// for build values, without loading SVG/native engines during Astro configuration.
import { FavseedError } from '../lib/core.mjs';
import { CONFIG_KEYS, normaliseOptions } from '../lib/config.mjs';

const keys = [...CONFIG_KEYS.filter((key) => key !== 'out' && key !== 'base'), 'dev', 'head'];

/** Translate diagnostic syntax only, retaining user values, filenames and --CSS names. */
export const configurationError = (error) => {
  if (!(error instanceof FavseedError)) return error;
  const message = error.message
    .replace(/^--(colors|quality|sizes|padding|bg)\b/, '$1')
    .replace(/^--var name(?= must be a CSS custom property)/, 'vars name')
    .replace(/^quality below 100 cannot be combined with --colors;/, 'quality below 100 cannot be combined with colors;')
    .replace(/^(unresolved var\([^)]*\) - no fallback and no )--var(?= override)/, '$1vars')
    .replace(/ - supply it with --var name=value(, or drop the animation with --no-animation)?$/, (_, motion) =>
      ' - supply it with vars: { name: value }' + (motion ? ', or set animation: false' : ''))
    .replace(/\n       use --bg none for a transparent, unpadded set$/, '\n       use bg: null for a transparent, unpadded set');
  return message === error.message ? error : new FavseedError(message);
};

/** Validate original options, before dev overrides or hook side effects can hide errors. */
export const validateOptions = (options) => {
  const fail = (message) => { throw new FavseedError(`favseed: ${message}`); };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('options must be an object');
  const unknown = Object.keys(options).filter((key) => !keys.includes(key));
  if (unknown.length) {
    const hints = [];
    if (unknown.includes('out')) hints.push('out is controlled by Astro publicDir');
    if (unknown.includes('base')) hints.push('base is controlled by Astro config.base');
    fail(`unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `'${key}'`).join(', ')}; `
      + `the options are ${keys.join(', ')}` + (hints.length ? `. ${hints.join('; ')}` : ''));
  }
  const { input = 'src/logo.svg', dev = 'fast', head = 'inject', bg, vars } = options;
  if (typeof input !== 'string' || !input.trim()) fail('input must be a non-empty string');
  if (!['fast', 'skip', 'full'].includes(dev)) fail(`dev must be 'fast', 'skip' or 'full', got ${JSON.stringify(dev)}`);
  if (![true, false, 'inject', 'component'].includes(head)) fail(`head must be true, 'inject', 'component' or false, got ${JSON.stringify(head)}`);
  if (bg !== undefined && bg !== null && (typeof bg !== 'string' || !bg.trim())) fail('bg must be a non-empty string or null');
  if (vars !== undefined && (vars === null || typeof vars !== 'object' || Array.isArray(vars))) fail('vars must be an object or Map');
  try { normaliseOptions(options); }
  catch (error) {
    if (!(error instanceof FavseedError)) throw error;
    fail(configurationError(error).message);
  }
};
