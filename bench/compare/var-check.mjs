// How librsvg draws CSS custom properties, through every sharp copy the competitors resolve:
// a fill given only by a definition (`:root { --c: … }` and `var(--c)`), only by a fallback
// (`var(--c, …)`), and by both. Each SVG is one 8 x 8 square; the check reads its centre pixel.
//
//   node bench/compare/var-check.mjs          prints the result for every copy, as JSON
//
// Each copy runs in its own process, as in run.mjs, so two libvips builds never share one.
// run.mjs records the same result in results.json (`varCheck`).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { depsDir, requireDep } from './deps.mjs';

const COLOUR = '#0e7c68';
const svg = (style, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" width="8" height="8">` +
  `${style ? `<style>${style}</style>` : ''}<rect width="8" height="8" style="fill:${fill}"/></svg>`;
export const CASES = {
  definition: svg(`:root{--c:${COLOUR}}`, 'var(--c)'),
  fallback: svg('', `var(--c, ${COLOUR})`),
  both: svg(':root{--c:#ff0000}', `var(--c, ${COLOUR})`),
};
// The package.json each copy resolves from: the root's (favicons, the Vite PWA assets generator
// and favseed's reference), favilib's (astro-favicons) and the RealFaviconGenerator adapter's.
const ANCHORS = [
  'package.json',
  'node_modules/favilib/package.json',
  'node_modules/@realfavicongenerator/image-adapter-node/package.json',
];

const hex = ([r, g, b, a]) =>
  a === 0 ? 'transparent' : `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

async function one(anchor) {
  const sharp = requireDep('sharp', join(depsDir, anchor));
  const drawn = {};
  for (const [name, text] of Object.entries(CASES)) {
    const { data, info } = await sharp(Buffer.from(text)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = ((info.height >> 1) * info.width + (info.width >> 1)) * 4;
    drawn[name] = hex(data.subarray(at, at + 4));
  }
  return { sharp: sharp.versions.sharp, librsvg: sharp.versions.rsvg, drawn };
}

/** Every copy, each in a child process of this script. */
export function varCheck() {
  return {
    colour: COLOUR,
    copies: ANCHORS.map((anchor) =>
      JSON.parse(
        execFileSync(process.execPath, [import.meta.filename, '--anchor', anchor], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ),
    ),
  };
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { anchor: { type: 'string' } } });
  if (values.anchor) process.stdout.write(JSON.stringify(await one(values.anchor)));
  else console.log(JSON.stringify(varCheck(), null, 2));
}
