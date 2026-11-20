// favseed's service worker: a classic script, because module service workers are not available
// in every browser the site supports. The build (build/write-offline.mjs) puts the file lists in
// front of this file as `self.FAVSEED_OFFLINE`. Pages are cached when the worker installs; the
// engine (about 5 MB per build) only when the site runs as an installed app or a build fetches it.
// Every worker global is read through `self`, so the Node tests can import a fresh copy of this
// file against their own stand-ins.
((self) => {
  'use strict';
  const { caches, fetch } = self;
  const { pages, engines, engineHash, version } = self.FAVSEED_OFFLINE;
  const PAGES = `pages-${version}`;
  const ENGINE = `engine-${engineHash}`;
  const VARIANTS = ['threaded', 'compatibility'];
  const done = (variant) => `/__complete/${variant}`;
  // Survives every deploy: it is what tells a new worker that this browser runs the installed app.
  const STATE = 'favseed-state';
  const INSTALLED = '/__installed';
  // Lists hold paths; a Request needs an absolute URL outside the browser (the Node tests).
  const absolute = (path) => new URL(path, self.location.origin);
  const pageSet = new Set(pages);
  const engineSet = new Set([...engines.threaded, ...engines.compatibility]);

  // The same slash-free path the site's canonical URLs use: /docs.html and /docs/ are /docs.
  const keyOf = (pathname) => pathname.replace(/(?:(^|\/)index)?\.html$/, '$1').replace(/(.)\/$/, '$1') || '/';

  const route = (url, mode) => {
    if (url.origin !== self.location.origin) return 'pass';
    // Both must always come from the network: they are how a new version is found.
    if (url.pathname === '/sw.js' || url.pathname === '/version.json') return 'network';
    if (engineSet.has(url.pathname)) return 'engine';
    if (mode === 'navigate') return 'navigate';
    if (pageSet.has(url.pathname)) return 'page';
    return 'pass';
  };

  const store = async (name, key, response) => {
    if (!response.ok || response.type === 'opaque') return;
    try {
      await (await caches.open(name)).put(key, response);
    } catch (error) {
      console.warn(`favseed: could not cache ${key} in ${name}`, error);
    }
  };

  // Cache housekeeping must never fail a response or stop activation: the network answer or the
  // activated worker is what the browser needs, and a missed marker or prune is retried later.
  const tidy = async (task) => {
    try {
      await task();
    } catch (error) {
      console.warn('favseed: cache housekeeping stopped', error);
    }
  };

  const pruneEngines = async () => {
    for (const name of await caches.keys())
      if (name.startsWith('engine-') && name !== ENGINE) await caches.delete(name);
  };

  // A build is complete when every file in its list is stored; the marker goes in last, and only
  // then may an older engine go. The new worker of an installed app downloads its engine while it
  // installs, so the old worker, pages and engine keep serving until the new ones are all there;
  // only an active worker prunes, because a waiting one has tabs still using the older engine.
  const markIfComplete = async ({ prune = true } = {}) => {
    const cache = await caches.open(ENGINE);
    for (const variant of VARIANTS) {
      if (await cache.match(done(variant))) continue;
      const stored = await Promise.all(engines[variant].map((url) => cache.match(url)));
      if (stored.every(Boolean)) await cache.put(done(variant), new Response(''));
    }
    if (!prune) return;
    for (const variant of VARIANTS) if (await cache.match(done(variant))) return pruneEngines();
  };

  const download = async (variant, { prune = true } = {}) => {
    if (!engines[variant]) return;
    const cache = await caches.open(ENGINE);
    if (await cache.match(done(variant))) return;
    for (const url of engines[variant]) {
      if (await cache.match(url)) continue;
      const response = await fetch(new Request(absolute(url), { cache: 'reload' }));
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      await cache.put(url, response);
    }
    await markIfComplete({ prune });
  };

  const respond = async (kind, request, url) => {
    if (kind === 'engine') {
      const hit = await (await caches.open(ENGINE)).match(url.pathname);
      if (hit) return hit;
      const response = await fetch(request);
      await store(ENGINE, url.pathname, response.clone());
      await tidy(markIfComplete);
      return response;
    }
    const cache = await caches.open(PAGES);
    const hit = await cache.match(kind === 'navigate' ? keyOf(url.pathname) : url.pathname);
    if (hit) return hit;
    try {
      return await fetch(request);
    } catch (error) {
      const missing = kind === 'navigate' && (await cache.match('/404'));
      if (!missing) throw error;
      return new Response(missing.body, { status: 404, statusText: 'Not Found', headers: missing.headers });
    }
  };

  const installedVariant = async () => {
    try {
      const flag = await (await caches.open(STATE)).match(INSTALLED);
      return flag ? (await flag.json()).variant : null;
    } catch {
      return null;
    }
  };

  self.addEventListener('install', (event) => {
    // No skipWaiting: an open page loads engine chunks lazily, and a deploy removes the old ones.
    event.waitUntil(
      (async () => {
        const cache = await caches.open(PAGES);
        await cache.addAll(pages.map((url) => new Request(absolute(url), { cache: 'reload' })));
        // A failed download fails the install: the old worker then stays, with its own engine.
        // Activation prunes the older engine once this worker takes over.
        const variant = await installedVariant();
        if (variant) await download(variant, { prune: false });
      })(),
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        await self.clients.claim();
        await tidy(async () => {
          for (const name of await caches.keys())
            if (name.startsWith('pages-') && name !== PAGES) await caches.delete(name);
        });
        await tidy(markIfComplete);
      })(),
    );
  });

  self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    const kind = route(url, request.mode);
    if (kind === 'pass' || kind === 'network') return;
    event.respondWith(respond(kind, request, url));
  });

  self.addEventListener('message', (event) => {
    const { type, variant } = event.data ?? {};
    if (type === 'get-version') event.ports[0]?.postMessage({ engineHash, version });
    else if (type === 'cache-engine')
      event.waitUntil(
        (async () => {
          if (VARIANTS.includes(variant))
            await tidy(async () => {
              const state = await caches.open(STATE);
              await state.put(INSTALLED, new Response(JSON.stringify({ variant })));
            });
          await download(variant).catch((error) => console.warn('favseed: the engine download stopped', error));
        })(),
      );
    else if (type === 'skip-waiting') event.waitUntil(self.skipWaiting());
  });

  self.favseedWorker = { route, keyOf, respond, markIfComplete, download };
})(self);
