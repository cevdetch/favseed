import favseed, { build, buildFiles, defineConfig, type BuildResult, type BuildFilesResult, type FavseedConfig } from 'favseed';
import favseedVite, { favseedIcons, type ManifestIcon } from 'favseed/vite';
import favseedAstro, { type FavseedOptions } from 'favseed/astro';
import type { Plugin } from 'vite';
import type { AstroIntegration } from 'astro';

const config: FavseedConfig = defineConfig({
  input: 'logo.svg', out: 'public', base: '/blog/', sizes: [192, 512],
  bg: null, quality: 80, padding: 'auto', vars: { brand: '#123456', width: 2 },
  animation: false, manifest: { name: 'Example' }, zopfli: false, mode: 'fast',
});
const result: Promise<BuildResult> = build({ ...config, input: 'logo.svg' });
const memoryResult: Promise<BuildFilesResult> = buildFiles({ input: 'logo.svg', onWarn: console.warn });
const memory = await memoryResult;
const firstName: string = memory.files[0].name;
const firstBytes: Uint8Array = memory.files[0].bytes;
const links: string = memory.links;
const animated: boolean = memory.animated;
const placement: BuildResult['fit'] = memory.fit;
// @ts-expect-error In-memory output has no published directory.
memory.dir;
// @ts-expect-error Input remains required for an in-memory build.
buildFiles({ quality: 80 });
// @ts-expect-error File contents are bytes, not text.
const text: string = memory.files[0].bytes;
const plugin: Plugin = favseedVite({ input: 'src/logo.svg', sizes: [48], quality: 80, base: '/blog/' });
const icons: ManifestIcon[] = favseedIcons({ sizes: [192, 512], bg: null, base: '/blog/' });
const options: FavseedOptions = {
  input: 'src/logo.svg', head: true, dev: 'full', quality: 80, bg: 'none',
  sizes: [48], vars: { brand: '#123456' }, manifest: { name: 'Example' }, animation: false,
};
const integration: AstroIntegration = favseedAstro(options);
const rootIntegration: AstroIntegration = favseed(options);
const defaultIntegration: AstroIntegration = favseed();
const sameFactory: typeof favseedAstro = favseed;
export { config, result, memoryResult, firstName, firstBytes, links, animated, placement,
  plugin, icons, integration, rootIntegration, defaultIntegration, sameFactory };
