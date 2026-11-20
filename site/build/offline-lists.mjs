// Which files the service worker caches, read from the built site. Pure: it takes file names and
// bytes and returns lists and hashes, so it is tested without a build. The engine graph is
// followed by file name: Vite writes every chunk, worker and asset URL into the importing file as
// a string holding the hashed name, so a name found in a file's text is a file it loads.
import { createHash } from 'node:crypto';

const ASTRO = '/_astro/';
const url = (name) => ASTRO + name;
const text = (bytes) => new TextDecoder('latin1').decode(bytes);

const closure = (roots, astro) => {
  const names = [...astro.keys()];
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    // Only scripts load other files; a .wasm holds no file names worth following.
    if (!/\.m?js$/.test(name)) continue;
    const body = text(astro.get(name));
    for (const next of names) if (!seen.has(next) && body.includes(next)) queue.push(next);
  }
  return seen;
};

const only = (astro, pattern) => {
  const found = [...astro.keys()].filter((name) => pattern.test(name));
  if (found.length !== 1) throw new Error(`offline lists: expected one ${pattern.source}, found ${found.length}`);
  return found[0];
};

const hash = (entries) => {
  const sha = createHash('sha256');
  for (const [path, bytes] of entries) sha.update(`${path}\0`).update(bytes).update('\0');
  return sha.digest('hex');
};

export function offlineLists({ html, precache, astro, other }) {
  const engine = closure([only(astro, /^engine-worker-.*\.js$/)], astro);
  const threaded = closure([only(astro, /^image\.wasi-browser-.*\.js$/)], astro);
  const compatibility = closure([only(astro, /^image\.wasip1-browser-.*\.js$/)], astro);
  // A file in both loaders' graphs, or in neither, is shared; one in a single graph belongs to
  // that build only, so a browser downloads only the build it can run.
  const shared = [...engine].filter((name) => threaded.has(name) === compatibility.has(name));
  const engines = {
    threaded: [...new Set([...shared, ...threaded])].map(url).toSorted(),
    compatibility: [...new Set([...shared, ...compatibility])].map(url).toSorted(),
  };

  // Every page's scripts, followed to what they load, minus the engine: the homepage script and
  // the pipeline that starts the engine worker are small and needed before any build.
  const pageRoots = [...astro.keys()].filter((name) => [...html.values()].some((page) => page.includes(url(name))));
  const pageAssets = [...closure(pageRoots, astro)].filter((name) => !engine.has(name));

  const pages = [...precache, ...other.keys(), ...pageAssets.map(url)].toSorted();
  const listed = new Set([...engine, ...pageAssets]);
  const unlisted = [...astro.keys()]
    .filter((name) => !listed.has(name))
    .map(url)
    .toSorted();

  const bytesOf = (path) =>
    path.startsWith(ASTRO)
      ? astro.get(path.slice(ASTRO.length))
      : html.has(path)
        ? new TextEncoder().encode(html.get(path))
        : other.get(path);
  const engineHash = hash(
    [...new Set([...engines.threaded, ...engines.compatibility])].toSorted().map((u) => [u, bytesOf(u)]),
  );
  const version = hash([['engine', new TextEncoder().encode(engineHash)], ...pages.map((u) => [u, bytesOf(u)])]);
  return { pages, engines, engineHash, version, unlisted };
}
