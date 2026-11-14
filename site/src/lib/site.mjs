// Names, URLs and structured-data nodes every page shares, so each page's JSON-LD graph uses the
// same @ids and the header bar is the same everywhere.
export const SITE = 'https://favseed.cevdet.ch';

export const ids = {
  website: `${SITE}/#website`,
  app: `${SITE}/#app`,
  source: `${SITE}/#source`,
  person: 'https://cevdet.ch/#person',
};

export const person = {
  '@type': 'Person',
  '@id': ids.person,
  name: 'Cevdet',
  url: 'https://cevdet.ch/',
  sameAs: ['https://github.com/cevdetch'],
};

// Every page's graph defines the site and its author itself: search engines read one page's
// graph at a time and do not follow an @id to another page.
export const website = { '@type': 'WebSite', '@id': ids.website, name: 'favseed', url: `${SITE}/`, inLanguage: 'en' };

// The header bar. A section joins it when its first page exists.
export const nav = [
  ['/', 'Generator'],
  ['/benchmarks', 'Benchmarks'],
  ['https://github.com/cevdetch/favseed', 'GitHub'],
];

// JSON inside <script> ends at the first "</script", so every "<" is escaped.
export const jsonLd = (graph) =>
  JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replaceAll('<', '\\u003c');

// trail runs from Home to the page itself, as the visible breadcrumb shows it.
export const breadcrumbList = (url, trail) => ({
  '@type': 'BreadcrumbList',
  '@id': `${url}#breadcrumb`,
  itemListElement: trail.map(([href, name], index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name,
    item: new URL(href, SITE).href,
  })),
});
