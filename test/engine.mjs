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

import { loadEngine, optimiseSvg } from '../bin/favseed.mjs';
import { nestForMask, placeInSafeZone, squareIconSvg } from '../lib/core.mjs';
import { createEngine, wrapForSize } from '../lib/engine.mjs';
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
  try { execFileSync('resvg', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
// The suite's decoder reads Buffers; the engine returns Uint8Arrays.
const dec = (bytes) => decode(Buffer.from(bytes));

describe('render', () => {
  it('bounds probes for a small painted mark without shrinking its safe-zone fit', async () => {
    const requested = [], canvas = 180;
    const result = await placeInSafeZone(icon('small-mark'), async (svg, px) => {
      requested.push(px);
      return engine.renderRgba(svg, px);
    }, canvas);
    assert.ok(requested.every((px) => px <= canvas), `oversized probe: ${Math.max(...requested)}`);
    assert.ok(result.box > 1000, 'the intrinsic viewport still needs enlargement');
    assert.equal(requested.length, 55, 'the full calibrated candidate walk must remain intact');
    const { rgba } = await engine.renderRgba(result.svg, canvas);
    let radius = 0;
    for (let y = 0; y < canvas; y++) for (let x = 0; x < canvas; x++) {
      if (!rgba[(y * canvas + x) * 4 + 3]) continue;
      for (const [a, b] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]])
        radius = Math.max(radius, Math.hypot(a - canvas / 2, b - canvas / 2));
    }
    assert.ok(radius <= canvas * 0.4 + 1.5, 'paint escapes the safe circle');
    assert.ok(radius >= canvas * 0.4 * 0.9, 'paint no longer fills the safe zone');
  });

  it('preserves shifted origins, root fill and nested percentages in cropped probes', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 64 64" fill="#175d8d">'
      + '<svg x="10" y="20" width="64" height="64" viewBox="0 0 64 64">'
      + '<rect x="43.75%" y="43.75%" width="12.5%" height="12.5%"/></svg></svg>';
    const requested = [];
    const result = await placeInSafeZone(source, (svg, px) => {
      requested.push(px); return engine.renderRgba(svg, px);
    }, 180);
    assert.ok(requested.every((px) => px <= 180));
    // The painted8/64 square snaps to94px centered in180px: [43,137) on both axes.
    const golden = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">'
      + '<path fill="#175d8d" d="M43 43h94v94H43z"/></svg>';
    assert.deepEqual((await engine.renderRgba(result.svg, 180)).rgba, (await engine.renderRgba(golden, 180)).rgba);
  });

  it('overlaps alignment probes while choosing the first crisp size in descending order', async () => {
    let active = 0, peak = 0;
    const requested = [];
    const render = async (_svg, px) => {
      requested.push(px); peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, px === 74 ? 8 : 1));
      const rgba = new Uint8Array(px * px * 4);
      rgba[((Math.floor(px / 2) * px) + (px === 100 ? 99 : Math.floor(px / 2))) * 4 + 3] = 255;
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
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
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
        const svg = icon(name), src = join(scratch, `${name}.svg`), out = join(scratch, `${name}-${px}.png`);
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
    for (const [w, h, cx, cy] of [[100, 101, 50, 50.5], [101, 100, 50.5, 50]]) {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><circle cx="${cx}" cy="${cy}" r="32"/></svg>`;
      const { data, warning } = squareIconSvg(source);
      const golden = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 101 101"><circle cx="50.5" cy="50.5" r="32"/></svg>';
      assert.equal(warning, null);
      assert.equal(score(dec(await engine.render(data, 202)), dec(await engine.render(golden, 202))).pct, 0);
    }
  });

  it('preserves nested viewports and inherited styling with explicit aspect-ratio settings', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 64" fill="#175d8d" preserveAspectRatio="none">'
      + '<svg x="32" y="16" width="64" height="32" viewBox="0 0 64 32"><circle cx="32" cy="16" r="16"/></svg></svg>';
    const golden = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="16" fill="#175d8d"/></svg>';
    assert.equal(score(dec(await engine.render(squareIconSvg(source).data, 128)), dec(await engine.render(golden, 128))).pct, 0);
  });

  it('retains valid XML prologs and self-closing roots across raster and padding wrappers', async () => {
    for (const body of ['', '<circle cx="64" cy="32" r="16"/>']) {
      const root = body ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 64">${body}</svg>`
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 64"/>';
      const source = '<?xml version="1.0"?><!DOCTYPE svg>' + root;
      const framed = squareIconSvg(source).data;
      const padded = nestForMask(framed, 64, 128);
      const golden = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
        + (body ? '<circle cx="64" cy="64" r="8"/>' : '') + '</svg>';
      assert.equal(score(dec(await engine.render(padded, 128)), dec(await engine.render(golden, 128))).pct, 0);
    }
  });

  it('keeps source-unit percentages correct with explicit mask padding', async () => {
    const source = readFileSync(new URL('aspect-percent.svg', FIX), 'utf8');
    const placement = await placeInSafeZone(squareIconSvg(optimiseSvg(source).data).data, engine.renderRgba, 128, 25);
    const golden = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="48" y="56" width="32" height="16" fill="#175d8d"/></svg>';
    assert.equal(score(dec(await engine.render(placement.svg, 128)), dec(await engine.render(golden, 128))).pct, 0);
  });

  it('frames tiny coordinate sources consistently with their square counterpart', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2e-12 1e-12"><circle cx="1e-12" cy="5e-13" r="2.5e-13"/></svg>';
    // Keep the literal golden in the same tiny units: the renderer itself
    // approximates sub-micro-unit circle arcs differently from ordinary ones.
    const golden = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2e-12 2e-12"><circle cx="1e-12" cy="1e-12" r="2.5e-13"/></svg>';
    assert.equal(score(dec(await engine.render(squareIconSvg(source).data, 128)), dec(await engine.render(golden, 128))).pct, 0);
  });

  it('retains namespace-scoped references inside the original viewport', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 64">'
      + '<defs><circle id="dot" cx="64" cy="32" r="16"/></defs><use xlink:href="#dot" fill="#175d8d"/></svg>';
    const golden = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="16" fill="#175d8d"/></svg>';
    assert.equal(score(dec(await engine.render(squareIconSvg(source).data, 128)), dec(await engine.render(golden, 128))).pct, 0);
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
  pngQuantize: async (png, opts) => { seen.quantize = opts; return q; },
  losslessCompressPng: async () => l,
});

describe('encode', () => {
  for (const synchronous of [false, true]) {
    it(`drains the other candidate after a ${synchronous ? 'synchronous' : 'asynchronous'} encoder failure`, async () => {
      const failure = new Error('quantizer failed');
      let finish, started = false, settled = false;
      const pending = new Promise((resolve) => { finish = resolve; });
      const image = {
        pngQuantize: () => { if (synchronous) throw failure; return Promise.reject(failure); },
        losslessCompressPng: () => { started = true; return pending; },
      };
      const encoded = createEngine({ image }).encode(Uint8Array.of(0), { colors: 8 });
      const rejected = assert.rejects(encoded, (error) => error === failure).then(() => { settled = true; });
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
    const q = Uint8Array.of(1, 1, 1), smaller = Uint8Array.of(2, 2), same = Uint8Array.of(3, 3, 3);
    const enc = (a, b) => createEngine({ image: fakeImage(a, b) }).encode(Uint8Array.of(0), { colors: 8 });
    assert.deepEqual(await enc(q, smaller), smaller);
    assert.deepEqual(await enc(q, same), q);
    assert.deepEqual(await enc(smaller, q), smaller);
  });

  it('asks the quantiser for a fixed palette, with no quality gate', async () => {
    const seen = {};
    await createEngine({ image: fakeImage(Uint8Array.of(1), Uint8Array.of(1, 2), seen) })
      .encode(Uint8Array.of(0), { colors: 256 });
    assert.deepEqual(seen.quantize, { colors: 256, speed: 1, minQuality: 0, maxQuality: 100 });
  });

  it('uses the quality target without a fixed palette below 100', async () => {
    const seen = {};
    await createEngine({ image: fakeImage(Uint8Array.of(1), Uint8Array.of(1, 2), seen) })
      .encode(Uint8Array.of(0), { colors: 256, quality: 80 });
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
    const unchangedRows = createEngine({ image: { losslessCompressPng: async (png) => png },
      zopfli: referenceZopfli, inflate: inflateSync });
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
