import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { siteHeaders, developmentHeaders, productionHeaders } from './headers.mjs';
import { wasiRuntime } from './build/wasi-runtime.mjs';

// A static site on Cloudflare Pages, built from main by the Pages dashboard: no adapter, no
// deploy workflow. Everything that touches an SVG runs in the visitor's tab: there is no
// endpoint to upload a mark to, because there is no server to receive it.
export default defineConfig({
  site: 'https://favseed.cevdet.ch',
  output: 'static',
  // Astro owns document/preview responses and forwards these headers to Vite's assets.
  server: { headers: siteHeaders },
  // Cloudflare Pages canonicalises a directory index as /foo/ and 308s /foo to it. Emitting
  // /foo.html instead serves the slash-free URL with no redirect, which is Cloudflare's own
  // advice for this case, and the same pair deadhead.cevdet.ch uses.
  trailingSlash: 'never',
  build: {
    format: 'file',
    // One page and one small stylesheet, so there is no second page to share a cached file
    // with: inlining removes the only render-blocking request. 'always', not the default
    // 'auto', so a stylesheet that grows past 4 KB does not turn back into a request unnoticed.
    inlineStylesheets: 'always',
  },
  integrations: [
    sitemap({
      // Only the homepage is indexable; /check and error pages stay out.
      filter: (page) => new URL(page).pathname === '/',
    }),
    {
      name: 'favseed-host',
      hooks: {
        'astro:config:setup': ({ command, updateConfig }) => {
          if (command === 'dev') updateConfig({
            server: { headers: developmentHeaders },
            vite: { server: { headers: developmentHeaders } },
          });
        },
        // Hashed build assets never change under the same name; everything else is revalidated.
        'astro:build:done': async ({ dir }) => {
          await writeFile(new URL('_headers', dir), productionHeaders);
        },
      },
    },
  ],
  vite: {
    plugins: [wasiRuntime()],
    // lib/core.mjs lives above this directory: the site shares favseed's isomorphic half by
    // importing the file, not by copying it. Vite refuses to serve outside the project root in
    // dev unless told, and this is the one exception.
    server: { headers: siteHeaders, fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
    preview: { headers: siteHeaders },
    build: {
      target: 'esnext',
      // Keep executable scripts external even if a future bundle falls below Vite's limit.
      // Other assets retain Vite's default, and Astro still inlines the stylesheet above.
      assetsInlineLimit: (file) => /\.m?js$/.test(file) ? false : undefined,
    },
    worker: { format: 'es', plugins: () => [wasiRuntime()] },
    optimizeDeps: { exclude: ['@napi-rs/image-wasm32-wasi'] },
  },
});
