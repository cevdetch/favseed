// favseed/vite: the favicon set as a Vite plugin. In dev it is built on the first request for
// an icon and served from memory; in a build it is emitted at the output root. Nothing is
// written to public/, and a file there with a name favseed emits is never shadowed.
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildFiles, CONFIG_FILES, engineVersions, FavseedError, linkTags, loadConfigFile } from '../bin/favseed.mjs';
import { normaliseOptions, resolveOptions } from '../lib/config.mjs';
import { declaresIcon, manifestIcons } from '../lib/core.mjs';
import { cacheKey, favseedVersion, readSlot, writeSlot } from './cache.mjs';

/**
 * The icon entries favseed's manifest would list, for vite-plugin-pwa's `manifest.icons`.
 * Synchronous, because vite.config runs before any build; pass the sizes, bg and base the
 * favseed plugin uses. vite-plugin-pwa offers no public API to set them from another plugin.
 */
export const favseedIcons = ({ sizes, bg, base } = {}) => {
  const o = normaliseOptions({ sizes, bg, base });
  return manifestIcons({ sizes: o.sizes, base: o.base, purpose: o.bg === null ? null : 'any maskable' });
};

const VIRTUAL = 'virtual:favseed';
const RESOLVED = '\0virtual:favseed';
const PWA = 'vite-plugin-pwa';
const TYPES = { ico: 'image/x-icon', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json' };
const message = (e) => (e instanceof FavseedError ? `favseed: ${e.message}` : String(e?.message ?? e));

/**
 * Only a real build's client environment emits. Astro also runs a `client` environment in
 * `dev` mode (its sync server), a `prerender` one and, for SSR, an `ssr` one; emitting there
 * leaves dead copies in dist/server/ or warns that emitFile is not supported in serve mode.
 */
const emitsHere = (env) => env?.mode === 'build' && env.config?.consumer === 'client';

export default function favseed(options = {}) {
  if ('out' in options) throw new FavseedError("the Vite plugin has no 'out': Vite's build.outDir decides where the files go");
  let root, publicDir, viteBase, cacheDir, logger, pwa = null;
  // Kept per mode: configResolved can fire on one instance for a dev-mode server and for the
  // build (Astro runs both in one `astro build`), and dev forces fast mode. One shared
  // promise would let the first caller decide the mode of the release bytes.
  const settings = { dev: null, build: null };   // Promise<{ merged, o, names, links }>
  const sets = { dev: null, build: null };       // Promise<{ name, bytes }[]>
  let built = null;                              // the files this build emits
  const warned = new Set();
  const warnOnce = (text) => { if (!warned.has(text)) { warned.add(text); logger.warn(text); } };

  /** Plugin options over favseed.config.* in the Vite root over the defaults. */
  const resolveSettings = async (dev) => {
    const { config, file, ignored } = await loadConfigFile(root);
    for (const f of ignored) warnOnce(`favseed: ${f} ignored: ${file} is the config file in use`);
    // Vite's base is the default when it is a path. './' (relative) and a URL (a CDN) say
    // where the bundle lives, not the path the icons are served under.
    const vitePath = /^\/(?!\/)/.test(viteBase) ? viteBase : null;
    if ((options.base ?? config.base) === undefined && vitePath === null) {
      warnOnce(`favseed: Vite's base '${viteBase}' is not a path, so the icon links use '/'; set base in the favseed options to change it`);
    }
    const merged = resolveOptions({ input: 'src/logo.svg', base: vitePath ?? '/' }, config, options);
    delete merged.out;
    merged.input = resolve(root, merged.input);
    if (dev) merged.mode = 'fast';
    if (merged.bg === undefined) {
      warnOnce('favseed: bg not given, using #000000 for the padded icons (iOS composites transparent icons onto black)');
    }
    // vite-plugin-pwa writes and links its own manifest.webmanifest.
    if (pwa && merged.manifest) {
      warnOnce('favseed: vite-plugin-pwa writes the manifest, so favseed does not; pass favseedIcons() to its manifest.icons');
    }
    if (pwa) merged.manifest = false;
    const o = normaliseOptions(merged);
    const names = ['icon.svg', 'favicon.ico', 'apple-touch-icon.png',
      ...o.sizes.map((s) => `icon-${s}.png`), ...(o.manifest ? ['site.webmanifest'] : [])];
    return { merged, o, names, links: linkTags(o.base, Boolean(o.manifest)) };
  };

  const settingsFor = (mode) => {
    if (!settings[mode]) {
      settings[mode] = resolveSettings(mode === 'dev');
      // Awaited later, by the hook that needs it; this stops Node reporting the rejection
      // of a bad option as unhandled in the meantime.
      settings[mode].catch(() => {});
    }
    return settings[mode];
  };

  /** The set for a mode's settings, from the cache when the key matches. */
  const setFor = (mode) => (sets[mode] ??= (async () => {
    const { merged } = await settingsFor(mode);
    const source = await readFile(merged.input).catch(() => { throw new FavseedError(`no such file: ${merged.input}`); });
    const key = cacheKey({ version: favseedVersion(), source, options: merged, engine: engineVersions() });
    const hit = await readSlot(cacheDir, key);
    if (hit) return hit;
    const fresh = await buildFiles({ ...merged, onWarn: (m) => warnOnce(`favseed: ${m}`) });
    await writeSlot(cacheDir, key, fresh.files);
    return fresh.files;
  })());

  /** True when public/ holds a different file under a name favseed emits. */
  const clash = (f) => {
    if (!publicDir) return false;
    const p = join(publicDir, f.name);
    return existsSync(p) && !Buffer.from(f.bytes).equals(readFileSync(p));
  };

  return {
    name: 'favseed',

    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir || null;
      viteBase = config.base;
      logger = config.logger;
      cacheDir = join(root, 'node_modules', '.cache', 'favseed');
      pwa = config.plugins.find((p) => p.name === PWA) ?? null;
    },

    configureServer(server) {
      const base = server.config.base;

      // Registered here, not returned: as a post hook, public/ and a framework's router
      // answer first.
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith(base)) return next();
        const name = path.slice(base.length);
        let files;
        try {
          if (!(await settingsFor('dev')).names.includes(name)) return next();
          files = await setFor('dev');
        } catch (e) {
          sets.dev = null;            // try again on the next request or change
          warnOnce(message(e));
          return next();
        }
        const f = files.find((x) => x.name === name);
        if (!f) return next();
        if (clash(f)) {
          warnOnce(`favseed: public/${f.name} exists and is not the file favseed builds; serving yours`);
          return next();
        }
        res.setHeader('Content-Type', TYPES[name.split('.').pop()]);
        res.setHeader('Cache-Control', 'no-cache');
        res.end(Buffer.from(f.bytes));
      });

      // The mark and the config file can sit outside the module graph, and outside the root.
      const watched = new Set();
      const watch = async () => {
        let s = null;
        try { s = await settingsFor('dev'); } catch { /* a bad option: watch the config files */ }
        const paths = [...CONFIG_FILES.map((f) => join(root, f)), ...(s ? [s.merged.input] : [])];
        for (const p of paths) if (!watched.has(p)) { watched.add(p); server.watcher.add(p); }
      };
      watch();
      const onChange = async (file) => {
        if (!watched.has(resolve(file))) return;
        settings.dev = null;
        sets.dev = null;
        warned.clear();
        await watch();
        const env = server.environments.client;
        const mod = env.moduleGraph.getModuleById(RESOLVED);
        if (mod) env.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      for (const event of ['change', 'add', 'unlink']) server.watcher.on(event, onChange);
    },

    async buildStart() {
      if (!emitsHere(this.environment)) return;
      try {
        built = await setFor('build');
      } catch (e) {
        sets.build = null;
        this.error(message(e));
      }
      // Here, not in generateBundle: an error here leaves the previous dist/ in place.
      for (const f of built) {
        if (clash(f)) {
          this.error(`favseed: public/${f.name} exists and is not the file favseed builds. ` +
            'Delete it to use favseed\'s, or remove the favseed plugin to keep yours.');
        }
      }
      if (pwa?.api?.pwaAssetsGenerator && await pwa.api.pwaAssetsGenerator()) {
        this.warn("favseed: vite-plugin-pwa's pwaAssets also writes favicon.ico and touch icons; turn one of them off");
      }
    },

    generateBundle() {
      if (!emitsHere(this.environment) || !built) return;
      for (const f of built) this.emitFile({ type: 'asset', fileName: f.name, source: f.bytes });
    },

    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        if (declaresIcon(html) || !html.includes('</head>')) return html;
        const { links } = await settingsFor(ctx.server ? 'dev' : 'build');
        return html.replace('</head>', `${links}</head>`);
      },
    },

    resolveId: (id) => (id === VIRTUAL ? RESOLVED : null),

    async load(id) {
      if (id !== RESOLVED) return null;
      const { names, links, o } = await settingsFor(this.environment?.mode === 'dev' ? 'dev' : 'build');
      const files = names.map((name) => ({ name, href: `${o.base}${name}`, type: TYPES[name.split('.').pop()] }));
      return `export const links = ${JSON.stringify(links)};\nexport const files = ${JSON.stringify(files)};\n`;
    },
  };
}
