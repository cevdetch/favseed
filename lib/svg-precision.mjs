// Select rounding on source pixels, before PNG quantization. Both hosts inject
// the same SVG stage and renderer; no Node APIs or browser-specific heuristics.
import { FavseedError, squareIconSvg } from './core.mjs';

const SIZE = 512;
const PRECISIONS = [1, 2, 3, 4, 6, 8];

/** At most 1% bad pixels on each composite; losing a tiny whole mark also fails. */
export function withinSvgBudget(candidate, reference) {
  const { width, height } = reference,
    a = candidate.rgba,
    b = reference.rgba;
  const count = width * height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    candidate.width !== width ||
    candidate.height !== height ||
    !(a instanceof Uint8Array) ||
    !(b instanceof Uint8Array) ||
    a.length !== count * 4 ||
    b.length !== count * 4
  ) {
    throw new FavseedError('SVG accuracy comparison needs matching dimensions and complete RGBA pixels');
  }
  const limit = Math.floor(count / 100);
  let black = 0,
    white = 0,
    visibleA = false,
    visibleB = false;
  for (let i = 0; i < a.length; i += 4) {
    const alphaA = a[i + 3],
      alphaB = b[i + 3];
    visibleA ||= alphaA > 0;
    visibleB ||= alphaB > 0;
    // Most pixels of an already-accurate mark are identical. Avoid allocating
    // composite images or doing floating-point work for those pixels.
    if (alphaA === alphaB && (alphaA === 0 || (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2])))
      continue;
    const aa = alphaA / 255,
      ab = alphaB / 255;
    let badBlack = false,
      badWhite = false;
    for (let c = 0; c < 3; c++) {
      const ca = a[i + c] * aa,
        cb = b[i + c] * ab;
      if (Math.abs(Math.round(ca) - Math.round(cb)) > 8) badBlack = true;
      if (Math.abs(Math.round(ca + 255 * (1 - aa)) - Math.round(cb + 255 * (1 - ab))) > 8) badWhite = true;
    }
    if (badBlack) black++;
    if (badWhite) white++;
    if (black > limit || white > limit) return false;
  }
  return visibleA === visibleB;
}

const validViewport = (svg) => {
  const match = /<svg\b[^>]*\bviewBox="([^"]*)"/.exec(svg);
  if (!match) return false;
  const box = match[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
};

/** First passing precision, or minimally prepared source with its numeric geometry intact. */
export async function selectSvg(source, options, { initial, optimiseSvg, renderRgba, warn = () => {} }) {
  const reference = optimiseSvg(source, { ...options, reference: true, onWarn: warn });
  const rasterReference = squareIconSvg(reference.data).data;
  // Source and actual renderer failures propagate; they are not precision failures.
  const referencePixels = await renderRgba(rasterReference, SIZE);
  for (const precision of PRECISIONS) {
    const output = precision === 1 && initial ? initial : optimiseSvg(source, { ...options, precision });
    if (!validViewport(output.data)) continue;
    const rasterSvg = squareIconSvg(output.data).data;
    const pixels = rasterSvg === rasterReference ? referencePixels : await renderRgba(rasterSvg, SIZE);
    if (withinSvgBudget(pixels, referencePixels)) return { output, rasterSvg, pixels };
  }
  warn('SVG optimization exceeded the 1% static-appearance budget; preserving source geometry');
  return { output: reference, rasterSvg: rasterReference, pixels: referencePixels };
}
