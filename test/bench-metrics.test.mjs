import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { edgeError, rmse, ssim } from '../bench/lib/metrics.mjs';

const image = (w, h, f) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...f(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
};
const edge = image(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255]));
const ramp = image(16, 16, (x) => [x * 16, x * 16, x * 16]);
const hard = image(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255]));

describe('second-gate metrics', () => {
  it('scores identical images as perfect', () => {
    assert.equal(rmse(edge, edge), 0);
    assert.equal(edgeError(edge, edge), 0);
    assert.equal(ssim(edge, edge), 1);
  });
  it('sees a ramp collapsed to two levels', () => {
    assert.ok(rmse(hard, ramp) > 20);
    assert.ok(ssim(hard, ramp) < 0.95);
    assert.ok(edgeError(hard, ramp) > 0);
  });
  it('weights error at edges more than error in flat regions', () => {
    const flatNoise = image(16, 16, (x, y) =>
      x === 2 && y === 2 ? [40, 40, 40] : x < 8 ? [0, 0, 0] : [255, 255, 255],
    );
    const edgeNoise = image(16, 16, (x, y) =>
      x === 8 && y === 2 ? [215, 215, 215] : x < 8 ? [0, 0, 0] : [255, 255, 255],
    );
    assert.ok(edgeError(edgeNoise, edge) > edgeError(flatNoise, edge));
  });
});
