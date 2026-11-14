// RealFaviconGenerator's generator, @realfavicongenerator/generate-favicon 0.9.0, rendering through
// @realfavicongenerator/image-adapter-node 0.9.0 (https://github.com/RealFaviconGenerator/core/tree/v0.9.0).
// generateFaviconFiles with initFaviconIconSettings(), the library's own defaults, is what the
// official `realfavicon generate` CLI runs for a settings file holding only those defaults.
// The default embeds attribution metadata in every PNG and SVG (src/metadata/index.ts); it stays,
// because it is the default.
import { readFile } from 'node:fs/promises';
import { importDep, pinned } from '../deps.mjs';

const pkg = pinned('@realfavicongenerator/generate-favicon', '0.9.0');
pinned('@realfavicongenerator/image-adapter-node', '0.9.0');
const { generateFaviconFiles, initFaviconIconSettings, stringToSvg } = await importDep(
  '@realfavicongenerator/generate-favicon',
);
const { getNodeImageAdapter } = await importDep('@realfavicongenerator/image-adapter-node');
const adapter = await getNodeImageAdapter();

export const id = 'realfavicon';
export const label = `RealFaviconGenerator (generate-favicon ${pkg.version})`;

const generate = async (svgPath) => {
  const masterIcon = { icon: stringToSvg(await readFile(svgPath, 'utf8'), adapter) };
  const files = await generateFaviconFiles(masterIcon, { icon: initFaviconIconSettings(), path: '/' }, adapter);
  return Object.entries(files).map(([name, contents]) => ({
    name,
    bytes: new Uint8Array(typeof contents === 'string' ? Buffer.from(contents) : contents),
  }));
};

export async function wholeSet(svgPath) {
  return { files: await generate(svgPath) };
}

// The default web app manifest icons are already transparent and full-bleed: the 0.7 image scale
// in initWebAppManifestSettings only applies to the 'background' transformation, and the default
// is 'none' (src/icon/helper.ts lines 90-136).
export async function likeForLike(svgPath) {
  const files = await generate(svgPath);
  const pick = (name) => files.find((file) => file.name === name).bytes;
  return { 192: pick('web-app-manifest-192x192.png'), 512: pick('web-app-manifest-512x512.png') };
}
