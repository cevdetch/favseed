// Host-independent adapter for the same upstream Zopfli source as @gfx/zopfli
// 1.0.15, rebuilt with modern LLVM. See bench/zopfli/ for provenance and recipe.
import { ZOPFLI_VERSION } from './zopfli-build.mjs';
export { ZOPFLI_VERSION };

export const createZopfli = ({ loadWasm }) => {
  let ready;
  const load = () => (ready ??= Promise.resolve().then(loadWasm).then((bytes) =>
    WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: {
      proc_exit: (code) => { throw new Error(`Zopfli exited with status ${code}`); },
    } })).then(({ instance }) => instance.exports).catch((error) => {
    ready = undefined;
    throw error;
  }));

  return {
    async zlibAsync(bytes, { numiterations = 15, blocksplitting = true, blocksplittingmax = 15 } = {}) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Zopfli input must be a Uint8Array');
      if (!Number.isInteger(numiterations) || numiterations < 1 || numiterations > 0x7fffffff) {
        throw new RangeError('Zopfli iterations must be a positive 32-bit integer');
      }
      if (blocksplitting !== true || blocksplittingmax !== 15) {
        throw new RangeError('Zopfli requires block splitting with a maximum of 15');
      }
      // If another pending call trapped after initialization, do not reuse its
      // potentially corrupted allocator. Compression itself is synchronous.
      let pending = load();
      let api = await pending;
      while (pending !== ready) { pending = load(); api = await pending; }
      try {
        const ptr = api.allocate(Math.max(1, bytes.length)) >>> 0;
        if (!ptr) throw new Error('Zopfli input allocation failed');
        try {
          new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
          const result = api.compress_zlib(ptr, bytes.length, numiterations) >>> 0;
          const length = api.result_size() >>> 0;
          if (!result || !length) throw new Error('Zopfli output allocation failed');
          // Compression may grow memory. Read the current buffer, then copy
          // before freeing: later calls must never overwrite a returned result.
          return new Uint8Array(new Uint8Array(api.memory.buffer, result, length));
        } finally {
          api.deallocate(ptr);
          api.clear_result();
        }
      } catch (error) {
        ready = undefined;
        throw error;
      }
    },
  };
};
