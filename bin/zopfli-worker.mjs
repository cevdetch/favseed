// One Zopfli compressor in a worker thread, for bin/zopfli-pool.mjs: one call at a time, the
// result's buffer transferred back, an error sent back as its name and message.
import { readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { createZopfli } from '../lib/zopfli.mjs';

const zopfli = createZopfli({ loadWasm: () => readFileSync(new URL('../lib/zopfli.wasm', import.meta.url)) });

parentPort.on('message', async ({ bytes, options }) => {
  try {
    const result = await zopfli.zlibAsync(bytes, options);
    parentPort.postMessage({ result }, [result.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: { name: error?.name, message: error?.message ?? String(error) } });
  }
});
