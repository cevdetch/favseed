// A stand-in Zopfli worker for test/zopfli.test.mjs: it exits on input starting 0xff, and otherwise
// echoes its input, so the pool's crash recovery can be tested without a real crash.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ bytes }) => {
  if (bytes[0] === 0xff) process.exit(3);
  parentPort.postMessage({ result: bytes });
});
