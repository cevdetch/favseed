import { pending } from '../gate.mjs';

export const GET = () => {
  const encoder = new TextEncoder();
  const head = '<html><head><title>Streaming endpoint</title></head><body>before-release';
  const tail = 'after-release</body></html>';
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(encoder.encode(head + tail).byteLength),
    'X-Fixture': 'stream',
  });
  headers.append('Set-Cookie', 'first=one; Path=/');
  headers.append('Set-Cookie', 'second=two; Path=/');
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(head));
        pending.then(() => {
          controller.enqueue(encoder.encode(tail));
          controller.close();
        });
      },
    }),
    { status: 207, headers },
  );
};
