// The raster stage: render an SVG at N px, encode the smaller of a quantised and a lossless PNG,
// and finish the winner with zopfli. Imports only core.mjs: the host passes in
// @napi-rs/image (native in Node, its WASM build in a browser), Zopfli and an inflate
// function, so the CLI and the website run the same code and produce the same bytes.
import { DEFAULT_COLORS, DEFAULT_QUALITY, SEARCH_COLORS, SEARCH_QUALITIES, viewBoxNumbers } from './core.mjs';
import { passesBar, prepareReference } from './quality.mjs';

// napi's Transformer.fromSvg never renders the longer side below 1000 px: it doubles the
// intrinsic size until it gets there. An outer SVG px wide and at least 1000 tall holds the
// longer side at that floor, and a crop then takes the px x px square from its top. Wrapping
// the content in the viewBox transform reproduced `resvg -w N -h N` on 40 of 40 renders.
const RENDER_FLOOR = 1000;

const ATTR = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
// Attributes that place the canvas, which the wrapper replaces. Every other attribute on the
// root (fill, stroke, style, class) is inherited by the content, so it moves onto the wrapper
// group; namespace declarations move onto the outer <svg>.
const CANVAS = new Set(['viewBox', 'width', 'height', 'preserveAspectRatio', 'x', 'y', 'version', 'baseProfile']);

export const wrapForSize = (svgText, px) => {
  const m = /<svg\b([^>]*?)\s*(?:\/>|>([\s\S]*)<\/svg>)\s*$/.exec(svgText);
  if (!m) throw new Error('not an SVG document');
  let box = null;
  const ns = [],
    carried = [];
  for (const [, k, v] of m[1].matchAll(ATTR)) {
    if (k === 'viewBox') box = viewBoxNumbers(v.slice(1, -1));
    else if (k === 'xmlns') continue;
    else if (k.startsWith('xmlns:')) ns.push(` ${k}=${v}`);
    else if (!CANVAS.has(k)) carried.push(` ${k}=${v}`);
  }
  if (!box || box.length !== 4 || !(box[2] > 0 && box[3] > 0)) {
    throw new Error('icon.svg needs a viewBox to render at a size');
  }
  // The pipeline supplies a square raster canvas. Non-square source geometry
  // remains in its own centered viewport inside that canvas.
  const [x, y, w, h] = box;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${ns.join('')} width="${px}" height="${Math.max(px, RENDER_FLOOR)}">` +
    `<g transform="scale(${px / w} ${px / h}) translate(${-x} ${-y})"${carried.join('')}>${m[2] ?? ''}</g></svg>`
  );
};

// Results can be views over WASM memory, which the next call reuses: own the bytes at once.
const copy = (bytes) => new Uint8Array(bytes);

// napi's own JsColorType: how many bytes rawPixels() spends per pixel. A paletted PNG's
// palette and tRNS are already resolved by this point, but the channel count still follows the
// DECODED image, not a fixed four — a fully opaque candidate (every pixel's alpha 255, the
// common padded-icon case; see lib/core.mjs's DEFAULT_BG) comes back as Rgb8 or even L8, never
// Rgba8. 16-bit and float variants never occur: encode()'s two paths (pngQuantize,
// losslessCompressPng) only ever write 8-bit PNGs.
const COLOR_CHANNELS = { 0: 1, 1: 2, 2: 3, 3: 4 }; // L8, La8, Rgb8, Rgba8

/** Expands rawPixels() bytes to width*height*4 RGBA, the shape every quality metric expects. */
const expandToRgba = (raw, width, height, colorType) => {
  const channels = COLOR_CHANNELS[colorType];
  if (!channels) throw new Error(`engine.decode: unsupported colour type ${colorType}`);
  if (channels === 4) return raw;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; o < out.length; i += channels, o += 4) {
    if (channels === 3) {
      out[o] = raw[i];
      out[o + 1] = raw[i + 1];
      out[o + 2] = raw[i + 2];
      out[o + 3] = 255;
    } else {
      out[o] = out[o + 1] = out[o + 2] = raw[i];
      out[o + 3] = channels === 2 ? raw[i + 1] : 255;
    }
  }
  return out;
};

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const BARE_PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const chunksOf = (png) => {
  const out = [];
  for (let o = 8; o + 12 <= png.length;) {
    const len = u32(png, o);
    out.push({ type: String.fromCharCode(...png.subarray(o + 4, o + 8)), data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
};
const chunk = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// The quality list at its colour ceiling, and quality 100 at every colour on its own ladder —
// the two probe lists `search`'s binary and exhaustive walks share. Built once per module, not
// per call: the settings are immutable and every call re-walks the same two lists.
const QUALITY_SETTINGS = SEARCH_QUALITIES.map((quality) => ({ quality, colors: DEFAULT_COLORS }));
const COLOR_SETTINGS = SEARCH_COLORS.map((colors) => ({ quality: 100, colors }));

// Quality below 100 ignores colours (encode's own quantOptions drop it), so the quality list's
// own q80 entry and effort 'fast' land on the same key — the search's binary walk always probes
// it first (index 4 of 9 is the first midpoint), so a build that finds nothing else passing
// never re-encodes to get "today's bytes".
const settingKey = (setting) => (setting.quality === 100 ? `colors:${setting.colors}` : `quality:${setting.quality}`);

/** Leftmost-passing binary search over `settings`, assuming the list is monotone in pass/fail
 * (true on the quality list for 568/568 corpus jobs, broken on the colour list for 13/568 —
 * bench/search/README.md's "smallest passing among every probe actually made" rule, below,
 * absorbs that). Every probed candidate is returned, in probe order. */
const binaryWalk = async (settings, probe) => {
  let lo = 0,
    hi = settings.length - 1;
  const probed = [];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = await probe(settings[mid]);
    probed.push(candidate);
    if (candidate.pass) hi = mid - 1;
    else lo = mid + 1;
  }
  return probed;
};

/** Every candidate on `settings`, in list order — effort 'max'. */
const exhaustiveWalk = async (settings, probe) => {
  const probed = [];
  for (const setting of settings) probed.push(await probe(setting));
  return probed;
};

/** True when `a` is the less-lossy of a tie on bytes: higher quality, then more colours. */
const lessLossy = (a, b) =>
  a.setting.quality !== b.setting.quality
    ? a.setting.quality > b.setting.quality
    : (a.setting.colors ?? 0) > (b.setting.colors ?? 0);

/** Smallest-bytes passing candidate among every probe made; ties go to the less-lossy setting. */
const smallestPassing = (probed) =>
  probed
    .filter((c) => c.pass)
    .reduce((best, c) => {
      if (!best) return c;
      if (c.png.length !== best.png.length) return c.png.length < best.png.length ? c : best;
      return lessLossy(c, best) ? c : best;
    }, null);

export const createEngine = ({ image, zopfli, inflate }) => {
  const at = (svgText, px, background) =>
    image.Transformer.fromSvg(wrapForSize(svgText, px), background ?? null).crop(0, 0, px, px);

  /**
   * The smaller of a quantised and a lossless encode. A tie keeps the quantised one (the
   * decision-7 guard and tie rule). Quality100 keeps the existing palette path; lower
   * quality derives a palette from the native target. No minimum-quality failure gate.
   */
  const encode = async (png, { colors, quality = 100 }) => {
    const quantOptions = { ...(quality === 100 ? { colors } : {}), speed: 1, minQuality: 0, maxQuality: quality };
    // Schedule both even on synchronous failure, and drain native work before rejecting.
    const settled = await Promise.allSettled([
      Promise.resolve()
        .then(() => image.pngQuantize(png, quantOptions))
        .then(copy),
      Promise.resolve()
        .then(() => image.losslessCompressPng(png))
        .then(copy),
    ]);
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    const [quantised, lossless] = settled.map((result) => result.value);
    return lossless.length < quantised.length ? lossless : quantised;
  };

  /** Decodes any PNG this engine might have produced to { width, height, rgba }. */
  const decode = async (png) => {
    const transformer = new image.Transformer(png);
    const { width, height, colorType } = await transformer.metadata();
    return { width, height, rgba: expandToRgba(copy(await transformer.rawPixels()), width, height, colorType) };
  };

  return {
    /** A PNG of svgText at px x px. `background` is a colour resvg parses, or absent. */
    render: async (svgText, px, background) => copy(await at(svgText, px, background).png()),

    /** The same render, decoded: what the safe-zone placement measures, and what a search's
     * reference is built from. `background` is the ground a padded reference needs; absent for
     * the unpadded renders placement already calls this with. */
    renderRgba: async (svgText, px, background) => ({
      width: px,
      height: px,
      rgba: copy(await at(svgText, px, background).rawPixels()),
    }),

    /** The pixel a ground paints, [r, g, b, a]. Rejects when resvg cannot parse the colour. */
    probe: async (background) => [
      ...copy(
        await image.Transformer.fromSvg(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${RENDER_FLOOR}"></svg>`,
          background,
        )
          .crop(0, 0, 1, 1)
          .rawPixels(),
      ),
    ],

    encode,

    /** Decodes an arbitrary PNG this engine produced — `new image.Transformer(png).rawPixels()`,
     * copied, then expanded to RGBA (see expandToRgba above for why that expansion is needed). */
    decode,

    /**
     * The smallest-passing encode of `raw` (the render encode() takes), gated against `reference`
     * (a decoded RGBA image; prepared once here, not once per candidate — lib/quality.mjs's
     * prepareReference). `effort`: 'fast' is today's one encode at quality 80, no search.
     * 'default' binary-searches the quality list and the colour list, 'max' walks both in full;
     * both then take the smallest passing candidate among every probe either walk actually made
     * (not "the first one to pass" — the colour list is not monotone in bytes; see
     * bench/search/README.md's colours=2 quirk). Nothing passing keeps the quality list's own
     * q80 probe, i.e. effort 'fast's bytes, and reports its (failing) gate rather than hiding it.
     * `pinned`, when given, skips the search entirely: one encode of exactly that setting,
     * returned whatever its gate says.
     */
    search: async (raw, reference, { effort, pinned }) => {
      const prepared = prepareReference(reference);
      const cache = new Map();
      const probe = (setting) => {
        const key = settingKey(setting);
        let entry = cache.get(key);
        if (!entry) {
          entry = (async () => {
            const png = await encode(raw, setting);
            const { pass, pct, edge } = passesBar(await decode(png), prepared);
            return { png, setting, pct, edge, pass };
          })();
          cache.set(key, entry);
        }
        return entry;
      };

      if (pinned) {
        const result = await probe(pinned);
        return { ...result, probes: cache.size };
      }
      if (effort === 'fast') {
        const result = await probe({ quality: DEFAULT_QUALITY });
        return { ...result, probes: cache.size };
      }

      const walk = effort === 'max' ? exhaustiveWalk : binaryWalk;
      const qualityProbed = await walk(QUALITY_SETTINGS, probe);
      const colorProbed = await walk(COLOR_SETTINGS, probe);
      const winner =
        smallestPassing([...qualityProbed, ...colorProbed]) ??
        qualityProbed.find((c) => c.setting.quality === DEFAULT_QUALITY);
      return { ...winner, probes: cache.size };
    },

    /**
     * Re-deflates the image data with zopfli. A lossless Sub pass can improve full palettes'
     * ordering; try it once on bare PNGs and keep it only if the cheap encode is smaller.
     * napi's prebuilt binaries leave zopfli out, so it runs here: within 0.21 % of oxipng's own
     * zopfli on 40 files, with identical decoded pixels. Zero iterations skips it; a result that
     * is not smaller is dropped.
     */
    finish: async (png, { iterations }) => {
      if (!iterations) return png;
      let chunks = chunksOf(png);
      let idat = concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
      // Low-colour palettes already favour None. Preserve metadata-bearing PNGs; the measured
      // gain comes from full-palette recoding, even on existing Sub rows. See bench/zopfli/COMPETITOR.md.
      if (
        chunks.some((c) => c.type === 'PLTE' && c.data.length === 256 * 3) &&
        chunks.every((c) => BARE_PNG_CHUNKS.has(c.type))
      ) {
        const sub = copy(await image.losslessCompressPng(png, { filter: [1], strip: false }));
        if (sub.length < png.length) {
          png = sub;
          chunks = chunksOf(png);
          idat = concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
        }
      }
      const deflated = copy(
        await zopfli.zlibAsync(await inflate(idat), {
          numiterations: iterations,
          blocksplitting: true,
          blocksplittingmax: 15,
        }),
      );
      if (deflated.length >= idat.length) return png;
      const parts = [SIGNATURE];
      let written = false;
      for (const c of chunks) {
        if (c.type !== 'IDAT') parts.push(chunk(c.type, c.data));
        else if (!written) {
          parts.push(chunk('IDAT', deflated));
          written = true;
        }
      }
      return concat(parts);
    },
  };
};
