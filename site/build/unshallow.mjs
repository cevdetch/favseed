// Fetch the full git history before a Cloudflare Pages build. The sitemap's lastmod and the
// articles' datePublished and dateModified come from git history (build/lastmod.mjs), and Pages
// always clones with --depth=1, where every date is left out. Anywhere else, and in a clone that
// already has its history, this does nothing. A failed fetch only costs the dates, so it never
// fails the deployment.
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

if (process.env.CF_PAGES === '1') {
  let shallow = false;
  try {
    shallow = git('rev-parse', '--is-shallow-repository') === 'true';
  } catch {
    // Not a git checkout: there is no history to fetch.
  }
  if (!shallow) {
    console.log('unshallow: not a shallow git clone, nothing to fetch');
  } else {
    try {
      git('fetch', '--unshallow', '--quiet');
      console.log('unshallow: fetched the full git history, so pages carry their dates');
    } catch {
      console.log('unshallow: could not fetch the full git history, so pages carry no dates');
    }
  }
}
