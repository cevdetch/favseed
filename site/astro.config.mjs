import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { readFile, writeFile } from 'node:fs/promises';
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
    // A few small pages and one small stylesheet: inlining removes the only render-blocking
    // request, which a visitor who reads one page would otherwise pay for. 'always', not the
    // default 'auto', so a stylesheet that grows past 4 KB does not turn back into a request
    // unnoticed.
    inlineStylesheets: 'always',
  },
  integrations: [
    sitemap({
      // The homepage and the documentation pages are indexable; /check and the 404 page are
      // noindex and stay out.
      filter: (page) => !['/check', '/404'].includes(new URL(page).pathname),
    }),
    {
      name: 'favseed-host',
      hooks: {
        'astro:config:setup': ({ command, updateConfig }) => {
          if (command === 'dev')
            updateConfig({
              server: { headers: developmentHeaders },
              vite: { server: { headers: developmentHeaders } },
            });
        },
        // Hashed build assets never change under the same name; everything else is revalidated.
        'astro:build:done': async ({ dir }) => {
          await writeFile(new URL('_headers', dir), productionHeaders);
          const vendor = new URL('./vendor/image-wasm32-wasip1/', import.meta.url);
          const notices = await Promise.all(
            ['LICENSE', 'THIRD-PARTY-NOTICES.txt'].map((name) => readFile(new URL(name, vendor), 'utf8')),
          );
          await writeFile(new URL('engine-licenses.txt', dir), notices.join('\n\n'));
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
      assetsInlineLimit: (file) => (/\.m?js$/.test(file) ? false : undefined),
    },
    worker: { format: 'es', plugins: () => [wasiRuntime()] },
    optimizeDeps: { exclude: ['@napi-rs/image-wasm32-wasi'] },
  },
});
