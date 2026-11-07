// The favseed Astro integration.
//
// Three things decide the shape of this file:
//
//   * The build belongs in astro:build:start, not astro:build:done. Writing into public/
//     before Astro's own copy step means the ordinary static-asset pipeline carries the
//     files to outDir: correct for static output AND for every SSR adapter, for free.
//     Building in astro:build:done means writing into `dir` by hand and getting it wrong
//     for any adapter that post-processes dist/.
//   * astro:config:setup must not build. It runs on every dev-server restart, and a 20-30 s
//     stall there is not a tool, it is a hostage situation. It only resolves paths, watches
//     the input and registers the middleware.
//   * Not re-running the build is a CONTENT-ADDRESSED CACHE, not a heuristic. See cacheKey
//     in vite/cache.mjs, which every host shares.

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FavseedError, linkTags } from '../lib/core.mjs';
import { normaliseOptions } from '../lib/config.mjs';
import { cacheKey, favseedVersion, writeSlot } from '../vite/cache.mjs';
import { generatedAsset, pruneCache, readCachedSet } from './cache.mjs';
import { configurationError, validateOptions } from './options.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** `/` and `/blog/` both come out as a prefix ending in a single slash. */
const basePrefix = (base) => (base && base !== '/' ? `/${base.replace(/^\/+|\/+$/g, '')}/` : '/');

/** Check ownership without changing public files or the record during development. */
const checkPublic = async ({ files, publicDir, stampPath }) => {
  let stamp = {};
  try {
    const value = JSON.parse(await readFile(stampPath, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) stamp = value;
  } catch {
    /* Missing or unreadable ownership metadata grants no ownership. */
  }

  for (const f of files) {
    const target = join(publicDir, f.name);
    if (!(await exists(target))) continue;
    const current = sha256(await readFile(target));
    // Already the bytes about to be written. Nothing to protect, and no stamp needed. That
    // is the case after `rm -rf node_modules`, where the stamp is gone but the files in
    // public/ are still favseed's because the same input and the same tools produce the same
    // bytes. Without this, a clean install would accuse the user of hand-editing their own
    // generated favicon.
    if (current === sha256(f.bytes)) continue;
    if (stamp[f.name] === current) continue; // ours, from an earlier build
    const starter =
      f.name === 'favicon.ico' && (await exists(join(publicDir, 'favicon.svg')))
        ? `\n       If migrating an Astro starter, also move ${join(publicDir, 'favicon.svg')} and remove its old <link rel="icon"> tags.`
        : '';
    throw new FavseedError(
      `${target} already exists and differs from the generated file.\n` +
        `       Favseed cannot verify ownership: the file may be edited or its ownership record missing.\n` +
        `       Back up and move the existing file before rebuilding.${starter}`,
    );
  }
  return stamp;
};

/** Production publishes independent copies, retaining the established ownership rules. */
const publish = async ({ files, publicDir, stampPath, logger }) => {
  const stamp = await checkPublic({ files, publicDir, stampPath });
  await mkdir(publicDir, { recursive: true });
  const next = {};
  for (const f of files) {
    const dst = join(publicDir, f.name);
    await rm(dst, { force: true });
    // Public edits must not mutate cached bytes. Otherwise reintroducing an edited
    // orphan can adopt those mutated bytes as generated, then delete the user's file.
    await writeFile(dst, f.bytes);
    next[f.name] = sha256(f.bytes);
  }

  // Use actual directory entries, never stamp keys as paths. Only unchanged regular
  // generated files are ours to remove; user replacements and symlinks stay intact.
  const active = new Set(files.map((f) => f.name));
  for (const entry of await readdir(publicDir, { withFileTypes: true })) {
    const name = entry.name;
    if (
      active.has(name) ||
      !generatedAsset(name) ||
      !entry.isFile() ||
      !Object.hasOwn(stamp, name) ||
      typeof stamp[name] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(stamp[name])
    )
      continue;
    const target = join(publicDir, name);
    let bytes;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (sha256(bytes) === stamp[name]) await rm(target, { force: true });
    else logger?.warn(`kept public/${name}: it changed since favseed wrote it`);
  }
  await mkdir(dirname(stampPath), { recursive: true });
  await writeFile(stampPath, JSON.stringify(next, null, 2));
  logger?.info(`wrote ${files.length} files to public/`);
};

export default function favseed(options = {}) {
  validateOptions(options);
  const { input = 'src/logo.svg', dev = 'fast', head = 'inject', ...buildOptions } = options;

  const state = { links: '', inputPath: '', publicDir: '', cacheDir: '', base: '/', devFiles: new Map(), devStamp: {} };
  const stampPath = () => join(state.cacheDir, 'written.json');
  const prune = async (key, logger) => {
    try {
      await pruneCache(state.cacheDir, key);
    } catch (error) {
      logger?.warn(`could not prune favicon cache: ${error.message}`);
    }
  };

  /** One build, cache-first. `mode` is 'full' or 'fast'. */
  const runBuild = async (mode, logger) => {
    const source = await readFile(state.inputPath);
    // Dev uses one size and, only when opted in, 15 Zopfli iterations.
    // base goes into the build, not only the links: the manifest's icon URLs carry it too,
    // and without it a site under /blog links /blog/site.webmanifest whose icons 404.
    const opts =
      mode === 'fast'
        ? { ...buildOptions, base: state.base, sizes: [256], mode: 'fast' }
        : { ...buildOptions, base: state.base };

    // Recheck mutable values before cache lookup, including values that share a key.
    try {
      normaliseOptions(opts);
    } catch (error) {
      throw configurationError(error);
    }
    // Config, sync, preview and dev:skip need only the shared options and links.
    // Even a cache hit can inspect engine identity without initializing SVG/native engines.
    const { buildFiles, engineVersions } = await import('../bin/favseed.mjs');
    const key = cacheKey({ version: favseedVersion(), source, options: opts, engine: engineVersions() });
    const slot = join(state.cacheDir, key);
    const cached = await readCachedSet(slot);
    if (cached) {
      logger?.info(`cache hit (${key.slice(0, 12)})`);
      return { files: cached, key };
    }

    const { files } = await buildFiles({ ...opts, input: state.inputPath, onWarn: (m) => logger?.warn(m) }).catch(
      (error) => {
        throw configurationError(error);
      },
    );
    await writeSlot(state.cacheDir, key, files, Object.fromEntries(files.map((f) => [f.name, sha256(f.bytes)])));
    return { files, key };
  };

  return {
    name: 'favseed',
    hooks: {
      'astro:config:setup': ({ command, config, addWatchFile, addMiddleware, updateConfig, logger }) => {
        // Nothing to do for either: `sync` only writes types, and `preview` serves what a
        // previous build already produced.
        if (command === 'sync' || command === 'preview') return;

        state.inputPath = resolve(fileURLToPath(config.root), input);
        state.publicDir = fileURLToPath(config.publicDir);
        state.cacheDir = join(fileURLToPath(config.root), 'node_modules', '.cache', 'favseed');
        state.base = basePrefix(config.base);
        state.links = linkTags(state.base, Boolean(buildOptions.manifest));

        addWatchFile(state.inputPath);

        // The links have to reach the middleware and <Head />, neither of which can be
        // passed arguments. A virtual module is the one channel Astro offers that works
        // in dev and in build, for both consumers, with no file on disk to keep in sync.
        updateConfig({
          vite: {
            // Astro hashes Vite defines for incremental builds, but not integration
            // options or middleware. Include both the links and whether we inject
            // them so cached HTML cannot retain a previous head configuration.
            ...(command === 'build' && config.experimental?.incrementalBuild
              ? {
                  define: {
                    __FAVSEED_HEAD_SIGNATURE__: JSON.stringify(
                      sha256(JSON.stringify([state.links, head === true || head === 'inject'])),
                    ),
                  },
                }
              : {}),
            plugins: [
              {
                name: 'favseed:virtual',
                // Astro has separate dev/prerender/SSR environments. All server imports
                // need transformation because our installed middleware uses a virtual ID.
                configEnvironment(name, config) {
                  const consumer = config.consumer ?? (name === 'client' ? 'client' : 'server');
                  if (consumer === 'server' && config.resolve?.noExternal !== true) {
                    return { resolve: { noExternal: ['favseed'] } };
                  }
                },
                resolveId: (id) => (id === 'virtual:favseed' ? '\0virtual:favseed' : null),
                load: (id) =>
                  id === '\0virtual:favseed' ? `export const links = ${JSON.stringify(state.links)};` : null,
              },
            ],
          },
        });

        if (head === true || head === 'inject') {
          // 'post' so the splice happens after the page has produced its HTML.
          addMiddleware({ entrypoint: 'favseed/astro/middleware', order: 'post' });
        } else if (head === false) {
          logger.info(`add these to your <head>:\n${state.links}`);
        }
      },

      // Register before Astro's public/router middleware. Responses own their bytes;
      // neither a dev restart nor disk-cache eviction needs to modify public/.
      'astro:server:setup': async ({ server, logger }) => {
        if (!state.inputPath || dev === 'skip') return;
        const warned = new Set();
        const warnOnce = (message) => {
          if (!warned.has(message)) {
            warned.add(message);
            logger?.warn(message);
          }
        };
        const types = {
          ico: 'image/x-icon',
          svg: 'image/svg+xml',
          png: 'image/png',
          webmanifest: 'application/manifest+json',
        };
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next();
          // Astro strips base from req.url before integrations; Connect keeps the original.
          const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
          if (!path.startsWith(state.base)) return next();
          const file = state.devFiles.get(path.slice(state.base.length));
          if (!file) return next();
          try {
            let current;
            try {
              const target = join(state.publicDir, file.name);
              if ((await lstat(target)).isSymbolicLink()) return next();
              current = sha256(await readFile(target));
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
            // Recheck on requests: an author may replace a public file after startup.
            if (current && current !== sha256(file.bytes) && current !== state.devStamp[file.name]) {
              warnOnce(`kept public/${file.name}: it differs from the generated file; serving yours`);
              return next();
            }
            res.setHeader('Content-Type', types[file.name.split('.').pop()]);
            res.setHeader('Content-Length', file.bytes.byteLength);
            res.setHeader('Cache-Control', 'no-cache');
            res.end(req.method === 'HEAD' ? undefined : file.bytes);
          } catch (error) {
            warnOnce(String(error?.message ?? error));
            next();
          }
        });
        try {
          const { files, key } = await runBuild(dev === 'full' ? 'full' : 'fast', logger);
          const stamp = await checkPublic({ files, publicDir: state.publicDir, stampPath: stampPath() });
          state.devFiles = new Map(files.map((f) => [f.name, f]));
          state.devStamp = stamp;
          await prune(key, logger);
        } catch (e) {
          // A dev server that will not start because the favicon is unhappy is worse than a
          // dev server with no favicon. The production build still fails, and says why.
          logger.warn(e instanceof FavseedError ? e.message : String(e?.message ?? e));
        }
      },

      'astro:build:start': async ({ logger }) => {
        if (!state.inputPath) return;
        const { files, key } = await runBuild('full', logger);
        await publish({ files, publicDir: state.publicDir, stampPath: stampPath(), logger });
        await prune(key, logger);
      },
    },
  };
}
