// Local built-site server for integration tests. Never exposed beyond loopback.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationHeaders, securityHeaders } from '../headers.mjs';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    for (const file of [path, `${path}.html`, resolve(path, 'index.html')]) {
      if (!(await stat(file).catch(() => null))?.isFile()) continue;
      const bytes = await readFile(file);
      res
        .writeHead(200, {
          ...securityHeaders,
          ...(url.searchParams.has('no-isolation') ? {} : isolationHeaders),
          'content-type': types[extname(file)] ?? 'application/octet-stream',
        })
        .end(bytes);
      return;
    }
    res.writeHead(404).end('not found');
  } catch {
    res.writeHead(400).end('bad request');
  }
});
server.listen(4175, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
