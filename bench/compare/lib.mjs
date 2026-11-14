// Pure helpers for bench/compare/run.mjs, kept free of the competitors and of favseed itself so
// test/bench-compare.mjs can check them without installing anything.
import { createHash } from 'node:crypto';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * One SHA-256 for a whole set: over the sorted `name:sha256(bytes)` lines of every file. Sorted,
 * because several tools build their files concurrently and return them in completion order, so
 * the order says nothing about the bytes; the names are hashed too, because a renamed file is a
 * different set.
 */
export const setDigest = (files) =>
  sha256(
    files
      .map(({ name, bytes }) => `${name}:${sha256(bytes)}`)
      .toSorted()
      .join('\n'),
  );

/**
 * The whole-set table counts PNG and ICO bytes as rasters and lists SVG, manifests, XML and HTML
 * separately: an SVG favicon is a different kind of file, and a manifest's size depends on the
 * names the tool writes into it, not on how well it encodes an image.
 */
export const classify = (name) => {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext === 'png' || ext === 'ico' ? 'raster' : ext === 'svg' ? 'svg' : 'other';
};

export const median = (values) => {
  if (!values.length) throw new Error('median of an empty list');
  const sorted = values.toSorted((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Repetitions of one tool, each `{ cold, inputs: [{ name, ms }] }`, reduced to the medians the
 * results report: per input, of each repetition's total, and of the cold time (process start to
 * the first finished set). Medians of totals, not totals of medians, so one slow input in one
 * repetition moves the total the way it moved that repetition.
 */
export const summarise = (runs) => {
  const names = runs[0].inputs.map((input) => input.name);
  return {
    coldMs: median(runs.map((run) => run.cold)),
    totalMs: median(runs.map((run) => run.inputs.reduce((sum, input) => sum + input.ms, 0))),
    perInput: Object.fromEntries(
      names.map((name) => [name, median(runs.map((run) => run.inputs.find((input) => input.name === name).ms))]),
    ),
  };
};
