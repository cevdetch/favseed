// Every docs and guide page in one file, in section and page order, each under its own URL.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { markdownOf, pathOf, sectionOf } from '../lib/content.mjs';
import { SITE } from '../lib/site.mjs';

const sectionOrder = ['docs', 'guides'];

export const GET: APIRoute = async () => {
  const entries = (await getCollection('pages')).sort(
    (a, b) => sectionOrder.indexOf(sectionOf(a)) - sectionOrder.indexOf(sectionOf(b)) || a.data.order - b.data.order,
  );
  const body = entries
    .map((entry) => `<!-- ${new URL(pathOf(entry), SITE).href} -->\n\n${markdownOf(entry)}`)
    .join('\n\n');
  return new Response(`# favseed: the documentation in full\n\n${body}`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
