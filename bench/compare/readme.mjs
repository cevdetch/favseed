// bench/compare/README.md, generated from results.json by `run.mjs --write` (after a run) or
// `run.mjs --readme` (from the committed results.json, running nothing). The method prose lives
// here with the tables, so every number in the README comes from the results it sits next to.
import { readFileSync, writeFileSync } from 'node:fs';
import { ACCURACY_PCT, EDGE_GATE } from '../../lib/core.mjs';
import { headToHead, median } from './lib.mjs';

const README = new URL('README.md', import.meta.url);

const n = (value) => Math.round(value).toLocaleString('en-GB');
const s1 = (ms) => (ms / 1000).toFixed(1);
const pct = (part, whole) => (whole ? ((part / whole) * 100).toFixed(1) : '0.0');
const ratio = ({ pass, scored }) => `${pass}/${scored}`;
const list = (items) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const pace = (ours, theirs) => (ours < theirs ? 'faster' : ours > theirs ? 'slower' : 'as fast');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const code = (items) => items.map((item) => `\`${item}\``);
const dateOf = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// Short names for the tables; the versions are in the first table.
const SHORT = {
  favseed: 'favseed',
  favicons: 'favicons',
  'astro-favicons': 'astro-favicons',
  'vite-pwa': 'Vite PWA assets generator',
  realfavicon: 'RealFaviconGenerator',
};

const DEFAULTS = {
  favseed: '`buildFiles({ input })`: default effort, `#000000` ground, no manifest',
  favicons: '`favicons(svg)` with no options: every platform on',
  'astro-favicons': "favilib with astro-favicons' own `defaults` object",
  'vite-pwa': '`minimal-2023` preset, nothing else set',
  realfavicon: "`generateFaviconFiles` with `initFaviconIconSettings()` and `path: '/'`",
};

const LIKE = {
  favseed: "`bg: 'none'` (the CLI's `--bg none`): `icon-192.png`, `icon-512.png`",
  favicons: 'the default `android-chrome-192x192.png` and `android-chrome-512x512.png`, asked for alone',
  'astro-favicons': "favilib's own `android-chrome-192x192.png` and `android-chrome-512x512.png` (offset 0)",
  'vite-pwa': '`minimal-2023` with `transparent: { sizes: [192, 512], padding: 0 }`',
  realfavicon: 'the default `web-app-manifest-192x192.png` and `web-app-manifest-512x512.png`',
};

function versionCell(tool) {
  const v = tool.versions ?? {};
  if (tool.id === 'favseed')
    return (
      `unreleased; \`bin/\` and \`lib/\` as of \`${tool.buildCommit ?? tool.commit}\`` +
      `${tool.buildDirty ? ' plus uncommitted changes' : ''}: ` +
      `@napi-rs/image ${v['@napi-rs/image']}, svgo ${v.svgo}, zopfli ${String(v.zopfli).split('+')[0]}`
    );
  return Object.entries(v)
    .map(([name, version]) => `${name} ${version}`)
    .join(', ');
}

const renderer = (tool) => (tool.id === 'favseed' ? 'resvg (@napi-rs/image)' : tool.sharpReference);

// Every failure message, with the inputs it hit, for one tool and one kind of failure.
function failures(rows, pick) {
  const byMessage = new Map();
  for (const row of rows) {
    // The first line only: libvips repeats part of a message on a second line, at times.
    const message = String(pick(row) || '')
      .split('\n')[0]
      .trim();
    if (!message) continue;
    if (!byMessage.has(message)) byMessage.set(message, []);
    byMessage.get(message).push(row.name);
  }
  return [...byMessage].map(([message, names]) => `${list(code(names))}: "${message}"`);
}

function timesPerInput(rows, id) {
  const ms = rows.filter((row) => !row.tools[id].error).map((row) => row.tools[id].ms);
  return { min: Math.min(...ms), median: median(ms), max: Math.max(...ms) };
}

// Whether every var() in a fixture carries a fallback and no custom property is defined, read
// from the file: the condition under which librsvg (see varCheck) draws it as resvg does.
function fallbackOnly(row) {
  if (row.corpus !== 'fixtures') return false;
  const svg = readFileSync(new URL(`../../test/fixtures/${row.name}.svg`, import.meta.url), 'utf8');
  const uses = [...svg.matchAll(/var\(\s*--[\w-]+\s*(,?)/g)];
  return uses.length > 0 && uses.every((use) => use[1] === ',') && !/(^|[;{\s])--[\w-]+\s*:/.test(svg);
}

// How the var-check renders came out, per sharp copy, in words.
function varCheckSentence(check) {
  if (!check) return '';
  const uniform = check.copies.every(
    (copy) =>
      copy.drawn.definition === '#000000' && copy.drawn.fallback === check.colour && copy.drawn.both === check.colour,
  );
  const copies = list(check.copies.map((copy) => `sharp ${copy.sharp} (librsvg ${copy.librsvg})`));
  if (!uniform)
    return (
      `\`bench/compare/var-check.mjs\` drew a fill given by a definition only, by a fallback only, and by both, ` +
      `with each sharp copy: ${check.copies.map((copy) => `sharp ${copy.sharp} ${JSON.stringify(copy.drawn)}`).join('; ')}. `
    );
  return (
    `With every sharp copy installed, ${copies}, librsvg draws a fill given only by a custom property ` +
    'definition black, draws `var(--c, colour)` in its fallback colour, and with both a definition and a fallback ' +
    'still draws the fallback: it ignores definitions. `bench/compare/var-check.mjs` repeats this check, and ' +
    '`results.json` records it as `varCheck`. '
  );
}

// What the fixtures no tool but favseed built have in common, read from the files themselves.
function excludedFixtures(rows, excluded) {
  const named = rows.filter((row) => row.corpus === 'fixtures' && excluded.includes(row.name));
  const boxes = named.map((row) => {
    const svg = readFileSync(new URL(`../../test/fixtures/${row.name}.svg`, import.meta.url), 'utf8');
    const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
    return {
      name: row.name,
      viewBox: /\bviewBox="([^"]*)"/.exec(root)?.[1],
      sized: /\s(?:width|height)=/.test(root),
    };
  });
  if (!boxes.length || boxes.some((box) => !box.viewBox || box.sized)) return [];
  return [
    `${list(code(boxes.map((box) => box.name)))} give their root \`<svg>\` only a viewBox, ` +
      `${list(boxes.map((box) => `\`${box.viewBox}\``))}, far smaller than one unit, and no width or height. ` +
      'libvips rejects them before any tool can scale them up; favseed, which reads the viewBox, builds them.',
    '',
  ];
}

export function writeReadme(results, path = README) {
  writeFileSync(path, renderReadme(results));
}

export function renderReadme(results) {
  const { machine, tools, summary, inputs: rows, determinism } = results;
  const all = summary.all;
  const S = (id) => all.tools[id];
  const fixtures = rows.filter((row) => row.corpus === 'fixtures').length;
  const open = rows.filter((row) => row.corpus === 'open').length;
  const perInput = (id, group = all) => group.tools[id].totalMs / group.common.inputs;
  const others = tools.filter((tool) => tool.id !== 'favseed');
  const fastest = others.toSorted((a, b) => perInput(a.id) - perInput(b.id))[0];
  const commonRows = rows.filter((row) => !all.common.excluded.includes(row.name));
  const varRows = rows.filter((row) => row.usesVar);
  const mostFiles = tools.toSorted((a, b) => S(b.id).files.max - S(a.id).files.max)[0];
  const svgTools = tools.filter((tool) => tool.fileNames.some((name) => name.endsWith('.svg')));
  const favseedLike = S('favseed').like;
  const favseedTool = tools.find((tool) => tool.id === 'favseed');
  const power = machine.power
    ? `, ${list(
        Object.entries({
          'platform profile': machine.power.platformProfile,
          'CPU governor': machine.power.governor,
          'energy preference': machine.power.energyPreference,
        })
          .filter(([, value]) => value)
          .map(([key, value]) => `${key} \`${value}\``),
      )}`
    : '';
  const sharpCopies = [...new Set(others.map((tool) => tool.sharpReference))];

  const lines = [
    '<!-- Generated by `node bench/compare/run.mjs --write` from results.json; `--readme` rewrites it',
    '     from the committed results.json without a run. Edit bench/compare/readme.mjs, not this file. -->',
    '',
    '# favseed next to four other favicon generators',
    '',
    `Measured on ${dateOf(results.generated)}. This benchmark builds the same ${rows.length} SVG files with favseed ` +
      'and four other favicon generators, each with its own defaults, and records how many files each one writes, ' +
      'how many bytes they take, how long a build takes, and how closely a transparent 192 and 512 px PNG from each ' +
      'tool matches the source. Every number below comes from `results.json` in this directory, from one run on one ' +
      'machine. Results depend on the input: the last section shows how far they move from one mark to the next.',
    '',
    '## The tools',
    '',
    'Each of the four takes one source image in Node and writes a favicon set. `favicons` is the general-purpose ' +
      'Node generator. astro-favicons and the Vite PWA assets generator plug into Astro and Vite, the two hosts ' +
      "favseed also integrates with. RealFaviconGenerator's `generate-favicon` is the generator library of the " +
      'RealFaviconGenerator project, the one its `realfavicon` CLI runs. All four render the SVG with sharp, which ' +
      'draws it with librsvg; favseed renders with resvg.',
    '',
    '| Tool | Versions | Renderer | Whole set: defaults as run |',
    '|---|---|---|---|',
    ...tools.map((tool) => `| ${SHORT[tool.id]} | ${versionCell(tool)} | ${renderer(tool)} | ${DEFAULTS[tool.id]} |`),
    '',
    'The four competitors are pinned to exact versions in `package.json` and `package-lock.json` here. ' +
      '`node bench/compare/run.mjs --install` installs them with `npm ci --ignore-scripts` into ' +
      '`bench/out/compare/deps/`, which git ignores. They are not dependencies of favseed or of the website, and ' +
      'nothing favseed ships imports them. Every competitor adapter in `tools/` checks the installed version against its pin ' +
      `before it runs. Each package resolves its own sharp, so three copies are installed: ${list(sharpCopies)}.`,
    '',
    '### Defaults, exactly as run',
    '',
    '- **favseed** builds what `favseed logo.svg` writes: `buildFiles({ input })` from `bin/favseed.mjs`, with the ' +
      'default effort, the `#000000` ground and no manifest.',
    '- **favicons** runs `favicons(svg)` with no options. Every platform is on by default, and every image and file ' +
      "it returns counts. It writes no SVG favicon by default: `favicon.svg` is marked optional in the package's " +
      'platform list, and optional icons are dropped unless a caller names them.',
    '- **astro-favicons** is an Astro integration with no standalone API. In `astro:config:setup` it passes its ' +
      'options to favilib, its engine, once per platform. A whole Astro build per input would time Astro rather ' +
      "than the generator, so the adapter calls favilib the way the integration does, with the integration's own " +
      '`defaults` object copied verbatim from `src/config/defaults.ts` at v3.1.8, one call per platform, all ' +
      "platforms at once, plus `withCapo: true` (Astro's `compressHTML` default). What this leaves out is the " +
      "integration's head middleware and the Vite plugin that serves and emits the files; neither changes a byte.",
    '- **Vite PWA assets generator** has no zero-config default: its CLI stops with "No preset found" without one. ' +
      'The adapter uses `minimal-2023`, the preset the package points new projects to (`minimal` is marked ' +
      "deprecated in its favour), and follows the CLI's path in memory without writing files. Another preset " +
      'would give other numbers.',
    '- **RealFaviconGenerator** runs `generateFaviconFiles(masterIcon, { icon: initFaviconIconSettings(), path: ' +
      "'/' }, adapter)` with `@realfavicongenerator/image-adapter-node`. Its default embeds attribution metadata in " +
      'every PNG and SVG; that stays, because it is the default.',
    '',
    'The files each default set holds (the same names for every input):',
    '',
    ...tools.map((tool) => `- **${SHORT[tool.id]}** (${tool.fileNames.length}): ${code(tool.fileNames).join(', ')}`),
    '',
    '## Inputs',
    '',
    `${rows.length} SVG files: ${plural(fixtures, 'fixture')} from \`test/fixtures/\` and ${plural(open, 'open-licence icon')} from ` +
      '`bench/corpus/` (fetched by `node bench/corpus/fetch.mjs` from four icon sets; licences in ' +
      '`bench/corpus/LICENSES.md`). Two fixtures are left out because they are invalid by design, as in every other ' +
      'sweep here: `unresolved.svg` uses a `var()` with no fallback, and `animvar.svg` uses a `var()` only inside ' +
      'its animation. The private corpus that the search sweep also runs over is left out, because this ' +
      'benchmark publishes its results per file.',
    '',
    '## Two measurements',
    '',
    '**Whole set.** Every file each tool writes by default, counted, summed and timed. PNG and ICO bytes are the ' +
      'raster total; SVG files and the rest (manifests, `browserconfig.xml`) are listed separately, because an SVG ' +
      "favicon is a different kind of file and a manifest's size depends on the names written into it.",
    '',
    '**Like for like.** The one pair every tool can write with the same framing: a transparent, unpadded 192 and ' +
      "512 px PNG. favseed's default icons sit on an opaque ground inside the maskable safe zone and the other " +
      "tools' defaults differ again, so their whole sets do not compare pixel for pixel. Each tool's pair:",
    '',
    ...tools.map((tool) => `- ${SHORT[tool.id]}: ${LIKE[tool.id]}`),
    '',
    (() => {
      const pngs = rows.flatMap((row) =>
        tools.flatMap((tool) => [192, 512].map((px) => row.tools[tool.id].like[px]).filter(Boolean)),
      );
      const sized = pngs.filter((like) => !like.error);
      return (
        `The run checks that every PNG of a pair is exactly 192 or 512 px square and records whether it has ` +
        `transparency: ${n(sized.length)} of the ${n(pngs.length)} PNGs written have the right size, and ` +
        `${n(sized.filter((like) => like.transparent).length)} of those are transparent.`
      );
    })(),
    '',
    '### Timing',
    '',
    `Each tool runs in its own fresh Node process for each of ${plural(results.reps, 'repetition')}, so engine start-up ` +
      'shows in the cold time instead of being amortised across runs. The process first builds a warm-up mark that is not one of the inputs (a ' +
      'filled circle), then every input in order, then the first input again to check it writes the same bytes ' +
      'twice. Each input is timed from the call to the returned files, in memory, with no files written. The ' +
      'warm-up is excluded from the totals; cold time is the time from starting the process to the end of the ' +
      'warm-up build, so it holds Node start-up, module loading and the first build. Tools run one at a time, ' +
      'never concurrently, in an order rotated each repetition. A time is the median of the repetitions. The run ' +
      'took ' +
      `${plural(Math.round(results.durationS / 60), 'minute')}. The 1, 5 and ` +
      `15 minute load averages were ${machine.load.before.join(', ')} as it started and ` +
      `${machine.load.after.join(', ')} as it ended, the second including the run's own load.`,
    '',
    `Machine: ${machine.cpu}, ${machine.cores} threads, ${machine.ramGiB} GiB RAM, ${machine.os}, Node ` +
      `${machine.node}${power}. These timings hold for this machine only.`,
    '',
    '### Accuracy and the two references',
    '',
    "Each like-for-like PNG is scored with favseed's own accuracy bar (`passesBar` in `lib/quality.mjs`): on " +
      `both a black and a white ground, the share of pixels more than 8/255 off must stay at or below ${ACCURACY_PCT} % ` +
      `and the edge error at or below ${EDGE_GATE}. A pass means both the 192 and the 512 pass. Each PNG is scored against ` +
      'two references, rendered at the same size:',
    '',
    `- **resvg**: the source, with its \`var()\` resolved, rendered by ${results.references.resvg}, ` +
      "favseed's own renderer (`reference` in `test/lib/accuracy.mjs`). This is the source as favseed draws it, " +
      'so it favours favseed: a place where librsvg draws a curve or an edge differently counts against the ' +
      'other tools.',
    "- **sharp**: the raw SVG rendered losslessly by each tool's own sharp copy, so with the same librsvg build " +
      'the tool used, at the density favicons gives sharp, fitted transparent into the square. favseed is scored ' +
      `against ${favseedTool.sharpReference}. Against this reference, a renderer ` +
      "difference does not count as another tool's encoding loss, but does count against favseed.",
    '',
    'Reporting both separates encoding loss from renderer differences. A tool that passes against its own ' +
      'renderer and fails against the other loses little in encoding and draws the mark differently.',
    '',
    `The two renderers often disagree with each other. Scored the same way, the lossless render of ` +
      `${favseedTool.sharpReference.split(' (')[0]}, favseed's sharp reference, ` +
      `passes against resvg's on ${all.renderers.agree} of the ${all.renderers.scored} inputs ` +
      `both can render (${summary.fixtures.renderers.agree} of ${summary.fixtures.renderers.scored} fixtures, ` +
      `${summary.open.renderers.agree} of ${summary.open.renderers.scored} open icons). On the other ` +
      `${all.renderers.passedBoth.inputs}, a PNG could in principle sit within the bar of both, but ` +
      (all.renderers.passedBoth.passed.length
        ? `only ${all.renderers.passedBoth.passed.length} of the ${all.renderers.passedBoth.pairs} pairs the five tools wrote do`
        : `none of the ${all.renderers.passedBoth.pairs} pairs the five tools wrote passes against both`) +
      ', so neither pass count alone measures encoding loss. The agreement count uses the sharp 0.35.5 render; ' +
      "the other tools' own references come from their own librsvg builds.",
    '',
    '### var()',
    '',
    varCheckSentence(results.varCheck) +
      `${plural(varRows.length, 'input')} use \`var()\` (${list(code(varRows.map((row) => row.name)))}` +
      `${varRows.every((row) => row.corpus === 'fixtures') ? ', all of them fixtures' : ''})` +
      (varRows.every(fallbackOnly)
        ? ', and every `var()` in them carries a fallback with no definition, so librsvg draws them in the ' +
          'colours resvg uses and no tool renders a mark black here.'
        : '.') +
      ' The pass counts are also given without those inputs, so a corpus that does show the effect shows it ' +
      'there. favseed resolves `var()` before it renders, including a value given with `--var`.',
    '',
    '## Results',
    '',
    `The headline totals cover the ${all.common.inputs} of ${all.inputs} inputs every tool built` +
      (all.common.excluded.length
        ? ` (left out: ${list(code(all.common.excluded))}, which at least one tool could not build; see Failures).`
        : '.') +
      ' A per-input time is the median total over those inputs divided by their number.',
    '',
    '### Whole set, defaults',
    '',
    '| Tool | Files | PNG+ICO bytes | SVG bytes | Other bytes | ms per input | Cold ms |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...tools.map((tool) => {
      const t = S(tool.id);
      const files = t.files.min === t.files.max ? `${t.files.min}` : `${t.files.min} to ${t.files.max}`;
      return (
        `| ${SHORT[tool.id]} | ${files} | ${n(t.rasterBytes)} | ${n(t.svgBytes)} | ${n(t.otherBytes)} | ` +
        `${n(perInput(tool.id))} | ${n(t.coldMs)} |`
      );
    }),
    '',
    'By corpus, over the inputs every tool built in each:',
    '',
    '| Tool | Fixtures: PNG+ICO bytes | ms per input | Open icons: PNG+ICO bytes | ms per input |',
    '|---|---:|---:|---:|---:|',
    ...tools.map((tool) => {
      const f = summary.fixtures,
        o = summary.open;
      return (
        `| ${SHORT[tool.id]} | ${n(f.tools[tool.id].rasterBytes)} | ${n(perInput(tool.id, f))} | ` +
        `${n(o.tools[tool.id].rasterBytes)} | ${n(perInput(tool.id, o))} |`
      );
    }),
    '',
    `(${plural(summary.fixtures.common.inputs, 'fixture')} and ${plural(summary.open.common.inputs, 'open icon')}.)`,
    '',
    'At its default effort favseed searches for the smallest encode that passes its accuracy bar and ' +
      'finishes every PNG with Zopfli; the sharp tools encode each file once. favseed against each tool, over the ' +
      `${commonRows.length} inputs every tool built: the mean time per input (the table above), the median ` +
      "input's time, and how many inputs each builds faster, with any corpus where the mean goes the other way:",
    '',
    ...others.map((tool) => {
      const h = headToHead(commonRows, 'favseed', tool.id);
      const mean = perInput('favseed'),
        theirs = perInput(tool.id);
      const flips = ['fixtures', 'open']
        .filter(
          (group) =>
            pace(perInput('favseed', summary[group]), perInput(tool.id, summary[group])) !== pace(mean, theirs),
        )
        .map(
          (group) =>
            `on the ${group === 'open' ? 'open icons' : 'fixtures'} favseed is ` +
            `${pace(perInput('favseed', summary[group]), perInput(tool.id, summary[group]))} ` +
            `(${n(perInput('favseed', summary[group]))} against ${n(perInput(tool.id, summary[group]))} ms)`,
        );
      const ties = h.inputs - h.aFaster - h.bFaster;
      return (
        `- **${SHORT[tool.id]}**: favseed is ${pace(mean, theirs)} on the mean (${n(mean)} against ` +
        `${n(theirs)} ms) ${pace(mean, theirs) === pace(h.aMedian, h.bMedian) ? 'and' : 'but'} ` +
        `${pace(h.aMedian, h.bMedian)} on the median input (${n(h.aMedian)} against ${n(h.bMedian)} ms); ` +
        (h.aFaster === h.inputs
          ? `it is faster on every one of the ${h.inputs} inputs`
          : h.bFaster === h.inputs
            ? `it is slower on every one of the ${h.inputs} inputs`
            : `it is faster on ${h.aFaster} of the ${h.inputs} inputs and slower on ${h.bFaster}`) +
        `${ties ? ` (${ties} tied)` : ''}${flips.length ? `; ${flips.join('; ')}` : ''}.`
      );
    }),
    '',
    `${SHORT[fastest.id]} builds a set ${n(perInput('favseed') / perInput(fastest.id))} times as fast as favseed ` +
      `on the mean. favseed's cold time, ` +
      `${n(S('favseed').coldMs)} ms, is Node start-up plus a full default-effort build of the warm-up circle` +
      (others.every((tool) => S(tool.id).coldMs < S('favseed').coldMs) ? ', the longest of the five.' : '.'),
    '',
    `${SHORT[mostFiles.id]} covers the most platforms, with ${S(mostFiles.id).files.max} files per set against ` +
      `favseed's ${S('favseed').files.max}, among them ` +
      `${mostFiles.fileNames.filter((name) => name.startsWith('apple-touch-startup-image')).length} Apple startup ` +
      `(splash screen) images; ${list(svgTools.map((tool) => SHORT[tool.id]))} write an SVG favicon. ` +
      'Bytes per set do not compare encoders on their own, because the sets hold different files at different ' +
      'sizes: the like-for-like pair below does.',
    '',
    "The spread across repetitions, as each repetition's total over the common inputs and its cold time:",
    '',
    '| Tool | Totals, s | Cold, ms |',
    '|---|---|---|',
    ...tools.map(
      (tool) =>
        `| ${SHORT[tool.id]} | ${S(tool.id).repsTotalMs.map(s1).join(', ')} | ` +
        `${S(tool.id).repsColdMs.map(n).join(', ')} |`,
    ),
    '',
    '### Like for like: transparent 192 and 512 px',
    '',
    `Bytes over the ${all.likeCommon.inputs} inputs every tool built a pair for. Passes are out of the inputs ` +
      'where that reference exists and the tool built both sizes, so the denominators differ by tool and ' +
      'reference.',
    '',
    '| Tool | 192 px bytes | 512 px bytes | Both | favseed as % | Pass, resvg | Pass, sharp | Pass, resvg, no var() | Pass, sharp, no var() |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...tools.map((tool) => {
      const l = S(tool.id).like,
        both = l.bytes[192] + l.bytes[512];
      return (
        `| ${SHORT[tool.id]} | ${n(l.bytes[192])} | ${n(l.bytes[512])} | ${n(both)} | ` +
        `${pct(favseedLike.bytes[192] + favseedLike.bytes[512], both)} | ${ratio(l.resvg)} | ${ratio(l.sharp)} | ` +
        `${ratio(l.withoutVar.resvg)} | ${ratio(l.withoutVar.sharp)} |`
      );
    }),
    '',
    '"favseed as %" is the size of favseed\'s pair as a percentage of that tool\'s.',
    '',
    ...others
      .filter((tool) => S(tool.id).like.sharp.pass === S(tool.id).like.sharp.scored)
      .flatMap((tool) => {
        const l = S(tool.id).like;
        return [
          `${SHORT[tool.id]} passes against its own renderer on every input it built (${ratio(l.sharp)}), with ` +
            `a pair ${((l.bytes[192] + l.bytes[512]) / (favseedLike.bytes[192] + favseedLike.bytes[512])).toFixed(1)} ` +
            "times the size of favseed's.",
          '',
        ];
      }),
    (() => {
      const size = (tool) => S(tool.id).like.bytes[192] + S(tool.id).like.bytes[512];
      const smallest = others.toSorted((a, b) => size(a) - size(b))[0];
      const l = S(smallest.id).like;
      return (
        `${SHORT[smallest.id]} writes the smallest pair of the other four, ${n(size(smallest))} bytes` +
        (smallest.pngQuality
          ? `, encoding every PNG at sharp quality ${smallest.pngQuality} (a lossy palette encode), the ` +
            `package default \`defaultPngCompressionOptions\` that ${smallest.preset ?? 'its preset'} leaves unchanged`
          : '') +
        `; it passes against its own renderer on ${l.sharp.pass} of ${l.sharp.scored} inputs.`
      );
    })(),
    '',
    (() => {
      const pngs = rows.flatMap((row) =>
        [192, 512].map((px) => ({ corpus: row.corpus, ...row.tools.favseed.like[px] })).filter((l) => l.self),
      );
      const scored = pngs.filter((l) => l.resvg);
      const missed = scored.filter((l) => !l.resvg.pass);
      // No candidate passed: the search kept quality 80 at the colour ceiling and its own gate failed.
      const kept = missed.filter((l) => !l.self.pass && l.self.quality === 80);
      const agree = scored.filter((l) => l.self.pass === l.resvg.pass).length;
      const edgeOnly = missed.filter((l) => l.resvg.pct <= ACCURACY_PCT).length;
      return (
        `favseed misses against resvg on ${missed.length} of its ${scored.length} PNGs ` +
        `(${missed.filter((l) => l.corpus === 'fixtures').length} on fixtures, ` +
        `${missed.filter((l) => l.corpus === 'open').length} on open icons; ${edgeOnly} of them on the edge ` +
        `clause alone). On ${kept.length === missed.length ? 'every one' : `${kept.length}`} of them, its own ` +
        'build found no setting on its search lists that passed and kept its quality-80 encode without a ' +
        "warning, as decision 29 in `docs/DECISIONS.md` specifies. Separately, favseed's own verdict, against " +
        `its own reference, matches this benchmark's resvg verdict on ${agree} of the ${scored.length} PNGs.`
      );
    })(),
    '',
    '### Failures',
    '',
    ...tools.flatMap((tool) => {
      const set = failures(rows, (row) => row.tools[tool.id].error);
      const like = failures(rows, (row) => !row.tools[tool.id].error && row.tools[tool.id].like.error);
      const sizeErrors = failures(rows, (row) =>
        [192, 512]
          .map((px) => row.tools[tool.id].like[px]?.error)
          .filter(Boolean)
          .join('; '),
      );
      const found = [
        ...set.map((line) => `no set for ${line}`),
        ...like.map((line) => `no like-for-like pair for ${line}`),
        ...sizeErrors.map((line) => `unusable like-for-like PNG for ${line}`),
      ];
      return [`- **${SHORT[tool.id]}**: ${found.length ? found.join('; ') : 'built every input'}.`];
    }),
    '',
    ...(() => {
      const resvgErrors = failures(rows, (row) => Object.values(row.referenceError?.resvg ?? {}).join('; '));
      const sharpErrors = failures(rows, (row) =>
        [...new Set(tools.flatMap((tool) => Object.values(row.tools[tool.id].like.referenceError?.sharp ?? {})))].join(
          '; ',
        ),
      );
      return [
        `References that could not be rendered, and so score nothing: resvg ${resvgErrors.length ? resvgErrors.join('; ') : 'none'}; ` +
          `sharp ${sharpErrors.length ? sharpErrors.join('; ') : 'none'}.`,
        '',
        ...excludedFixtures(rows, all.common.excluded),
      ];
    })(),
    '### Determinism',
    '',
    tools.every((tool) => determinism[tool.id].deterministic)
      ? `Every tool wrote identical bytes for every input in each of ${plural(results.reps, 'repetition')}, and for the first ` +
        'input built twice in one process.'
      : tools
          .map(
            (tool) =>
              `${SHORT[tool.id]}: ${determinism[tool.id].deterministic ? 'identical bytes' : `differing bytes on ${list(code(determinism[tool.id].differing)) || 'the repeat build'}`}`,
          )
          .join('; ') + '.',
    '',
    'A failed build counts as the same outcome whatever its message says, because libvips words the same ' +
      'failure differently from run to run.',
    '',
    '## Results depend on the input',
    '',
    `Per input, over the ${commonRows.length} inputs every tool built, each tool's build time (the median of ` +
      'the repetitions), from the fastest input to the slowest:',
    '',
    '| Tool | Fastest, ms | Median, ms | Slowest, ms |',
    '|---|---:|---:|---:|',
    ...tools.map((tool) => {
      const t = timesPerInput(commonRows, tool.id);
      return `| ${SHORT[tool.id]} | ${n(t.min)} | ${n(t.median)} | ${n(t.max)} |`;
    }),
    '',
    'Byte totals move with the corpus too. The fixtures are test marks drawn to exercise particular cases, ' +
      "the open icons come from four published icon sets, and the by-corpus table above shows each tool's " +
      'totals shifting differently between the two. A mark with a different mix of flat colour, gradients and fine detail, ' +
      'a different machine, or a different power setting gives different numbers. Per-input results for every ' +
      'tool, with a SHA-256 of every like-for-like PNG and one digest per whole set, are in `results.json`; the ' +
      'hash of every file of every set goes to `bench/out/compare/hashes.json` when the benchmark runs.',
    '',
    '## Reproduce',
    '',
    ...(() => {
      const t = favseedTool;
      return t.trees
        ? [
            `favseed's code is named by content, since a branch commit does not survive a squash merge: the run ` +
              `used \`bin/\` tree \`${t.trees.bin}\` and \`lib/\` tree \`${t.trees.lib}\`, last changed in ` +
              `\`${t.buildCommit}\`, with \`pnpm-lock.yaml\` blob \`${t.lockfile}\`. Any checkout where ` +
              '`git rev-parse HEAD:bin`, `HEAD:lib` and `HEAD:pnpm-lock.yaml` print these runs the same favseed code ' +
              'with the same engine pins; `pnpm install` installs them.',
            '',
          ]
        : [];
    })(),
    "The competitors' `package-lock.json` pins every package, including sharp's platform-specific libvips " +
      'binaries (`@img/sharp-*`) for each platform; npm installs the one for the machine, so another platform ' +
      'runs a different binary of the same version. The open icons are pinned by `bench/corpus/manifest.json`: ' +
      'the icon sets, their versions, the icon names and a hash of each file.',
    '',
    'From the repository root, with Node 24 or later:',
    '',
    '```sh',
    'pnpm install                                                # favseed and its pinned engines',
    'node bench/corpus/fetch.mjs                                 # the open icons, once',
    `node bench/compare/run.mjs --install --reps ${results.reps} --write   # install the pins, run, write results.json and this file`,
    'node bench/compare/run.mjs --readme                         # rewrite this file from results.json',
    '```',
    '',
    '`--only a,b` and `--inputs N` restrict a run to some inputs, for a quick check; `--write` is meant for a full ' +
      'run. The like-for-like PNGs land in `bench/out/compare/like/`.',
    '',
  ];
  return lines.join('\n');
}
