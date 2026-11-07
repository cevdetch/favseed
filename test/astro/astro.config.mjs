import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import favseed from 'favseed/astro';

const {
  ssr = false,
  incremental = false,
  ...options
} = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: '/blog',
  publicDir: './static',
  devToolbar: { enabled: false },
  output: ssr ? 'server' : 'static',
  adapter: ssr ? node({ mode: 'middleware' }) : undefined,
  ...(incremental
    ? {
        experimental: { incrementalBuild: true },
        vite: { define: { __CONSUMER_VALUE__: JSON.stringify('kept') } },
      }
    : {}),
  integrations: [favseed({ sizes: [48], manifest: true, ...options })],
});
