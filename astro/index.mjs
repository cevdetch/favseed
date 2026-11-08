// The favseed Astro integration: favseed/vite, plus the one thing Vite cannot do for Astro,
// which is putting the links into every page's <head>.
//
// Astro builds on Vite, so the icons are the Vite plugin's: built on the first request in dev
// and served from memory, emitted into the client build otherwise. Adapters ship the client
// build as static assets, so this is correct for static output and every SSR adapter alike,
// and nothing is written to public/: there is nothing to own, stamp or prune.
//
// Measured on Astro 7.3.8: every `astro build` runs a `client` build environment, even for a
// static site with no client scripts. Its outDir is dist/ for static output and dist/client/
// with the Node adapter; the `prerender` and `ssr` environments write dist/.prerender/ and
// dist/server/, which no host serves. So the Vite plugin's client-only emit rule needs no
// Astro exception.
//
// astro:config:setup must not build. It runs on every dev-server restart; the Vite plugin
// builds lazily, from a content-addressed cache (vite/cache.mjs).
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { normaliseOptions } from '../lib/config.mjs';
import { linkTags } from '../lib/core.mjs';
import { validateOptions } from './options.mjs';

export default function favseed(options = {}) {
  validateOptions(options);
  const { head = 'inject', ...pluginOptions } = options;

  return {
    name: 'favseed',
    hooks: {
      'astro:config:setup': async ({ command, config, addMiddleware, updateConfig, logger }) => {
        // `sync` only writes types, and `preview` serves what a previous build produced.
        if (command === 'sync' || command === 'preview') return;
        // Imported here, not at the top: the Vite plugin loads the Node build module, which
        // configuration, `sync` and `preview` never need.
        const [{ default: favseedVite }, { loadConfigFile }] = await Promise.all([
          import('../vite/index.mjs'),
          import('../bin/favseed.mjs'),
        ]);
        const { base } = normaliseOptions({ base: config.base });
        // The plugin reads favseed.config.* too, and the manifest link depends on it. A broken
        // file is the plugin's to report: a warning in dev, a failed build otherwise.
        const file = await loadConfigFile(fileURLToPath(config.root)).then(
          (r) => r.config,
          () => ({}),
        );
        const links = linkTags(base, Boolean(pluginOptions.manifest ?? file.manifest));
        const inject = head === true || head === 'inject';

        updateConfig({
          vite: {
            // Astro hashes Vite defines for incremental builds, but not integration options or
            // middleware: fold the links and the injection mode in, so cached HTML cannot keep
            // a previous head.
            ...(command === 'build' && config.experimental?.incrementalBuild
              ? {
                  define: {
                    __FAVSEED_HEAD_SIGNATURE__: JSON.stringify(
                      createHash('sha256')
                        .update(JSON.stringify([links, inject]))
                        .digest('hex'),
                    ),
                  },
                }
              : {}),
            plugins: [
              favseedVite({ ...pluginOptions, base }),
              {
                name: 'favseed:astro',
                // The middleware imports virtual:favseed, so every server environment must
                // transform favseed rather than externalise it.
                configEnvironment(name, env) {
                  const consumer = env.consumer ?? (name === 'client' ? 'client' : 'server');
                  if (consumer === 'server' && env.resolve?.noExternal !== true) {
                    return { resolve: { noExternal: ['favseed'] } };
                  }
                },
              },
            ],
          },
        });

        // 'post' so the splice happens after the page has produced its HTML.
        if (inject) addMiddleware({ entrypoint: 'favseed/astro/middleware', order: 'post' });
        else if (head === false) logger.info(`add these to your <head>:\n${links}`);
      },
    },
  };
}
