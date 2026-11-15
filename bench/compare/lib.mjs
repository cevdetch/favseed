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

/**
 * What a build produced, for the determinism checks: the set digest, or `error` for a build that
 * failed. Not the message: libvips words the same failure differently from run to run (its
 * error buffer is shared, and at times cut short), and a build that writes no bytes cannot write
 * different ones.
 */
export const outcomeKey = (result) => (result.error ? 'error' : result.digest);

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
  const totals = runs.map((run) => run.inputs.reduce((sum, input) => sum + input.ms, 0));
  return {
    coldMs: median(runs.map((run) => run.cold)),
    totalMs: median(totals),
    // Every repetition's total and cold time, sorted, so the spread behind each median is on
    // record next to it.
    repsTotalMs: totals.toSorted((a, b) => a - b),
    repsColdMs: runs.map((run) => run.cold).toSorted((a, b) => a - b),
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

/**
 * One like-for-like size of one tool, scored against each reference. `candidate()` reads and
 * decodes the tool's PNG and throws for one it cannot use; `references[ref]()` returns that
 * reference's prepared pixels, null when it does not exist, or throws when it cannot be read or
 * prepared. A candidate failure is the tool's (`like.error`); a reference failure is no verdict
 * on the tool, so it leaves that score null and is returned in `referenceErrors[ref]`.
 */
export const scoreSize = ({ candidate, references, score }) => {
  const like = {},
    referenceErrors = {};
  let img;
  try {
    img = candidate(like);
  } catch (error) {
    return { like: { ...like, error: error.message }, referenceErrors };
  }
  for (const [ref, prepare] of Object.entries(references)) {
    let prepared = null;
    try {
      prepared = prepare();
    } catch (error) {
      referenceErrors[ref] = error.message;
    }
    try {
      like[ref] = prepared ? score(img, prepared) : null;
    } catch (error) {
      return { like: { ...like, error: error.message }, referenceErrors };
    }
  }
  return { like, referenceErrors };
};

/**
 * How often the two references themselves agree: the inputs where the sharp render (`row.renderers`,
 * the root copy's, sharp 0.35.5 in the committed run) passes the bar against the resvg render at
 * every size. Where they do not, a PNG between the two could still pass against both, so
 * `passedBoth` counts how many tools' pairs actually did.
 */
export const rendererAgreement = (rows, sizes) => {
  const scored = rows.filter((row) => sizes.every((px) => row.renderers?.[px]));
  return { scored: scored.length, agree: scored.filter((row) => sizes.every((px) => row.renderers[px].pass)).length };
};

/**
 * On the inputs where the two references disagree (`row.renderers` fails at some size), the
 * pairs, one per tool in `ids`, that still pass against both references at every size.
 */
export const passedBoth = (rows, ids, sizes) => {
  const disagree = rows.filter(
    (row) => sizes.every((px) => row.renderers?.[px]) && !sizes.every((px) => row.renderers[px].pass),
  );
  const pairs = disagree.flatMap((row) =>
    ids.filter((id) => likeBuilt(row.tools[id], sizes)).map((id) => ({ name: row.name, id, like: row.tools[id].like })),
  );
  return {
    inputs: disagree.length,
    pairs: pairs.length,
    passed: pairs
      .filter(({ like }) => sizes.every((px) => like[px].resvg?.pass && like[px].sharp?.pass))
      .map(({ name, id }) => `${name}:${id}`),
  };
};

/**
 * Tool `a` against tool `b`, input by input, over the rows both built: how many inputs each
 * builds faster (a tie goes to neither) and the median input's time, from each input's median
 * over the repetitions. A mean hides that one tool can win most inputs and lose on total time.
 */
export const headToHead = (rows, a, b) => {
  const both = rows.filter((row) => !row.tools[a].error && !row.tools[b].error);
  const ms = (id) => both.map((row) => row.tools[id].ms);
  return {
    inputs: both.length,
    aFaster: both.filter((row) => row.tools[a].ms < row.tools[b].ms).length,
    bFaster: both.filter((row) => row.tools[b].ms < row.tools[a].ms).length,
    aMedian: both.length ? median(ms(a)) : null,
    bMedian: both.length ? median(ms(b)) : null,
  };
};

/** A group's mean time per input: its median total over the inputs every tool built, divided by their number. */
export const perInput = (group, id) => group.tools[id].totalMs / group.common.inputs;

/**
 * Tool `a` against tool `b` on time, as the README and the website both state it: the mean per
 * input over the inputs every tool built, headToHead over the same inputs, and each corpus group
 * (`fixtures`, `open`) where the mean goes the other way, with both tools' means there.
 */
export const speedAgainst = (results, a, b) => {
  const { summary, inputs: rows } = results;
  const common = rows.filter((row) => !summary.all.common.excluded.includes(row.name));
  const mean = [perInput(summary.all, a), perInput(summary.all, b)];
  return {
    mean,
    ...headToHead(common, a, b),
    flips: ['fixtures', 'open']
      .map((group) => ({ group, a: perInput(summary[group], a), b: perInput(summary[group], b) }))
      .filter((flip) => Math.sign(flip.a - flip.b) !== Math.sign(mean[0] - mean[1])),
  };
};

/**
 * favseed's like-for-like PNGs scored against the resvg reference, and the ones that miss the
 * bar: by corpus, those that miss on the edge clause alone (pixel share within `accuracyPct`),
 * and those its own build kept at quality 80 because no candidate passed (decision 29). `agree`
 * counts the PNGs where favseed's own verdict matches this benchmark's.
 */
export const favseedMisses = (rows, accuracyPct) => {
  const pngs = rows.flatMap((row) =>
    [192, 512].map((px) => ({ corpus: row.corpus, ...row.tools.favseed.like[px] })).filter((like) => like.self),
  );
  const scored = pngs.filter((like) => like.resvg);
  const missed = scored.filter((like) => !like.resvg.pass);
  return {
    scored: scored.length,
    missed: missed.length,
    fixtures: missed.filter((like) => like.corpus === 'fixtures').length,
    open: missed.filter((like) => like.corpus === 'open').length,
    edgeOnly: missed.filter((like) => like.resvg.pct <= accuracyPct).length,
    kept: missed.filter((like) => !like.self.pass && like.self.quality === 80).length,
    agree: scored.filter((like) => like.self.pass === like.resvg.pass).length,
  };
};

/**
 * Whether each tool wrote the same bytes every time: `runs[id]` is that tool's repetitions, each
 * `{ repeatsMatch, inputs: [{ name, digest } | { name, error }] }`. An input is listed when its
 * outcome (outcomeKey) differs between repetitions, a success against a failure included.
 */
export const determinismOf = (runs, ids, names) =>
  Object.fromEntries(
    ids.map((id) => {
      const differing = names.filter(
        (name) => new Set(runs[id].map((run) => outcomeKey(run.inputs.find((item) => item.name === name)))).size > 1,
      );
      const repeatsMatch = runs[id].every((run) => run.repeatsMatch);
      return [id, { deterministic: !differing.length && repeatsMatch, differing, repeatsMatch }];
    }),
  );

/**
 * results.json as text: indented, except one compact line per input, because the file is
 * committed and indenting 103 rows five tools deep would triple its size and every diff of it.
 */
export const formatResults = (results) => {
  const { inputs, ...head } = results;
  return (
    JSON.stringify({ ...head, inputs: [] }, null, 2).replace(
      '"inputs": []',
      `"inputs": [\n${inputs.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`,
    ) + '\n'
  );
};

const sumOf = (rows, id, key) => rows.reduce((total, row) => total + row.tools[id][key], 0);
const timing = (toolRuns, names) =>
  summarise(toolRuns.map((run) => ({ cold: run.cold, inputs: run.inputs.filter((input) => names.has(input.name)) })));
const round = (ms) => Number(ms.toFixed(1));
const fileRange = (rows, id) => {
  const counts = rows.map((row) => row.tools[id].files);
  return counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null;
};

/** What each part of a group summary covers, stated in results.json next to the numbers. */
const SCOPE =
  'Top-level totals per tool (files, rasterBytes, svgBytes, otherBytes, totalMs, repsTotalMs) cover ' +
  '`common.inputs`, the inputs every tool built. `own` covers the inputs each tool itself built and ' +
  'is not comparable across tools. coldMs is the warm-up set, the same mark for every tool. ' +
  'like.bytes covers `likeCommon.inputs`, the inputs every tool built a like-for-like pair for. ' +
  "Pass counts use each reference's own `scored` set: the inputs where that reference exists and " +
  'the tool built both sizes; a pass means both sizes pass. renderers counts the inputs where the ' +
  'resvg and sharp 0.35.5 references themselves agree within the bar, and passedBoth the pairs that pass ' +
  'against both references on the inputs where they do not.';

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
    const commonTiming = timing(runs[id], commonNames);
    tools[id] = {
      failed: rows.filter((row) => row.tools[id].error).map((row) => row.name),
      likeFailed: rows.filter((row) => !likeBuilt(row.tools[id], sizes)).map((row) => row.name),
      files: fileRange(common, id),
      rasterBytes: sumOf(common, id, 'rasterBytes'),
      svgBytes: sumOf(common, id, 'svgBytes'),
      otherBytes: sumOf(common, id, 'otherBytes'),
      totalMs: round(commonTiming.totalMs),
      repsTotalMs: commonTiming.repsTotalMs.map(round),
      coldMs: round(commonTiming.coldMs),
      repsColdMs: commonTiming.repsColdMs.map(round),
      own: {
        inputs: built.length,
        files: fileRange(built, id),
        rasterBytes: sumOf(built, id, 'rasterBytes'),
        svgBytes: sumOf(built, id, 'svgBytes'),
        otherBytes: sumOf(built, id, 'otherBytes'),
        totalMs: round(timing(runs[id], new Set(built.map((row) => row.name))).totalMs),
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
    scope: SCOPE,
    inputs: rows.length,
    renderers: { ...rendererAgreement(rows, sizes), passedBoth: passedBoth(rows, ids, sizes) },
    common: { inputs: common.length, excluded: excluded(commonNames) },
    likeCommon: { inputs: likeCommon.length, excluded: excluded(likeNames) },
    tools,
  };
};
