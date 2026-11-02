import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const rules = 'User-agent: *\nAllow: /\n';
  const base = import.meta.env.BASE_URL;
  const root = site ? new URL(base.endsWith('/') ? base : `${base}/`, site) : undefined;
  const sitemap = root ? `\nSitemap: ${new URL('sitemap-index.xml', root).href}\n` : '';
  return new Response(rules + sitemap, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
