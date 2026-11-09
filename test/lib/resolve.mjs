// A var() resolver for reference renders.
//
// A SECOND implementation on purpose, not an import of favseed's. The accuracy gate
// compares favseed's output against a reference render, and if both sides resolved custom
// properties with the same code then a resolver bug would cancel itself out and the gate
// would pass. This one is slower and simpler; that is the point.

const substitute = (text, vars, depth = 0) => {
  if (depth > 32) throw new Error('var() nested too deep');
  let out = '',
    i = 0;
  for (;;) {
    const at = text.indexOf('var(', i);
    if (at === -1) return out + text.slice(i);
    if (at > 0 && /[\w-]/.test(text[at - 1])) {
      out += text.slice(i, at + 4);
      i = at + 4;
      continue;
    }
    let depth2 = 0,
      close = -1;
    for (let j = at + 3; j < text.length; j++) {
      if (text[j] === '(') depth2++;
      else if (text[j] === ')' && --depth2 === 0) {
        close = j;
        break;
      }
    }
    if (close === -1) throw new Error('unbalanced var(');
    const inner = text.slice(at + 4, close);
    let split = -1,
      d = 0;
    for (let j = 0; j < inner.length; j++) {
      if (inner[j] === '(') d++;
      else if (inner[j] === ')') d--;
      else if (inner[j] === ',' && d === 0) {
        split = j;
        break;
      }
    }
    const name = (split === -1 ? inner : inner.slice(0, split)).trim();
    const fallback = split === -1 ? null : inner.slice(split + 1).trim();
    out += text.slice(i, at);
    if (vars.has(name)) out += vars.get(name);
    else if (fallback !== null) out += substitute(fallback, vars, depth + 1);
    else throw new Error(`unresolved var(${name})`);
    i = close + 1;
  }
};

// A comment is never rendered, so prose inside one (this file's own header comment says
// "var()" more than once) must not be scanned for calls to resolve. An unclosed `<!--` runs
// to the end of the document, exactly as XML parses it, so it is never substituted either.
const splitComments = (svg) => {
  const parts = [];
  let i = 0;
  for (;;) {
    const start = svg.indexOf('<!--', i);
    if (start === -1) {
      parts.push({ text: svg.slice(i), comment: false });
      return parts;
    }
    parts.push({ text: svg.slice(i, start), comment: false });
    const end = svg.indexOf('-->', start + 4);
    if (end === -1) {
      parts.push({ text: svg.slice(start), comment: true });
      return parts;
    }
    parts.push({ text: svg.slice(start, end + 3), comment: true });
    i = end + 3;
  }
};

// Inside a <style>...</style> block, a CSS comment is just as unrendered as an XML one, so it
// gets the same treatment: skipped for substitution, its own text kept verbatim. An unclosed
// `/*` runs to the end of the style block's text, matching the XML comment rule above.
const STYLE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;

// A `/*` written inside a quoted CSS string (e.g. content: "/*") is not a comment opener; a
// quote only closes at a matching, non-escaped quote character, same as the quote handling
// `substitute` itself has no need for but a comment scan does.
const findCommentOpen = (css, from) => {
  let quote = null;
  for (let i = from; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === quote && css[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') return i;
  }
  return -1;
};

const substituteCss = (css, vars) => {
  const out = [];
  let from = 0;
  for (;;) {
    const start = findCommentOpen(css, from);
    if (start === -1) {
      out.push(substitute(css.slice(from), vars));
      return out.join('');
    }
    out.push(substitute(css.slice(from, start), vars));
    const end = css.indexOf('*/', start + 2);
    if (end === -1) {
      out.push(css.slice(start));
      return out.join('');
    }
    out.push(css.slice(start, end + 2));
    from = end + 2;
  }
};

const substituteMarkup = (text, vars) => {
  let out = '',
    last = 0;
  for (const m of text.matchAll(STYLE)) {
    out += substitute(text.slice(last, m.index), vars) + m[1] + substituteCss(m[2], vars) + m[3];
    last = m.index + m[0].length;
  }
  return out + substitute(text.slice(last), vars);
};

/** `vars` keys may be given with or without the leading `--`. */
export function resolveVars(svg, vars = {}) {
  const map = new Map();
  for (const [k, v] of Object.entries(vars)) map.set(k.startsWith('--') ? k : '--' + k, String(v));
  return splitComments(svg)
    .map(({ text, comment }) => (comment ? text : substituteMarkup(text, map)))
    .join('');
}
