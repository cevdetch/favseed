// Whatever an image build strips or recompiles for the browser, favseed only trusts it with
// real work once it reproduces the native module byte for byte on the calls favseed actually
// makes. Run through lib/engine.mjs itself, not a hand-rolled subset, so a call this harness
// misses cannot slip past review either.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../../lib/engine.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const SIZES = [16, 32, 48, 180, 192, 512];
const BACKGROUNDS = [undefined, '#000000'];
// Five settings, not the full search ladder: two colour-only points below the 256 ceiling, and
// two quality points below 100. Exercises both of encode()'s branches (colours kept, colours
// dropped) and is small enough to run on every fixture/size/background without re-deriving the
// search's own probe lists here.
const SETTINGS = [
  { quality: 100, colors: 256 },
  { quality: 100, colors: 16 },
  { quality: 100, colors: 2 },
  { quality: 80, colors: 256 },
  { quality: 60, colors: 256 },
];
const MAX_REPORTED_MISMATCHES = 10;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const settingLabel = (s) => `q${s.quality}c${s.colors}`;

// A flipped byte can land in a CRC or a length field rather than pixel data, so the corrupted
// side throws instead of returning different bytes (lib/engine.mjs's decode rejects a PNG that
// fails its own CRC check). Catching per output turns that into a comparable digest rather than
// an unhandled rejection that would abort every other output for the same case.
const attempt = async (fn) => {
  try {
    return { ok: true, bytes: await fn() };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
};
const digestOf = (result) => (result.ok ? sha256(result.bytes) : `error:${result.message}`);

// Same derivation encode() uses internally (lib/engine.mjs): quality below 100 drops colours,
// since quantOptions.maxQuality already pins the palette size there. Called directly here so a
// regression in the quantiser itself is caught even on a setting where encode()'s lossless side
// happens to win and would otherwise hide it.
const quantOptionsFor = ({ quality, colors }) => ({
  ...(quality === 100 ? { colors } : {}),
  speed: 1,
  minQuality: 0,
  maxQuality: quality,
});

export const listFixtures = () =>
  readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.svg'))
    .toSorted();

const TAG_IMAGE = /<image\b([^>]*)>/gi;
const ATTR = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g;

// Native resvg falls back to a system font for an unavailable one, and reads an image href off
// the real filesystem; the WASI sandbox has neither, so it substitutes nothing and the rendered
// bytes legitimately differ between the two builds. That is a property of the host, not of the
// image engine under test, so it is a rule on the markup (any <text>, or an <image> href that is
// not already embedded as a data: URI) rather than a fixture name list, so a future fixture with
// the same shape is caught automatically instead of silently producing a false mismatch.
export const isHostDependent = (svgText) => {
  if (/<text\b/i.test(svgText)) return true;
  for (const [, attrs] of svgText.matchAll(TAG_IMAGE)) {
    for (const [, name, quoted] of attrs.matchAll(ATTR)) {
      if (/^(?:xlink:)?href$/i.test(name) && !/^data:/i.test(quoted.slice(1, -1))) return true;
    }
  }
  return false;
};

/** The native `@napi-rs/image` with no argument, or a WASM target's Node loader by path. */
export const loadImage = (loaderPath) => (loaderPath ? require(loaderPath) : require('@napi-rs/image'));

/** Every output lib/engine.mjs's calls can produce for one (fixture, size, background) case,
 * in a fixed order, so the caller can zip two engines' lists together and compare by position. */
const computeCase = async (engine, image, svgText, px, background) => {
  const outputs = [];
  const render = await attempt(() => engine.render(svgText, px, background));
  outputs.push(['render', render]);
  outputs.push(['renderRgba', await attempt(async () => (await engine.renderRgba(svgText, px, background)).rgba)]);
  outputs.push([
    'decode',
    render.ok
      ? await attempt(async () => (await engine.decode(render.bytes)).rgba)
      : { ok: false, message: 'no render' },
  ]);
  outputs.push([
    'lossless',
    render.ok
      ? await attempt(async () => new Uint8Array(await image.losslessCompressPng(render.bytes)))
      : { ok: false, message: 'no render' },
  ]);
  outputs.push([
    'lossless-finish',
    render.ok
      ? await attempt(
          async () => new Uint8Array(await image.losslessCompressPng(render.bytes, { filter: [1], strip: false })),
        )
      : { ok: false, message: 'no render' },
  ]);
  for (const setting of SETTINGS) {
    const label = settingLabel(setting);
    if (!render.ok) {
      outputs.push([`encode-${label}`, { ok: false, message: 'no render' }]);
      outputs.push([`decode-encode-${label}`, { ok: false, message: 'no render' }]);
      outputs.push([`pngQuantize-${label}`, { ok: false, message: 'no render' }]);
      continue;
    }
    const encoded = await attempt(() => engine.encode(render.bytes, setting));
    outputs.push([`encode-${label}`, encoded]);
    outputs.push([
      `decode-encode-${label}`,
      encoded.ok
        ? await attempt(async () => (await engine.decode(encoded.bytes)).rgba)
        : { ok: false, message: 'no encode' },
    ]);
    outputs.push([
      `pngQuantize-${label}`,
      await attempt(async () => new Uint8Array(await image.pngQuantize(render.bytes, quantOptionsFor(setting)))),
    ]);
  }
  return outputs;
};

/**
 * Runs lib/engine.mjs's calls over `fixtures` (default: every SVG in test/fixtures/) at
 * `sizes` (default: the set the icons, the apple touch icon and the ICO payload actually need),
 * each with no ground and on `#000000`, once per raw image module, and hashes every output.
 * `zopfli`/`inflate` are never passed to createEngine: nothing compared here calls finish().
 * A fixture `isHostDependent` flags is skipped on both sides and counted in `hostDependent`,
 * never compared. A fixture `native` cannot even render is skipped on both sides too and
 * counted in `skipped`, rather than letting two unrelated error messages disagree and read as
 * a mismatch.
 */
export async function compareEngines(native, wasm, { fixtures, sizes = SIZES } = {}) {
  const names = fixtures ?? listFixtures();
  const nativeEngine = createEngine({ image: native, zopfli: null, inflate: null });
  const wasmEngine = createEngine({ image: wasm, zopfli: null, inflate: null });
  let total = 0;
  let skipped = 0;
  let hostDependent = 0;
  const mismatches = [];

  for (const name of names) {
    const svgText = readFileSync(new URL(name, FIXTURES), 'utf8');
    if (isHostDependent(svgText)) {
      hostDependent++;
      continue;
    }
    try {
      await nativeEngine.render(svgText, sizes[0], BACKGROUNDS[0]);
    } catch {
      skipped++;
      continue;
    }
    for (const px of sizes) {
      for (const background of BACKGROUNDS) {
        const bgLabel = background ?? 'none';
        const [nativeOutputs, wasmOutputs] = await Promise.all([
          computeCase(nativeEngine, native, svgText, px, background),
          computeCase(wasmEngine, wasm, svgText, px, background),
        ]);
        for (let i = 0; i < nativeOutputs.length; i++) {
          const [label, nativeResult] = nativeOutputs[i];
          const wasmResult = wasmOutputs[i][1];
          total++;
          const nativeSha = digestOf(nativeResult);
          const wasmSha = digestOf(wasmResult);
          if (nativeSha !== wasmSha) mismatches.push({ case: `${name} ${px} ${bgLabel} ${label}`, nativeSha, wasmSha });
        }
      }
    }
  }
  return { total, mismatches, skipped, hostDependent };
}

const isEntryPoint = (url) => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
};

async function main(argv) {
  if (!argv.length) {
    throw new Error('Usage: node bench/wasm-engine/parity.mjs <loader> [<loader> ...]');
  }
  const native = loadImage();
  const allMismatches = [];
  for (const loaderPath of argv) {
    const wasm = loadImage(loaderPath);
    const { total, mismatches, skipped, hostDependent } = await compareEngines(native, wasm, {});
    const notes = [];
    if (skipped) notes.push(`${skipped} fixture(s) skipped`);
    if (hostDependent) notes.push(`host-dependent, skipped: ${hostDependent}`);
    process.stdout.write(
      `${loaderPath}: ${total - mismatches.length} of ${total} identical` +
        (notes.length ? ` (${notes.join('; ')})` : '') +
        '\n',
    );
    for (const mismatch of mismatches) allMismatches.push({ ...mismatch, loader: loaderPath });
  }
  if (allMismatches.length) {
    for (const { loader, case: label, nativeSha, wasmSha } of allMismatches.slice(0, MAX_REPORTED_MISMATCHES)) {
      process.stderr.write(`  ${loader} ${label}: native ${nativeSha} != wasm ${wasmSha}\n`);
    }
    return 1;
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`favseed parity: ${error.message}\n`);
      process.exit(1);
    },
  );
}
