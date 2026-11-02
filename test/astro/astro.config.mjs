import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import favseed from 'favseed/astro';

const { ssr = false, ...options } = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: '/blog',
  publicDir: './static',
  devToolbar: { enabled: false },
  output: ssr ? 'server' : 'static',
  adapter: ssr ? node({ mode: 'middleware' }) : undefined,
  integrations: [favseed({ sizes: [48], manifest: true, ...options })],
});
