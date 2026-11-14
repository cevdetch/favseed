// favseed's isomorphic core: everything that needs no filesystem, no child process and no
// Node built-in.
//
// It exists because the website generates icons in the browser, and the alternative to sharing
// this code was reimplementing it (the svgo plugins, the safe-zone placement, the ICO
// container) against a second set of bugs. The CLI, the integrations and the website all run
// this file; what only Node can do lives in bin/favseed.mjs.
//
// Three seams make that possible, and each one is a parameter rather than a bundler trick:
//
//   * svgo is injected. `createSvgStage({ optimize })` takes the Node build from the
//     synchronous API and svgo/browser from builds and the website. No aliasing.
//   * the mask maths takes DECODED pixels, from the engine's renderRgba in every host.
//   * icoWrap works in Uint8Array and DataView, not Buffer.
//
// Nothing here imports anything. That is the whole contract, and it is worth keeping.

/** Every error a caller is meant to handle. Carries a message, never a stack for the user. */
export class FavseedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FavseedError';
  }
}

// one PNG-backed fallback entry; see bench/ico-size/README.md
export const ICO_SIZE = 48;
// 60pt at @3x, the largest size Apple documents for a web clip
// icon; no iPhone renders above @3x.
export const APPLE_SIZE = 180;
// the encode effort 'fast' runs (and the search falls back to when no
// candidate passes): quality 80 at the full palette ceiling.
export const DEFAULT_QUALITY = 80;
// the quantiser's ceiling, not a target: it spends only the
// colours a mark needs, so a flat mark still lands at a handful, and
// 64, 128 and 256 produce identical bytes on every non-gradient
// fixture. It replaces 8 (decision 19), which missed the 1.0%
// accuracy bar on anti-aliased marks and wrecked gradients (27%
// of pixels off). Decision 24 has the byte cost.
export const DEFAULT_COLORS = 256;
// the padded "any maskable" icons. web.dev's install criteria, Chrome's
// own docs and MDN all require a 192 and a 512. Chromium 152's code
// on desktop accepts one "any" icon of 144px or more (tested with
// Page.getInstallabilityErrors), but that is one engine on one
// platform, and the documentation is the contract every browser is
// held to. SVG cannot fill the role: an SVG entry makes Android's
// WebAPK install fail (crbug.com/40925759). Decision 11.
export const DEFAULT_SIZES = [192, 512];
// the ground of the masked icons. iOS composites a
// transparent Home Screen icon onto black, so black is what
// the platform would have done anyway. The difference is
// that the alpha channel goes away and the file gets smaller.
export const DEFAULT_BG = '#000000';
// Zopfli iterations per effort, applied to whichever encode the effort chose.
// 'fast' skips Zopfli: one encode, nothing to wait for, for dev builds.
// 'default' runs 15: 0.27 % more bytes than 120 for about a sixth of the
// time (spike, 40 files, 2026-10-04).
// 'max' runs 120. Measured over the corpus: 79665 B at 15, 79454 at 60,
// 79386 at 120. The curve is flattening hard (-0.27%, then -0.09%), but
// bytes ship forever and build time does not, so the knee is taken on the
// byte side for the slowest effort.
export const EFFORT_ITERATIONS = Object.freeze({ fast: 0, default: 15, max: 120 });
// the effort a build runs when none is given: the smallest file that passes
// the accuracy bar, at a build time a release can afford.
export const DEFAULT_EFFORT = 'default';
// W3C Web App Manifest, "icon masks": the safe zone is a circle
// centred on the icon with a radius of 2/5 of its size, the
// part every platform mask (circle, squircle, rounded square,
// teardrop) is guaranteed to show. iOS's own mask is a rounded
// square with corners of about 22% of the tile, which contains
// that circle whole, so the same placement serves
// apple-touch-icon: unplaced, a mark with a 6% margin lost 12
// corner pixels to it at 180 px. A square mark's corners reach furthest, so a
// square that fills its viewBox lands at 0.4 * sqrt(2) = 56.6%
// of the icon; a mark with its own margin lands larger in
// proportion, which is why the extent is measured, not padded.
export const MASK_SAFE_RADIUS = 0.4;
// how far below the exact fit the mark may shrink to land on
// whole pixels. A pixel-grid mark finds its size within a few
// percent (the C mark: 320 of a possible 330px at 512, 112 of 116
// at 180); a curved mark never does, and keeps the exact fit.
export const SNAP_WINDOW = 0.9;

// the pixel-distance gate: share of pixels, worse of the black and white
// composites, whose channel error exceeds 8/255. Unchanged from the
// original spec; see lib/quality.mjs for why a second metric joins it.
export const ACCURACY_PCT = 1.0;
// the edge-weighted luma error gate, worse of the two composites. 1.5883
// is the worst edgeError among today's (quality-80) files that already
// pass ACCURACY_PCT over the fixtures and the open corpus (the
// bench/sheet.mjs sheet, 346 rasters): the pixel-distance bar alone passes some visibly
// serrated edges at 192px (flat-color-icons/file), which this catches.
export const EDGE_GATE = 1.5883;
// the quality ladder the search walks at the default palette ceiling
// (256): binary search over these for `effort: 'default'`, every value
// for `'max'`.
export const SEARCH_QUALITIES = [40, 50, 60, 70, 80, 90, 95, 98, 99];
// the palette ladder the search also walks, at quality 100.
export const SEARCH_COLORS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

// =============================================================== CSS helpers ==
// Scanners shared by the var() resolver and the animation strip. Hand-written rather
// than delegated to a CSS parser because they run on attribute values too, where there is no
// stylesheet to parse, and because svgo's own parser is not on the public API.

/** Remove complete comments without retrying an unclosed comment at every later opener. */
const stripComments = (css) => {
  const parts = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf('/*', from);
    if (start < 0) break;
    const end = css.indexOf('*/', start + 2);
    if (end < 0) break;
    parts.push(css.slice(from, start));
    from = end + 2;
  }
  parts.push(css.slice(from));
  return parts.join('');
};

/**
 * Index of the next comment opener in `s` from `i`, skipping quoted strings the same way
 * `scan` does (a quote closes only at its own character, and a backslash escapes it) — so a
 * literal `/*` inside `content: "/*"` is not mistaken for one. The closer is still found with
 * a plain `indexOf('*‍/', ...)`: once a real comment has opened, CSS gives quotes inside it no
 * meaning, so the first `*‍/` always ends it.
 */
const nextCommentOpen = (s, i) => {
  let quote = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') return i;
  }
  return -1;
};

/**
 * Apply `fn` to the parts of `css` that sit OUTSIDE a `/* ... *‍/` comment, leaving every
 * comment's own text untouched rather than removed: minifyStyles deletes comments later, and
 * in the meantime a comment is never rendered, so prose inside one must not be scanned by
 * `fn` at all. An unclosed comment runs to the end of `css`, exactly as an unclosed XML
 * comment runs to the end of a document.
 */
const mapOutsideComments = (css, fn) => {
  const out = [];
  let from = 0;
  for (;;) {
    const start = nextCommentOpen(css, from);
    if (start < 0) {
      out.push(fn(css.slice(from)));
      return out.join('');
    }
    out.push(fn(css.slice(from, start)));
    const end = css.indexOf('*/', start + 2);
    if (end < 0) {
      out.push(css.slice(start));
      return out.join('');
    }
    out.push(css.slice(start, end + 2));
    from = end + 2;
  }
};

/**
 * Walk `s` from `i`, skipping quoted strings and counting `open`/`close` nesting. Returns the
 * first index where `stop(c, depth)` holds (depth already updated for `c`), or -1.
 */
const scan = (s, i, open, close, stop) => {
  let depth = 0,
    quote = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) depth--;
    if (stop(c, depth)) return i;
  }
  return -1;
};

/** Split at the first top-level comma; quotes and nested parens do not count. */
const splitFirstComma = (s) => {
  const i = scan(s, 0, '(', ')', (c, depth) => c === ',' && depth === 0);
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
};

/** Index of the ')' closing the '(' at or after `open`, or -1. */
const matchParen = (s, open) => scan(s, open, '(', ')', (c, depth) => c === ')' && depth === 0);

/**
 * Index of the next of `stops` at nesting depth 0, or -1. `stops` must not contain a paren:
 * `scan` tests `stops` after it has already updated depth for the current character, so a
 * paren in `stops` would be tested at the depth on its own far side, not the depth it opens
 * or closes at.
 */
const scanTo = (s, i, stops) => scan(s, i, '(', ')', (c, depth) => depth === 0 && stops.includes(c));

/** Index of the '}' closing the '{' at or after `open`, or -1. */
const matchBrace = (s, open) => scan(s, open, '{', '}', (c, depth) => c === '}' && depth === 0);

const KEYFRAMES = /^@(-[a-z]+-)?keyframes\b/i;

/**
 * A stylesheet's top-level statements, in order: `{ pre, body }` for a block, `{ text }` for
 * a `;`-terminated statement or for whatever follows the last complete one (including an
 * unclosed block, kept verbatim). The three rewriters below differ only in what they do
 * with a block.
 */
const cssStatements = (css) => {
  const out = [];
  for (let i = 0; i < css.length;) {
    const j = scanTo(css, i, '{;');
    const k = j >= 0 && css[j] === '{' ? matchBrace(css, j) : -1;
    if (j < 0 || (css[j] === '{' && k < 0)) {
      out.push({ text: css.slice(i) });
      break;
    }
    if (css[j] === ';') {
      out.push({ text: css.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    out.push({ pre: css.slice(i, j), body: css.slice(j + 1, k) });
    i = k + 1;
  }
  return out;
};

// ================================================================== plugins ==

/**
 * Resolve var() everywhere: attribute values and <style> text. Listed FIRST in the plugin
 * list, so it lands before preset-default's inlineStyles and minifyStyles get to a value
 * they cannot parse.
 *
 * Errors accumulate rather than throwing at the first one, so a mark with three unresolved
 * properties names all three. `errs` is owned by the caller: svgo reuses a plugin object
 * across passes and across calls, so per-run state cannot live in the plugin.
 *
 * Inside a <style> block, a CSS comment is skipped via `mapOutsideComments`: it is never
 * rendered, so prose there that happens to spell var(--x) must not be resolved or counted as
 * unresolved. Attribute values have no comment syntax of their own and are scanned whole.
 */
const resolveVarsPlugin = (vars, errs) => {
  const rv = (text, depth = 0) => {
    if (depth > 32) {
      errs.push('var() nested more than 32 deep');
      return text;
    }
    let out = '',
      i = 0;
    for (;;) {
      const at = text.indexOf('var(', i);
      if (at === -1) return out + text.slice(i);
      // `myvar(` and `--x-var(` are not var(). Only a token boundary starts one.
      if (at > 0 && /[\w-]/.test(text[at - 1])) {
        out += text.slice(i, at + 4);
        i = at + 4;
        continue;
      }
      const close = matchParen(text, at + 3);
      if (close === -1) {
        errs.push('unbalanced var(');
        return out + text.slice(i);
      }
      out += text.slice(i, at);
      const [rawName, fallback] = splitFirstComma(text.slice(at + 4, close));
      const name = rawName.trim();
      if (!/^--[\w-]+$/.test(name)) errs.push(`not a custom property: ${name}`);
      else if (vars.has(name)) out += vars.get(name);
      // A fallback is itself an arbitrary value, so it may hold another var().
      else if (fallback !== null) out += rv(fallback.trim(), depth + 1);
      else errs.push(`unresolved var(${name}) - no fallback and no --var override`);
      i = close + 1;
    }
  };
  // A stylesheet's text can arrive as either node type (stripAnimationPlugin and
  // hoistKeyframesPlugin both treat them alike for the same reason), so both get the same
  // comment-aware resolution.
  const resolveStyle = (node, parent) => {
    if (parent.name === 'style' && node.value.includes('var(')) node.value = mapOutsideComments(node.value, rv);
  };
  return {
    name: 'resolveVars',
    fn: () => ({
      element: {
        enter(node) {
          for (const k of Object.keys(node.attributes)) {
            const v = node.attributes[k];
            if (typeof v === 'string' && v.includes('var(')) node.attributes[k] = rv(v);
          }
        },
      },
      text: { enter: resolveStyle },
      cdata: { enter: resolveStyle },
      root: {
        exit() {
          if (errs.length) throw new Error(errs.join('; '));
        },
      },
    }),
  };
};

const SMIL = new Set(['animate', 'animateMotion', 'animateTransform', 'animateColor', 'set', 'discard']);
const MOTION = /^\s*(-[a-z]+-)?(animation|transition)(-[a-z-]+)?\s*:/i;

/**
 * Remove animation by structure, not by pattern-matching the whole file: SMIL elements,
 * @keyframes, any @media on prefers-reduced-motion (everything inside one is motion by
 * definition, including a "reduce" block that only exists to switch motion off), and any
 * `animation-`/`transition-` declaration wherever it is: rules, nested at-rules, style="".
 * Rules left empty are dropped. The CSS is rewritten only when something was in fact
 * removed, so a static input reaches preset-default byte-for-byte.
 *
 * `state.stripped` counts what was (or, preserving, would be) removed; the caller reports a
 * preserved animation from it.
 */
const stripAnimationPlugin = (state, preserve = false) => {
  const stripDecls = (s) => {
    const out = [];
    let i = 0;
    for (;;) {
      const j = scanTo(s, i, ';');
      const d = s.slice(i, j < 0 ? s.length : j);
      if (MOTION.test(d)) state.stripped++;
      else if (d.trim()) out.push(d);
      if (j < 0) return out.join(';');
      i = j + 1;
    }
  };
  const stripRules = (css) =>
    cssStatements(css)
      .map((st) => {
        if (st.text !== undefined) return st.text;
        const p = st.pre.trim();
        if (KEYFRAMES.test(p) || (/^@media\b/i.test(p) && /prefers-reduced-motion/i.test(p))) {
          state.stripped++;
          return '';
        }
        // @supports, @media on anything else: recurse.
        const r = p[0] === '@' ? stripRules(st.body) : stripDecls(st.body);
        return r.trim() ? st.pre + '{' + r + '}' : '';
      })
      .join('');
  const stripCss = (css) => {
    const before = state.stripped;
    const r = stripRules(stripComments(css));
    return state.stripped === before ? css : r;
  };
  const cssNode = {
    enter(node, parent) {
      if (parent.name !== 'style') return;
      const stripped = stripCss(node.value);
      if (!preserve) node.value = stripped;
    },
  };
  return {
    name: preserve ? 'detectAnimation' : 'stripAnimation',
    fn: () => ({
      element: {
        enter(node, parent) {
          if (SMIL.has(node.name)) {
            if (!preserve) parent.children = parent.children.filter((c) => c !== node);
            state.stripped++;
            return;
          }
          const st = node.attributes.style;
          if (typeof st !== 'string') return;
          const before = state.stripped;
          const v = stripDecls(st);
          if (preserve) return;
          if (state.stripped === before) return;
          if (v.trim()) node.attributes.style = v;
          else delete node.attributes.style;
        },
      },
      text: cssNode,
      cdata: cssNode,
    }),
  };
};

/**
 * The class and id names that inlineStyles would consume even though another rule still
 * needs them. Empty means inlining is safe and gets to run.
 *
 * inlineStyles copies a rule's declarations onto the elements it matches and then deletes
 * the class or id attribute it has consumed (plugins/inlineStyles.js, "clean up matched
 * class + ID attribute values"), without checking whether a rule it LEFT ALONE still
 * selects that name. It leaves two kinds alone: rules inside an at-rule (its useMqs default
 * of ['', 'screen'] is compared against a string built as `media screen`, so in practice no
 * at-rule qualifies) and rules with a pseudo-class. Both are where motion lives.
 *
 * The damage is more than a dead selector. minifyStyles hands csso a usage list built from
 * the classes still present in the document, so once the attribute is gone csso drops the
 * @media rule as unused and the animation disappears from icon.svg with no warning at all:
 * an icon sitting still without a word, which is worse than a bigger file.
 *
 * The hazard is per NAME, not per file. A name is at risk only if BOTH are true:
 *
 *   * some rule svgo will not inline selects it, so it is still needed afterwards, and
 *   * some rule svgo WILL inline selects it, so svgo will delete the attribute.
 *
 * A mark whose motion class appears only inside the guard (`.a` in an @media block, palette
 * classes at the top level) is the common case and is safe: nothing inlines `.a`, so
 * nothing removes it. Asking the coarser question ("is any class selected inside an
 * at-rule?") switched inlining off for those marks too and cost 44 B on a real logo.
 */
const classesInliningWouldEat = (source) => {
  const sheets = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const needed = new Set(); // named by a rule svgo will NOT inline
  const consumed = new Set(); // named by a rule svgo WILL inline, and so will strip
  // Pseudo-classes are stripped from the selector before matching, so `.x:hover` still
  // names `.x`; a plain token scan is the right granularity.
  const names = (sel) => sel.match(/[.#][-\w]+/g) ?? [];

  const walk = (css, insideAtRule) => {
    for (const st of cssStatements(css)) {
      if (st.text !== undefined) continue;
      const p = st.pre.trim();
      // Keyframe percentages are not selectors: svgo never puts them in the rule table, so
      // they neither need a class to be kept nor cause one to be removed.
      if (KEYFRAMES.test(p)) continue;
      if (p[0] === '@') walk(st.body, true);
      else for (const n of names(p)) (insideAtRule || p.includes(':') ? needed : consumed).add(n);
    }
  };
  for (const css of sheets) walk(stripComments(css), false);
  return [...needed].filter((n) => consumed.has(n));
};

/**
 * Move any @keyframes that sits INSIDE another at-rule out to the top level of the same
 * stylesheet. Only the default (animation-preserving) pass needs this, and only when there is
 * something to move.
 *
 * This is a workaround for a real svgo 4.1.0 crash, and it is worth being precise about,
 * because the shape it crashes on is the exact shape the animated-input contract requires:
 * @keyframes inside @media (prefers-reduced-motion: no-preference).
 *
 * svgo's lib/style.js parseStylesheet walks the CSS and SKIPS a top-level @keyframes on
 * purpose: its percentage selectors are not selectors and have no business in a rule
 * table. But for any OTHER at-rule it runs an inner csstree.walk that collects every
 * descendant Rule with no such guard, so `0%` and `100%` land in the stylesheet svgo
 * matches elements against. Everything downstream that resolves a computed style then feeds
 * them to css-select, which throws:
 *
 *     Error: Unmatched selector: %   at css-what parse.js:128
 *       ... css-select is() -> svgo lib/xast.js matches() -> lib/style.js computeOwnStyle()
 *
 * That path is reached from removeDeprecatedAttrs, removeUnknownsAndDefaults, inlineStyles
 * and more, so switching off one plugin only moves the crash. Hoisting removes the input
 * that triggers it instead.
 *
 * The hoist is safe: @keyframes has no cascade and no conditional behaviour of its own, it
 * only defines a name. What decides whether the mark moves is the `animation` declaration,
 * and that stays inside the guard, so icon.svg still honours prefers-reduced-motion.
 */
const hoistKeyframesPlugin = () => {
  const lift = (css, lifted, top) =>
    cssStatements(css)
      .map((st) => {
        if (st.text !== undefined) return st.text;
        const p = st.pre.trim();
        if (KEYFRAMES.test(p)) {
          if (top) return st.pre + '{' + st.body + '}'; // already where it belongs
          lifted.push(p + '{' + st.body + '}');
          return '';
        }
        if (p[0] === '@') {
          const inner = lift(st.body, lifted, false);
          return inner.trim() ? st.pre + '{' + inner + '}' : '';
        }
        return st.pre + '{' + st.body + '}';
      })
      .join('');
  const hoist = (css) => {
    const lifted = [];
    const rest = lift(css, lifted, true);
    return lifted.length ? rest + lifted.join('') : css; // untouched when nothing moved
  };
  const cssNode = {
    enter(node, parent) {
      if (parent.name === 'style') node.value = hoist(node.value);
    },
  };
  return { name: 'hoistKeyframes', fn: () => ({ text: cssNode, cdata: cssNode }) };
};

/**
 * An animated logo keeps its <style>, so removeAttrs can no longer drop every class (the
 * motion rules select by class) and cleanupIds deoptimises across the board. This keeps the
 * classes a selector names and the ids something references, no more, and drops the rest.
 */
const ariaRefs = (attributes) =>
  Object.entries(attributes)
    .filter(([name]) =>
      /^aria-(?:labelledby|describedby|controls|owns|flowto|activedescendant|details|errormessage)$/.test(name),
    )
    .flatMap(([, value]) => value.trim().split(/\s+/))
    .filter(Boolean);

const pruneRefs = {
  name: 'pruneRefs',
  fn: () => {
    const els = [],
      refs = new Set();
    let css = '',
      smil = false;
    const urls = (v) => {
      for (const m of String(v).matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) refs.add(m[1]);
    };
    return {
      element: {
        enter(node) {
          els.push(node);
          if (SMIL.has(node.name)) smil = true;
          if (node.name === 'style') {
            for (const c of node.children) if (c.type === 'text' || c.type === 'cdata') css += c.value;
          }
          for (const id of ariaRefs(node.attributes)) refs.add(id);
          for (const v of Object.values(node.attributes)) urls(v);
          const h = node.attributes.href ?? node.attributes['xlink:href'];
          if (typeof h === 'string' && h[0] === '#') refs.add(h.slice(1));
        },
      },
      root: {
        exit() {
          const cls = new Set();
          for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) cls.add(m[1]);
          for (const m of css.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) refs.add(m[1]);
          urls(css);
          for (const n of els) {
            const c = n.attributes.class;
            if (c != null) {
              const keep = String(c)
                .split(/\s+/)
                .filter((x) => cls.has(x));
              if (keep.length) n.attributes.class = keep.join(' ');
              else delete n.attributes.class;
            }
            // SMIL can name an id in begin="x.end", which no pattern here would see.
            if (!smil && n.attributes.id != null && !refs.has(n.attributes.id)) delete n.attributes.id;
          }
        },
      },
    };
  },
};

// =============================================================== the svg stage ==

const documentElement = {
  name: 'documentElement',
  fn: () => ({
    root: {
      enter(node) {
        // Document annotations are outside the rendered SVG. Removing them
        // structurally also keeps the renderer's root-element wrapper unambiguous.
        node.children = node.children.filter((child) => child.type !== 'comment' && child.type !== 'instruction');
      },
    },
  }),
};

// Only the root's intrinsic size becomes the raster coordinate plane. Removing
// dimensions from nested SVGs changes their viewport and would corrupt the very
// reference used to judge SVGO. Convert root lengths without rounding geometry.
const SVG_NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?';
const SVG_SPACE = '[ \\t\\r\\n]';
// Keep a comma between whitespace runs so invalid input cannot make overlapping
// whitespace repetitions backtrack. Missing values and JS hex coercions stay errors.
const SVG_SEPARATOR = `(?:${SVG_SPACE}+(?:,${SVG_SPACE}*)?|,${SVG_SPACE}*)`;
const VIEWBOX = new RegExp(`^${SVG_SPACE}*${Array(4).fill(`(${SVG_NUMBER})`).join(SVG_SEPARATOR)}${SVG_SPACE}*$`);
const referenceViewport = (input) => ({
  name: 'referenceViewport',
  fn: () => ({
    element: {
      enter(node, parent) {
        // Inspect parsed elements in this existing pass: comments and CDATA cannot
        // masquerade as dependencies, and precision retries do not repeat warnings.
        if (node.name === 'text') input.text = true;
        if (node.name === 'image' || node.name === 'feImage') {
          const href = (node.attributes.href ?? node.attributes['xlink:href'] ?? '').trim();
          if (href && !href.startsWith('#') && !/^data:/i.test(href)) input.externalImage = true;
        }
        if (node.name !== 'svg' || parent.type !== 'root') return;
        const attrs = node.attributes;
        if (attrs.viewBox == null) {
          const length = (value) => {
            const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|in|cm|mm|pt|pc|m|ft)?$/i.exec(
              String(value).trim(),
            );
            if (!match) return NaN;
            const units = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 4 / 3, pc: 16, m: 9600 / 2.54, ft: 1152 };
            return Number(match[1]) * (match[2] ? units[match[2].toLowerCase()] : 1);
          };
          const w = length(attrs.width),
            h = length(attrs.height);
          if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) attrs.viewBox = `0 0 ${w} ${h}`;
        }
        if (attrs.viewBox != null) {
          const box = VIEWBOX.exec(attrs.viewBox)?.slice(1).map(Number);
          input.viewport = Boolean(box && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0);
          delete attrs.width;
          delete attrs.height;
        }
      },
    },
  }),
});

/**
 * The SVG stage, bound to an svgo. `optimize` comes from 'svgo' in Node and from 'svgo/browser'
 * in a bundler. The browser build exports it too, so the plugin list below is the same one in
 * both places and cannot drift.
 */
export const createSvgStage = ({ optimize }) => {
  /**
   * Preserve animation and accessibility by default. Explicit icon mode strips motion
   * and accessibility for callers requesting a static SVG.
   */
  const svgoConfig = ({ icon, vars, errs, animState, source, precision, reference, input }) => {
    if (reference)
      return {
        multipass: false,
        // A reference must not share the numeric/path simplification being graded.
        // This also supplies the geometry-preserving fallback for difficult sources.
        plugins: [
          documentElement,
          stripAnimationPlugin(animState, !icon),
          resolveVarsPlugin(vars, errs),
          referenceViewport(input),
          ...(icon
            ? [
                { name: 'removeAttrs', params: { attrs: '(role|aria-.*|data-.*)' } },
                'removeTitle',
                { name: 'removeDesc', params: { removeAny: true } },
              ]
            : []),
        ],
      };
    const overrides = {};
    // SVGO does not track ARIA IDREFs. Collect parsed targets before its cleanupIds pass;
    // keep their names stable, including across multipass optimization.
    const accessibleIds = [];
    if (!icon) overrides.cleanupIds = { preserve: accessibleIds };

    // A prefers-color-scheme block is the one stylesheet icon.svg keeps (decision 25): the
    // browser applies it to the favicon, and resvg skips @media, so the rasters stay light.
    // It then needs what the default (animation-preserving) pass already gets: the classes its
    // rules select survive.
    const colorScheme = icon && /prefers-color-scheme/i.test(source);
    const keepsStyle = !icon || colorScheme;
    if (!icon) overrides.removeUnknownsAndDefaults = { keepRoleAttr: true };

    // Only a pass that keeps a stylesheet can lose a class it still needs.
    if (keepsStyle && classesInliningWouldEat(source).length) overrides.inlineStyles = false;

    return {
      multipass: true,
      floatPrecision: precision,
      plugins: [
        documentElement,
        // First, so a var() used only by an animation cannot fail a build that drops it.
        stripAnimationPlugin(animState, !icon),
        // The static pass (`--no-animation`) has already deleted every @keyframes, so only the
        // default (animation-preserving) pass can trip the svgo crash this avoids. A source
        // with nothing nested is passed through untouched.
        ...(icon ? [] : [hoistKeyframesPlugin()]),
        resolveVarsPlugin(vars, errs),
        ...(!icon
          ? [
              {
                name: 'preserveAriaIds',
                fn: () => ({
                  element: {
                    enter(node) {
                      accessibleIds.push(...ariaRefs(node.attributes));
                    },
                  },
                }),
              },
            ]
          : []),
        { name: 'preset-default', params: { overrides } },
        'convertStyleToAttrs',
        ...(icon
          ? [
              {
                name: 'removeAttrs',
                params: { attrs: keepsStyle ? '(role|aria-.*|data-.*)' : '(role|aria-.*|data-.*|class)' },
              },
            ]
          : []),
        ...(keepsStyle ? [pruneRefs] : []),
        'removeDimensions',
        ...(icon ? ['removeTitle'] : []),
        // removeAny: svgo's default keeps any <desc> that is not empty or an editor stamp, and
        // general.svg's 87-byte description was 30 % of its 289-byte icon.svg.
        ...(icon ? [{ name: 'removeDesc', params: { removeAny: true } }] : []),
      ],
    };
  };

  /**
   * One svgo pass. `icon: true` strips motion; the default preserves it. Exported for the
   * synchronous `optimiseSvg` API and the tests: var() resolution, the animation strip, the
   * keyframes hoist and the reference pruning all live here.
   *
   * Returns `{ data, stripped, animated }`; preserved motion is detected without removal.
   */
  function optimiseSvg(
    source,
    { icon = false, vars = {}, name = 'input.svg', precision = 1, reference = false, onWarn = () => {} } = {},
  ) {
    const map = vars instanceof Map ? vars : normaliseVars(vars);
    const errs = [];
    const animState = { stripped: 0 };
    const input = {};
    let result;
    try {
      result = optimize(source, svgoConfig({ icon, vars: map, errs, animState, source, precision, reference, input }));
    } catch (e) {
      // The resolveVars plugin throws through svgo; surface its message, not a stack.
      const m = /unresolved var\([^)]*\)[^;\n]*/.exec(e.message);
      if (m) {
        throw new FavseedError(
          `${m[0]} in ${name} - supply it with --var name=value` +
            (icon ? '' : ', or drop the animation with --no-animation'),
        );
      }
      throw new FavseedError(`svgo failed on ${name}: ${e.message}`);
    }
    if (!result.data) throw new FavseedError(`optimising ${name} produced an empty file`);
    if (reference) {
      if (!input.viewport)
        throw new FavseedError(
          `${name} needs a valid viewBox="min-x min-y width height" with finite numbers and positive dimensions; ` +
            `add a viewBox or positive numeric width and height instead of percentage-only dimensions`,
        );
      if (input.text)
        onWarn(
          'SVG contains text; fonts may be unavailable or differ between native and browser rendering. Convert text to paths for consistent PNG/ICO output.',
        );
      if (input.externalImage)
        onWarn(
          'SVG references an external image; PNG/ICO exports and SVG image contexts may omit it. Embed the image as a data: URL.',
        );
    }
    return { data: result.data, stripped: icon ? animState.stripped : 0, animated: !icon && animState.stripped > 0 };
  }

  return { optimiseSvg };
};

// ============================================================== the options ==

export const normaliseVars = (vars) => {
  const map = new Map();
  const entries = vars instanceof Map ? vars.entries() : Object.entries(vars ?? {});
  for (const [rawName, value] of entries) {
    const name = String(rawName).trim().startsWith('--') ? String(rawName).trim() : '--' + String(rawName).trim();
    if (!/^--[\w-]+$/.test(name)) throw new FavseedError(`--var name must be a CSS custom property, got '${name}'`);
    map.set(name, String(value));
  }
  return map;
};

// =================================================================== the ICO ==

/**
 * A 22-byte directory plus the PNG verbatim, byte-identical to `icotool -c -r` on every build
 * it was checked against.
 *
 * Uint8Array and DataView rather than Buffer, so the website can write an ICO too. Buffer is a
 * Uint8Array, so a Node caller may still pass one in.
 *
 * wBitCount is the field to get wrong. Across the corpus the payload IHDR was 2/3, 4/3, 8/3 or
 * 8/6 (four different bit-depth/colour-type pairs), and icotool wrote wPlanes=1, wBitCount=32
 * for every one of them. The directory entry describes the DECODED 32-bit image, not the
 * encoding, so deriving it from the IHDR produces a file icotool never writes. Same for
 * bColorCount=0 on a payload that is paletted for real.
 */
export const icoWrap = (png, px) => {
  if (!Number.isInteger(px) || px < 1 || px > 256) {
    throw new FavseedError(`an ICO entry must be 1-256 px, got ${px}`);
  }
  const src = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // The directory says how big the image is, so check rather than trust: an ICO whose header
  // disagrees with its payload decodes at the wrong size in some viewers and not at all in
  // others. IHDR is always the first chunk, so width and height sit at a fixed offset. This is
  // what caught resvg preserving the aspect ratio of a non-square source: the payload was
  // 32x16 and the header would have claimed 32x32.
  if (png.length < 24 || src.getUint32(1) !== 0x504e470d) {
    throw new FavseedError('ICO payload is not a PNG');
  }
  const w = src.getUint32(16),
    h = src.getUint32(20);
  if (w !== px || h !== px) {
    throw new FavseedError(`ICO payload is ${w}x${h}, expected ${px}x${px}`);
  }
  const out = new Uint8Array(22 + png.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true); // idReserved
  dv.setUint16(2, 1, true); // idType: 1 = icon
  dv.setUint16(4, 1, true); // idCount
  out[6] = px & 0xff; // bWidth: 256 is stored as 0, hence the mask
  out[7] = px & 0xff; // bHeight: likewise
  out[8] = 0; // bColorCount: 0 even for a paletted payload
  out[9] = 0; // bReserved
  dv.setUint16(10, 1, true); // wPlanes
  dv.setUint16(12, 32, true); // wBitCount: the decoded image, always 32
  dv.setUint32(14, png.length, true); // dwBytesInRes
  dv.setUint32(18, 22, true); // dwImageOffset: straight after this directory
  out.set(png, 22);
  return out;
};

// ============================================================= the masked icon ==

/**
 * How far the mark reaches from the centre of its (square) icon, from a transparent render.
 *
 * `radius` is the distance of the farthest opaque pixel's OUTER corner, as a fraction of the
 * icon width, so the whole pixel lands inside the zone, not its centre alone. Takes DECODED
 * pixels, not a PNG: every host passes the engine's renderRgba. `scale` is what icon.svg has
 * to be multiplied by for that pixel to sit on the safe circle: the mark fills the zone, in
 * both directions. A mark drawn small is enlarged, because on a maskable icon its own margin
 * means nothing (the platform's shape is the frame).
 *
 * A source that is opaque in all four corners is already full-bleed (a background drawn
 * into the mark on purpose) and is used as it is: scaling it would shrink the author's own
 * ground into a square sitting on --bg, which is never what a full-bleed mark wants.
 */
export const maskableFit = ({ width: W, height: H, rgba }) => {
  const alpha = (x, y) => rgba[(y * W + x) * 4 + 3];
  const cx = W / 2,
    cy = H / 2;
  let r2 = 0,
    any = false;
  for (let y = 0; y < H; y++) {
    // Only a row's first and last visible pixels can be farthest from the centre.
    let left = 0,
      right = W - 1;
    while (left < W && alpha(left, y) === 0) left++;
    if (left === W) continue;
    while (right > left && alpha(right, y) === 0) right--;
    any = true;
    const dx = Math.max(Math.abs(left - cx), Math.abs(right + 1 - cx));
    const dy = Math.max(Math.abs(y - cy), Math.abs(y + 1 - cy));
    const d = dx * dx + dy * dy;
    if (d > r2) r2 = d;
  }
  if (!any) throw new FavseedError('icon.svg renders nothing, so there is no mark to fit into the safe zone');
  const fullBleed = alpha(0, 0) > 0 && alpha(W - 1, 0) > 0 && alpha(0, H - 1) > 0 && alpha(W - 1, H - 1) > 0;
  const radius = Math.sqrt(r2) / W;
  return { radius, fullBleed, scale: fullBleed ? 1 : MASK_SAFE_RADIUS / radius };
};

// Retain a real inner viewport: rewriting its viewBox would change percentages.
// Prologs belong before the outer document, never inside the nested SVG content.
const nestViewport = (iconData, { x, y, width, height }, canvas) => {
  const start = iconData.search(/<svg\b/i);
  if (start < 0) throw new FavseedError('cannot frame an SVG without a root svg element');
  const prolog = iconData.slice(0, start);
  const inner = iconData
    .slice(start)
    .replace(
      /<svg\b([^>]*?)(\/?)>/i,
      (_m, attrs, close) =>
        `<svg${attrs.replace(/\s(?:x|y|width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')} x="${x}" y="${y}" width="${width}" height="${height}"${close}>`,
    );
  return `${prolog}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas} ${canvas}">${inner}</svg>`;
};

/**
 * Draw the raster source as a `box`-pixel square centred in a `canvas`-pixel one.
 * Both are even, so a crisp mark retains whole-pixel alignment. The original source
 * viewport remains nested inside non-square raster sources. The render's background
 * supplies the ground, so this wrapper adds no bytes to the emitted SVG or PNG.
 */
export const nestForMask = (iconData, box, canvas) => {
  const off = (canvas - box) / 2;
  return nestViewport(iconData, { x: off, y: off, width: box, height: box }, canvas);
};

const partialAlpha = (rgba) => {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0 && rgba[i] !== 255) n++;
  return n;
};

// Limit both active work and estimated RGBA canvases (including image1.15's 1000px
// render floor). This is a working-pixel budget, not a total process-memory limit.
// `extraBytes` adds what an item holds beyond its render canvas. An oversized item runs
// alone. Drain a failed batch before its caller can retry.
export const mapImages = async (items, sizeOf, work, { serial = false, extraBytes = () => 0 } = {}) => {
  const results = [];
  for (let start = 0; start < items.length;) {
    let end = start,
      bytes = 0;
    while (end < items.length && end - start < (serial ? 1 : 4)) {
      const px = sizeOf(items[end]),
        cost = px * Math.max(1000, px) * 4 + extraBytes(items[end]);
      if (end > start && bytes + cost > 16 * 1024 * 1024) break;
      bytes += cost;
      end++;
    }
    const settled = await Promise.allSettled(
      items.slice(start, end).map((item) => Promise.resolve().then(() => work(item))),
    );
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    results.push(...settled.map((result) => result.value));
    start = end;
  }
  return results;
};

/**
 * Where the mark goes in a masked icon of `canvas` px, decided on renders at that size, so the
 * snap is to that icon's own pixels. `render(svgText, px)` returns { width, height, rgba }.
 * Every host passes the engine's renderRgba, and the test suite its own reference render, so
 * the build and the gate agree on where the mark goes.
 *
 * Two steps. The FIT scales the mark until its farthest opaque pixel sits on the safe circle
 * (maskableFit). The SNAP then walks the box size down in whole even pixels, no further than
 * SNAP_WINDOW, looking for the size where the mark renders with the fewest semi-transparent
 * pixels, which for a mark drawn on a pixel grid is a size with none at all. A smaller box is
 * only taken when it at least halves them, so a curved mark, which is anti-aliased at every
 * size, is not shrunk for nothing.
 *
 * Returns { svg, box, scale, snapped, radius, fullBleed, padding }; `scale` is box / canvas
 * and `padding` is the per-side margin in use, as a percentage: a number even when
 * `auto` chose it, so callers can report what the measurement decided.
 */
export const placeInSafeZone = async (iconData, render, canvas, padding = 'auto') => {
  if (!Number.isInteger(canvas) || canvas < 2 || canvas % 2) {
    throw new FavseedError(`internal error: a masked icon's size must be an even pixel count, got ${canvas}`);
  }
  const even = (n) => n - (n % 2);

  // An explicit padding is a promise, not a hint: it is applied as given and never snapped.
  // Snapping exists to find a crisper size NEAR the measured fit; moving a number the caller
  // chose would make --padding mean something different from what it says.
  if (padding !== 'auto') {
    const box = Math.max(2, even(Math.floor(canvas * (1 - (2 * padding) / 100))));
    return {
      svg: nestForMask(iconData, box, canvas),
      box,
      scale: box / canvas,
      snapped: false,
      radius: null,
      fullBleed: false,
      padding,
    };
  }

  const fit = maskableFit(await render(iconData, canvas));
  if (fit.fullBleed) {
    return { svg: iconData, box: canvas, scale: 1, snapped: false, radius: fit.radius, fullBleed: true, padding: 0 };
  }
  // Not capped at the canvas: a mark drawn small gets a box wider than the icon, and only its
  // own transparent margin falls outside. The fit has already put every opaque pixel inside.
  const exact = even(Math.floor(fit.scale * canvas));
  // Keep moderate probes reusable across output sizes. For larger margins, probe
  // exportable pixels instead: the source stays enlarged with an integer offset,
  // while every probe canvas remains at most twice the target. Keep the full walk
  // and selection rules; see bench/placement/ for the measured cache tradeoff.
  const cropProbes = exact > canvas * 2;
  const probe = (box) => (cropProbes ? render(nestForMask(iconData, box, canvas), canvas) : render(iconData, box));
  const baseline = partialAlpha((await probe(exact)).rgba);
  let box = exact;
  if (baseline > 0) {
    let best = { box: exact, n: baseline };
    const serial = canvas > 512 || exact > 1024,
      step = serial ? 1 : 4;
    search: for (let b = exact - 2; b >= Math.ceil(exact * SNAP_WINDOW); b -= step * 2) {
      const sizes = Array.from({ length: step }, (_, i) => b - i * 2).filter(
        (size) => size >= Math.ceil(exact * SNAP_WINDOW),
      );
      const images = await mapImages(sizes, (size) => (cropProbes ? canvas : size), probe, { serial });
      for (let i = 0; i < sizes.length; i++) {
        const n = partialAlpha(images[i].rgba);
        if (n < best.n) best = { box: sizes[i], n };
        if (n === 0) break search; // retain the largest crisp size, regardless of finish order
      }
    }
    if (best.n * 2 <= baseline) box = best.box;
  }
  return {
    svg: nestForMask(iconData, box, canvas),
    box,
    scale: box / canvas,
    snapped: box !== exact,
    radius: fit.radius,
    fullBleed: false,
    padding: ((1 - box / canvas) / 2) * 100,
  };
};

// ===================================================================== links ==

/**
 * The `<link>` block, in one place. The Astro integration imports this rather than keeping
 * its own copy: it needs the tags in astro:config:setup, before any build has run, and two
 * copies of the ICO's declared-size rule is the kind of thing that drifts apart.
 */
export const linkTags = (base = '/', manifest = false) =>
  // Declare the actual fallback bitmap size alongside the reusable SVG icon.
  `<link rel="icon" href="${base}favicon.ico" sizes="${ICO_SIZE}x${ICO_SIZE}">\n` +
  `<link rel="icon" href="${base}icon.svg" type="image/svg+xml">\n` +
  `<link rel="apple-touch-icon" href="${base}apple-touch-icon.png">\n` +
  (manifest ? `<link rel="manifest" href="${base}site.webmanifest">\n` : '');

/**
 * True when the page already links an icon: a <link> whose rel holds the `icon` keyword.
 * rel is a list of keywords, so `alternate icon` counts and `apple-touch-icon` does not.
 * An author who linked an icon has said what they want, and two competing sets of
 * <link rel="icon"> leave the choice to the browser.
 */
export const declaresIcon = (html) => {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const m = /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    if (m && (m[1] ?? m[2] ?? m[3]).toLowerCase().split(/\s+/).includes('icon')) return true;
  }
  return false;
};

// ============================================================= the square box ==

/**
 * Raster slots are square, but source geometry must keep its proportions. Center
 * the original rectangular viewport in a square canvas rather than stretching it
 * or changing the coordinate plane used by percentage lengths. This wrapper stays
 * private to rasterization; the shared icon.svg retains its original viewport.
 * Returns { data, warning }; near-square sources retain the existing quiet tolerance.
 */
export const squareIconSvg = (iconData) => {
  const vb = /\bviewBox\s*=\s*"([^"]*)"/.exec(iconData);
  if (!vb) return { data: iconData, warning: null };
  const [, , w, h] = vb[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!(w > 0 && h > 0) || w === h) return { data: iconData, warning: null };
  const box = Math.max(w, h);
  return {
    data: nestViewport(iconData, { x: (box - w) / 2, y: (box - h) / 2, width: w, height: h }, box),
    warning:
      w / h > 1.01 || h / w > 1.01
        ? `viewBox ${w}x${h} is not square; the rasters preserve its proportions on a centered square canvas ` +
          `(icon.svg keeps the original proportions)`
        : null,
  };
};

// ================================================================== manifest ==

// icon.svg is never listed: an SVG entry breaks Android's WebAPK install (crbug.com/40925759).

/** The manifest's icon entries: one per padded size, `purpose` only when the set is padded. */
export const manifestIcons = ({ sizes, base = '/', purpose = null }) =>
  sizes.map((s) => ({
    src: `${base}icon-${s}.png`,
    sizes: `${s}x${s}`,
    type: 'image/png',
    ...(purpose ? { purpose } : {}),
  }));

/**
 * site.webmanifest, icons only unless the caller has a name to add.
 *
 * Written by hand rather than with JSON.stringify(..., 2), which puts every key of every icon
 * on its own line; one entry per line is far easier to read and to diff.
 */
export const manifestJson = ({ sizes, base = '/', purpose = null, extra = null }) => {
  const head =
    extra && typeof extra === 'object'
      ? Object.entries(extra)
          .filter(([k]) => k !== 'icons')
          .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`)
          .join('')
      : '';
  // One entry per line, written by hand: JSON.stringify would put every key on its own line.
  const entry = (i) =>
    '    { ' +
    Object.entries(i)
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(', ') +
    ' }';
  return `{\n${head}  "icons": [\n${manifestIcons({ sizes, base, purpose }).map(entry).join(',\n')}\n  ]\n}\n`;
};
