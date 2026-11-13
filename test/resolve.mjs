// resolveVars is the test suite's own, independent var() resolver (test/lib/resolve.mjs):
// a second implementation of the same rule favseed's resolveVarsPlugin enforces, kept
// deliberately separate so a shared bug cannot cancel itself out in the accuracy gate.
//
// An XML comment is not rendered, so prose inside one that happens to mention "var()" must
// not be mistaken for a call to resolve.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveVars } from './lib/resolve.mjs';

test('skips var() mentioned inside an XML comment', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
    '<!-- favseed resolves var() at build time --><rect fill="var(--c, #000)"/></svg>';
  const out = resolveVars(svg);
  assert.ok(out.includes('<!-- favseed resolves var() at build time -->'));
  assert.ok(out.includes('fill="#000"'));
});

test('does not throw on an unresolved var() inside a comment', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
    '<!-- var(--x) is just prose here --><rect fill="var(--c, #000)"/></svg>';
  assert.doesNotThrow(() => resolveVars(svg));
});

test('still throws on an unresolved var() outside a comment', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' + '<!-- prose --><rect fill="var(--y)"/></svg>';
  assert.throws(() => resolveVars(svg), /unresolved var\(--y\)/);
});

test('still resolves var() that sits between two comments', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
    '<!-- one --><rect fill="var(--c, #000)"/><!-- two --></svg>';
  assert.ok(resolveVars(svg).includes('fill="#000"'));
});

test('an unclosed comment runs to the end of the file, like XML', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
    '<rect fill="var(--c, #000)"/><!-- unterminated var(--x)';
  assert.doesNotThrow(() => resolveVars(svg));
});

test('skips var() mentioned inside a CSS comment in a <style> block', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
    '<style>/* uses var(--undefined) */ .a{fill:var(--c, #123456)}</style>' +
    '<rect class="a"/></svg>';
  const out = resolveVars(svg);
  assert.ok(out.includes('/* uses var(--undefined) */'));
  assert.ok(out.includes('fill:#123456'));
});

test('still throws on an unresolved var() outside a CSS comment', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
    '<style>/* fine */ .a{fill:var(--undefined2)}</style><rect class="a"/></svg>';
  assert.throws(() => resolveVars(svg), /unresolved var\(--undefined2\)/);
});

// A quoted "/*" (a legal CSS string, e.g. a generated-content value) is not a comment opener.
// Treating it as one would swallow everything up to the next literal "*/" as "comment", so a
// genuinely unresolvable var() just after it would silently stop being scanned at all.
test('throws on an unresolvable var() after a quoted "/*" that looks like a comment opener', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
    '<style>.a{content:"/*"; fill:var(--undefined)} ' +
    '@media (prefers-color-scheme: dark){.a{fill:red}}</style>' +
    '<rect class="a" width="10" height="10"/></svg>';
  assert.throws(() => resolveVars(svg), /unresolved var\(--undefined\)/);
});

test('keeps a quoted "/*" string intact when there is no var() problem', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
    '<style>.a{content:"/*"; fill:#000}</style><rect class="a" width="10" height="10"/></svg>';
  const out = resolveVars(svg);
  assert.ok(out.includes('content:"/*"'));
});

test('still skips a real comment that follows a quoted "/*" string', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
    '<style>.a{content:"/*"} /* uses var(--undefined) */ .b{fill:var(--c, #123456)}</style>' +
    '<rect class="b" width="10" height="10"/></svg>';
  const out = resolveVars(svg);
  assert.ok(out.includes('/* uses var(--undefined) */'));
  assert.ok(out.includes('fill:#123456'));
});
