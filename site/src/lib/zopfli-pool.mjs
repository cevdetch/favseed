// Zopfli in its own workers, for the engine worker. Run in the engine worker, its synchronous
// WASM blocked that worker for every finish, so no other job's search could start an encode
// meanwhile; the Node host made the same move (decision 34). Same interface as lib/zopfli.mjs's
// createZopfli, so the engine cannot tell. Workers start on the first finish, never before: the
// quick set runs no Zopfli, and starting them with the engine delayed it. `loadWasm` supplies
// the bytes each new worker is sent. A worker that fails rejects only its own call and is
// replaced by the next one.
const ERRORS = { RangeError, TypeError };

export const createZopfliPool = ({
  loadWasm,
  size = 2,
  spawn = () => new Worker(new URL('./zopfli-worker.mjs', import.meta.url), { type: 'module' }),
} = {}) => {
  const idle = [],
    queue = [],
    all = new Set();

  const start = () => {
    const worker = spawn();
    all.add(worker);
    // A copy each, not a transfer: every worker is sent the same bytes.
    Promise.resolve()
      .then(loadWasm)
      .then(
        (bytes) => worker.postMessage({ type: 'wasm', bytes }),
        (error) => worker.postMessage({ type: 'wasm', error: error?.message ?? String(error) }),
      );
    worker.onmessage = ({ data: { result, error } }) => {
      const call = worker.current;
      worker.current = null;
      if (error) call.reject(new (ERRORS[error.name] ?? Error)(error.message));
      else call.resolve(result);
      const next = queue.shift();
      if (next) run(worker, next);
      else idle.push(worker);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      all.delete(worker);
      const at = idle.indexOf(worker);
      if (at >= 0) idle.splice(at, 1);
      worker.current?.reject(new Error(`Zopfli worker failed: ${event.message ?? 'unknown error'}`));
      worker.current = null;
      worker.terminate();
      if (queue.length) run(start(), queue.shift());
    };
    return worker;
  };

  const run = (worker, call) => {
    worker.current = call;
    worker.postMessage({ input: call.input, options: call.options });
  };

  return {
    zlibAsync: (input, options) =>
      new Promise((resolve, reject) => {
        const call = { input, options, resolve, reject };
        const worker = idle.pop() ?? (all.size < size ? start() : null);
        if (worker) run(worker, call);
        else queue.push(call);
      }),
  };
};
