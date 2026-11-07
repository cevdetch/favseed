// Head injection.
//
// Astro has no official head-injection hook: all four injectScript stages are JavaScript,
// and a <link rel="icon"> written by a script is a link the browser finds late, after it has
// already asked for /favicon.ico. So the HTML is spliced instead, in an order:'post'
// middleware that runs once the page has rendered.
//
// Two guards. A page that already declares an icon is left alone: the author has said what
// they want, and two competing <link rel="icon"> sets is a coin toss. And only text/html is
// touched: an endpoint returning JSON is not a page.
//
// Inspect at most 64 KiB through the closing head, then forward bytes as they arrive.
// Oversized or unclosed heads pass through unchanged; <Head /> avoids inspection entirely.

import { links } from 'virtual:favseed';

import { declaresIcon } from '../lib/core.mjs';

const HEAD_LIMIT = 64 * 1024;
const encodedLinks = new TextEncoder().encode(links);
const decoder = new TextDecoder();

const injectHead = () => {
  let pending = new Uint8Array(0),
    length = 0,
    scanned = 0,
    passthrough = false;
  return new TransformStream({
    transform(chunk, controller) {
      if (passthrough) {
        controller.enqueue(chunk);
        return;
      }

      const take = Math.min(chunk.byteLength, HEAD_LIMIT - length);
      if (length + take > pending.byteLength) {
        // Geometric growth bounds copying even if an adapter emits one byte per chunk.
        const grown = new Uint8Array(Math.min(HEAD_LIMIT, Math.max(1024, pending.byteLength * 2, length + take)));
        grown.set(pending.subarray(0, length));
        pending = grown;
      }
      pending.set(chunk.subarray(0, take), length);
      length += take;

      let end = -1;
      // Byte offsets keep BOM, split UTF-8 and even undecodable bytes intact. Rescan
      // only the unfinished marker suffix, never the previously inspected prefix.
      for (; scanned + 7 <= length; scanned++) {
        if (
          pending[scanned] === 60 &&
          pending[scanned + 1] === 47 &&
          (pending[scanned + 2] | 32) === 104 &&
          (pending[scanned + 3] | 32) === 101 &&
          (pending[scanned + 4] | 32) === 97 &&
          (pending[scanned + 5] | 32) === 100 &&
          pending[scanned + 6] === 62
        ) {
          end = scanned;
          break;
        }
      }
      if (end < 0 && length < HEAD_LIMIT) return;

      if (end >= 0 && !declaresIcon(decoder.decode(pending.subarray(0, end)))) {
        controller.enqueue(pending.subarray(0, end));
        controller.enqueue(encodedLinks.slice());
        controller.enqueue(pending.subarray(end, length));
      } else {
        controller.enqueue(pending.subarray(0, length));
      }
      pending = null;
      passthrough = true;
      if (take < chunk.byteLength) controller.enqueue(chunk.subarray(take));
    },
    flush(controller) {
      if (!passthrough && length) controller.enqueue(pending.subarray(0, length));
    },
  });
};

export const onRequest = async (context, next) => {
  const response = await next();

  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('text/html') || !response.body) return response;

  const headers = new Headers(response.headers);
  // Decide during consumption, so the final length is not known when headers leave.
  headers.delete('content-length');
  return new Response(response.body.pipeThrough(injectHead()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
