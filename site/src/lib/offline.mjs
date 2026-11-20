// The page's side of the service worker (src/sw/sw.js): registration, the engine download for an
// installed app, the check before each build and the state a reload must carry. Every browser API
// arrives as an argument, so the Node tests drive it with stand-ins.
const RESUME = 'favseed:resume';
const RELOADED = 'favseed:engine-reloaded';

export function registerOffline({ sw, isStandalone, onInstalled, variant, saveData }) {
  if (!sw) return null;
  const registered = sw.register('/sw.js').catch(() => null);
  const cacheEngine = () =>
    registered
      .then((registration) => registration && sw.ready)
      .then((ready) => {
        const kind = variant();
        if (ready?.active && kind && !saveData()) ready.active.postMessage({ type: 'cache-engine', variant: kind });
      })
      .catch(() => {});
  if (isStandalone()) cacheEngine();
  onInstalled(cacheEngine);
  return registered;
}

const ask = (worker, timeoutMs) =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(value);
    };
    channel.port1.onmessage = ({ data }) => finish(data);
    worker.postMessage({ type: 'get-version' }, [channel.port2]);
  });

// The browser may not have fetched the new sw.js yet: ask it to, then wait for that worker to
// finish installing. Nothing new within the limit (a deploy still spreading) gives null.
const waitForInstalled = (registration, timeoutMs) =>
  new Promise((resolve) => {
    if (!registration) return resolve(null);
    if (registration.waiting) return resolve(registration.waiting);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const finish = (worker) => {
      clearTimeout(timer);
      resolve(worker);
    };
    const watch = (worker) =>
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') finish(worker);
        else if (worker.state === 'redundant') finish(null);
      });
    watch(registration.installing);
    registration.addEventListener('updatefound', () => watch(registration.installing));
    registration
      .update()
      .then(() => registration.waiting && finish(registration.waiting))
      .catch(() => finish(null));
  });

export async function checkEngine({ sw, fetch, storage, timeoutMs = 3000, installTimeoutMs = 30000 }) {
  const controller = sw?.controller;
  // No worker controls the page, so the engine comes from the network and is the current one.
  if (!controller) return { status: 'current' };
  const [mine, latest] = await Promise.all([
    ask(controller, timeoutMs),
    fetch('/version.json', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
  ]);
  if (!mine || !latest) return { status: 'unchecked' };
  if (mine.engineHash === latest.engine) return { status: 'current' };
  // Without storage an update could not resume or be limited to one reload: build on what is here.
  if (!storage || storage.getItem(RELOADED)) return { status: 'stale' };
  const waiting = await waitForInstalled(await sw.getRegistration(), installTimeoutMs);
  if (!waiting) return { status: 'stale' };
  return {
    status: 'update',
    apply: () => {
      storage.setItem(RELOADED, '1');
      waiting.postMessage({ type: 'skip-waiting' });
    },
  };
}

export function saveResume(storage, state) {
  try {
    if (!storage) return false;
    storage.setItem(RESUME, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function takeResume(storage) {
  try {
    if (!storage) return null;
    const raw = storage.getItem(RESUME);
    storage.removeItem(RESUME);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
