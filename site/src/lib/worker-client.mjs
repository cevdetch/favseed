// Worker lifecycle and request ownership, independent of bundler/image imports for testing.
const aborted = () => new DOMException('Build cancelled', 'AbortError');

export function createWorkerClient({ createWorker, checkCapabilities }) {
  let worker,
    threaded,
    sequence = 0,
    activeBuild;
  const pending = new Map();
  const reset = (error = aborted()) => {
    const previous = worker;
    worker = undefined;
    previous?.terminate();
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    pending.clear();
    activeBuild = undefined;
  };
  const start = () => {
    if (worker) return worker;
    threaded = checkCapabilities();
    const current = createWorker();
    worker = current;
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      const request = pending.get(data.id);
      if (!request) return;
      if (data.type === 'progress') {
        request.onProgress?.(data.progress);
        return;
      }
      if (data.type === 'warning') {
        request.onWarn?.(data.message);
        return;
      }
      if (data.type === 'early') {
        request.onEarly?.(data.result);
        return;
      }
      if (data.type === 'error' && data.fatal) {
        reset(new Error(data.message));
        return;
      }
      pending.delete(data.id);
      request.cleanup();
      if (activeBuild === data.id) activeBuild = undefined;
      if (data.type === 'error') request.reject(new Error(data.message));
      else request.resolve(data.result);
    };
    current.onerror = (event) => {
      event.preventDefault();
      if (worker === current) reset(new Error(event.message || 'Could not start the image engine. Please retry.'));
    };
    current.onmessageerror = () => {
      if (worker === current) reset(new Error('Could not read the image worker response. Please retry.'));
    };
    return current;
  };
  const request = (type, payload = {}, { signal, onProgress, onWarn, onEarly } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(aborted());
        return;
      }
      if (type === 'build' && activeBuild !== undefined) reset();
      let current;
      try {
        current = start();
      } catch (e) {
        reject(e);
        return;
      }
      const id = ++sequence;
      const cancel = () => reset();
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      pending.set(id, { resolve, reject, cleanup, onProgress, onWarn, onEarly });
      if (type === 'build') activeBuild = id;
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        current.postMessage({ id, type, threaded, ...payload });
      } catch (e) {
        reset(e);
      }
    });
  return {
    warm: () => request('warm'),
    // Only a caller that shows the quick set asks for it: without one the build is one pass.
    build: (source, options, controls) =>
      request('build', { source, options, early: typeof controls?.onEarly === 'function' }, controls),
    dispose: () => reset(),
  };
}
