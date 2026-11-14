// Checks on the built site (run `pnpm --filter favseed-site build` first): every indexable page
// has its own title, description and canonical URL, one H1, a JSON-LD graph whose @id links
// resolve, the header bar, and links that land on a built page and an existing anchor. Markdown
// pages also have their .md alternate and are drawn as cards, the sitemap dates every page, and
// every site link in the README lands on a built page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { pageSources } from '../build/lastmod.mjs';

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
  const local = hrefs(bars[0]).filter((link) => link.startsWith('/'));
  assert.ok(local.length > 0, 'the header bar links no page of the site');
  for (const href of local) {
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
    assert.ok(headings.length > 0, `${path}: no h2`);
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

test('every site link in the README lands on a built page and an existing anchor', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const links = [...readme.matchAll(/https:\/\/favseed\.cevdet\.ch(\/[^\s)>"]*)?/g)].map((match) => match[1] ?? '/');
  assert.ok(links.length >= 8, 'the README links the docs pages');
  for (const href of links) {
    const resolved = resolveLink(href);
    assert.ok(resolved, `README links ${href}, which the site does not build`);
    if (resolved.fragment)
      assert.ok(resolved.html && ids(resolved.html).has(resolved.fragment), `README: ${href} has no target`);
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

const markdownPages = indexable.filter((path) => /<link rel="alternate" type="text\/markdown"/.test(pages.get(path)));

test('every Markdown page links its .md alternate, which exists and starts with the page heading', () => {
  assert.ok(markdownPages.includes('/docs'), 'the docs hub is a Markdown page');
  for (const path of markdownPages) {
    const html = pages.get(path);
    const href = /<link rel="alternate" type="text\/markdown" href="([^"]+)"/.exec(html)[1];
    assert.equal(href, `${urlOf(path)}.md`, path);
    const markdown = readFileSync(join(dist, `${path}.md`), 'utf8');
    const heading = /<h1>([^<]*)<\/h1>/.exec(html)[1];
    assert.ok(markdown.startsWith(`# ${decode(heading)}\n`), `${path}.md starts with its heading`);
    assert.ok(!markdown.startsWith('---'), `${path}.md carries no frontmatter`);
  }
});

test('Markdown pages are drawn as cards: <main> holds only <section> elements', () => {
  for (const path of markdownPages) {
    const main = /<main>([\s\S]*)<\/main>/.exec(pages.get(path))[1].trim();
    // Removing every <section>…</section> (they do not nest) must leave nothing behind.
    assert.match(main, /^<section>/, path);
    assert.equal(main.replace(/<section>[\s\S]*?<\/section>/g, '').trim(), '', `${path}: content outside a card`);
  }
});

test('llms.txt links every indexable page once: Markdown pages by their .md alternate', () => {
  const text = readFileSync(join(dist, 'llms.txt'), 'utf8');
  assert.match(text, /^# favseed\n\n> /);
  const links = [...text.matchAll(/\]\((https:\/\/favseed\.cevdet\.ch\/[^)]*)\)/g)].map((match) => match[1]);
  const listed = links
    .map((href) => new URL(href).pathname.replace(/\.md$/, ''))
    .map((path) => (path === '' ? '/' : path));
  const pagesListed = listed.filter((path) => pages.has(path));
  assert.deepEqual([...new Set(pagesListed)].sort(), indexable, 'llms.txt lists exactly the indexable pages');
  assert.equal(new Set(pagesListed).size, pagesListed.length, 'a page is listed twice');
  for (const href of links) {
    const path = new URL(href).pathname;
    if (path.endsWith('.md')) assert.ok(existsSync(join(dist, path)), `${href} does not exist`);
    else if (pages.has(path === '/' ? '/' : path))
      assert.ok(!markdownPages.includes(path), `${href} should link the .md alternate`);
  }
});

test('llms-full.txt holds every Markdown page in full', () => {
  const text = readFileSync(join(dist, 'llms-full.txt'), 'utf8');
  for (const path of markdownPages) {
    const markdown = readFileSync(join(dist, `${path}.md`), 'utf8');
    assert.ok(text.includes(markdown.trim()), `${path} is missing from llms-full.txt`);
  }
});

const site = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) =>
  execFileSync('git', args, { cwd: site, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
// Without git, or in a shallow clone, the build leaves the dates out, so there is nothing to check.
let shallow;
try {
  shallow = git('rev-parse', '--is-shallow-repository') === 'true' && 'shallow clone';
} catch {
  shallow = 'no git repository';
}

test('the sitemap dates every page from git, unless the clone is shallow', { skip: shallow }, () => {
  const xml = readFileSync(join(dist, 'sitemap-0.xml'), 'utf8');
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  assert.equal(entries.length, indexable.length);
  for (const entry of entries) {
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(entry)?.[1];
    assert.ok(lastmod, `no lastmod in ${entry}`);
    assert.ok(Date.parse(lastmod) <= Date.now(), `${lastmod} is in the future`);
  }
});

test(
  'every article is dated from git, matching its sitemap lastmod, unless the clone is shallow',
  { skip: shallow },
  () => {
    const xml = readFileSync(join(dist, 'sitemap-0.xml'), 'utf8');
    const lastmods = new Map(
      [...xml.matchAll(/<loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g)].map((match) => [match[1], match[2]]),
    );
    for (const path of articles) {
      const article = graphOf(pages.get(path))['@graph'].find((node) => node['@type'] === 'TechArticle');
      assert.ok(article.datePublished && article.dateModified, `${path}: article dates`);
      assert.ok(article.datePublished <= article.dateModified, `${path}: published after modified`);
      assert.equal(article.dateModified, lastmods.get(urlOf(path)), `${path}: dateModified and lastmod differ`);
    }
  },
);

test('an article is published on the first commit of its own source file', { skip: shallow }, () => {
  for (const path of articles) {
    const article = graphOf(pages.get(path))['@graph'].find((node) => node['@type'] === 'TechArticle');
    const [own] = pageSources(path);
    assert.ok(own, `${path}: no source file`);
    const first = git('log', '--follow', '--format=%cI', '--', own).split('\n').at(-1);
    assert.equal(article.datePublished, new Date(first).toISOString(), `${path}: datePublished`);
  }
});
