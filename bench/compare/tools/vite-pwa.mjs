// @vite-pwa/assets-generator 2.0.0 (https://github.com/vite-pwa/assets-generator/tree/v2.0.0) has
// no zero-config default: its CLI throws "No preset found" without one (src/cli-start.ts
// lines 73-74). minimal-2023 is the preset it points new projects to: `minimal` is marked
// "@deprecated use `minimal-2023` instead" (src/presets/minimal.ts lines 3-8). The whole set is
// that preset with nothing else changed.
//
// This follows the CLI's own path in memory: resolveInstructions with the options cli-start.ts
// passes it, then generateAssets' groups in its order (transparent, maskable, apple, favicon,
// splash screens), each group concurrently, minus the writeFile. The SVG favicon entry the
// instructions carry for an SVG source is the source itself, and generateAssets skips it.
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { importDep, pinned } from '../deps.mjs';

const pkg = pinned('@vite-pwa/assets-generator', '2.0.0');
const { instructions } = await importDep('@vite-pwa/assets-generator/api/instructions');
const { minimal2023Preset } = await importDep('@vite-pwa/assets-generator/presets/minimal-2023');

export const id = 'vite-pwa';
export const label = `@vite-pwa/assets-generator ${pkg.version}`;
export const preset = 'minimal-2023';
// The sharp copy the package resolves (sharp-ico nests an older one, used only to write the ICO).
export const sharpFrom = pkg.path;

const resolve = (svgPath, chosen) =>
  instructions({
    imageResolver: () => readFile(svgPath),
    imageName: svgPath,
    originalName: basename(svgPath),
    preset: chosen,
    htmlLinks: { xhtml: false, includeId: false },
    basePath: '/',
    resolveSvgName: (name) => basename(name),
  });

const build = async (entries) =>
  Promise.all(entries.map(async (icon) => ({ name: icon.name, bytes: new Uint8Array(await icon.buffer()) })));

export async function wholeSet(svgPath) {
  const steps = await resolve(svgPath, 'minimal-2023');
  const files = [];
  for (const group of ['transparent', 'maskable', 'apple', 'favicon', 'appleSplashScreen']) {
    const entries = Object.values(steps[group]).filter((icon) => !icon.name.endsWith('.svg'));
    files.push(...(await build(entries)));
  }
  return { files };
}

// The same preset with the transparent icons at 192 and 512 px and no padding (its default is
// 5 %, src/api/defaults.ts line 20), so they line up with the other tools' unpadded pairs.
// Everything else, the quality 60 encode included, stays the preset's.
export async function likeForLike(svgPath) {
  const steps = await resolve(svgPath, {
    ...minimal2023Preset,
    transparent: { ...minimal2023Preset.transparent, sizes: [192, 512], padding: 0 },
  });
  const [small, large] = await build(
    ['pwa-192x192.png', 'pwa-512x512.png'].map((name) =>
      Object.values(steps.transparent).find((icon) => icon.name === name),
    ),
  );
  return { 192: small.bytes, 512: large.bytes };
}
