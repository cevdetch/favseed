// favseed itself, from this checkout: buildFiles() with no options is the CLI's default set
// (default effort, #000000 ground, no manifest), the bytes `favseed logo.svg` writes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildFiles } from '../../../bin/favseed.mjs';

const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
// Until the first release package.json says 0.0.0, which names no build; the commit does.
const commit = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

export const id = 'favseed';
export const label = version === '0.0.0' ? `favseed (commit ${commit()})` : `favseed ${version}`;

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
