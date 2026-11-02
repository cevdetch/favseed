// Run the browser self-check in headless Chromium and report what it printed.
//
//   node test/cdp-check.mjs            # serves dist/ itself
//
// Two things this does that `chromium --dump-dom` cannot. It waits for the page to finish
// (dump-dom snapshots at the load event, before the WASM codecs are even fetched, so it always
// reports "running..."), and it surfaces console messages and uncaught exceptions, without
// which a module that fails to import looks the same as one that is slow.
//
// The static server runs inside this process and dies with it, so there is no stray listener
// to hunt down afterwards. Node's built-in WebSocket speaks DevTools; no dependency.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildFiles } from '../../bin/favseed.mjs';
import { cases } from './cases.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationHeaders } from '../headers.mjs';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PATH = process.argv[2] ?? '/check';
// Resolve a supported name to a fixed command; CHROME cannot select an arbitrary executable.
const BROWSERS = new Map([['chromium', 'chromium'], ['google-chrome', 'google-chrome']]);
const browser = BROWSERS.get(process.env.CHROME ?? 'chromium');
if (!browser) {
  console.error('cdp-check: CHROME must be chromium or google-chrome');
  process.exit(1);
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  // Resolved the way Cloudflare Pages resolves it with build.format 'file': the path, then
  // the path plus .html, then a directory's index.html.
  const file = [join(ROOT, p), join(ROOT, `${p}.html`), join(ROOT, p, 'index.html')]
    .find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
  if (!file) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { ...isolationHeaders, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const localBase = `http://127.0.0.1:${server.address().port}`;
const base = process.env.FAVSEED_ORIGIN ?? localBase;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('FAVSEED_ORIGIN must be a local HTTP origin');

const profile = mkdtempSync(join(tmpdir(), 'favseed-cdp.'));
const PORT = 9333 + (process.pid % 500);
// CI's runner image has google-chrome; local runs default to chromium.
const chrome = spawn(browser, [
  '--headless', '--disable-gpu', '--no-sandbox', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, base + PATH,
], { stdio: ['ignore', 'ignore', 'pipe'] });
const chromeErrors = [];
chrome.stderr.on('data', (chunk) => { chromeErrors.push(String(chunk)); if (chromeErrors.length > 20) chromeErrors.shift(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The verdict prints first and sets the exit code. Cleanup comes after: Chromium writes to its
// profile while it shuts down, so an immediate delete fails with ENOTEMPTY. It waits for the
// exit, retries, and cannot turn a passing run into a failing one or hide the result.
const finish = async (code, ...msg) => {
  for (const m of msg) if (m) console.log(m);
  if (code && !target && chromeErrors.length) console.log(chromeErrors.join(''));
  server.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  try { chrome.kill(); } catch {}
  await Promise.race([exited, sleep(5000)]);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  process.exit(code);
};

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  await sleep(150);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* still coming up */ }
}
if (!target) await finish(1, 'could not reach the browser');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const noise = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const request = pending.get(m.id); clearTimeout(request.timer); pending.delete(m.id); request.resolve(m); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    noise.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    noise.push(`uncaught: ${d.exception?.description ?? d.text}`);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const { text, url } = m.params.entry;
    // Vite's HMR socket closes when Chrome caches the dev page. Retain that
    // expected diagnostic separately; production and other errors still fail.
    const hmrCacheClose = base !== localBase &&
      text.startsWith(`WebSocket connection to '${base.replace('http:', 'ws:')}/?token=`) &&
      text.endsWith("' failed: Page entered Back-Forward Cache.");
    noise.push(`${hmrCacheClose ? 'dev-hmr' : 'log'}: ${text} ${url ?? ''}`);
  }
  if (m.method === 'Target.attachedToTarget') {
    const session = m.params.sessionId;
    (async () => {
      await send('Runtime.enable', {}, session);
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session);
      await send('Runtime.runIfWaitingForDebugger', {}, session);
    })();
  }
};
const send = (method, params, sessionId) => new Promise((resolve, reject) => {
  const n = ++id;
  const timer = setTimeout(() => { pending.delete(n); reject(new Error(`CDP timeout: ${method}`)); }, 120000);
  pending.set(n, { resolve, timer });
  ws.send(JSON.stringify({ id: n, method, params, sessionId }));
});
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.error) throw new Error(JSON.stringify(response.error));
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  return response.result?.result?.value;
};
const call = (method, ...args) => evaluate(`window.favseedCheck.${method}(...${JSON.stringify(args)})`);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shared = ({ files, fit, links, animated }) => ({ files, fit, links, animated });
const summary = (built) => ({ ...shared(built), files: built.files.map(({ name, bytes }) => ({ name, hash: hash(bytes), size: bytes.length })) });
const workerCount = async () => ((await send('Target.getTargets', {})).result?.targetInfos ?? []).filter((t) => t.type === 'worker').length;
const noWorkers = async () => {
  for (let i = 0; i < 100; i++) { if (await workerCount() === 0) return; await sleep(50); }
  throw new Error('Cancelled worker left nested workers alive');
};
const waitFor = async (expression) => {
  for (let i = 0; i < 1200; i++) { if (await evaluate(expression)) return; await sleep(50); }
  throw new Error(`Page condition timed out: ${expression}`);
};
const watchdog = setTimeout(() => { finish(1, 'Browser check exceeded 8 minutes', noise.join('\n')); }, 8 * 60 * 1000);
try {
  await send('Runtime.enable', {});
  await send('Log.enable', {});
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Page.enable', {});
  await send('Page.reload', { ignoreCache: false });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (await evaluate('!!window.favseedCheck')) { ready = true; break; }
    await sleep(50);
  }
  assert.ok(ready, 'check page loaded');
  assert.equal(await evaluate('window.favseedCheck.isolated'), true, 'cross-origin isolated');
  const response = await fetch(base + PATH);
  for (const [header, value] of Object.entries(isolationHeaders)) assert.equal(response.headers.get(header), value);
  const benchmark = process.env.FAVSEED_BENCH === '1';
  if (benchmark) {
    const initializationMs = await evaluate('(async () => { const t = performance.now(); await window.favseedCheck.warm(); return performance.now() - t; })()');
    console.log(JSON.stringify({ initializationMs }));
    await buildFiles({ input: fileURLToPath(new URL('../../test/fixtures/general.svg', import.meta.url)), mode: 'fast', sizes: [32] });
  }
  const selectedCases = benchmark ? [
    ...cases.filter((c) => c.name.endsWith('/release')),
    ...['general', 'heavy'].map((mark) => ({ name: `${mark}/release`, mark, options: { mode: 'release' } })),
  ] : process.env.FAVSEED_SMOKE === '1' ? cases.slice(0, 1) : cases;
  for (const item of selectedCases) {
    const input = fileURLToPath(new URL(`../../test/fixtures/${item.mark}.svg`, import.meta.url));
    const source = readFileSync(input, 'utf8'), options = { manifest: true, ...item.options };
    const start = performance.now();
    const native = summary(await buildFiles({ input, ...options }));
    const nativeMs = performance.now() - start;
    const actual = await call('build', source, options);
    assert.deepEqual(shared(actual), native, item.name);
    assert.ok(actual.ms < 20 || actual.ticks > 0, 'page timer runs during worker builds');
    console.log(JSON.stringify({ name: item.name, nativeMs: Math.round(nativeMs), browserMs: Math.round(actual.ms),
      bytes: actual.files.reduce((n, f) => n + f.size, 0), maxGap: Math.round(actual.maxGap), files: actual.files }));
  }
  const source = readFileSync(new URL('../../test/fixtures/general.svg', import.meta.url), 'utf8');
  const options = { sizes: [180, 32], mode: 'fast' };
  assert.equal(await call('cache', source, options), true);
  const repeat = await call('build', source, options);
  assert.deepEqual(repeat.progress, [], 'identical build hits cache');
  console.log(`cached build ms=${repeat.ms.toFixed(2)}`);
  assert.equal(await call('invalid', source), true);
  await call('dispose'); await noWorkers();
  assert.equal(await call('unsupported'), true);
  await noWorkers();
  assert.equal(await call('cancel', source, options, 'initialization'), true);
  await noWorkers();
  // A complete retry proves cancellation did not poison WASM initialization.
  await call('build', source, options);
  assert.equal(await call('cancel', source, { ...options, padding: 20 }, 'raster'), true);
  await noWorkers();
  await call('build', source, options);
  await call('dispose'); await noWorkers();
  // Exercise the form itself: failed and cancelled builds must keep working downloads.
  await send('Page.navigate', { url: base + '/' });
  // A cold dev server can deliver the form before its module installs submit.
  // Wait for module execution before firing change/submit through CDP.
  await waitFor('document.readyState === "complete" && !!document.querySelector("form")');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("cancel")).display'), 'none');
  await send('DOM.enable', {});
  const doc = await send('DOM.getDocument', {});
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId,
    files: [fileURLToPath(new URL('../../test/fixtures/tiles.svg', import.meta.url))] });
  await evaluate('document.querySelector("select[name=mode]").value="fast"; document.querySelector("form").requestSubmit()');
  await waitFor('document.querySelector("output").className === "good"');
  const download = await evaluate('document.getElementById("zip").href');
  await evaluate('document.querySelector("input[name=bg]").value="#ffffff80"; document.querySelector("form").requestSubmit()');
  await waitFor('document.querySelector("output").className === "bad" && !document.querySelector("button[type=submit]").disabled');
  assert.equal(await evaluate('document.getElementById("zip").href'), download);
  assert.ok(await evaluate('(async () => (await (await fetch(document.getElementById("zip").href)).arrayBuffer()).byteLength > 100)()'));
  await evaluate('document.querySelector("input[name=bg]").value="#000000"; document.querySelector("input[name=padding]").value="20"; document.querySelector("input[name=zopfli]").checked=true; document.querySelector("form").requestSubmit()');
  await waitFor('!document.getElementById("cancel").hidden');
  await evaluate('document.getElementById("cancel").click()');
  await waitFor('document.querySelector("output").textContent === "Cancelled."');
  await noWorkers();
  assert.equal(await evaluate('document.getElementById("zip").href'), download);
  assert.ok(await evaluate('(async () => (await (await fetch(document.getElementById("zip").href)).arrayBuffer()).byteLength > 100)()'));
  // A preserved history entry must keep its visible result downloads alive.
  await evaluate('window.favseedHistoryMarker = true; window.addEventListener("pageshow", (event) => { window.favseedHistoryRestored = event.persisted; })');
  await send('Page.navigate', { url: base + '/check' });
  await waitFor('!!window.favseedCheck');
  await evaluate('history.back()');
  await waitFor('window.favseedHistoryMarker === true');
  assert.equal(await evaluate('window.favseedHistoryRestored'), true, 'restored from back/forward cache');
  assert.equal(await evaluate('document.getElementById("result").hidden'), false);
  assert.equal(await evaluate('document.getElementById("zip").href'), download);
  assert.ok(await evaluate('(async () => (await (await fetch(document.getElementById("zip").href)).arrayBuffer()).byteLength > 100)()'));
  assert.equal(noise.filter((line) => /^(uncaught:|log:|console.error:)/.test(line)).length, 0, noise.join('\n'));
  clearTimeout(watchdog);
  await finish(0, 'OK: native/browser parity, archive, cache, responsiveness, cancellation and retry');
} catch (error) {
  clearTimeout(watchdog);
  const targets = (await send('Target.getTargets', {})).result;
  const workers = targets?.targetInfos?.filter((t) => t.type === 'worker') ?? [];
  await finish(1, error.stack, noise.join('\n'), JSON.stringify({ workers: workers.length, urls: [...new Set(workers.map((t) => t.url))] }));
}
