// astro-favicons 3.1.8 is an Astro integration with no standalone API: in astro:config:setup it
// hands its options to favilib, its engine, once per platform, and serves or emits whatever comes
// back. Running a whole Astro build per input would time Astro, not the generator, so this runs
// favilib exactly as the integration does, with the integration's own defaults.
//
// What this misses: anything the integration does around favilib (its <head> middleware, the
// Vite plugin that serves and emits the files). Neither changes a byte of the files.
import { importDep, packageJson, pinned } from '../deps.mjs';

const pkg = pinned('astro-favicons', '3.1.8');
// favilib as astro-favicons resolves it (its dependency is ^1.0.5), not some other copy.
pinned('favilib', '1.0.5', pkg.path);
const { default: favilib } = await importDep('favilib', pkg.path);

export const id = 'astro-favicons';
export const label = `astro-favicons ${pkg.version}`;
export const engine = `favilib ${packageJson('favilib', pkg.path).version}`;

// Copied verbatim from src/config/defaults.ts lines 4-29 at v3.1.8,
// https://github.com/ACP-CODE/astro-favicons/blob/v3.1.8/src/config/defaults.ts#L4-L29
// (dist/index.mjs lines 5-30 of the published 3.1.8). The 512 px Android icon is the one icon
// with a margin, a fixed 13 %, and the only one declared maskable.
const defaults = {
  name: null,
  short_name: null,
  icons: {
    android: [
      'android-chrome-192x192.png',
      {
        name: 'android-chrome-512x512.png',
        sizes: [{ width: 512, height: 512 }],
        purpose: 'maskable',
        transparent: true,
        rotate: false,
        offset: 13,
      },
    ],
    appleIcon: ['apple-touch-icon.png', 'apple-touch-icon-precomposed.png', 'safari-pinned-tab.svg'],
    appleStartup: false,
    favicons: true,
    windows: true,
    yandex: true,
  },
};

// getIconsForPlatform and fetch, src/core/index.ts lines 29-78 at v3.1.8
// (https://github.com/ACP-CODE/astro-favicons/blob/v3.1.8/src/core/index.ts#L29-L78): one favilib
// call per platform with every other platform switched off, all platforms concurrently.
const forPlatform = (input, options, platform) =>
  favilib(input, {
    ...options,
    icons: Object.fromEntries(Object.entries(options.icons).map(([key, value]) => [key, key === platform && value])),
  });

const run = async (svgPath, options) => {
  const responses = await Promise.all(
    Object.keys(options.icons).map((platform) => forPlatform(svgPath, options, platform)),
  );
  return responses.flatMap((response) => [...response.images, ...response.files]);
};

const bytes = (contents) => new Uint8Array(typeof contents === 'string' ? Buffer.from(contents) : contents);

export async function wholeSet(svgPath) {
  // src/index.ts lines 27 and 40: `{ ...defaults, ...options }`, then withCapo from Astro's
  // compressHTML, which defaults to true. The input is the user's one option here.
  const files = await run(svgPath, { ...defaults, input: svgPath, withCapo: true });
  return { files: files.map(({ name, contents }) => ({ name, bytes: bytes(contents) })) };
}

// favilib's own Android entries, transparent with offset 0, as favicons builds them: the
// integration's 512 px icon carries its fixed 13 % margin, which would not be like for like.
export async function likeForLike(svgPath) {
  const files = await run(svgPath, {
    ...defaults,
    // Every platform named, the rest off: favilib turns on any platform its options leave out.
    icons: {
      android: ['android-chrome-192x192.png', 'android-chrome-512x512.png'],
      appleIcon: false,
      appleStartup: false,
      favicons: false,
      windows: false,
      yandex: false,
    },
  });
  const pick = (name) => bytes(files.find((file) => file.name === name).contents);
  return { 192: pick('android-chrome-192x192.png'), 512: pick('android-chrome-512x512.png') };
}
