import favseed, { build, defineConfig, type BuildResult, type FavseedConfig } from 'favseed';
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
export { config, result, plugin, icons, integration, rootIntegration, defaultIntegration, sameFactory };
