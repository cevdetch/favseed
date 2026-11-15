// favseed itself, from this checkout: buildFiles() with no options is the CLI's default set
// (default effort, #000000 ground, no manifest), the bytes `favseed logo.svg` writes.
import { readFileSync } from 'node:fs';
import { buildFiles } from '../../../bin/favseed.mjs';
import { depsManifest } from '../deps.mjs';

const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

export const id = 'favseed';
// Until the first release package.json says 0.0.0, which names no build; run.mjs records the
// commit next to this label instead.
export const label = version === '0.0.0' ? 'favseed (unreleased)' : `favseed ${version}`;
// favseed renders with resvg, not sharp; its librsvg reference comes from the root sharp copy.
export const sharpFrom = depsManifest;

// Warnings (a non-square viewBox, for one) go nowhere: the CLI prints them, the set is the same.
const quiet = () => {};

export async function wholeSet(svgPath) {
  const { files } = await buildFiles({ input: svgPath, onWarn: quiet });
  return { files: files.map(({ name, bytes }) => ({ name, bytes })) };
}

// --bg none: icon-192.png and icon-512.png transparent and unpadded, the like-for-like pair.
export async function likeForLike(svgPath) {
  const { files } = await buildFiles({ input: svgPath, bg: 'none', onWarn: quiet });
  const pick = (name) => files.find((f) => f.name === name).bytes;
  return { 192: pick('icon-192.png'), 512: pick('icon-512.png') };
}
