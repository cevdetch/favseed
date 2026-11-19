// Names and URLs every page shares, so the header bar is the same everywhere. The JSON-LD nodes
// come from structured-data.ts, the copy every cevdet.ch site shares.
export const SITE = 'https://favseed.cevdet.ch';
export const REPO = 'https://github.com/cevdetch/favseed';

// A page's slash-free path from the URL Astro renders it at: /docs.html and /docs/index.html
// are /docs, the homepage is /. Canonical URLs, breadcrumbs and JSON-LD all start from it.
export const pathOfUrl = (pathname) => pathname.replace(/(?:(^|\/)index)?\.html$/, '$1').replace(/(.)\/$/, '$1') || '/';

// The canonical URL of the page Astro renders at pathname.
export const pageUrl = (pathname) => new URL(pathOfUrl(pathname), SITE).href;

// The header bar. A section joins it when its first page exists.
export const nav = [
  ['/', 'Generator'],
  ['/docs', 'Docs'],
  ['/guides', 'Guides'],
  ['/compare', 'Compare'],
  ['/benchmarks', 'Benchmarks'],
  [REPO, 'GitHub'],
];
