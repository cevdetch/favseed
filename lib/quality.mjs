// Pixel and edge quality metrics, shared by the pipeline's smallest-passing search and by the
// test/bench sheets that measure it.
//
// Two metrics, not one: the 1 % pixel-distance bar (pctOff) alone passes some rasters whose
// edges are visibly serrated at 192 px — flat-color-icons/file is the example the Phase 2a
// sheet (346 rasters, fixtures + the open corpus) turned up — because a single stray channel
// over 8/255 counts the same whether it sits on a flat fill or astride a hard edge. edgeError
// weights error by where the reference actually has edges, so a serration that pctOff shrugs
// off still fails the gate. EDGE_GATE (lib/core.mjs) is today's worst edgeError among the
// quality-80 files that already pass ACCURACY_PCT over that same sheet — not a derived
// constant, a measured one.
//
// Both ports are deliberately exact, not merely equivalent, down to which composite rounds and
// which does not:
//   - pctOff is test/lib/accuracy.mjs's score(), minus the rmse it also returns (unused here;
//     error there is driven by raster size, not by the mark, so it was never a gate).
//   - edgeError is bench/lib/metrics.mjs's edgeError(), unchanged.
// test/lib/accuracy.mjs keeps its own copy as an independent oracle — it must not import this
// file, or a bug shared by both sides would cancel itself out of the gate it exists to run.
//
// No imports beyond core.mjs's constants: this runs in the pipeline, which runs in the browser.

import { ACCURACY_PCT, EDGE_GATE } from './core.mjs';

const GROUNDS = [255, 0];

// Marks prepareReference's return value, so pctOff/edgeError/passesBar can take either it or a
// raw { width, height, rgba } reference and compute identically either way (test/quality.mjs).
// A Symbol rather than a string/boolean field: it can never collide with a real image's own
// properties, and it stays off every enumeration (JSON.stringify, for-in) of the object.
const PREPARED = Symbol('preparedReference');

const assertSameSize = (a, b) => {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
};

// ------------------------------------------------------------------------- pctOff --

const CHANNEL_TOLERANCE = 8; // out of 255, test/lib/accuracy.mjs's score()

// Rounded to 8-bit, as test/lib/accuracy.mjs's composite does: the gate measures the error an
// 8-bit PNG can actually hold, not the unrounded float a naive port would compare instead.
const compositeRounded = (img, ground) => {
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, o = 0; i < img.rgba.length; i += 4, o += 3) {
    const a = img.rgba[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(img.rgba[i + c] * a + ground * (1 - a));
  }
  return out;
};

/**
 * Share of pixels (0-100) whose colour distance from `reference` exceeds 8/255 in any channel,
 * composited on both black and white, the worse of the two reported (alpha error cannot hide
 * in a single ground). `candidate`/`reference` are { width, height, rgba }, the engine's
 * renderRgba shape.
 */
export function pctOff(candidate, reference) {
  assertSameSize(candidate, reference);
  const prepared = reference[PREPARED];
  let pct = 0;
  for (let g = 0; g < GROUNDS.length; g++) {
    const a = compositeRounded(candidate, GROUNDS[g]),
      b = prepared ? prepared[g].rounded : compositeRounded(reference, GROUNDS[g]);
    let bad = 0;
    for (let i = 0; i < a.length; i += 3) {
      let worst = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[i + c] - b[i + c]);
        if (d > worst) worst = d;
      }
      if (worst > CHANNEL_TOLERANCE) bad++;
    }
    pct = Math.max(pct, (bad / (a.length / 3)) * 100);
  }
  return pct;
}

// ----------------------------------------------------------------------- edgeError --

// bench/lib/metrics.mjs's compositeRgb: unrounded, unlike pctOff's composite above. edgeError
// measures a weighted mean, where one pixel's rounding error would wash out; pctOff counts
// pixels past a hard threshold, where it would not.
const compositeFloat = (img, ground) => {
  const out = new Float64Array(img.width * img.height * 3);
  for (let i = 0, o = 0; i < img.rgba.length; i += 4, o += 3) {
    const a = img.rgba[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[o + c] = img.rgba[i + c] * a + ground * (1 - a);
  }
  return out;
};

const toLuma = (rgb) => {
  const out = new Float64Array(rgb.length / 3);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o++) out[o] = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  return out;
};

// The largest magnitude an 8-bit luma Sobel gradient can reach (both Gx and Gy saturated at
// their extreme 1020): sqrt(1020^2 + 1020^2). Dividing by this keeps the raw gradient in [0, 1]
// without a per-image normalisation step, which would need a zero-gradient special case for
// flat input.
const SOBEL_MAX = 1020 * Math.SQRT2;

/** Sobel gradient magnitude of `luma` at (x, y), edges clamped to the nearest real pixel. */
const sobelMagnitude = (luma, width, height, x, y) => {
  const at = (xx, yy) => {
    const cx = xx < 0 ? 0 : xx >= width ? width - 1 : xx;
    const cy = yy < 0 ? 0 : yy >= height ? height - 1 : yy;
    return luma[cy * width + cx];
  };
  const a = at(x - 1, y - 1),
    b = at(x, y - 1),
    c = at(x + 1, y - 1);
  const d = at(x - 1, y),
    f = at(x + 1, y);
  const g = at(x - 1, y + 1),
    h = at(x, y + 1),
    i = at(x + 1, y + 1);
  const gx = c - a + 2 * (f - d) + (i - g);
  const gy = g - a + 2 * (h - b) + (i - c);
  return Math.sqrt(gx * gx + gy * gy);
};

/** Per-pixel weight from `luma`'s own Sobel edges, normalised to [0, 1], plus a 0.05 floor so
 * flat regions still count a little. */
const edgeWeights = (luma, width, height) => {
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out[y * width + x] = sobelMagnitude(luma, width, height, x, y) / SOBEL_MAX + 0.05;
  return out;
};

/**
 * Weighted mean absolute luma error, weighted by `reference`'s own Sobel edges, composited on
 * both black and white, the worse of the two. `candidate`/`reference` are { width, height,
 * rgba }.
 */
export function edgeError(candidate, reference) {
  assertSameSize(candidate, reference);
  const prepared = reference[PREPARED];
  let worst = 0;
  for (let g = 0; g < GROUNDS.length; g++) {
    const la = toLuma(compositeFloat(candidate, GROUNDS[g]));
    const lb = prepared ? prepared[g].luma : toLuma(compositeFloat(reference, GROUNDS[g]));
    const weights = prepared ? prepared[g].weights : edgeWeights(lb, candidate.width, candidate.height);
    let num = 0,
      den = 0;
    for (let i = 0; i < la.length; i++) {
      num += weights[i] * Math.abs(la[i] - lb[i]);
      den += weights[i];
    }
    worst = Math.max(worst, num / den);
  }
  return worst;
}

/**
 * Precomputes `ref`'s own side of pctOff and edgeError, over both grounds, once: the rounded
 * composite pctOff diffs each candidate against, and the float luma plus Sobel edge weights
 * edgeError diffs each candidate against. engine.search calls this once per search rather than
 * once per probed candidate — up to 26 candidates sharing one reference's worth of work, not
 * recomputing it 26 times. `ref` is a raw { width, height, rgba } image; the result is accepted
 * wherever a raw reference is, by pctOff, edgeError and passesBar, with identical numbers either
 * way (test/quality.mjs).
 */
export function prepareReference(ref) {
  const grounds = GROUNDS.map((ground) => {
    const luma = toLuma(compositeFloat(ref, ground));
    return { rounded: compositeRounded(ref, ground), luma, weights: edgeWeights(luma, ref.width, ref.height) };
  });
  return { width: ref.width, height: ref.height, [PREPARED]: grounds };
}

// -------------------------------------------------------------------------- passesBar --

/**
 * The accuracy bar a raster must clear: pct <= ACCURACY_PCT and edge <= EDGE_GATE. Returns the
 * measured values alongside the verdict, so a caller can report why a candidate failed.
 */
export function passesBar(candidate, reference) {
  const pct = pctOff(candidate, reference),
    edge = edgeError(candidate, reference);
  return { pass: pct <= ACCURACY_PCT && edge <= EDGE_GATE, pct, edge };
}
