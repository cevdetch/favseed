// Dates for a page from git: the newest and the oldest commit that touched its source. Used for
// the sitemap's lastmod and the articles' dateModified and datePublished.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The site's root directory. The sitemap runs this file where it lies, in build/, but the build
// bundles it into a chunk under dist/ for the pages, so the root is found by walking up to the
// directory holding astro.config.mjs rather than by a fixed relative path.
const rootOf = (dir) =>
  existsSync(join(dir, 'astro.config.mjs')) || dirname(dir) === dir ? dir : rootOf(dirname(dir));
const site = rootOf(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: site, encoding: 'utf8' }).trim();

// A shallow clone reports its one commit as the last change to every file, which would date
// every page to the newest commit; no date is better than a wrong one.
let usable;
const gitUsable = () => {
  if (usable === undefined) {
    try {
      usable = git('rev-parse', '--is-shallow-repository') === 'false';
    } catch {
      usable = false;
    }
  }
  return usable;
};

// Numbers on /outputs come from the byte manifest, so a new manifest changes the page.
const extra = { '/outputs': ['../test/bytes.json'] };

export const pageSources = (pathname) => {
  const path = pathname.replace(/\/$/, '');
  const candidates =
    path === ''
      ? ['src/pages/index.astro']
      : [`src/content${path}.md`, `src/content${path}/index.md`, `src/pages${path}.astro`];
  const own = candidates.find((file) => existsSync(join(site, file)));
  return own ? [own, ...(extra[path] ?? [])] : [];
};

const iso = (date) => new Date(date).toISOString();

export const gitDates = (files) => {
  if (files.length === 0 || !gitUsable()) return {};
  const dates = git('log', '--format=%cI', '--', ...files)
    .split('\n')
    .filter(Boolean);
  if (dates.length === 0) return {};
  return { modified: iso(dates[0]), published: iso(dates.at(-1)) };
};
