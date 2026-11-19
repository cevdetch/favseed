// After `astro build`: read dist/, work out what an offline visit needs (offline-lists.mjs), and
// write sw.js and version.json. A file the lists cannot place fails the build, so a new chunk
// cannot silently stay online-only.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { offlineLists } from './offline-lists.mjs';

const OTHER = [
  '/site.webmanifest',
  '/favicon.ico',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
];
const noindex = (html) => /<meta name="robots" content="[^"]*noindex/.test(html);

export async function writeOffline(distUrl) {
  const dist = fileURLToPath(distUrl);
  const files = (await readdir(dist, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  const html = new Map();
  for (const entry of files.filter((e) => e.name.endsWith('.html'))) {
    const file = join(entry.parentPath, entry.name);
    const path =
      '/' +
      relative(dist, file)
        .split(sep)
        .join('/')
        .replace(/\.html$/, '');
    html.set(path === '/index' ? '/' : path, await readFile(file, 'utf8'));
  }
  const precache = [...html].filter(([path, page]) => path === '/404' || !noindex(page)).map(([path]) => path);
  const astro = new Map();
  for (const name of await readdir(join(dist, '_astro'))) astro.set(name, await readFile(join(dist, '_astro', name)));
  const other = new Map();
  for (const url of OTHER) other.set(url, await readFile(join(dist, url)));

  const lists = offlineLists({ html, precache, astro, other });
  if (lists.unlisted.length) throw new Error(`offline: no list for ${lists.unlisted.join(', ')}`);
  const { pages, engines, engineHash, version } = lists;
  const worker = await readFile(new URL('../src/sw/sw.js', import.meta.url), 'utf8');
  await writeFile(
    join(dist, 'sw.js'),
    `self.FAVSEED_OFFLINE = ${JSON.stringify({ pages, engines, engineHash, version })};\n${worker}`,
  );
  await writeFile(join(dist, 'version.json'), `${JSON.stringify({ engine: engineHash, version })}\n`);
  return { engineHash, version };
}
