// Second-gate image metrics for the search-winner sheet (bench/sheet.mjs). The accuracy
// gate (test/lib/accuracy.mjs) is a single cheap threshold, by design — this file exists so a
// human looking at the sheet has finer-grained signals (structural similarity, edge-weighted
// error) alongside the pixel-distance count that gate reports. Pure functions over decoded
// RGBA images ({ width, height, data }), no imports: the unit tests exercise exactly this file.
//
// Every metric composites on black AND on white (like test/lib/accuracy.mjs's `score`) and
// keeps the worse of the two — alpha error cannot hide in a single ground.

const GROUNDS = [0, 255];

/** Composite `img` on `ground` (0 or 255); RGB only, flattened to width*height*3. */
function compositeRgb(img, ground) {
  const out = new Float64Array(img.width * img.height * 3);
  for (let i = 0, o = 0; i < img.data.length; i += 4, o += 3) {
    const a = img.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[o + c] = img.data[i + c] * a + ground * (1 - a);
  }
  return out;
}

/** RGB triples (as from compositeRgb) to one luma value per pixel: 0.299R + 0.587G + 0.114B. */
function toLuma(rgb) {
  const out = new Float64Array(rgb.length / 3);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o++) out[o] = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  return out;
}

const assertSameSize = (a, b) => {
  if (a.width !== b.width || a.height !== b.height) throw new Error('metrics: size mismatch');
};

/** Root mean square error over RGB of the composites, the worse (higher) of the two grounds. */
export function rmse(a, b) {
  assertSameSize(a, b);
  let worst = 0;
  for (const ground of GROUNDS) {
    const ca = compositeRgb(a, ground),
      cb = compositeRgb(b, ground);
    let sq = 0;
    for (let i = 0; i < ca.length; i++) {
      const d = ca[i] - cb[i];
      sq += d * d;
    }
    worst = Math.max(worst, Math.sqrt(sq / ca.length));
  }
  return worst;
}

// ---------------------------------------------------------------------- ssim --

const C1 = 0.01 * 255 * (0.01 * 255);
const C2 = 0.03 * 255 * (0.03 * 255);

/**
 * Window origins over a width x height grid: 8x8, stride 4, the last column/row of windows
 * clipped to the image edge rather than skipped (a window's origin is always inside the
 * image, by the loop bound below, so none is ever "fully outside"). Images smaller than 8px
 * in either dimension get exactly one window covering the whole image.
 */
function windows(width, height) {
  if (width < 8 || height < 8) return [[0, 0, width, height]];
  const out = [];
  for (let y = 0; y < height; y += 4)
    for (let x = 0; x < width; x += 4) out.push([x, y, Math.min(8, width - x), Math.min(8, height - y)]);
  return out;
}

/** SSIM of one window, luma only. Written so a == b collapses to exactly 1 (no ** rounding). */
function windowSsim(la, lb, width, x, y, w, h) {
  const n = w * h;
  let sumA = 0,
    sumB = 0;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const idx = (y + j) * width + (x + i);
      sumA += la[idx];
      sumB += lb[idx];
    }
  const meanA = sumA / n,
    meanB = sumB / n;
  let varA = 0,
    varB = 0,
    covar = 0;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const idx = (y + j) * width + (x + i);
      const da = la[idx] - meanA,
        db = lb[idx] - meanB;
      varA += da * da;
      varB += db * db;
      covar += da * db;
    }
  varA /= n;
  varB /= n;
  covar /= n;
  const numerator = (2 * meanA * meanB + C1) * (2 * covar + C2);
  const denominator = (meanA * meanA + meanB * meanB + C1) * (varA + varB + C2);
  return numerator / denominator;
}

/**
 * Mean SSIM over 8x8 windows (stride 4) of luma, the worse (lower) of the two grounds.
 * C1 = (0.01*255)^2, C2 = (0.03*255)^2, as specified for 8-bit luma.
 */
export function ssim(a, b) {
  assertSameSize(a, b);
  let worst = Infinity;
  for (const ground of GROUNDS) {
    const la = toLuma(compositeRgb(a, ground)),
      lb = toLuma(compositeRgb(b, ground));
    const ws = windows(a.width, a.height);
    let sum = 0;
    for (const [x, y, w, h] of ws) sum += windowSsim(la, lb, a.width, x, y, w, h);
    worst = Math.min(worst, sum / ws.length);
  }
  return worst;
}

// ------------------------------------------------------------------ edgeError --

// The largest magnitude an 8-bit luma Sobel gradient can reach (both Gx and Gy saturated at
// their extreme 1020, i.e. a hard 0->255 step filling the whole 3x3 neighbourhood on one
// side): sqrt(1020^2 + 1020^2). Dividing by this keeps the raw gradient in [0, 1] without a
// per-image normalisation step, which would need a zero-gradient special case for flat input.
const SOBEL_MAX = 1020 * Math.SQRT2;

/** Sobel gradient magnitude of `luma` at (x, y), edges clamped to the nearest real pixel. */
function sobelMagnitude(luma, width, height, x, y) {
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
}

/** Per-pixel weight from `luma`'s own Sobel edges, normalised to [0, 1], plus a 0.05 floor so
 * flat regions still count a little. */
function edgeWeights(luma, width, height) {
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out[y * width + x] = sobelMagnitude(luma, width, height, x, y) / SOBEL_MAX + 0.05;
  return out;
}

/**
 * Weighted mean absolute luma error, weighted by `b`'s (the reference's) Sobel edges — a
 * sheet caller always calls this `edgeError(candidate, reference)`, matching the convention
 * `score(candidate, ref)` already uses elsewhere in this repo. The worse (higher) of the two
 * grounds.
 */
export function edgeError(a, b) {
  assertSameSize(a, b);
  let worst = 0;
  for (const ground of GROUNDS) {
    const la = toLuma(compositeRgb(a, ground)),
      lb = toLuma(compositeRgb(b, ground));
    const weights = edgeWeights(lb, a.width, a.height);
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
