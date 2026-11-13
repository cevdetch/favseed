import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { header } from '../../test/lib/png.mjs';

const canonical = 'https://favseed.cevdet.ch/';
const fixture = fileURLToPath(new URL('../../test/fixtures/tiles.svg', import.meta.url));

test('homepage metadata agrees with the canonical URL and served share image', async ({ page, request }) => {
  await page.goto('/');
  const head = page.locator('head');
  const attribute = async (selector, name = 'content') => {
    const element = head.locator(selector);
    await expect(element).toHaveCount(1);
    const value = await element.getAttribute(name);
    expect(value?.trim()).toBeTruthy();
    return value;
  };
  await expect(head.locator('title')).toHaveCount(1);
  const title = await page.title();
  expect(title.trim()).toBeTruthy();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect((await attribute('meta[charset]', 'charset')).toLowerCase()).toBe('utf-8');
  expect(await attribute('meta[name=viewport]')).toBe('width=device-width, initial-scale=1');
  const description = await attribute('meta[name=description]');
  expect(await attribute('link[rel=canonical]', 'href')).toBe(canonical);
  expect(await attribute('meta[property="og:url"]')).toBe(canonical);
  expect(await attribute('meta[property="og:title"]')).toBe(title);
  expect(await attribute('meta[property="og:description"]')).toBe(description);
  expect(await attribute('meta[property="og:type"]')).toBe('website');
  expect(await attribute('meta[name="twitter:card"]')).toBe('summary_large_image');
  const name = await attribute('meta[property="og:site_name"]');
  await expect(head.locator('meta[name=robots]')).toHaveCount(0);
  const schema = head.locator('script[type="application/ld+json"]');
  await expect(schema).toHaveCount(1);
  expect(JSON.parse(await schema.textContent())).toMatchObject({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name,
    url: canonical,
    description,
    inLanguage: 'en',
    publisher: { '@type': 'Person', '@id': 'https://cevdet.ch/#person', name: 'Cevdet', url: 'https://cevdet.ch/' },
  });

  const image = new URL(await attribute('meta[property="og:image"]'));
  expect(image.origin).toBe(new URL(canonical).origin);
  expect(image.pathname).toMatch(/\.png$/);
  // Exercise this build's asset, without making a request to production.
  const response = await request.get(image.pathname + image.search);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^image\/png\b/);
  expect(header(await response.body())).toMatchObject({ width: 1200, height: 630 });
});

const docs = ['/how-it-works', '/outputs', '/benchmarks'];

for (const path of docs) {
  test(`${path} has its own title, description and slash-free canonical URL`, async ({ page }) => {
    await page.goto(path);
    const head = page.locator('head');
    const content = async (selector, name = 'content') => {
      await expect(head.locator(selector)).toHaveCount(1);
      return head.locator(selector).getAttribute(name);
    };
    const url = new URL(path, canonical).href;
    const title = await page.title();
    expect(title).toMatch(/ · favseed$/);
    const description = await content('meta[name=description]');
    expect(description.length).toBeGreaterThan(100);
    expect(await content('link[rel=canonical]', 'href')).toBe(url);
    expect(await content('meta[property="og:url"]')).toBe(url);
    expect(await content('meta[property="og:title"]')).toBe(title);
    expect(await content('meta[property="og:description"]')).toBe(description);
    expect(await content('meta[name="twitter:card"]')).toBe('summary_large_image');
    await expect(head.locator('meta[name=robots]')).toHaveCount(0);
    await expect(page.locator('h1')).toHaveCount(1);
    // Every page reaches the tool and the other documentation pages.
    for (const target of ['/', ...docs]) await expect(page.locator(`a[href="${target}"]`).first()).toBeAttached();
  });
}

test('the sitemap lists the indexable pages and nothing else', async ({ request }) => {
  const xml = await (await request.get('/sitemap-0.xml')).text();
  const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc).sort();
  expect(listed).toEqual(['/', ...docs].map((path) => new URL(path, canonical).href).sort());
});

for (const path of ['/check', '/404']) {
  test(`${path} stays noindex without a canonical URL`, async ({ page }) => {
    await page.goto(path);
    const robots = page.locator('head meta[name=robots]');
    await expect(robots).toHaveCount(1);
    expect((await robots.getAttribute('content')).split(/[\s,]+/)).toContain('noindex');
    await expect(page.locator('head link[rel=canonical]')).toHaveCount(0);
  });
}

test('/check stays idle until explicitly initialized', async ({ page }) => {
  const workers = [],
    requests = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('request', (request) => requests.push(request.url()));
  const response = await page.goto('/check', { waitUntil: 'networkidle' });
  expect(response.status()).toBe(200);
  await expect(page.locator('#out')).toHaveText('ready');
  // Observe settled startup, not arbitrarily delayed background work.
  expect(workers, 'Visiting the diagnostic page starts no workers').toEqual([]);
  expect(
    requests.filter((url) => /(?:engine-worker|wasi-worker)[-.]|\.wasm(?:$|\?)/.test(url)),
    'Visiting the diagnostic page downloads no engine or WASM assets',
  ).toEqual([]);

  // The diagnostic API must remain usable against the same deployed build.
  const worker = page.waitForEvent('worker');
  const wasm = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('.wasm'));
  await page.evaluate(() => window.favseedCheck.warm());
  await Promise.all([worker, wasm]);
  await page.evaluate(() => window.favseedCheck.dispose());
});

test('cold startup stays small and defers engine loading until SVG selection', async ({ page }, testInfo) => {
  const responses = [],
    requests = [],
    workers = [];
  const pending = new Set();
  let lastActivity = 0;
  const onResponse = (response) => responses.push(response);
  const onRequest = (request) => {
    requests.push(request.url());
    pending.add(request);
    lastActivity = Date.now();
  };
  const onFinished = (request) => {
    pending.delete(request);
    lastActivity = Date.now();
  };
  const settled = async () => {
    // Start a fresh quiet interval: navigation's networkidle can already be satisfied.
    lastActivity = Date.now();
    await expect
      .poll(() => pending.size === 0 && Date.now() - lastActivity >= 500, {
        message: 'Startup network settles',
        timeout: 10_000,
      })
      .toBe(true);
  };
  page.on('response', onResponse);
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFinished);
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto('/');
  // A bounded settled-load observation, not a timing/performance benchmark.
  await settled();
  await page.getByText('Advanced: pin a setting').click();
  await page.locator('input[name=quality]').fill('100');
  await expect(page.locator('input[name=colors]')).toBeEnabled();
  await page.locator('input[name=quality]').fill('80');
  await expect(page.locator('input[name=colors]')).toBeDisabled();
  await page.locator('input[name=sizes]').fill('32');
  await page.locator('input[name=file]').setInputFiles({
    name: 'not-an-svg.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not an SVG'),
  });
  await expect(page.locator('output')).toHaveText('That is not an SVG.');
  await settled();
  page.off('response', onResponse);
  page.off('request', onRequest);
  page.off('requestfinished', onFinished);
  page.off('requestfailed', onFinished);
  expect(workers, 'No workers before SVG selection').toEqual([]);
  expect(
    requests.filter((url) => /(?:pipeline|engine-worker|wasi-worker)[-.]|\.wasm(?:$|\?)/.test(url)),
    'No engine or WASM requests before SVG selection',
  ).toEqual([]);

  // Include imported/preloaded resources, not just scripts linked in HTML.
  const resources = [];
  for (const response of responses) {
    const type = response.request().resourceType();
    const mime = response.headers()['content-type'] ?? '';
    const kind =
      type === 'document' || mime.includes('text/html')
        ? 'html'
        : type === 'script' || /(?:java|ecma)script/.test(mime)
          ? 'js'
          : type === 'stylesheet' || mime.includes('text/css')
            ? 'css'
            : undefined;
    if (!kind) continue;
    expect(response.status(), response.url()).toBe(200);
    const bytes = await response.body();
    resources.push({ url: response.url(), kind, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length });
  }
  const inlineCSS = await page.locator('style').allTextContents();
  const sum = (kind, field) =>
    resources.filter((resource) => resource.kind === kind).reduce((total, resource) => total + resource[field], 0);
  const totals = {
    htmlGzip: sum('html', 'gzip'),
    jsGzip: sum('js', 'gzip'),
    totalGzip: resources.reduce((total, resource) => total + resource.gzip, 0),
    cssRaw: sum('css', 'raw') + inlineCSS.reduce((total, css) => total + Buffer.byteLength(css), 0),
  };
  await testInfo.attach('startup-budget', {
    body: JSON.stringify({ totals, resources }, null, 2),
    contentType: 'application/json',
  });
  expect(totals.htmlGzip).toBeGreaterThan(0);
  expect(totals.jsGzip).toBeGreaterThan(0);
  expect(totals.htmlGzip, 'HTML gzip budget').toBeLessThanOrEqual(5 * 1024);
  expect(totals.jsGzip, 'JS gzip budget').toBeLessThanOrEqual(4 * 1024);
  expect(totals.totalGzip, 'HTML + JS + CSS gzip budget').toBeLessThanOrEqual(8 * 1024);
  expect(totals.cssRaw, 'Inline + external CSS raw budget').toBeLessThanOrEqual(5 * 1024);

  // Prove the same page can observe and run the engine after a valid selection.
  const worker = page.waitForEvent('worker');
  const wasm = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('.wasm'));
  await page.locator('input[name=file]').setInputFiles(fixture);
  await Promise.all([worker, wasm]);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('output')).toHaveText(/Done in/, { timeout: 120_000 });
  await expect(page.locator('#zip')).toBeVisible();
});

test('the engine starts loading when the pointer reaches the drop zone, with Zopfli alongside', async ({ page }) => {
  const workers = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto('/', { waitUntil: 'networkidle' });
  expect(workers, 'No worker before any sign of intent').toEqual([]);
  // At the default effort the build will run Zopfli, so its WASM is fetched with the engine's.
  const worker = page.waitForEvent('worker');
  const wasm = (name) => page.waitForRequest((request) => new RegExp(`/${name}[^/]*\\.wasm$`).test(request.url()));
  await page.locator('label.drop').hover();
  await Promise.all([worker, wasm('image\\.wasm32-'), wasm('zopfli')]);
  await expect(page.locator('output')).toHaveText('');
});

test('focusing the file input also starts the engine', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const worker = page.waitForEvent('worker');
  await page.locator('input[name=file]').focus();
  await worker;
});
