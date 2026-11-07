// Exercise the actual middleware with Web Response bodies. Only Astro's virtual
// configuration module is supplied here; no implementation code is replaced.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const LINKS =
  '<link rel="icon" href="/blog/favicon.ico" sizes="48x48">\n' +
  '<link rel="icon" href="/blog/icon.svg" type="image/svg+xml">\n' +
  '<link rel="apple-touch-icon" href="/blog/apple-touch-icon.png">\n';
const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'virtual:favseed'
      ? {
          url: `data:text/javascript,${encodeURIComponent(`export const links = ${JSON.stringify(LINKS)};`)}`,
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
let onRequest;
try {
  ({ onRequest } = await import('../astro/middleware.mjs'));
} finally {
  hook.deregister();
}

const encode = (text) => new TextEncoder().encode(text);
const htmlResponse = (body, init = {}) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const run = (response) => onRequest({}, async () => response);
const chunks = (values) =>
  new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
const bytes = async (response) => Buffer.from(await response.arrayBuffer());
const promptly = async (operation) => {
  const abort = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(2000, undefined, { signal: abort.signal }).then(() => assert.fail('head waited for the unfinished body')),
    ]);
  } finally {
    abort.abort();
  }
};

describe('Astro streaming head injection', () => {
  it('delivers the injected head while the body is still pending', async () => {
    let source;
    const input = htmlResponse(
      new ReadableStream({
        start(c) {
          source = c;
          c.enqueue(encode('<html><head><title>Hi</title></head>'));
        },
      }),
    );
    let reader;
    try {
      const output = await promptly(run(input));
      reader = output.body.getReader();
      const received = [];
      await promptly(
        (async () => {
          while (!Buffer.concat(received).includes('</head>')) received.push(Buffer.from((await reader.read()).value));
        })(),
      );
      assert.equal(Buffer.concat(received).toString(), `<html><head><title>Hi</title>${LINKS}</head>`);
      source.enqueue(encode('<body>later</body></html>'));
      source.close();
      const tail = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        tail.push(Buffer.from(part.value));
      }
      assert.equal(Buffer.concat(tail).toString(), '<body>later</body></html>');
    } finally {
      if (!reader) source.close();
      else await reader.cancel();
    }
  });

  it('inserts exactly once across every byte split, preserving BOM and multibyte text', async () => {
    const input = Buffer.from('\uFEFF<html><head><title>café 🐱</title></head><body>世界</body></html>');
    const expected = Buffer.from(`\uFEFF<html><head><title>café 🐱</title>${LINKS}</head><body>世界</body></html>`);
    for (let split = 0; split <= input.length; split++) {
      assert.deepEqual(
        await bytes(await run(htmlResponse(chunks([input.subarray(0, split), input.subarray(split)])))),
        expected,
        `split ${split}`,
      );
    }
    assert.deepEqual(
      await bytes(await run(htmlResponse(chunks(Array.from(input, (byte) => Uint8Array.of(byte)))))),
      expected,
    );
  });

  it('preserves undecodable bytes around the insertion', async () => {
    const input = Buffer.concat([
      Buffer.from('<head>'),
      Buffer.from([0xff, 0xc0]),
      Buffer.from('</head>'),
      Buffer.from([0xfe]),
    ]);
    const expected = Buffer.concat([
      Buffer.from('<head>'),
      Buffer.from([0xff, 0xc0]),
      Buffer.from(LINKS + '</head>'),
      Buffer.from([0xfe]),
    ]);
    assert.deepEqual(await bytes(await run(htmlResponse(chunks([input])))), expected);
  });

  it('honors existing icon tokens in the head across chunk boundaries', async () => {
    for (const declaration of [
      '<link rel="shortcut icon" href="custom.ico">',
      "<LINK REL='alternate ICON' href='custom.svg'>",
      '<link rel=icon href=custom.ico>',
    ]) {
      const input = encode(`<head>${declaration}</head><body>unchanged</body>`);
      assert.deepEqual(
        await bytes(await run(htmlResponse(chunks(Array.from(input, (byte) => Uint8Array.of(byte)))))),
        Buffer.from(input),
      );
    }
  });

  it('ignores body icon links when deciding whether to inject', async () => {
    const input = '<head></head><body><link rel="icon" href="body.svg"></body>';
    assert.equal(
      await (await run(htmlResponse(input))).text(),
      `<head>${LINKS}</head><body><link rel="icon" href="body.svg"></body>`,
    );
  });

  it('recognizes ASCII case variations in the closing head', async () => {
    assert.equal(
      await (await run(htmlResponse('<HEAD></HeAd><body>ok</body>'))).text(),
      `<HEAD>${LINKS}</HeAd><body>ok</body>`,
    );
  });

  it('releases 64KiB without a head marker and passes later bytes through unchanged', async () => {
    const prefix = encode('<head>' + 'x'.repeat(65536 - 6));
    let source;
    let reader;
    try {
      const output = await promptly(
        run(
          htmlResponse(
            new ReadableStream({
              start(c) {
                source = c;
                c.enqueue(prefix);
              },
            }),
          ),
        ),
      );
      reader = output.body.getReader();
      assert.deepEqual(Buffer.from((await promptly(reader.read())).value), Buffer.from(prefix));
      source.enqueue(encode('</head><body>late</body>'));
      source.close();
      assert.equal(Buffer.from((await reader.read()).value).toString(), '</head><body>late</body>');
      assert.equal((await reader.read()).done, true);
    } finally {
      if (!reader) source.close();
      else await reader.cancel();
    }
  });

  it('applies the cap within a single large chunk and flushes incomplete heads unchanged', async () => {
    for (const input of ['', '<html><head>unfinished', '<head>' + 'x'.repeat(65536) + '</head><body>end</body>']) {
      assert.equal(Buffer.compare(await bytes(await run(htmlResponse(input))), Buffer.from(input)), 0);
    }
    const exact = '<head>' + 'x'.repeat(65536 - 13) + '</head>';
    assert.equal(await (await run(htmlResponse(exact))).text(), '<head>' + 'x'.repeat(65536 - 13) + LINKS + '</head>');
  });

  it('keeps status and other headers while dropping the stale HTML length', async () => {
    const output = await run(
      new Response('<head></head>', {
        status: 404,
        statusText: 'Missing',
        headers: {
          'content-type': 'text/html',
          'content-length': '13',
          'cache-control': 'private',
          'x-test': 'kept',
          'set-cookie': 'a=b; HttpOnly',
        },
      }),
    );
    assert.equal(output.status, 404);
    assert.equal(output.statusText, 'Missing');
    assert.equal(output.headers.get('content-length'), null);
    assert.equal(output.headers.get('cache-control'), 'private');
    assert.equal(output.headers.get('x-test'), 'kept');
    assert.deepEqual(output.headers.getSetCookie(), ['a=b; HttpOnly']);
    assert.equal(await output.text(), `<head>${LINKS}</head>`);
  });

  it('returns non-HTML and null-body responses without consuming or replacing them', async () => {
    for (const response of [
      new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'content-length': '11' } }),
      new Response(null, { status: 204, headers: { 'content-type': 'text/html' } }),
    ]) {
      assert.equal(await run(response), response);
      assert.equal(response.bodyUsed, false);
    }
  });

  it('forwards cancellation to the source without draining the body', async () => {
    let pulls = 0;
    let cancelled;
    const cancellation = new Promise((resolve) => {
      cancelled = resolve;
    });
    const input = htmlResponse(
      new ReadableStream({
        start(c) {
          c.enqueue(encode('<head></head>'));
        },
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(1024));
        },
        cancel(reason) {
          cancelled(reason);
        },
      }),
    );
    const output = await promptly(run(input));
    const reader = output.body.getReader();
    await reader.read();
    await reader.cancel('client left');
    assert.equal(await promptly(cancellation), 'client left');
    assert.ok(pulls <= 2, `eagerly pulled ${pulls} body chunks`);
  });

  it('propagates upstream failures before and after the head', async () => {
    for (const prefix of ['<head>unfinished', '<head></head><body>partial']) {
      let source;
      const input = htmlResponse(
        new ReadableStream({
          start(c) {
            source = c;
            c.enqueue(encode(prefix));
          },
        }),
      );
      const output = await promptly(run(input));
      const reader = output.body.getReader();
      if (prefix.includes('</head>')) {
        const received = [];
        while (!Buffer.concat(received).includes('</head>'))
          received.push(Buffer.from((await promptly(reader.read())).value));
        assert.match(Buffer.concat(received).toString(), /favicon\.ico/);
      }
      source.error(new Error('render failed'));
      await assert.rejects(reader.read(), /render failed/);
    }
  });

  it('does not let a consumed link chunk change another response', async () => {
    const first = await run(htmlResponse('<head></head>'));
    const reader = first.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (Buffer.from(value).includes('/blog/favicon.ico')) value.fill(0);
    }
    assert.equal(await (await run(htmlResponse('<head></head>'))).text(), `<head>${LINKS}</head>`);
  });
});
