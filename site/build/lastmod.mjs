// Dates for a page from git: modified is the newest commit to any of its sources, published the
// first commit of its own file. Used for the sitemap's lastmod and the articles' dateModified and
// datePublished.
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
// stderr is dropped so a checkout without git history does not print `fatal:` into the build.
const git = (...args) =>
  execFileSync('git', args, { cwd: site, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

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

const commits = (...args) =>
  git('log', '--format=%cI', ...args)
    .split('\n')
    .filter(Boolean);

// The page was published when its own file first appeared, so an older extra source such as the
// byte manifest cannot date it earlier; --follow carries the date across a rename.
export const gitDates = (files) => {
  if (files.length === 0 || !gitUsable()) return {};
  try {
    const modified = commits('--', ...files)[0];
    const published = commits('--follow', '--', files[0]).at(-1);
    return { ...(modified && { modified: iso(modified) }), ...(published && { published: iso(published) }) };
  } catch {
    return {};
  }
};
