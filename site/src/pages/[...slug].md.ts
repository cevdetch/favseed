// The Markdown source of every docs and guide page, at the page's own URL plus .md.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { markdownOf, slugOf } from '../lib/content.mjs';

export async function getStaticPaths() {
  return (await getCollection('pages')).map((entry) => ({ params: { slug: slugOf(entry) }, props: { entry } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(markdownOf(props.entry), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
