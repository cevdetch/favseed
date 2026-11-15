// favicons 7.3.1 (https://github.com/itgalaxy/favicons/tree/v7.3.1): favicons(source) with no
// options. Every platform defaults on (src/config/defaults.ts), so every image and every file it
// returns counts. favicon.svg is not among them: it is marked `optional` (src/platforms/favicons.ts
// line 11), and src/platforms/base.ts lines 51 and 57 drop optional icons unless a caller lists
// them by name.
import { importDep, pinned } from '../deps.mjs';

const pkg = pinned('favicons', '7.3.1');
const { default: favicons } = await importDep('favicons');

export const id = 'favicons';
export const label = `favicons ${pkg.version}`;
export const versions = { favicons: pkg.version };
// The sharp copy favicons resolves: its reference is rendered by the same librsvg build.
export const sharpFrom = pkg.path;

const bytes = (contents) => new Uint8Array(typeof contents === 'string' ? Buffer.from(contents) : contents);

export async function wholeSet(svgPath) {
  const { images, files } = await favicons(svgPath);
  return { files: [...images, ...files].map(({ name, contents }) => ({ name, bytes: bytes(contents) })) };
}

// The default Android icons, which are transparent with offset 0 (transparentIcon,
// src/config/icons.ts lines 3-11): the same entries the default set builds, asked for alone.
export async function likeForLike(svgPath) {
  const off = { favicons: false, appleIcon: false, appleStartup: false, windows: false, yandex: false };
  const { images } = await favicons(svgPath, {
    icons: { ...off, android: ['android-chrome-192x192.png', 'android-chrome-512x512.png'] },
  });
  const pick = (name) => bytes(images.find((image) => image.name === name).contents);
  return { 192: pick('android-chrome-192x192.png'), 512: pick('android-chrome-512x512.png') };
}
