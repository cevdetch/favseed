// Every CLI flag the README or a site page names is one bin/favseed.mjs accepts. A renamed or
// removed flag fails here rather than in a reader's terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { linkTags } from '../lib/core.mjs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const source = read('bin/favseed.mjs');
const flags = new Set(
  [...source.match(/const CLI_FLAGS = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
);

// Tokens that look like flags but are not favseed's: a CSS custom property written as its own
// code span, and the option-syntax placeholder the CLI page explains.
const notFlags = new Set(['--opt', '--brand']);

const list = (dir, extension) =>
  readdirSync(new URL(dir, root), { recursive: true })
    .filter((name) => name.endsWith(extension))
    .map((name) => join(dir, name));
const docs = list('site/src/content', '.md');
const pages = list('site/src/pages', '.astro');

const FLAG = /(?:^|\s)(--?[a-zA-Z][\w-]*)/g;
const COMMAND = /^\s*(?:\$ )?(?:npx |pnpm (?:exec |dlx )?)?favseed\b/;

// Inline code: a span that starts with a flag names it, and a span that is a favseed command
// names every flag in it.
const fromCode = (span, found) => {
  const flag = /^(--?[a-zA-Z][\w-]*)/.exec(span)?.[1];
  if (flag) found.add(flag);
  if (COMMAND.test(span)) for (const [, each] of span.matchAll(FLAG)) found.add(each);
};

// A flag in prose is always code: an inline code span (`…` in Markdown, <code>…</code> in a
// hand-written page), a favseed command line, or a line of a fenced flag reference, which starts
// with `-x,` or `--flag`.
const named = (text) => {
  const found = new Set();
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) fromCode(span, found);
  for (const [, span] of text.matchAll(/<code>([\s\S]*?)<\/code>/g)) fromCode(span, found);
  for (const [line] of text.matchAll(/^.*\bfavseed\b(?! *\().*$/gm)) {
    if (COMMAND.test(line)) for (const [, flag] of line.matchAll(FLAG)) found.add(flag);
  }
  for (const [, block] of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
    for (const line of block.split('\n')) {
      if (/^\s*(?:-[a-zA-Z],|--[a-zA-Z])/.test(line)) for (const [, flag] of line.matchAll(FLAG)) found.add(flag);
    }
  }
  return [...found].filter((flag) => !notFlags.has(flag));
};

test('the parser finds the flag reference, short forms included', () => {
  const found = new Set(named(read('site/src/content/docs/cli.md')));
  for (const flag of ['-o', '--sizes', '-q', '-V', '--version', '-h', '--help']) assert.ok(found.has(flag), flag);
});

for (const file of ['README.md', ...docs, ...pages]) {
  test(`${file} names only flags the CLI accepts`, () => {
    for (const flag of named(read(file))) assert.ok(flags.has(flag), `${file}: ${flag} is not a favseed flag`);
  });
}

// The README's quickstart shows real output: the <link> block --html prints and the bytes of the
// general fixture at the default effort, which test/hashes.mjs keeps in test/bytes.json.
const manifest = JSON.parse(read('test/bytes.json'));

test('the README links block is what favseed --html prints', () => {
  assert.ok(read('README.md').includes(linkTags('/', false).trim()), 'README <link> block differs from linkTags()');
});

test('the README byte table matches the byte manifest for the general fixture', () => {
  const readme = read('README.md');
  for (const file of ['icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
    const bytes = manifest.files[`default/general/${file}`].bytes.toLocaleString('en-GB');
    assert.match(readme, new RegExp(`\\| \`${file.replace('.', '\\.')}\` \\|[^\\n]*\\| ${bytes} B \\|`), file);
  }
});
