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

// ------------------------------------------------------------------------------ totals --
//
// Rows are run.mjs's per-input results: `{ name, usesVar, tools: { [id]: entry } }`, where an
// entry is `{ error }` for a set the tool could not build, or `{ files, rasterBytes, svgBytes,
// otherBytes }`, and either way carries `like: { error } | { [px]: { bytes, error?, resvg, sharp } }`
// with `resvg`/`sharp` a `{ pct, edge, pass }` score or null when that reference could not be
// rendered.

/** The rows every tool in `ids` built a whole set for. */
export const builtByAll = (rows, ids) => rows.filter((row) => ids.every((id) => !row.tools[id].error));

const likeBuilt = (entry, sizes) => !entry.like.error && sizes.every((px) => entry.like[px] && !entry.like[px].error);

/** The rows every tool in `ids` built a decodable like-for-like pair for, at every size. */
export const likeByAll = (rows, ids, sizes) => rows.filter((row) => ids.every((id) => likeBuilt(row.tools[id], sizes)));

/**
 * Passes against one reference, out of the rows where that reference and the tool's pair both
 * exist at every size: a reference that could not be rendered is no verdict on the tool, and a
 * pair the tool could not build is counted as a failure of its own, not as a failed pass.
 */
export const passCounts = (rows, id, sizes, ref) => {
  const scored = rows.filter(
    (row) => likeBuilt(row.tools[id], sizes) && sizes.every((px) => row.tools[id].like[px][ref]),
  );
  return {
    scored: scored.length,
    pass: scored.filter((row) => sizes.every((px) => row.tools[id].like[px][ref].pass)).length,
  };
};

const sumOf = (rows, id, key) => rows.reduce((total, row) => total + row.tools[id][key], 0);
const timing = (toolRuns, names) =>
  summarise(toolRuns.map((run) => ({ cold: run.cold, inputs: run.inputs.filter((input) => names.has(input.name)) })));

/**
 * One corpus group, summarised for every tool. The headline totals (bytes, time, like-for-like
 * bytes) cover only the inputs every tool built, so no tool's total is smaller for having
 * failed on the hard inputs, and a fast failure adds no time; the inputs left out are listed,
 * and each tool's failures named. `own` keeps each tool's totals over everything it built, for
 * reference only: those totals compare different sets of inputs.
 */
export const groupSummary = (rows, runs, ids, sizes) => {
  const common = builtByAll(rows, ids),
    likeCommon = likeByAll(rows, ids, sizes);
  const commonNames = new Set(common.map((row) => row.name));
  const likeNames = new Set(likeCommon.map((row) => row.name));
  const excluded = (kept) => rows.filter((row) => !kept.has(row.name)).map((row) => row.name);
  const plain = rows.filter((row) => !row.usesVar);
  const tools = {};
  for (const id of ids) {
    const built = rows.filter((row) => !row.tools[id].error);
    const counts = built.map((row) => row.tools[id].files);
    const commonTiming = timing(runs[id], commonNames);
    tools[id] = {
      failed: rows.filter((row) => row.tools[id].error).map((row) => row.name),
      likeFailed: rows.filter((row) => !likeBuilt(row.tools[id], sizes)).map((row) => row.name),
      files: counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null,
      rasterBytes: sumOf(common, id, 'rasterBytes'),
      svgBytes: sumOf(common, id, 'svgBytes'),
      otherBytes: sumOf(common, id, 'otherBytes'),
      totalMs: Number(commonTiming.totalMs.toFixed(1)),
      coldMs: Number(commonTiming.coldMs.toFixed(1)),
      own: {
        inputs: built.length,
        rasterBytes: sumOf(built, id, 'rasterBytes'),
        svgBytes: sumOf(built, id, 'svgBytes'),
        otherBytes: sumOf(built, id, 'otherBytes'),
        totalMs: Number(timing(runs[id], new Set(built.map((row) => row.name))).totalMs.toFixed(1)),
      },
      like: {
        bytes: Object.fromEntries(
          sizes.map((px) => [px, likeCommon.reduce((total, row) => total + row.tools[id].like[px].bytes, 0)]),
        ),
        resvg: passCounts(rows, id, sizes, 'resvg'),
        sharp: passCounts(rows, id, sizes, 'sharp'),
        withoutVar: { resvg: passCounts(plain, id, sizes, 'resvg'), sharp: passCounts(plain, id, sizes, 'sharp') },
      },
    };
  }
  return {
    inputs: rows.length,
    common: { inputs: common.length, excluded: excluded(commonNames) },
    likeCommon: { inputs: likeCommon.length, excluded: excluded(likeNames) },
    tools,
  };
};
