// Shared by the production host, development/preview servers, and actual-browser tests.
export const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const policy = (development = false) =>
  [
    "default-src 'self'",
    // WASM compilation is needed in both the engine worker and its nested workers.
    `script-src 'self' 'wasm-unsafe-eval'${development ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    `connect-src 'self' blob:${development ? ' ws: wss:' : ''}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');

export const securityHeaders = {
  'Content-Security-Policy': policy(),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
export const siteHeaders = { ...isolationHeaders, ...securityHeaders };
// Astro's dev tooling injects scripts and connects to Vite's HMR WebSocket.
export const developmentHeaders = { ...siteHeaders, 'Content-Security-Policy': policy(true) };

export const productionHeaders =
  '/*\n' +
  Object.entries(siteHeaders)
    .map(([key, value]) => `  ${key}: ${value}\n`)
    .join('') +
  '/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n';
