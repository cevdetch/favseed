// Every CLI flag the README or a docs page names is one bin/favseed.mjs accepts. A renamed or
// removed flag fails here rather than in a reader's terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const source = read('bin/favseed.mjs');
const flags = new Set(
  [...source.match(/const CLI_FLAGS = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
);

// Tokens that look like flags but are not favseed's: CSS custom properties written as their own
// code span, and the option-syntax placeholders the CLI page explains.
const notFlags = new Set(['--opt', '--brand', '--loop']);

const docs = readdirSync(new URL('site/src/content/', root), { recursive: true })
  .filter((name) => name.endsWith('.md'))
  .map((name) => join('site/src/content', name));

// A flag in prose is always code: an inline code span starting with it, or a favseed command line.
const named = (markdown) => {
  const found = new Set();
  for (const [, span] of markdown.matchAll(/`([^`\n]+)`/g)) {
    const flag = /^(--?[a-zA-Z][\w-]*)/.exec(span)?.[1];
    if (flag) found.add(flag);
  }
  for (const [line] of markdown.matchAll(/^.*\bfavseed\b(?! *\().*$/gm)) {
    if (!/^\s*(?:\$ )?(?:npx |pnpm (?:exec |dlx )?)?favseed\b/.test(line)) continue;
    for (const [, flag] of line.matchAll(/\s(--?[a-zA-Z][\w-]*)/g)) found.add(flag);
  }
  return [...found].filter((flag) => !notFlags.has(flag));
};

for (const file of ['README.md', ...docs]) {
  test(`${file} names only flags the CLI accepts`, () => {
    for (const flag of named(read(file))) assert.ok(flags.has(flag), `${file}: ${flag} is not a favseed flag`);
  });
}
