import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Docs and guides: one Markdown file per page under src/content/, its URL the file's path
// (docs/index.md is /docs). title is the full <title>; label names the page in breadcrumbs and
// the pager; order places it in its section, the section's hub first at 0.
const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content' }),
  schema: z.object({
    title: z.string().endsWith(' - favseed'),
    description: z.string().min(120).max(160),
    heading: z.string(),
    label: z.string(),
    lede: z.string(),
    order: z.number().int().min(0),
  }),
});

export const collections = { pages };
