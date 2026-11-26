import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri';
import sections from '../src/lib/sections.mjs';

const render = async (markdown) => {
  const processor = await createSatteriMarkdownProcessor({ hastPlugins: [sections], syntaxHighlight: false });
  return (await processor.render(markdown)).code;
};

test('each ## section becomes one <section>, with its heading id', async () => {
  const html = await render('Intro line.\n\n## First\n\nOne.\n\n### Sub\n\nTwo.\n\n## Second\n\nThree.\n');
  const cards = [...html.matchAll(/<section>([\s\S]*?)<\/section>/g)].map((match) => match[1]);
  assert.equal(cards.length, 3);
  assert.match(cards[0], /^\s*<p>Intro line\.<\/p>\s*$/);
  assert.match(cards[1], /<h2 id="first">First<\/h2>[\s\S]*<h3 id="sub">Sub<\/h3>[\s\S]*Two\./);
  assert.match(cards[2], /<h2 id="second">Second<\/h2>\s*<p>Three\.<\/p>/);
});

test('a page that starts with a heading has no empty first card', async () => {
  const html = await render('## Only\n\nText.\n');
  assert.equal([...html.matchAll(/<section>/g)].length, 1);
});
