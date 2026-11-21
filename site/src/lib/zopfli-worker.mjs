// One Zopfli compressor in its own worker, for zopfli-pool.mjs: one call at a time, the result's
// buffer transferred back, an error sent back as its name and message. The engine worker sends
// the WASM bytes it fetched, so a worker never downloads them itself; a call that arrives before
// them waits for them.
import { createZopfli } from '../../../lib/zopfli.mjs';

let receive;
const wasm = new Promise((resolve, reject) => {
  receive = ({ bytes, error }) => (error ? reject(new Error(error)) : resolve(bytes));
});
wasm.catch(() => {});
const zopfli = createZopfli({ loadWasm: () => wasm });

self.onmessage = async ({ data }) => {
  if (data.type === 'wasm') {
    receive(data);
    return;
  }
  try {
    const result = await zopfli.zlibAsync(data.input, data.options);
    self.postMessage({ result }, [result.buffer]);
  } catch (error) {
    self.postMessage({ error: { name: error?.name, message: error?.message ?? String(error) } });
  }
};
