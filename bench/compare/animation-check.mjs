// What each tool does with an animated source: every tool's default set (its adapter's
// `wholeSet`, as run.mjs builds it) from a CSS-animated and a SMIL-animated fixture, and for each
// SVG file in the set whether it is the source unchanged and which kinds of animation it keeps.
// favicons writes no SVG by default, so its opt-in `favicon.svg` is built as well.
//
//   node bench/compare/animation-check.mjs     prints the result for every tool, as JSON
//
// The README's "Animated SVG" section states what this prints for the pinned versions.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importDep } from './deps.mjs';

const FIXTURES = ['animated', 'smil'];
const TOOLS = ['favseed', 'favicons', 'astro-favicons', 'vite-pwa', 'realfavicon'];
const KINDS = {
  keyframes: /@keyframes\b/,
  cssAnimation: /\banimation\s*:/,
  smil: /<(?:animate|animateMotion|animateTransform|set)\b/,
};

const fixture = (name) => fileURLToPath(new URL(`../../test/fixtures/${name}.svg`, import.meta.url));
const describe = (bytes, source) => {
  const text = Buffer.from(bytes).toString('utf8');
  return {
    unchanged: Buffer.compare(Buffer.from(bytes), source) === 0,
    ...Object.fromEntries(Object.entries(KINDS).map(([kind, re]) => [kind, re.test(text)])),
  };
};

const svgsOf = (files, source) =>
  Object.fromEntries(files.filter((f) => f.name.endsWith('.svg')).map((f) => [f.name, describe(f.bytes, source)]));

const out = {};
for (const id of TOOLS) {
  const tool = await import(`./tools/${id}.mjs`);
  out[id] = {};
  for (const name of FIXTURES) {
    const source = readFileSync(fixture(name));
    const { files } = await tool.wholeSet(fixture(name));
    out[id][name] = svgsOf(files, source);
  }
}
// favicons' favicon.svg, asked for by name with every other platform off.
const { default: favicons } = await importDep('favicons');
const off = { android: false, appleIcon: false, appleStartup: false, windows: false, yandex: false };
out['favicons, favicon.svg asked for'] = {};
for (const name of FIXTURES) {
  const { images } = await favicons(fixture(name), { icons: { ...off, favicons: ['favicon.svg'] } });
  out['favicons, favicon.svg asked for'][name] = svgsOf(
    images.map(({ name: file, contents }) => ({ name: file, bytes: contents })),
    readFileSync(fixture(name)),
  );
}
console.log(JSON.stringify(out, null, 2));
