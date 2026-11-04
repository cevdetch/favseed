// Documents and workers can have different isolation policies. Both must permit sharing
// before choosing the threaded engine; an exposed constructor alone is insufficient.
export function checkCapabilities(scope = globalThis) {
  if (typeof scope.WebAssembly?.compile !== 'function') {
    throw new Error('This browser needs WebAssembly support. Update your browser or use the favseed CLI.');
  }
  if (typeof scope.DecompressionStream !== 'function') {
    throw new Error('This browser needs DecompressionStream support. Update your browser or use the favseed CLI.');
  }
  if (!scope.crossOriginIsolated || typeof scope.SharedArrayBuffer !== 'function') return false;
  let channel;
  try {
    const memory = new scope.WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    channel = new scope.MessageChannel();
    channel.port1.postMessage(memory.buffer);
    return true;
  } catch {
    // Only this capability probe falls back. Loading/compilation failures remain errors.
    return false;
  } finally {
    channel?.port1.close();
    channel?.port2.close();
  }
}
