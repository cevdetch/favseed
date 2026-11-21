// Zopfli for the Node host, in worker threads. In the calling thread its synchronous WASM blocks
// the event loop for the whole finish, so no other job's search can start an encode meanwhile:
// two workers and a largest-first schedule took a default build 20 to 34 % faster with the same
// bytes (decision 34). Same interface as lib/zopfli.mjs's createZopfli, so the engine cannot tell.
//
// Workers start on the first call, so a build with no Zopfli (effort 'fast') starts none. An idle
// worker is unref'd and never keeps the process alive; a busy one does, as an in-thread finish
// would. A worker that dies rejects only its own call and is replaced by the next one.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

const ERRORS = { RangeError, TypeError };

export const createZopfliPool = ({
  size = Math.min(2, availableParallelism()),
  script = new URL('./zopfli-worker.mjs', import.meta.url),
} = {}) => {
  const idle = [],
    queue = [];
  let workers = 0;

  const settle = (worker, call, outcome) => {
    worker.current = null;
    worker.unref();
    outcome(call);
    const next = queue.shift();
    if (next) run(worker, next);
    else idle.push(worker);
  };

  const spawn = () => {
    // No inherited flags: Zopfli needs none, and some refuse a worker, --input-type (for
    // `node -e`) among them, which makes the worker reject its own script file.
    const worker = new Worker(script, { execArgv: [] });
    workers++;
    worker.unref();
    worker.on('message', ({ result, error }) => {
      const call = worker.current;
      if (!call) return;
      if (error) {
        const failure = new (ERRORS[error.name] ?? Error)(error.message);
        settle(worker, call, ({ reject }) => reject(failure));
      } else settle(worker, call, ({ resolve }) => resolve(result));
    });
    const lost = (reason) => {
      if (worker.dead) return;
      worker.dead = true;
      workers--;
      const at = idle.indexOf(worker);
      if (at >= 0) idle.splice(at, 1);
      worker.current?.reject(reason);
      worker.current = null;
      // A queued call would otherwise wait for a worker that never comes.
      if (queue.length) run(spawn(), queue.shift());
    };
    worker.on('error', lost);
    worker.on('exit', (code) => lost(new Error(`Zopfli worker stopped with exit code ${code}`)));
    return worker;
  };

  const run = (worker, call) => {
    worker.current = call;
    worker.ref();
    worker.postMessage({ bytes: call.bytes, options: call.options });
  };

  return {
    zlibAsync: (bytes, options) =>
      new Promise((resolve, reject) => {
        const call = { bytes, options, resolve, reject };
        const worker = idle.pop() ?? (workers < size ? spawn() : null);
        if (worker) run(worker, call);
        else queue.push(call);
      }),
  };
};
