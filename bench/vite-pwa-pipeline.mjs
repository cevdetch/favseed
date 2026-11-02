// Real generator and Vite build measurements. Run each section sequentially on an idle CPU.
// node bench/vite-pwa-pipeline.mjs /isolated/deps /fresh/results generator|plugin [marks] [comma-separated arms]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { decode } from '../test/lib/png.mjs';
import { benchmarkPath } from './path.mjs';

assert.ok(process.argv[2] && process.argv[3], 'Pass isolated dependencies and fresh result directory');
const dependencyDirectory = benchmarkPath(process.argv[2]);
const out = benchmarkPath(process.argv[3]), section = process.argv[4] ?? 'generator';
const deps = createRequire(join(dependencyDirectory, 'package.json'));
assert.ok(['generator', 'plugin'].includes(section));
const selectedArms = process.argv[6]?.split(',');
const selectArms = (available) => {
  assert.ok(!selectedArms || selectedArms.every((arm) => available.includes(arm)), 'Unknown arm');
  return selectedArms ?? available;
};
const marks = (process.argv[5] ?? (section === 'generator' ? 'tiles,general,heavy,gradient' : 'general')).split(',');
assert.ok(marks.every((m) => ['tiles', 'general', 'heavy', 'gradient'].includes(m)));
mkdirSync(out, { recursive: true });
assert.ok(!readdirSync(out).length, 'Use a fresh result directory');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const external = (name) => import(pathToFileURL(deps.resolve(name)));
const importStart = performance.now();
const [{ loadEngine, optimiseSvg, engineVersions }, { buildSet }, { normaliseOptions },
  { instructions }, { generateAssets }, { minimal2023Preset }, { generateManifestIconsEntry }] = await Promise.all([
  import('../bin/favseed.mjs'), import('../lib/pipeline.mjs'), import('../lib/config.mjs'),
  external('@vite-pwa/assets-generator/api/instructions'), external('@vite-pwa/assets-generator/api/generate-assets'),
  external('@vite-pwa/assets-generator/presets'), external('@vite-pwa/assets-generator/api/generate-manifest-icons-entry'),
]);
const engine = await loadEngine();
const importMs = performance.now() - importStart;
assert.equal(deps('@vite-pwa/assets-generator/package.json').version, '2.0.0');
assert.equal(deps('sharp').versions.sharp, '0.35.5');
const metadata = { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, section,
  favseedVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version,
  sourceSha256: Object.fromEntries(['lib/engine.mjs', 'lib/pipeline.mjs', 'lib/core.mjs', 'lib/config.mjs']
    .map((name) => [name, hash(readFileSync(new URL(`../${name}`, import.meta.url)))])),
  engine: engineVersions(), assetsGenerator: '2.0.0', sharp: deps('sharp').versions,
  importMs, repetitions: 3,
  note: 'Full default presets differ in file counts, framing, backgrounds and SVG processing. Do not attribute their total byte differences to compression alone. Generator timings include source reads, instructions/buildSet, PNG/ICO writes and manifest serialization; exclude module imports and post-run validation. Plugin timings include the same minimal PWA service-worker setup in both arms; cache state is explicit.' };
writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
const presetFor = (quality) => ({ ...structuredClone(minimal2023Preset), ...(quality ? { png: { quality, compressionLevel: 9 } } : {}) });
const collect = (directory) => readdirSync(directory).filter((n) => /\.(?:png|ico|svg|webmanifest)$/.test(n)).sort().map((name) => {
  const bytes = readFileSync(join(directory, name));
  let dimensions;
  if (name.endsWith('.png')) {
    const decoded = decode(bytes);
    dimensions = { width: decoded.width, height: decoded.height, pixels: hash(decoded.data) };
  } else if (name.endsWith('.ico')) {
    assert.equal(bytes.readUInt16LE(2), 1);
    const count = bytes.readUInt16LE(4);
    dimensions = { entries: count, width: bytes[6] || 256, height: bytes[7] || 256 };
  }
  return { name, bytes: bytes.length, sha256: hash(bytes), ...dimensions };
});
const rows = [], seen = new Map();
const record = (row) => {
  const key = `${row.mark}/${row.arm}`, previous = seen.get(key);
  if (previous) assert.deepEqual(row.files, previous, `${key}: nondeterministic icon files`);
  seen.set(key, row.files);
  row.rasterBytes = row.files.filter((f) => /\.(png|ico)$/.test(f.name)).reduce((n, f) => n + f.bytes, 0);
  row.iconBytes = row.files.reduce((n, f) => n + f.bytes, 0);
  rows.push(row);
  writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(JSON.stringify({ section, rep: row.rep, mark: row.mark, arm: row.arm,
    cache: row.cache, ms: +row.ms.toFixed(2), rasterBytes: row.rasterBytes, files: row.files.length }));
};

if (section === 'generator') {
  const arms = selectArms(['vite-default', 'vite-quality90', 'favseed-default', 'favseed-release', 'favseed-fast', 'favseed-5', 'favseed-0']);
  // Initialize both render/encode paths with a small untimed image; full measurements retain placement work.
  await engine.encode(await engine.render('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>', 32), { colors: 256 });
  await engine.finish(await engine.render('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', 32), { iterations: 1 });
  const tiny = await instructions({ imageResolver: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32"/></svg>'),
    imageName: 'logo.svg', preset: { transparent: { sizes: [32] }, maskable: { sizes: [] }, apple: { sizes: [] } },
    htmlLinks: {}, basePath: '/', resolveSvgName: () => 'logo.svg' });
  await Object.values(tiny.transparent)[0].buffer();
  for (let rep = 0; rep < metadata.repetitions; rep++) for (const [index, mark] of marks.entries()) {
    const offset = index % arms.length, order = [...arms.slice(offset), ...arms.slice(0, offset)];
    if (rep % 2) order.reverse();
    for (const arm of order) {
      const directory = join(out, `r${rep}`, mark, arm);
      mkdirSync(directory, { recursive: true });
      const start = performance.now();
      const source = readFileSync(new URL(`../test/fixtures/${mark}.svg`, import.meta.url));
      if (arm.startsWith('vite')) {
        const plan = await instructions({ imageResolver: () => source, imageName: 'logo.svg',
          preset: presetFor(arm === 'vite-quality90' ? 90 : undefined), htmlLinks: {}, basePath: '/', resolveSvgName: () => 'logo.svg' });
        await generateAssets(plan, true, directory);
        writeFileSync(join(directory, 'logo.svg'), source);
        writeFileSync(join(directory, 'site.webmanifest'), JSON.stringify(generateManifestIconsEntry('object', plan)));
      } else {
        const options = normaliseOptions({ mode: arm === 'favseed-fast' ? 'fast' : 'release', zopfli: arm !== 'favseed-default', manifest: true });
        if (arm === 'favseed-5' || arm === 'favseed-0') options.iterations = Number(arm.slice(8));
        const result = await buildSet(source.toString(), options, { engine, optimiseSvg });
        for (const file of result.files) writeFileSync(join(directory, file.name), file.bytes);
      }
      const ms = performance.now() - start;
      record({ rep, mark, arm, cache: 'no-result-cache', ms, files: collect(directory) });
    }
  }
} else {
  const [{ build }, { VitePWA }, { default: favseed, favseedIcons }] = await Promise.all([
    external('vite'), external('vite-plugin-pwa'), import('../vite/index.mjs'),
  ]);
  metadata.vite = deps('vite/package.json').version;
  metadata.vitePwa = deps('vite-plugin-pwa/package.json').version;
  // Initialize common Workbox/Vite machinery before measuring empty icon caches.
  const warmRoot = join(out, 'warmup'); mkdirSync(warmRoot);
  writeFileSync(join(warmRoot, 'index.html'), '<!doctype html><html><head><title>Warmup</title></head><body></body></html>');
  await build({ configFile: false, root: warmRoot, logLevel: 'silent',
    plugins: VitePWA({ injectRegister: null, manifest: { name: 'Warmup', short_name: 'Warmup', icons: [] },
      workbox: { globPatterns: [], globIgnores: ['**/*'] } }),
    build: { outDir: 'dist', minify: false } });
  const arms = selectArms(['vite-default', 'vite-quality90', 'favseed-default', 'favseed-release', 'favseed-fast']);
  for (let rep = 0; rep < 3; rep++) for (const mark of marks) for (const arm of rep % 2 ? arms.toReversed() : arms) {
    const root = join(out, 'projects', mark, arm), publicDir = join(root, 'public'), src = join(root, 'src');
    mkdirSync(publicDir, { recursive: true }); mkdirSync(src, { recursive: true });
    const source = readFileSync(new URL(`../test/fixtures/${mark}.svg`, import.meta.url));
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>Icon benchmark</title></head><body>Icon benchmark</body></html>');
    writeFileSync(join(src, 'logo.svg'), source);
    const isFavseed = arm.startsWith('favseed');
    if (!isFavseed) writeFileSync(join(publicDir, 'logo.svg'), source);
    // A config file is how vite-plugin-pwa accepts a custom quality preset.
    const config = join(root, 'pwa-assets.config.mjs');
    writeFileSync(config, `export default ${JSON.stringify({ images: ['public/logo.svg'], preset: presetFor(arm === 'vite-quality90' ? 90 : undefined) })};\n`);
    const plugins = [];
    if (isFavseed) plugins.push(favseed({ input: 'src/logo.svg', bg: '#000000', mode: arm === 'favseed-fast' ? 'fast' : 'release', zopfli: arm !== 'favseed-default' }));
    plugins.push(...VitePWA({ injectRegister: null,
      manifest: { name: 'Icon benchmark', short_name: 'Icon benchmark', icons: isFavseed ? favseedIcons() : [] },
      pwaAssets: isFavseed ? { disabled: true } : { config },
      workbox: { globPatterns: [], globIgnores: ['**/*'] },
    }));
    const start = performance.now();
    await build({ configFile: false, root, logLevel: 'silent', plugins,
      build: { outDir: 'dist', emptyOutDir: true, minify: false } });
    const ms = performance.now() - start;
    record({ rep, mark, arm, cache: rep ? 'unchanged-input' : 'empty-icon-cache', persistentIconCache: isFavseed,
      ms, files: collect(join(root, 'dist')) });
  }
}
writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
const summaries = [...new Set(rows.map((r) => r.arm))].map((arm) => ({ arm,
  byRepetition: Array.from({ length: metadata.repetitions }, (_, rep) => {
    const selected = rows.filter((r) => r.arm === arm && r.rep === rep);
    return { rep, ms: selected.reduce((n, r) => n + r.ms, 0),
      rasterBytes: selected.reduce((n, r) => n + r.rasterBytes, 0), iconBytes: selected.reduce((n, r) => n + r.iconBytes, 0) };
  }),
}));
writeFileSync(join(out, 'summary.json'), JSON.stringify({ metadata, summaries }, null, 2) + '\n');
console.log(JSON.stringify(summaries));
