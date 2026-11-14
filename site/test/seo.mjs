// Checks on the built site (run `pnpm --filter favseed-site build` first): every indexable page
// has its own title, description and canonical URL, one H1, a JSON-LD graph whose @id links
// resolve, the header bar, and links that land on a built page and an existing anchor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const SITE = 'https://favseed.cevdet.ch';
const HOME_TITLE = 'SVG favicon generator: one SVG, an optimised set - favseed';
export const dist = fileURLToPath(new URL('../dist/', import.meta.url));

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const pathnameOf = (file) => {
  const path =
    '/' +
    relative(dist, file)
      .split(sep)
      .join('/')
      .replace(/\.html$/, '');
  return path === '/index' ? '/' : path;
};
export const pages = new Map(
  walk(dist)
    .filter((file) => file.endsWith('.html'))
    .map((file) => [pathnameOf(file), readFileSync(file, 'utf8')]),
);
const noindex = (html) => /<meta name="robots" content="[^"]*noindex/.test(html);
export const indexable = [...pages.keys()].filter((path) => !noindex(pages.get(path))).toSorted();
// Every indexable page but the homepage is an article on the Doc layout.
const articles = indexable.filter((path) => path !== '/');
export const urlOf = (path) => new URL(path, SITE).href;

const all = (html, re) => [...html.matchAll(re)].map((match) => match[1]);
const one = (html, re, what) => {
  const found = all(html, re);
  assert.equal(found.length, 1, `${what}: expected one, found ${found.length}`);
  return found[0];
};
const decode = (text) =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
export const meta = (html, key) =>
  decode(one(html, new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`, 'g'), key));
export const titleOf = (html) => decode(one(html, /<title>([^<]*)<\/title>/g, 'title'));
export const graphOf = (html) =>
  JSON.parse(one(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, 'JSON-LD'));
// Anything that renders a page without a header bar is not one of the site's pages.
const navOf = (html) => one(html, /<nav aria-label="Site"[^>]*>([\s\S]*?)<\/nav>/g, 'header bar');
const hrefs = (html) => all(html, /<a [^>]*href="([^"]+)"/g).map(decode);
const ids = (html) => new Set(all(html, /\sid="([^"]+)"/g));

test('the noindex pages are exactly /404 and /check', () => {
  assert.deepEqual([...pages.keys()].filter((path) => noindex(pages.get(path))).toSorted(), ['/404', '/check']);
});

test('every indexable page has its own title, description and canonical URL, and one H1', () => {
  const titles = new Set(),
    descriptions = new Set();
  for (const path of indexable) {
    const html = pages.get(path);
    const title = titleOf(html);
    const description = meta(html, 'description');
    if (path === '/') assert.equal(title, HOME_TITLE);
    else assert.match(title, / - favseed$/, path);
    assert.ok(
      description.length >= 120 && description.length <= 160,
      `${path}: description is ${description.length} characters`,
    );
    assert.ok(!titles.has(title), `${path}: duplicate title`);
    assert.ok(!descriptions.has(description), `${path}: duplicate description`);
    titles.add(title);
    descriptions.add(description);
    assert.equal(one(html, /<link rel="canonical" href="([^"]+)"/g, 'canonical'), urlOf(path), path);
    assert.equal(meta(html, 'og:url'), urlOf(path), path);
    assert.equal(meta(html, 'og:title'), title, path);
    assert.equal(meta(html, 'og:description'), description, path);
    assert.equal(all(html, /<(h1)[\s>]/g).length, 1, `${path}: one H1`);
    // The generator's effort labels predate this check; every article page is held to it.
    if (path !== '/') assert.doesNotMatch(html, /\u2014/, `${path}: em dash in the page`);
  }
});

test('every JSON-LD graph parses and each @id reference is defined in the same graph', () => {
  for (const path of indexable) {
    const { '@context': context, '@graph': graph } = graphOf(pages.get(path));
    assert.equal(context, 'https://schema.org', path);
    assert.ok(Array.isArray(graph), `${path}: @graph`);
    const defined = new Set(graph.map((node) => node['@id']).filter(Boolean));
    assert.ok(defined.has(`${SITE}/#website`) && defined.has('https://cevdet.ch/#person'), `${path}: site and person`);
    const references = [];
    const visit = (value) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '@id') references.push(value['@id']);
        else Object.values(value).forEach(visit);
      }
    };
    graph.forEach((node) => Object.values(node).forEach(visit));
    for (const id of references) assert.ok(defined.has(id), `${path}: ${id} is referenced but not defined`);
  }
});

test('the homepage graph describes the site, the web app and the source code', () => {
  const graph = graphOf(pages.get('/'))['@graph'];
  const byType = Object.fromEntries(graph.map((node) => [node['@type'], node]));
  assert.equal(byType.WebSite.url, `${SITE}/`);
  assert.deepEqual(byType.WebSite.publisher, { '@id': 'https://cevdet.ch/#person' });
  assert.equal(byType.WebApplication.url, `${SITE}/`);
  assert.equal(byType.WebApplication.offers.price, '0');
  assert.deepEqual(byType.WebApplication.author, { '@id': 'https://cevdet.ch/#person' });
  assert.equal(byType.SoftwareSourceCode.codeRepository, 'https://github.com/cevdetch/favseed');
  assert.deepEqual(byType.SoftwareSourceCode.author, { '@id': 'https://cevdet.ch/#person' });
});

test('every page but the homepage is an article with a breadcrumb trail matching the one shown', () => {
  for (const path of articles) {
    const html = pages.get(path);
    const graph = graphOf(html)['@graph'];
    const article = graph.find((node) => node['@type'] === 'TechArticle' || node['@type'] === 'Article');
    assert.ok(article, `${path}: article`);
    assert.equal(article.url, urlOf(path), path);
    assert.deepEqual(article.author, { '@id': 'https://cevdet.ch/#person' }, path);
    assert.deepEqual(article.isPartOf, { '@id': `${SITE}/#website` }, path);
    const list = graph.find((node) => node['@type'] === 'BreadcrumbList');
    assert.ok(list, `${path}: BreadcrumbList`);
    const shown = one(html, /<nav aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/g, 'breadcrumb');
    const shownLinks = all(shown, /<a href="([^"]+)"/g).map((href) => urlOf(href));
    const items = list.itemListElement.map((item) => item.item);
    assert.deepEqual(items.slice(0, -1), shownLinks, `${path}: breadcrumb links`);
    assert.equal(items.at(-1), urlOf(path), `${path}: breadcrumb ends on the page`);
    assert.equal(items[0], `${SITE}/`, `${path}: breadcrumb starts at home`);
  }
});

test('every indexable page has the same header bar, and it links only indexable pages', () => {
  const bars = indexable.map((path) => navOf(pages.get(path)).replace(/ aria-current="page"/g, ''));
  assert.equal(new Set(bars).size, 1, 'the header bar differs between pages');
  for (const href of hrefs(bars[0]).filter((link) => link.startsWith('/'))) {
    assert.ok(indexable.includes(href), `header bar links ${href}, which is not an indexable page`);
  }
});

test('pages other than the homepage ship no JavaScript', () => {
  for (const path of articles) {
    const html = pages.get(path);
    const scripts = all(html, /<script([^>]*)>/g).filter(
      (attributes) => !/type="application\/ld\+json"/.test(attributes),
    );
    assert.deepEqual(scripts, [], `${path}: script elements`);
    assert.doesNotMatch(html, /rel="modulepreload"/, path);
  }
});

test('every section heading on an article page has a unique id', () => {
  for (const path of articles) {
    const headings = all(pages.get(path), /<h2([^>]*)>/g);
    const headingIds = headings.map((attributes) => /\sid="([^"]+)"/.exec(attributes)?.[1]);
    assert.ok(headingIds.every(Boolean), `${path}: an h2 without an id`);
    assert.equal(new Set(headingIds).size, headingIds.length, `${path}: duplicate h2 id`);
  }
});

// A link to /foo is served by foo.html, foo itself (a .txt, .md or image) or foo/index.html.
export const resolveLink = (href) => {
  const [path, fragment] = href.split('#');
  const target = path === '' || path === '/' ? '/' : path;
  if (pages.has(target)) return { html: pages.get(target), fragment };
  const file = join(dist, decodeURIComponent(target));
  if (existsSync(file) && statSync(file).isFile()) return { html: null, fragment };
  return null;
};

test('every internal link lands on a built file, and every fragment on an existing id', () => {
  for (const path of indexable) {
    const html = pages.get(path);
    for (const href of hrefs(html).filter((link) => link.startsWith('/') || link.startsWith('#'))) {
      const resolved = href.startsWith('#') ? { html, fragment: href.slice(1) } : resolveLink(href);
      assert.ok(resolved, `${path}: ${href} does not resolve`);
      if (resolved.fragment)
        assert.ok(resolved.html && ids(resolved.html).has(resolved.fragment), `${path}: ${href} has no target`);
    }
  }
});

test('the sitemap lists exactly the indexable pages', () => {
  const index = readFileSync(join(dist, 'sitemap-index.xml'), 'utf8');
  const listed = all(index, /<loc>([^<]+)<\/loc>/g).flatMap((loc) =>
    all(readFileSync(join(dist, new URL(loc).pathname), 'utf8'), /<loc>([^<]+)<\/loc>/g),
  );
  assert.deepEqual(listed.toSorted(), indexable.map(urlOf).toSorted());
});

test('robots.txt allows every crawler and names the sitemap', () => {
  const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.doesNotMatch(robots, /Disallow/);
  assert.match(robots, new RegExp(`^Sitemap: ${SITE}/sitemap-index\\.xml$`, 'm'));
});
