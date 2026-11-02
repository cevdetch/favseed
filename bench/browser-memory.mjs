// Linux renderer memory, measured through Chromium CDP and /proc. Build the site first.
// Route-only controls restore upstream allocation/preload for an interleaved comparison;
// no dependency or production file is changed. Run with no other browser tests active.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../site/node_modules/@playwright/test/index.mjs';
import '../site/test/serve.mjs';

const memoryStats = async (cdp) => {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  let pss = 0, rss = 0;
  for (const { type, id } of processInfo) {
    if (type !== 'renderer') continue;
    const data = await readFile(`/proc/${id}/smaps_rollup`, 'utf8');
    pss += Number(/^Pss:\s+(\d+)/m.exec(data)?.[1] ?? 0);
    rss += Number(/^Rss:\s+(\d+)/m.exec(data)?.[1] ?? 0);
  }
  return { rendererPssMiB: +(pss / 1024).toFixed(1), rendererRssMiB: +(rss / 1024).toFixed(1) };
};
const variants = [{ baseline: true, cores: 16 }, { cores: 16 }, { baseline: true, cores: 16 }, { cores: 16 }, { cores: 1 }, { cores: 2 }];
const expected = new Map();
let browser;
const watchdog = setTimeout(() => { console.error('Memory measurement exceeded 10 minutes'); process.exit(1); }, 600_000);
let exitCode = 0;
try {
  for (const [run, variant] of variants.entries()) {
    browser = await chromium.launch({ ...(process.env.FAVSEED_CHROMIUM_PATH ? { executablePath: process.env.FAVSEED_CHROMIUM_PATH } : {}), args: ['--disable-gpu'] });
    const cdp = await browser.newBrowserCDPSession();
    const page = await browser.newPage();
    let worker;
    page.on('worker', (value) => { if (value.url().includes('engine-worker-')) worker = value; });
    await page.route('**/engine-worker-*.js', async (route) => {
      const response = await route.fetch();
      const prefix = `Object.defineProperty(navigator, 'hardwareConcurrency', { value: ${variant.cores} });\n` +
        `const memories = []; const OriginalMemory = WebAssembly.Memory;\n` +
        `WebAssembly.Memory = new Proxy(OriginalMemory, { construct(Target, [descriptor]) {\n` +
        `const memory = new Target(descriptor); if (descriptor.shared) memories.push({ memory, initial: descriptor.initial }); return memory;\n` +
        `} }); globalThis.benchMemories = () => memories.map(({memory, initial}) => ({ initialMiB: initial / 16, currentMiB: memory.buffer.byteLength / 1048576 }));\n`;
      await route.fulfill({ response, body: prefix + await response.text() });
    });
    if (variant.baseline) await page.route('**/image.wasi-browser-*.js', async (route) => {
      const response = await route.fetch(), source = await response.text();
      const pool = 'Math.min(4,Math.max(2,globalThis.navigator?.hardwareConcurrency??4))';
      assert.equal(source.split('initial:1024').length, 2, 'minified memory shape changed');
      assert.equal(source.split(pool).length, 2, 'minified worker shape changed');
      await route.fulfill({ response, body: source.replace('initial:1024', 'initial:4000')
        .replace(pool, 'Math.max(2,globalThis.navigator?.hardwareConcurrency??4)') });
    });
    await page.goto('http://127.0.0.1:4175/check');
    await page.waitForFunction(() => !!window.favseedCheck);
    const start = performance.now();
    await page.evaluate(() => window.favseedCheck.warm());
    const initMs = Math.round(performance.now() - start);
    const workers = (await cdp.send('Target.getTargets')).targetInfos.filter((target) => target.type === 'worker').length;
    assert.equal(workers, 1 + 4 + (variant.baseline ? variant.cores : Math.min(4, Math.max(2, variant.cores))));
    const linear = await worker.evaluate(() => globalThis.benchMemories());
    assert.equal(linear[0].initialMiB, variant.baseline ? 250 : 64);
    console.log(JSON.stringify({ run, variant, initMs, workers, linear, ...await memoryStats(cdp) }));
    for (const mark of variant.cores < 4 ? ['tiles'] : ['general', 'heavy', 'gradient']) {
      const source = await readFile(new URL(`../test/fixtures/${mark}.svg`, import.meta.url), 'utf8');
      const built = await page.evaluate((source) => window.favseedCheck.build(source, { mode: 'fast', manifest: true }), source);
      const output = { files: built.files, fit: built.fit, links: built.links, animated: built.animated };
      if (!expected.has(mark)) expected.set(mark, output); else assert.deepEqual(output, expected.get(mark));
      console.log(JSON.stringify({ run, variant, mark, buildMs: Math.round(built.ms),
        linear: await worker.evaluate(() => globalThis.benchMemories()), ...await memoryStats(cdp) }));
    }
    await browser.close(); browser = undefined;
  }
} catch (error) { console.error(error.stack); exitCode = 1; }
finally { clearTimeout(watchdog); await browser?.close(); process.exit(exitCode); }
