import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildFiles } from '../../bin/favseed.mjs';
import { isolationHeaders } from '../headers.mjs';
import { cases } from './cases.mjs';

const fixture = (mark) => fileURLToPath(new URL(`../../test/fixtures/${mark}.svg`, import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const summary = ({ files, fit, links, animated }) => ({
  files: files.map(({ name, bytes }) => ({ name, hash: hash(bytes), size: bytes.length })),
  fit, links, animated,
});
const downloads = (page) => page.locator('#files a').evaluateAll(async (links) => Promise.all(links.map(async (link) => {
  const bytes = await (await fetch(link.href)).arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { name: link.download, size: bytes.byteLength, hash: Array.from(digest, (n) => n.toString(16).padStart(2, '0')).join('') };
})));
const checkPage = async (page) => {
  const response = await page.goto('/check');
  for (const [name, value] of Object.entries(isolationHeaders)) expect(await response.headerValue(name)).toBe(value);
  await page.waitForFunction(() => !!window.favseedCheck);
  expect(await page.evaluate(() => window.favseedCheck.isolated)).toBe(true);
};

const clipboardStub = (page) => page.addInitScript(() => {
  window.favseedClipboard = { writes: [], pending: [] };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText(text) {
      window.favseedClipboard.writes.push(text);
      return new Promise((resolve, reject) => window.favseedClipboard.pending.push({ resolve, reject }));
    },
  } });
});
const generateHead = async (page) => {
  await page.locator('input[name=file]').setInputFiles(fixture('tiles'));
  await page.locator('input[name=sizes]').fill('32');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('output')).toHaveText(/^Done in/);
  return page.locator('#links').textContent();
};

test('head markup copies exact text with keyboard/touch feedback and rejection recovery', async ({ page, isMobile }) => {
  await clipboardStub(page);
  if (isMobile) await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  const copy = page.getByRole('button', { name: 'Copy markup', exact: true });
  await expect(copy).toBeHidden();
  const markup = await generateHead(page);
  const expected = await buildFiles({ input: fixture('tiles'), manifest: true, sizes: [32] });
  expect(markup).toBe(expected.links.trim());
  const zip = await page.locator('#zip').getAttribute('href');
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute('type', 'button');
  await expect(page.locator('#copy-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('#copy-status')).toHaveAttribute('aria-atomic', 'true');
  if (isMobile) await copy.tap();
  else { await copy.focus(); await page.keyboard.press('Enter'); }
  await expect(copy).toBeDisabled();
  if (!isMobile) {
    await expect(copy).toBeFocused();
    await page.keyboard.press('Enter'); // A second activation must not queue another write.
  } else await copy.evaluate((button) => button.click());
  expect(await page.evaluate(() => window.favseedClipboard.writes)).toEqual([markup]);
  await page.evaluate(() => window.favseedClipboard.pending.shift().resolve());
  await expect(page.locator('#copy-status')).toHaveText('Copied head markup.');
  await expect(copy).toBeEnabled();
  if (!isMobile) await expect(copy).toBeFocused();
  await copy.click();
  await expect(page.locator('#copy-status')).toHaveText('');
  await page.evaluate(() => window.favseedClipboard.pending.shift().reject(new DOMException('Denied', 'NotAllowedError')));
  await expect(page.locator('#copy-status')).toHaveText('Could not copy. Select and copy the markup below.');
  await expect(copy).toBeEnabled();
  await expect(page.locator('#links')).toHaveText(markup);
  await expect(page.locator('#links link')).toHaveCount(0);
  await expect(page.locator('#zip')).toHaveAttribute('href', zip);
  await copy.click();
  await page.evaluate(() => window.favseedClipboard.pending.shift().resolve());
  await expect(page.locator('#copy-status')).toHaveText('Copied head markup.');
  await generateHead(page);
  await expect(page.locator('#copy-status')).toHaveText('');
  if (isMobile) {
    expect((await copy.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

for (const outcome of ['resolve', 'reject']) {
  test(`head markup ignores stale clipboard ${outcome} after new results`, async ({ page }) => {
    await clipboardStub(page);
    await page.goto('/');
    const markup = await generateHead(page), copy = page.getByRole('button', { name: 'Copy markup', exact: true });
    await copy.click();
    await generateHead(page); // These settings produce the same links: result identity still matters.
    await expect(page.locator('#copy-status')).toHaveText('');
    await page.evaluate((outcome) => window.favseedClipboard.pending.shift()[outcome](), outcome);
    await expect(copy).toBeEnabled();
    await expect(page.locator('#copy-status')).toHaveText('');
    await expect(page.locator('#links')).toHaveText(markup);
    await copy.click();
    await page.evaluate(() => window.favseedClipboard.pending.shift().resolve());
    await expect(page.locator('#copy-status')).toHaveText('Copied head markup.');
  });
}

test('head markup stays selectable with manual guidance when clipboard support is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await page.goto('/');
  const markup = await generateHead(page);
  await expect(page.getByRole('button', { name: 'Copy markup', exact: true })).toBeHidden();
  await expect(page.locator('#copy-status')).toHaveText('Select and copy the markup below.');
  await page.locator('#links').evaluate((element) => {
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.addRange(range);
  });
  expect(await page.evaluate(() => window.getSelection().toString())).toBe(markup);
  await expect(page.locator('#zip')).toBeVisible();
});

test('files and metadata match the CLI; archives, cache and page timers work', async ({ page, isMobile }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await checkPage(page);
  const selected = isMobile ? cases.filter((item) =>
    ['small-mark/placement', 'aspect-wide/proportions', 'aspect-tall/proportions', 'aspect-percent/transparent',
      'grid-1/precision', 'grid-tiny/precision', 'grid-fallback/precision', 'gradient/fast', 'tiles/release', 'gradient/quality60-zopfli', 'transparent-aliases', 'custom-manifest'].includes(item.name)) : cases;
  let fileCount = 0;
  for (const item of selected) {
    await test.step(item.name, async () => {
      const input = fixture(item.mark), original = await readFile(input, 'utf8');
      // Export annotations must not change bytes, including the source fallback.
      const source = item.mark.startsWith('grid-')
        ? `<!-- exported <svg> --><?export metadata?>${original}<!-- exported logo --><?export done?>` : original;
      const options = { manifest: true, ...item.options };
      const expected = summary(await buildFiles({ input, ...options }));
      const actual = await page.evaluate(({ source, options }) => window.favseedCheck.build(source, options), { source, options });
      expect({ files: actual.files, fit: actual.fit, links: actual.links, animated: actual.animated }).toEqual(expected);
      expect(actual.ticks).toBeGreaterThan(0);
      fileCount += actual.files.length;
    });
  }
  const source = await readFile(fixture('general'), 'utf8'), options = { mode: 'fast', sizes: [180, 32] };
  expect(await page.evaluate(({ source, options }) => window.favseedCheck.cache(source, options), { source, options })).toBe(true);
  const repeat = await page.evaluate(({ source, options }) => window.favseedCheck.build(source, options), { source, options });
  expect(repeat.progress).toEqual([]);
  expect(errors).toEqual([]);
  console.log(`${test.info().project.name}: ${fileCount} files match native across ${selected.length} cases`);
});

test('site favicon metadata and actual ICO payload both declare48px', async ({ page }) => {
  for (const path of ['/', '/404']) {
    await page.goto(path);
    const icon = page.locator('link[rel="icon"][href="/favicon.ico"]');
    await expect(icon).toHaveAttribute('sizes', '48x48');
  }
  const response = await page.request.get('/favicon.ico');
  expect(response.ok()).toBe(true);
  const ico = await response.body();
  expect(ico.readUInt16LE(4)).toBe(1);
  expect([...ico.subarray(6, 8)]).toEqual([48, 48]);
  const offset = ico.readUInt32LE(18);
  expect([ico.readUInt32BE(offset + 16), ico.readUInt32BE(offset + 20)]).toEqual([48, 48]);
});

test('SVG diagnostics match native and replay once on a cached build', async ({ page }) => {
  await checkPage(page);
  const input = fixture('dependent'), source = await readFile(input, 'utf8');
  const options = { manifest: true, sizes: [32], padding: 20, bg: '#fff' }, warnings = [];
  const expected = summary(await buildFiles({ input, ...options, onWarn: (w) => warnings.push(w) }));
  expect(warnings).toHaveLength(2);
  for (let i = 0; i < 2; i++) {
    const actual = await page.evaluate(({ source, options }) => window.favseedCheck.build(source, options), { source, options });
    expect(actual.warnings).toEqual(warnings);
    // The fixture intentionally depends on host fonts: native can substitute one
    // while WASM omits text. The self-contained corpus above checks all raster bytes.
    const reusable = (files) => files.filter((file) => /\.(svg|webmanifest)$/.test(file.name));
    expect(reusable(actual.files)).toEqual(reusable(expected.files));
    expect({ fit: actual.fit, links: actual.links, animated: actual.animated })
      .toEqual({ fit: expected.fit, links: expected.links, animated: expected.animated });
    if (i) expect(actual.progress).toEqual([]);
  }
});

test('form keeps SVG guidance through failed builds and clears it on the next build', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[name=file]').setInputFiles(fixture('dependent'));
  await page.locator('input[name=sizes]').fill('32');
  const generate = page.getByRole('button', { name: 'Generate', exact: true });
  await generate.click();
  await expect(page.locator('output')).toHaveText(/^Done in/);
  await expect(page.locator('#warnings li')).toHaveCount(2);
  await expect(page.locator('#warnings')).toContainText('Convert text to paths');
  const previous = await downloads(page);
  await generate.click(); // Replaying the cached build must not lose or duplicate guidance.
  await expect(page.locator('output')).toHaveText(/^Done in/);
  await expect(page.locator('#warnings li')).toHaveCount(2);
  await page.locator('input[name=file]').setInputFiles({ name: 'text.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text font-family="FavseedOutlineOnlyMissingFont">F</text></svg>') });
  await generate.click();
  await expect(page.locator('output')).toContainText('renders nothing');
  await expect(page.locator('#warnings li')).toHaveCount(1);
  await expect(page.locator('#warnings')).toContainText('Convert text to paths');
  expect(await downloads(page)).toEqual(previous);
  await page.locator('input[name=file]').setInputFiles({ name: 'unsized.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><circle cx="32" cy="32" r="20"/></svg>') });
  await generate.click();
  await expect(page.locator('output')).toContainText('add a viewBox');
  await expect(page.locator('#warnings')).toBeHidden();
  expect(await downloads(page)).toEqual(previous);
  for (const box of [',0 64 64', '0 0 0x40 64', '0 0 64,,64']) {
    await page.locator('input[name=file]').setInputFiles({ name: 'malformed.svg', mimeType: 'image/svg+xml',
      buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"><circle cx="32" cy="32" r="20"/></svg>`) });
    await generate.click();
    await expect(page.locator('output')).toContainText('add a viewBox');
    expect(await downloads(page)).toEqual(previous);
  }
  await page.locator('input[name=file]').setInputFiles(fixture('flat'));
  await generate.click();
  await expect(page.locator('output')).toHaveText(/^Done in/);
  await expect(page.locator('#warnings')).toBeHidden();
});

test('invalid options, cancellation and worker retry leave the engine usable', async ({ page }) => {
  await checkPage(page);
  const source = await readFile(fixture('general'), 'utf8'), options = { mode: 'fast', sizes: [32] };
  expect(await page.evaluate((source) => window.favseedCheck.invalid(source), source)).toBe(true);
  await page.evaluate(() => window.favseedCheck.dispose());
  expect(await page.evaluate(({ source, options }) => window.favseedCheck.cancel(source, options, 'initialization'), { source, options })).toBe(true);
  await page.evaluate(({ source, options }) => window.favseedCheck.build(source, options), { source, options });
  expect(await page.evaluate(({ source, options }) => window.favseedCheck.cancel(source, options, 'raster'),
    { source, options: { ...options, padding: 20 } })).toBe(true);
  const actual = await page.evaluate(({ source, options }) => window.favseedCheck.build(source, options), { source, options });
  expect(actual.files).toEqual(summary(await buildFiles({ input: fixture('general'), manifest: true, ...options })).files);
});

test('a 1024px raster matches native after shared memory grows', async ({ page }) => {
  let worker;
  page.on('worker', (value) => { if (value.url().includes('engine-worker-')) worker = value; });
  await page.route('**/engine-worker-*.js', async (route) => {
    const response = await route.fetch();
    const observe = `const memories = []; const OriginalMemory = WebAssembly.Memory;
      WebAssembly.Memory = new Proxy(OriginalMemory, { construct(Target, [descriptor]) {
        const memory = new Target(descriptor);
        if (descriptor.shared) memories.push({memory, initial: descriptor.initial * 65536});
        return memory;
      } });
      globalThis.favseedMemoryGrew = () => memories.some(({memory, initial}) => memory.buffer.byteLength > initial);\n`;
    await route.fulfill({ response, body: observe + await response.text() });
  });
  await checkPage(page);
  const input = fixture('general'), source = await readFile(input, 'utf8');
  const options = { mode: 'fast', sizes: [1024], padding: 0, bg: 'none' };
  const actual = await page.evaluate(({ source, options }) => window.favseedCheck.build(source, options), { source, options });
  expect({ files: actual.files, fit: actual.fit, links: actual.links, animated: actual.animated })
    .toEqual(summary(await buildFiles({ input, manifest: true, ...options })));
  expect(await worker.evaluate(() => globalThis.favseedMemoryGrew())).toBe(true);
});

test('form downloads match native and survive failed and cancelled builds', async ({ page, isMobile, browserName, context }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (isMobile) await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  if (isMobile) await page.evaluate(() => {
    window.favseedTouches = 0;
    document.addEventListener('touchstart', () => window.favseedTouches++);
  });
  await expect(page.locator('#cancel')).toBeHidden();
  await page.locator('input[type=file]').setInputFiles(fixture('tiles'));
  await page.locator('select[name=mode]').selectOption('fast');
  const generate = page.getByRole('button', { name: 'Generate', exact: true });
  if (isMobile) await generate.tap(); else await generate.click();
  await expect(page.locator('output')).toHaveClass('good', { timeout: 90_000 });
  await expect(page.locator('#result')).toBeVisible();
  const expected = summary(await buildFiles({ input: fixture('tiles'), mode: 'fast', manifest: true }));
  const actual = await downloads(page);
  expect(actual).toEqual(expected.files);
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const copy = page.getByRole('button', { name: 'Copy markup', exact: true });
    if (isMobile) await copy.tap(); else await copy.click();
    await expect(page.locator('#copy-status')).toHaveText('Copied head markup.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected.links.trim());
  }
  const downloadEvent = page.waitForEvent('download');
  if (isMobile) await page.locator('#zip').tap(); else await page.locator('#zip').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('favseed.zip');
  const zip = await readFile(await download.path());
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const url = await page.locator('#zip').getAttribute('href');
  await page.locator('input[name=bg]').fill('#ffffff80');
  await generate.click();
  await expect(page.locator('output')).toHaveClass('bad');
  await expect(generate).toBeEnabled();
  await expect(page.locator('#zip')).toHaveAttribute('href', url);
  await page.locator('input[name=bg]').fill('#000000');
  await page.locator('input[name=padding]').fill('20');
  await page.locator('input[name=zopfli]').check();
  await generate.click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('output')).toHaveText('Cancelled.');
  await expect(page.locator('#zip')).toHaveAttribute('href', url);
  expect(await page.evaluate(async () => (await (await fetch(document.getElementById('zip').href)).arrayBuffer()).byteLength)).toBe(zip.length);
  if (isMobile) {
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth }));
    expect(layout.width).toBeLessThanOrEqual(layout.viewport);
    expect(await page.evaluate(() => window.favseedTouches)).toBeGreaterThan(0);
    for (const control of ['button[type=submit]', '#zip']) {
      expect((await page.locator(control).boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
  }
  expect(errors).toEqual([]);
});

test('PNG quality controls palette availability and downloads match native', async ({ page }) => {
  await page.goto('/');
  const quality = page.locator('[name=quality]'), colors = page.locator('[name=colors]');
  await expect(quality).toHaveValue('80');
  await expect(colors).toBeDisabled();
  await quality.fill('100');
  await colors.fill('32');
  await quality.fill('80');
  await expect(colors).toBeDisabled();
  await quality.fill('100');
  await expect(colors).toBeEnabled();
  await expect(colors).toHaveValue('32');
  await quality.fill('80');
  await page.locator('input[type=file]').setInputFiles(fixture('gradient'));
  await quality.fill('0');
  expect(await page.locator('form').evaluate((form) => form.checkValidity())).toBe(false);
  await quality.fill('80');
  expect(await page.locator('form').evaluate((form) => form.checkValidity())).toBe(true);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('output')).toContainText('Done in', { timeout: 120_000 });
  const expected = summary(await buildFiles({ input: fixture('gradient'), quality: 80, manifest: true }));
  expect(await downloads(page)).toEqual(expected.files);
  await expect(colors).toBeDisabled();
  await quality.fill('100');
  await expect(colors).toBeEnabled();
  await expect(colors).toHaveValue('32');
});

test('form defaults skip extra compression and opt-in matches native bytes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('input[name=zopfli]')).not.toBeChecked();
  expect(await page.locator('header img').getAttribute('src'))
    .toBe(await page.locator('link[type="image/svg+xml"]').getAttribute('href'));
  await page.locator('input[type=file]').setInputFiles(fixture('tiles'));
  await page.locator('select[name=mode]').selectOption('fast');
  await page.locator('input[name=zopfli]').check();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('output')).toHaveClass('good', { timeout: 90_000 });
  const expected = summary(await buildFiles({ input: fixture('tiles'), mode: 'fast', zopfli: true, manifest: true }));
  expect(await downloads(page)).toEqual(expected.files);
  expect(expected.files.filter((f) => f.name.endsWith('.svg')).map((f) => f.name)).toEqual(['icon.svg']);
});

test('missing document isolation gives the CLI alternative and restores form controls', async ({ page }) => {
  await page.goto('/?no-isolation');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await page.locator('input[type=file]').setInputFiles(fixture('tiles'));
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('output')).toHaveClass('bad');
  await expect(page.locator('output')).toContainText('favseed CLI');
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await expect(page.locator('#cancel')).toBeHidden();
  await expect(page.locator('#result')).toBeHidden();
});

test('missing worker isolation rejects initialization and permits retry', async ({ page }) => {
  test.setTimeout(30_000);
  let intercepted = false;
  await page.route('**/engine-worker-*.js', async (route) => {
    intercepted = true;
    const response = await route.fetch();
    const headers = { ...response.headers(), 'cross-origin-embedder-policy': 'unsafe-none' };
    await route.fulfill({ response, headers });
  });
  await checkPage(page);
  await expect(page.evaluate(() => window.favseedCheck.warm())).rejects.toThrow();
  expect(intercepted).toBe(true);
  await page.unroute('**/engine-worker-*.js');
  await page.evaluate(() => window.favseedCheck.warm());
});
