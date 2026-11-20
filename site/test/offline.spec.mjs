import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFiles } from '../../bin/favseed.mjs';

// The worker is blocked for the rest of the suite (playwright.config.mjs); this file is its own.
test.use({ serviceWorkers: 'allow' });

const fixture = fileURLToPath(new URL('../../test/fixtures/tiles.svg', import.meta.url));
const swFile = new URL('../dist/sw.js', import.meta.url);
const versionFile = new URL('../dist/version.json', import.meta.url);
// The update test swaps these two files and keeps the originals beside them. A run killed before
// its cleanup (SIGKILL, the global timeout) would leave dist mutated and poison every later read,
// so the next run puts the originals back before it reads anything.
const heal = () => {
  for (const file of [swFile, versionFile]) {
    const pristine = new URL(`${file.href}.pristine`);
    if (existsSync(pristine)) renameSync(pristine, file);
  }
};
heal();
const sw = readFileSync(swFile, 'utf8');
const lists = JSON.parse(
  sw
    .split('\n', 1)[0]
    .replace(/^self\.FAVSEED_OFFLINE = /, '')
    .replace(/;$/, ''),
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const controlled = (page) =>
  page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
const cacheKeys = (page) =>
  page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys())
      out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
const engineCache = async (page) =>
  Object.entries(await cacheKeys(page)).filter(([name]) => name.startsWith('engine-'));
const downloads = (page) =>
  page.locator('#files a').evaluateAll(async (links) =>
    Promise.all(
      links.map(async (link) => {
        const bytes = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return {
          name: link.download,
          hash: Array.from(digest, (n) => n.toString(16).padStart(2, '0')).join(''),
          size: bytes.length,
        };
      }),
    ),
  );
const generate = async (page) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('output')).toHaveClass('good', { timeout: 180_000 });
};

test.describe('offline', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'offline emulation with service workers is reliable in Chromium only',
  );

  test('the first visit registers the worker and caches every page', async ({ page }) => {
    await page.goto('/');
    await controlled(page);
    const keys = await cacheKeys(page);
    expect(keys[`pages-${lists.version}`]?.toSorted()).toEqual(lists.pages.toSorted());
  });

  test('an installed app saves the engine, then builds and browses offline with CLI bytes', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await controlled(page);
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expect
      .poll(async () => (await engineCache(page)).flatMap(([, urls]) => urls), { timeout: 120_000 })
      .toContain('/__complete/threaded');
    await context.setOffline(true);
    await page.goto('/docs');
    await expect(page.locator('h1')).toBeVisible();
    await page.goto('/');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await generate(page);
    const expected = (await buildFiles({ input: fixture, manifest: true })).files.map(({ name, bytes }) => ({
      name,
      hash: hash(bytes),
      size: bytes.length,
    }));
    expect(await downloads(page)).toEqual(expected);
    await expect(page.locator('#engine')).toContainText('Built offline');
  });

  test('in a tab, the first build saves the engine and the second runs offline', async ({ page, context }) => {
    await page.goto('/');
    await controlled(page);
    await generate(page);
    await expect(page.locator('#engine')).toHaveText(/^Engine: @napi-rs\/image [\d.]+, zopfli [\d.]+\.$/);
    await expect
      .poll(async () => (await engineCache(page)).flatMap(([, urls]) => urls), { timeout: 60_000 })
      .toContain('/__complete/threaded');
    await context.setOffline(true);
    await page.reload();
    await generate(page);
  });

  test('a newer engine reloads the page once and the build resumes on it', async ({ page }) => {
    await page.goto('/');
    await controlled(page);
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expect
      .poll(async () => (await engineCache(page)).flatMap(([, urls]) => urls), { timeout: 120_000 })
      .toContain('/__complete/threaded');
    // Deploy a "new" worker: same files, new hashes, so it caches the engine again under a new name.
    // Written into dist because Playwright does not route the browser's own worker-script update
    // check (context.route sees only the first registration); heal() undoes it even after a kill.
    const next = sw
      .replace(`"engineHash":"${lists.engineHash}"`, '"engineHash":"next"')
      .replace(`"version":"${lists.version}"`, '"version":"next"');
    writeFileSync(new URL(`${swFile.href}.pristine`), sw);
    writeFileSync(new URL(`${versionFile.href}.pristine`), readFileSync(versionFile));
    try {
      writeFileSync(swFile, next);
      writeFileSync(versionFile, JSON.stringify({ engine: 'next', version: 'next' }));
      let loads = 0;
      page.on('load', () => loads++);
      await page.locator('input[type=file]').setInputFiles(fixture);
      await page.getByRole('button', { name: 'Generate', exact: true }).click();
      await expect(page.locator('output')).toHaveClass('good', { timeout: 180_000 });
      expect(loads).toBe(1);
      expect(await page.evaluate(() => window.favseedOffline.checked)).toBe('current');
      // The resumed build leaves the file input empty: Generate must still be allowed.
      expect(await page.evaluate(() => document.querySelector('form').checkValidity())).toBe(true);
      await expect
        .poll(async () => (await engineCache(page)).map(([name]) => name), { timeout: 60_000 })
        .toEqual(['engine-next']);
    } finally {
      heal();
    }
  });

  test('an update that never takes over keeps the form busy, then builds on the current engine', async ({ page }) => {
    await page.addInitScript(() => {
      const post = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message, ...rest) {
        if (message?.type !== 'skip-waiting') return post.call(this, message, ...rest);
      };
    });
    await page.goto('/');
    await controlled(page);
    const next = sw
      .replace(`"engineHash":"${lists.engineHash}"`, '"engineHash":"next"')
      .replace(`"version":"${lists.version}"`, '"version":"next"');
    writeFileSync(new URL(`${swFile.href}.pristine`), sw);
    writeFileSync(new URL(`${versionFile.href}.pristine`), readFileSync(versionFile));
    try {
      writeFileSync(swFile, next);
      writeFileSync(versionFile, JSON.stringify({ engine: 'next', version: 'next' }));
      await page.locator('select[name=effort]').selectOption('fast');
      await page.locator('input[type=file]').setInputFiles(fixture);
      const go = page.getByRole('button', { name: 'Generate', exact: true });
      await go.click();
      await expect(page.locator('output')).toHaveText('Updating the engine…', { timeout: 60_000 });
      await expect(go).toBeDisabled();
      await expect(page.locator('output')).toHaveClass('good', { timeout: 180_000 });
      await expect(page.locator('#engine')).toContainText('A newer engine may exist.');
      expect(await page.evaluate(() => sessionStorage.getItem('favseed:resume'))).toBeNull();
    } finally {
      heal();
    }
  });

  test('a tab left on old page code reloads once before it builds', async ({ page, context }) => {
    await page.goto('/');
    await controlled(page);
    const sibling = await context.newPage();
    await sibling.goto('/');
    await controlled(sibling);
    const next = sw
      .replace(`"engineHash":"${lists.engineHash}"`, '"engineHash":"next"')
      .replace(`"version":"${lists.version}"`, '"version":"next"');
    writeFileSync(new URL(`${swFile.href}.pristine`), sw);
    writeFileSync(new URL(`${versionFile.href}.pristine`), readFileSync(versionFile));
    try {
      writeFileSync(swFile, next);
      writeFileSync(versionFile, JSON.stringify({ engine: 'next', version: 'next' }));
      await page.locator('select[name=effort]').selectOption('fast');
      await generate(page);
      // The sibling never asked for the new worker, but has it now.
      await expect
        .poll(() => sibling.evaluate(() => navigator.serviceWorker.controller?.scriptURL), { timeout: 30_000 })
        .toContain('/sw.js');
      let loads = 0;
      sibling.on('load', () => loads++);
      await sibling.locator('select[name=effort]').selectOption('fast');
      await generate(sibling);
      expect(loads).toBe(1);
      expect(await sibling.evaluate(() => window.favseedOffline.checked)).toBe('current');
    } finally {
      heal();
    }
  });
});

test('a page under the worker is isolated and builds in any browser', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await controlled(page);
  await page.reload();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.locator('select[name=effort]').selectOption('fast');
  await generate(page);
  await page.goto('/docs');
  expect(errors).toEqual([]);
});

test('blocked site data does not stop the form from working', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['sessionStorage', 'localStorage'])
      Object.defineProperty(window, name, {
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
  });
  await page.goto('/');
  await page.locator('select[name=effort]').selectOption('fast');
  await generate(page);
  expect(errors).toEqual([]);
});
