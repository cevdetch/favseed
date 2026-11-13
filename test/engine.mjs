// The raster engine on its own: render size and fidelity, the colour probe, encode's choice,
// and finish's promise that zopfli changes bytes and never pixels.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import referenceZopfli from '@gfx/zopfli';
import * as napi from '@napi-rs/image';
import { Transformer } from '@napi-rs/image';

import { loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import {
  DEFAULT_COLORS,
  DEFAULT_QUALITY,
  SEARCH_COLORS,
  SEARCH_QUALITIES,
  nestForMask,
  placeInSafeZone,
  squareIconSvg,
} from '../lib/core.mjs';
import { createEngine, wrapForSize } from '../lib/engine.mjs';
import { passesBar } from '../lib/quality.mjs';
import { score } from './lib/accuracy.mjs';
import { decode } from './lib/png.mjs';
import { framingCases } from './lib/framing.mjs';

const FIX = new URL('./fixtures/', import.meta.url);
const icon = (name) =>
  squareIconSvg(optimiseSvg(readFileSync(new URL(`${name}.svg`, FIX), 'utf8'), { icon: true }).data).data;
const scratch = mkdtempSync(join(tmpdir(), 'favseed-engine.'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const engine = await loadEngine();

const haveResvg = (() => {
  try {
    execFileSync('resvg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
// The suite's decoder reads Buffers; the engine returns Uint8Arrays.
const dec = (bytes) => decode(Buffer.from(bytes));

describe('render', () => {
  it('bounds probes for a small painted mark without shrinking its safe-zone fit', async () => {
    const requested = [],
      canvas = 180;
    const result = await placeInSafeZone(
      icon('small-mark'),
      async (svg, px) => {
        requested.push(px);
        return engine.renderRgba(svg, px);
      },
      canvas,
    );
    assert.ok(
      requested.every((px) => px <= canvas),
      `oversized probe: ${Math.max(...requested)}`,
    );
    assert.ok(result.box > 1000, 'the intrinsic viewport still needs enlargement');
    assert.equal(requested.length, 55, 'the full calibrated candidate walk must remain intact');
    const { rgba } = await engine.renderRgba(result.svg, canvas);
    let radius = 0;
    for (let y = 0; y < canvas; y++)
      for (let x = 0; x < canvas; x++) {
        if (!rgba[(y * canvas + x) * 4 + 3]) continue;
        for (const [a, b] of [
          [x, y],
          [x + 1, y],
          [x, y + 1],
          [x + 1, y + 1],
        ])
          radius = Math.max(radius, Math.hypot(a - canvas / 2, b - canvas / 2));
      }
    assert.ok(radius <= canvas * 0.4 + 1.5, 'paint escapes the safe circle');
    assert.ok(radius >= canvas * 0.4 * 0.9, 'paint no longer fills the safe zone');
  });

  it('preserves shifted origins, root fill and nested percentages in cropped probes', async () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 64 64" fill="#175d8d">' +
      '<svg x="10" y="20" width="64" height="64" viewBox="0 0 64 64">' +
      '<rect x="43.75%" y="43.75%" width="12.5%" height="12.5%"/></svg></svg>';
    const requested = [];
    const result = await placeInSafeZone(
      source,
      (svg, px) => {
        requested.push(px);
        return engine.renderRgba(svg, px);
      },
      180,
    );
    assert.ok(requested.every((px) => px <= 180));
    // The painted8/64 square snaps to94px centered in180px: [43,137) on both axes.
    const golden =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">' +
      '<path fill="#175d8d" d="M43 43h94v94H43z"/></svg>';
    assert.deepEqual((await engine.renderRgba(result.svg, 180)).rgba, (await engine.renderRgba(golden, 180)).rgba);
  });

  it('overlaps alignment probes while choosing the first crisp size in descending order', async () => {
    let active = 0,
      peak = 0;
    const requested = [];
    const render = async (_svg, px) => {
      requested.push(px);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, px === 74 ? 8 : 1));
      const rgba = new Uint8Array(px * px * 4);
      rgba[(Math.floor(px / 2) * px + (px === 100 ? 99 : Math.floor(px / 2))) * 4 + 3] = 255;
      if (px !== 100 && px !== 74 && px !== 72) rgba[3] = 128;
      active--;
      return { width: px, height: px, rgba };
    };
    const fit = await placeInSafeZone('<svg viewBox="0 0 100 100"/>', render, 100);
    assert.equal(fit.box, 74, 'a faster later probe must not win a tie');
    assert.ok(peak > 1 && peak <= 4);
    assert.equal(active, 0);
    assert.ok(!requested.includes(68), 'a later batch ran after a crisp result');
  });
  it('renders px x px, below and above the 1000 px floor', async () => {
    for (const px of [16, 32, 180, 512, 1024, 1500]) {
      const img = dec(await engine.render(icon('general'), px));
      assert.deepEqual([img.width, img.height], [px, px], `asked for ${px}`);
    }
  });

  it('carries attributes of the root <svg> onto the content', async () => {
    // Icon sets put fill="none" and the stroke on the root; dropping them changes the mark.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#7c3aed" stroke-width="4"><path d="M2 12h20"/></svg>';
    const img = dec(await engine.render(svg, 24));
    assert.deepEqual(pixel(img, 12, 12), [124, 58, 237, 255], 'the root stroke was lost');
    assert.equal(pixel(img, 12, 3)[3], 0, 'the root fill="none" was lost');
  });

  it('paints the background under the mark', async () => {
    const img = dec(await engine.render('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"/>', 4, '#0e7c68'));
    assert.deepEqual(pixel(img, 0, 0), [14, 124, 104, 255]);
  });

  it('renderRgba returns the decoded pixels of the same render', async () => {
    const svg = icon('general');
    const a = await engine.renderRgba(svg, 64);
    const b = dec(await engine.render(svg, 64));
    assert.deepEqual([a.width, a.height], [64, 64]);
    assert.deepEqual([...a.rgba], [...b.data]);
  });

  it('matches resvg -w N -h N pixel for pixel', { skip: haveResvg ? false : 'resvg not installed' }, async () => {
    for (const name of ['general', 'heavy', 'mask', 'tiles', 'flat', 'gradient', 'wide', 'dark']) {
      for (const px of [32, 192, 512]) {
        const svg = icon(name),
          src = join(scratch, `${name}.svg`),
          out = join(scratch, `${name}-${px}.png`);
        writeFileSync(src, svg);
        execFileSync('resvg', ['--quiet', '-w', String(px), '-h', String(px), src, out]);
        const s = score(dec(await engine.render(svg, px)), decode(readFileSync(out)));
        assert.equal(s.pct, 0, `${name}@${px}: ${s.pct} % of pixels differ from resvg`);
      }
    }
  });

  it('refuses an SVG without a viewBox', () => {
    assert.throws(() => wrapForSize('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 32), /viewBox/);
  });
});

describe('square raster framing', () => {
  for (const { mark, golden } of framingCases) {
    it(`${mark} preserves source shape and alignment`, async () => {
      const source = readFileSync(new URL(`${mark}.svg`, FIX), 'utf8');
      const actual = dec(await engine.render(squareIconSvg(optimiseSvg(source).data).data, 128));
      assert.equal(score(actual, dec(await engine.render(golden, 128))).pct, 0);
    });
  }

  it('keeps both near-square directions centered without distorting circles', async () => {
    for (const [w, h, cx, cy] of [
      [100, 101, 50, 50.5],
      [101, 100, 50.5, 50],
    ]) {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><circle cx="${cx}" cy="${cy}" r="32"/></svg>`;
      const { data, warning } = squareIconSvg(source);
      const golden =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 101 101"><circle cx="50.5" cy="50.5" r="32"/></svg>';
      assert.equal(warning, null);
      assert.equal(score(dec(await engine.render(data, 202)), dec(await engine.render(golden, 202))).pct, 0);
    }
  });

  it('preserves nested viewports and inherited styling with explicit aspect-ratio settings', async () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 64" fill="#175d8d" preserveAspectRatio="none">' +
      '<svg x="32" y="16" width="64" height="32" viewBox="0 0 64 32"><circle cx="32" cy="16" r="16"/></svg></svg>';
    const golden =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="16" fill="#175d8d"/></svg>';
    assert.equal(
      score(dec(await engine.render(squareIconSvg(source).data, 128)), dec(await engine.render(golden, 128))).pct,
      0,
    );
  });

  it('retains valid XML prologs and self-closing roots across raster and padding wrappers', async () => {
    for (const body of ['', '<circle cx="64" cy="32" r="16"/>']) {
      const root = body
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 64">${body}</svg>`
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 64"/>';
      const source = '<?xml version="1.0"?><!DOCTYPE svg>' + root;
      const framed = squareIconSvg(source).data;
      const padded = nestForMask(framed, 64, 128);
      const golden =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
        (body ? '<circle cx="64" cy="64" r="8"/>' : '') +
        '</svg>';
      assert.equal(score(dec(await engine.render(padded, 128)), dec(await engine.render(golden, 128))).pct, 0);
    }
  });

  it('keeps source-unit percentages correct with explicit mask padding', async () => {
    const source = readFileSync(new URL('aspect-percent.svg', FIX), 'utf8');
    const placement = await placeInSafeZone(squareIconSvg(optimiseSvg(source).data).data, engine.renderRgba, 128, 25);
    const golden =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="48" y="56" width="32" height="16" fill="#175d8d"/></svg>';
    assert.equal(score(dec(await engine.render(placement.svg, 128)), dec(await engine.render(golden, 128))).pct, 0);
  });

  it('frames tiny coordinate sources consistently with their square counterpart', async () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2e-12 1e-12"><circle cx="1e-12" cy="5e-13" r="2.5e-13"/></svg>';
    // Keep the literal golden in the same tiny units: the renderer itself
    // approximates sub-micro-unit circle arcs differently from ordinary ones.
    const golden =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2e-12 2e-12"><circle cx="1e-12" cy="1e-12" r="2.5e-13"/></svg>';
    assert.equal(
      score(dec(await engine.render(squareIconSvg(source).data, 128)), dec(await engine.render(golden, 128))).pct,
      0,
    );
  });

  it('retains namespace-scoped references inside the original viewport', async () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 64">' +
      '<defs><circle id="dot" cx="64" cy="32" r="16"/></defs><use xlink:href="#dot" fill="#175d8d"/></svg>';
    const golden =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="16" fill="#175d8d"/></svg>';
    assert.equal(
      score(dec(await engine.render(squareIconSvg(source).data, 128)), dec(await engine.render(golden, 128))).pct,
      0,
    );
  });
});

describe('probe', () => {
  it('returns the pixel a ground paints', async () => {
    assert.deepEqual(await engine.probe('#ffffff'), [255, 255, 255, 255]);
    assert.deepEqual(await engine.probe('#ffffff80'), [255, 255, 255, 128]);
    assert.deepEqual(await engine.probe('rgb(14 124 104)'), [14, 124, 104, 255]);
  });

  it('rejects a colour resvg cannot parse', async () => {
    await assert.rejects(engine.probe('nonered'));
  });
});

const fakeImage = (q, l, seen = {}) => ({
  pngQuantize: async (png, opts) => {
    seen.quantize = opts;
    return q;
  },
  losslessCompressPng: async () => l,
});

describe('encode', () => {
  for (const synchronous of [false, true]) {
    it(`drains the other candidate after a ${synchronous ? 'synchronous' : 'asynchronous'} encoder failure`, async () => {
      const failure = new Error('quantizer failed');
      let finish,
        started = false,
        settled = false;
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      const image = {
        pngQuantize: () => {
          if (synchronous) throw failure;
          return Promise.reject(failure);
        },
        losslessCompressPng: () => {
          started = true;
          return pending;
        },
      };
      const encoded = createEngine({ image }).encode(Uint8Array.of(0), { colors: 8 });
      const rejected = assert
        .rejects(encoded, (error) => error === failure)
        .then(() => {
          settled = true;
        });
      await new Promise((resolve) => setImmediate(resolve));
      try {
        assert.ok(started, 'both candidates must be scheduled');
        assert.equal(settled, false, 'returned while sibling was still active');
      } finally {
        finish(Uint8Array.of(1));
        await rejected;
      }
    });
  }
  it('owns each candidate before a later native task reuses its memory', async () => {
    const shared = Uint8Array.of(1, 2);
    const image = {
      pngQuantize: async () => shared,
      losslessCompressPng: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        shared.fill(9);
        return Uint8Array.of(3, 3, 3);
      },
    };
    assert.deepEqual(await createEngine({ image }).encode(Uint8Array.of(0), { colors: 8 }), Uint8Array.of(1, 2));
  });
  it('keeps the smaller encode, and the quantised one on a tie', async () => {
    const q = Uint8Array.of(1, 1, 1),
      smaller = Uint8Array.of(2, 2),
      same = Uint8Array.of(3, 3, 3);
    const enc = (a, b) => createEngine({ image: fakeImage(a, b) }).encode(Uint8Array.of(0), { colors: 8 });
    assert.deepEqual(await enc(q, smaller), smaller);
    assert.deepEqual(await enc(q, same), q);
    assert.deepEqual(await enc(smaller, q), smaller);
  });

  it('asks the quantiser for a fixed palette, with no quality gate', async () => {
    const seen = {};
    await createEngine({ image: fakeImage(Uint8Array.of(1), Uint8Array.of(1, 2), seen) }).encode(Uint8Array.of(0), {
      colors: 256,
    });
    assert.deepEqual(seen.quantize, { colors: 256, speed: 1, minQuality: 0, maxQuality: 100 });
  });

  it('uses the quality target without a fixed palette below 100', async () => {
    const seen = {};
    await createEngine({ image: fakeImage(Uint8Array.of(1), Uint8Array.of(1, 2), seen) }).encode(Uint8Array.of(0), {
      colors: 256,
      quality: 80,
    });
    assert.deepEqual(seen.quantize, { speed: 1, minQuality: 0, maxQuality: 80 });
  });

  it('returns a PNG of the same size as its input', async () => {
    const out = dec(await engine.encode(await engine.render(icon('heavy'), 96), { colors: 256 }));
    assert.deepEqual([out.width, out.height], [96, 96]);
  });
});

const chunksValid = (png) => {
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const crc = png.readUInt32BE(o + 8 + len);
    assert.equal(crc32(png.subarray(o + 4, o + 8 + len)), crc, `bad CRC at offset ${o}`);
    o += 12 + len;
  }
};

describe('finish', () => {
  it('reduces a full-palette gradient with the same pixels', async () => {
    const { svg } = await placeInSafeZone(icon('gradient'), engine.renderRgba, 180, 'auto');
    const encoded = await engine.encode(await engine.render(svg, 180, '#000000'), { colors: 256 });
    // The old final-compression path: retain its rows and compress with the same upstream source.
    const unchangedRows = createEngine({
      image: { losslessCompressPng: async (png) => png },
      zopfli: referenceZopfli,
      inflate: inflateSync,
    });
    const baseline = await unchangedRows.finish(encoded, { iterations: 15 });
    const finished = await engine.finish(encoded, { iterations: 15 });
    assert.ok(finished.length < baseline.length, `${finished.length} >= ${baseline.length}`);
    assert.deepEqual(dec(finished), dec(encoded));
    chunksValid(Buffer.from(finished));
  });

  for (const name of ['general', 'gradient', 'tiles']) {
    it(`${name}: the same pixels in no more bytes, with valid chunks`, async () => {
      const enc = await engine.encode(await engine.render(icon(name), 128, '#000000'), { colors: 256 });
      const fin = await engine.finish(enc, { iterations: 15 });
      assert.ok(fin.length <= enc.length, `${fin.length} > ${enc.length}`);
      assert.deepEqual([...dec(fin).data], [...dec(enc).data]);
      chunksValid(Buffer.from(fin));
    });
  }

  it('returns its input untouched at zero iterations', async () => {
    const enc = await engine.encode(await engine.render(icon('flat'), 32), { colors: 256 });
    assert.equal(await engine.finish(enc, { iterations: 0 }), enc);
  });
});

describe('decode', () => {
  it('round-trips width and height through its own encode', async () => {
    const raw = await engine.render(icon('general'), 192, '#000000');
    const encoded = await engine.encode(raw, { quality: 100 });
    const decoded = await engine.decode(encoded);
    assert.deepEqual([decoded.width, decoded.height], [192, 192]);
  });

  // Pixel-exact against test/lib/png.mjs's independent decoder, one case per channel count
  // engine.decode's expandToRgba actually handles. `metadata().colorType` is asserted directly
  // (0 = L8, 1 = La8, 2 = Rgb8, 3 = Rgba8), so each case is proven to exercise the path its name
  // claims, not just happen to produce the right pixels some other way.
  const pixelExact = async (name, png, expectedColorType) => {
    const meta = await new Transformer(png).metadata();
    assert.equal(
      meta.colorType,
      expectedColorType,
      `${name}: expected colour type ${expectedColorType}, got ${meta.colorType}`,
    );
    const mine = await engine.decode(png);
    const theirs = decode(Buffer.from(png));
    assert.deepEqual([mine.width, mine.height], [theirs.width, theirs.height], `${name}: size`);
    assert.deepEqual([...mine.rgba], [...theirs.data], `${name}: pixels`);
  };

  it("matches the suite's decoder on an opaque truecolour (Rgb8) candidate", async () => {
    // general@192 on an opaque ground, at quality 80: every pixel's alpha is 255, so the
    // quantiser/lossless pick drops the alpha channel entirely rather than carry a constant one.
    const raw = await engine.render(icon('general'), 192, '#000000');
    const png = await engine.encode(raw, { quality: 80 });
    await pixelExact('general@192 q80', png, 2);
  });

  it("matches the suite's decoder on an opaque greyscale (L8) candidate", async () => {
    // A pixel-grid black-and-white mark on a ground: no colour and no alpha to carry, so
    // losslessCompressPng's grayscaleReduction (on by default) drops both.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="16"/><rect y="16" width="32" height="16" fill="#fff"/></svg>';
    const raw = await engine.render(svg, 32, '#ffffff');
    const png = await engine.encode(raw, { colors: 256 });
    await pixelExact('black-and-white on white', png, 0);
  });

  it("matches the suite's decoder on a translucent greyscale (La8) candidate", async () => {
    // A flat grey circle with no ground: one colour, but a real anti-aliased alpha edge, so
    // colour is dropped and alpha is kept.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#808080"/></svg>';
    const raw = await engine.render(svg, 32);
    const png = await engine.encode(raw, { colors: 256 });
    await pixelExact('grey circle, no ground', png, 1);
  });

  it("matches the suite's independent decoder on a quantised, paletted PNG", async () => {
    // No ground: the circle's anti-aliased edge keeps partial alpha, so the quantiser's
    // palette carries a tRNS entry — the case decode() must resolve (palette + transparency)
    // the same way test/lib/png.mjs's own decoder does, not just the opaque case render's
    // typical padded icon hits (see expandToRgba's Rgb8/L8 paths in lib/engine.mjs).
    const raw = await engine.render(icon('flat'), 32);
    const encoded = await engine.encode(raw, { colors: 8 });
    const mine = await engine.decode(encoded);
    const theirs = decode(Buffer.from(encoded));
    assert.deepEqual([mine.width, mine.height], [theirs.width, theirs.height]);
    assert.deepEqual([...mine.rgba], [...theirs.data]);
  });
});

const SEARCH_FIXTURES = ['general', 'gradient'];
const searchCaptures = {};
for (const name of SEARCH_FIXTURES) {
  searchCaptures[name] = {
    raw: await engine.render(icon(name), 192, '#000000'),
    reference: await engine.renderRgba(icon(name), 192, '#000000'),
  };
}

describe('search', () => {
  for (const name of SEARCH_FIXTURES) {
    const { raw, reference } = searchCaptures[name];

    it(`${name}: fast is exactly encode's own quality-80 bytes, one probe`, async () => {
      const fast = await engine.search(raw, reference, { effort: 'fast', pinned: null });
      const direct = await engine.encode(raw, { quality: 80 });
      assert.deepEqual([...fast.png], [...direct]);
      assert.equal(fast.probes, 1);
      assert.deepEqual(fast.setting, { quality: DEFAULT_QUALITY, colors: DEFAULT_COLORS });
    });

    it(`${name}: fast accepts a null reference and skips the gate entirely`, async () => {
      const fast = await engine.search(raw, null, { effort: 'fast', pinned: null });
      const direct = await engine.encode(raw, { quality: 80 });
      assert.deepEqual([...fast.png], [...direct]);
      assert.equal(fast.probes, 1);
      assert.deepEqual(fast.setting, { quality: DEFAULT_QUALITY, colors: DEFAULT_COLORS });
      assert.deepEqual([fast.pct, fast.edge, fast.pass], [null, null, null]);
    });

    it(`${name}: default passes the bar and is no larger than fast when fast itself passes`, async () => {
      const fast = await engine.search(raw, reference, { effort: 'fast', pinned: null });
      const result = await engine.search(raw, reference, { effort: 'default', pinned: null });
      assert.equal(result.pass, true);
      if (fast.pass) assert.ok(result.png.length <= fast.png.length, `${result.png.length} > ${fast.png.length}`);
      assert.ok(result.probes >= 2 && result.probes <= 10, `probes ${result.probes} outside [2, 10]`);
    });

    it(`${name}: max passes the bar, is no larger than default, and probes every candidate`, async () => {
      const result = await engine.search(raw, reference, { effort: 'default', pinned: null });
      const max = await engine.search(raw, reference, { effort: 'max', pinned: null });
      assert.equal(max.pass, true);
      assert.ok(max.png.length <= result.png.length, `${max.png.length} > ${result.png.length}`);
      assert.equal(max.probes, 26);
    });

    it(`${name}: a pinned setting skips the search entirely`, async () => {
      const pinned = { quality: 100, colors: 4 };
      const result = await engine.search(raw, reference, { effort: 'default', pinned });
      const direct = await engine.encode(raw, pinned);
      assert.deepEqual([...result.png], [...direct]);
      assert.equal(result.probes, 1);
      assert.deepEqual(result.setting, pinned);
      const decoded = decode(Buffer.from(direct));
      const gate = passesBar({ width: decoded.width, height: decoded.height, rgba: decoded.data }, reference);
      assert.equal(result.pass, gate.pass);
    });

    it(`${name}: two default searches agree byte for byte`, async () => {
      const a = await engine.search(raw, reference, { effort: 'default', pinned: null });
      const b = await engine.search(raw, reference, { effort: 'default', pinned: null });
      assert.deepEqual([...a.png], [...b.png]);
      assert.deepEqual(a.setting, b.setting);
    });
  }

  it('keeps the fast encode, failing gate and all, when nothing on either list passes', async () => {
    const raw = await engine.render(icon('general'), 192, '#000000');
    const mismatched = await engine.renderRgba(icon('gradient'), 192, '#000000');
    const direct = await engine.encode(raw, { quality: 80 });
    const expectedSetting = { quality: DEFAULT_QUALITY, colors: DEFAULT_COLORS };

    const result = await engine.search(raw, mismatched, { effort: 'default', pinned: null });
    assert.deepEqual([...result.png], [...direct]);
    assert.equal(result.pass, false);
    assert.equal(result.probes, 9);
    assert.deepEqual(result.setting, expectedSetting);

    const max = await engine.search(raw, mismatched, { effort: 'max', pinned: null });
    assert.deepEqual([...max.png], [...direct]);
    assert.equal(max.pass, false);
    assert.equal(max.probes, 26);
    assert.deepEqual(max.setting, expectedSetting);
  });

  it('rejects an unknown effort', async () => {
    const raw = await engine.render(icon('general'), 32, '#000000');
    await assert.rejects(engine.search(raw, null, { effort: 'bogus', pinned: null }), /unknown effort/);
  });

  for (const effort of ['default', 'max']) {
    it(`rejects a null reference at effort '${effort}' (only 'fast' and a pinned setting may skip the gate)`, async () => {
      const raw = await engine.render(icon('general'), 32, '#000000');
      await assert.rejects(engine.search(raw, null, { effort, pinned: null }), /needs a reference/);
    });
  }

  it("a pinned setting accepts a null reference too, gate skipped like effort 'fast'", async () => {
    const raw = await engine.render(icon('general'), 32, '#000000');
    const pinned = { quality: 100, colors: 4 };
    // effort is irrelevant once a setting is pinned — 'max' here on purpose, to show the
    // reference requirement above is effort's business, not pinned's.
    const result = await engine.search(raw, null, { effort: 'max', pinned });
    const direct = await engine.encode(raw, pinned);
    assert.deepEqual([...result.png], [...direct]);
    assert.equal(result.probes, 1);
    assert.deepEqual(result.setting, pinned);
    assert.deepEqual([result.pct, result.edge, result.pass], [null, null, null]);
  });
});

// Ties on bytes go to the higher quality, then the larger palette.
const lessLossy = (a, b) =>
  a.setting.quality !== b.setting.quality ? a.setting.quality > b.setting.quality : a.setting.colors > b.setting.colors;

// The search as it ran when the two walks took turns: the quality walk, then the colour walk,
// one encode at a time. The oracle the overlapped walks must match in bytes, setting and probes.
const sequentialSearch = async (raw, reference) => {
  const cache = new Map();
  const probe = async ({ quality = 100, colors = DEFAULT_COLORS }) => {
    const key = quality === 100 ? `colors:${colors}` : `quality:${quality}`;
    if (!cache.has(key)) {
      const png = await engine.encode(raw, { quality, colors });
      const { pass, pct, edge } = passesBar(await engine.decode(png), reference);
      cache.set(key, { png, setting: { quality, colors }, pct, edge, pass });
    }
    return cache.get(key);
  };
  const walk = async (settings) => {
    const probed = [];
    let lo = 0,
      hi = settings.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = await probe(settings[mid]);
      probed.push(candidate);
      if (candidate.pass) hi = mid - 1;
      else lo = mid + 1;
    }
    return probed;
  };
  const probed = [
    ...(await walk(SEARCH_QUALITIES.map((quality) => ({ quality })))),
    ...(await walk(SEARCH_COLORS.map((colors) => ({ colors })))),
  ];
  const winner =
    probed
      .filter((c) => c.pass)
      .reduce((best, c) => {
        if (!best || c.png.length < best.png.length) return c;
        return c.png.length === best.png.length && lessLossy(c, best) ? c : best;
      }, null) ?? (await probe({ quality: DEFAULT_QUALITY }));
  return { ...winner, probes: cache.size };
};

// A leftmost-passing binary walk over n settings probes at most floor(log2 n) + 1 of them.
const binaryBound = (n) => Math.floor(Math.log2(n)) + 1;

describe('search, both walks at once', () => {
  for (const name of SEARCH_FIXTURES) {
    for (const px of [192, 512]) {
      it(`${name} at ${px} px: default matches the sequential walks in bytes, setting and probes`, async () => {
        const raw = await engine.render(icon(name), px, '#000000');
        const reference = await engine.renderRgba(icon(name), px, '#000000');
        const expected = await sequentialSearch(raw, reference);
        const result = await engine.search(raw, reference, { effort: 'default', pinned: null });
        assert.deepEqual([...result.png], [...expected.png]);
        assert.deepEqual(result.setting, expected.setting);
        assert.equal(result.probes, expected.probes);
        assert.deepEqual([result.pct, result.edge, result.pass], [expected.pct, expected.edge, expected.pass]);
      });
    }

    it(`${name}: a q80 seed saves exactly one encode and changes nothing else`, async () => {
      const { raw, reference } = searchCaptures[name];
      const plain = await engine.search(raw, reference, { effort: 'default', pinned: null });
      const seed = {
        setting: { quality: DEFAULT_QUALITY },
        png: await engine.encode(raw, { quality: DEFAULT_QUALITY }),
      };
      const seeded = await engine.search(raw, reference, { effort: 'default', pinned: null, seed });
      assert.deepEqual([...seeded.png], [...plain.png]);
      assert.deepEqual(seeded.setting, plain.setting);
      assert.deepEqual([seeded.pct, seeded.edge, seeded.pass], [plain.pct, plain.edge, plain.pass]);
      assert.equal(seeded.probes, plain.probes - 1);
    });

    it(`${name}: onProbe reports every encode, done counting up to probes`, async () => {
      const { raw, reference } = searchCaptures[name];
      for (const effort of ['fast', 'default', 'max']) {
        const calls = [];
        const result = await engine.search(raw, reference, {
          effort,
          pinned: null,
          onProbe: (p) => calls.push(p),
        });
        const total = {
          fast: 1,
          default: 1 + binaryBound(SEARCH_QUALITIES.length) + binaryBound(SEARCH_COLORS.length),
          max: SEARCH_QUALITIES.length + SEARCH_COLORS.length,
        }[effort];
        assert.equal(calls.length, result.probes, effort);
        assert.deepEqual(
          calls.map((p) => p.done),
          calls.map((_, i) => i + 1),
          effort,
        );
        for (const p of calls) {
          assert.equal(p.total, total, effort);
          assert.equal(typeof p.bytes, 'number');
          assert.equal(typeof p.pass, 'boolean');
          assert.deepEqual(Object.keys(p.setting).toSorted(), ['colors', 'quality']);
        }
        const winner = calls.find(
          (p) => p.setting.quality === result.setting.quality && p.setting.colors === result.setting.colors,
        );
        assert.equal(winner?.bytes, result.png.length, effort);
      }
    });
  }

  it('five concurrent default searches of one raster agree byte for byte', async () => {
    const { raw, reference } = searchCaptures.gradient;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => engine.search(raw, reference, { effort: 'default', pinned: null })),
    );
    for (const r of results.slice(1)) {
      assert.deepEqual([...r.png], [...results[0].png]);
      assert.deepEqual(r.setting, results[0].setting);
      assert.equal(r.probes, results[0].probes);
    }
  });

  it('overlaps the two walks: two quantisations in flight at once', async () => {
    let inFlight = 0,
      peak = 0;
    const image = {
      ...napi,
      pngQuantize: async (...args) => {
        peak = Math.max(peak, ++inFlight);
        try {
          return await napi.pngQuantize(...args);
        } finally {
          inFlight--;
        }
      },
    };
    const counted = createEngine({ image, zopfli: null, inflate: inflateSync });
    const { raw, reference } = searchCaptures.general;
    await counted.search(raw, reference, { effort: 'default', pinned: null });
    assert.equal(peak, 2);
  });

  it('a seed no walk asks for is never gated, never counted and never wins', async () => {
    const { raw, reference } = searchCaptures.general;
    const plain = await engine.search(raw, reference, { effort: 'default', pinned: null });
    // Not a PNG at all: decoding it would throw, so passing proves it was never touched.
    const seed = { setting: { quality: 45 }, png: new Uint8Array([1, 2, 3]) };
    const seeded = await engine.search(raw, reference, { effort: 'default', pinned: null, seed });
    assert.deepEqual([...seeded.png], [...plain.png]);
    assert.deepEqual(seeded.setting, plain.setting);
    assert.equal(seeded.probes, plain.probes);
  });

  it('a seed matching the one encode fast or a pin needs leaves nothing to encode', async () => {
    const { raw, reference } = searchCaptures.general;
    const fastPng = await engine.encode(raw, { quality: DEFAULT_QUALITY });
    const calls = [];
    const fast = await engine.search(raw, null, {
      effort: 'fast',
      pinned: null,
      seed: { setting: { quality: DEFAULT_QUALITY, colors: 8 }, png: fastPng },
      onProbe: (p) => calls.push(p),
    });
    assert.deepEqual([...fast.png], [...fastPng]);
    // The search reports the setting it asked for; quality below 100 ignores colours.
    assert.deepEqual(fast.setting, { quality: DEFAULT_QUALITY, colors: DEFAULT_COLORS });
    assert.equal(fast.probes, 0);
    assert.deepEqual(calls, []);

    const pinned = { quality: 100, colors: 4 };
    const pinnedPng = await engine.encode(raw, pinned);
    const result = await engine.search(raw, reference, {
      effort: 'max',
      pinned,
      seed: { setting: pinned, png: pinnedPng },
    });
    assert.deepEqual([...result.png], [...pinnedPng]);
    assert.equal(result.probes, 0);
    assert.equal(typeof result.pass, 'boolean');
  });
});
