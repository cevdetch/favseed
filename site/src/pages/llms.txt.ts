// The llms.txt index (llmstxt.org): what favseed is, then every page. Markdown pages are linked
// by their .md alternate, which is the same text without the page around it.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { pathOf, sectionOf } from '../lib/content.mjs';
import { SITE } from '../lib/site.mjs';

// The hand-written pages, which have no Markdown source.
const pagesWithoutMarkdown = [
  ['/', 'Generator', 'make the set in your browser; nothing is uploaded'],
  ['/how-it-works', 'How it works', 'from one SVG to the set, step by step'],
  ['/outputs', 'Outputs', 'every file, the HTML it needs and the platforms that read it'],
  ['/benchmarks', 'Benchmarks', 'bytes, accuracy and build time, with sources'],
];

// Each Markdown section gets its own list, in this order. A new section needs only a line here.
const sections = [['docs', 'Docs']];

const summary = `favseed writes one optimised \`icon.svg\`, a 48×48 PNG-backed \`favicon.ico\`, an \`apple-touch-icon.png\`, and safe-zone-placed \`icon-192.png\`/\`icon-512.png\`, plus an optional \`site.webmanifest\`. Each raster is the smallest encode that passes an accuracy bar (at most 1.0% of pixels off by more than 8/255, checked on a white and a black background) and an edge gate, finished with Zopfli. \`--effort fast\`, \`default\` or \`max\` sets how many candidates are tried; \`--quality\` or \`--colors\` pins one setting instead. The browser and the command line share the same pipeline and produce identical bytes. Processing stays local: nothing is uploaded.`;

export const GET: APIRoute = async () => {
  const entries = (await getCollection('pages')).sort((a, b) => a.data.order - b.data.order);
  const line = (href: string, name: string, note: string) => `- [${name}](${new URL(href, SITE).href}): ${note}`;
  const sectionBlocks = sections.flatMap(([section, heading]) => {
    const list = entries
      .filter((entry) => sectionOf(entry) === section)
      .map((entry) => line(`${pathOf(entry)}.md`, entry.data.heading, entry.data.description));
    return list.length === 0 ? [] : ['', `## ${heading}`, '', ...list];
  });
  const text = [
    '# favseed',
    '',
    '> One SVG in, an optimised favicon set out. A Node CLI, a Vite plugin, an Astro integration and this website, which runs the same pipeline in the browser with nothing uploaded.',
    '',
    summary,
    ...sectionBlocks,
    '',
    '## Site',
    '',
    ...pagesWithoutMarkdown.map(([href, name, note]) => line(href, name, note)),
    '',
    '## Optional',
    '',
    line('/llms-full.txt', 'Every docs page in one file', 'the Markdown of all docs and guides'),
    '- [Source](https://github.com/cevdetch/favseed)',
    '- [Decisions](https://github.com/cevdetch/favseed/blob/main/docs/DECISIONS.md): every pipeline choice and the measurement behind it',
    '- [Changelog](https://github.com/cevdetch/favseed/blob/main/CHANGELOG.md)',
    '',
  ].join('\n');
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
