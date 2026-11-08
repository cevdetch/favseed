// Iconify JSON icon sets as standalone SVG files, for the bench-only real-world corpus.
// Pure functions: no I/O, so the suite can test them without the network.

/** One icon of a parsed Iconify JSON set as an SVG document. Aliases resolve to their parent. */
export const iconSvg = (set, name) => {
  let icon = set.icons?.[name];
  for (let hops = 0; !icon && set.aliases?.[name] && hops < 8; hops++) {
    name = set.aliases[name].parent;
    icon = set.icons?.[name];
  }
  if (!icon) throw new Error(`no icon '${name}' in set '${set.prefix}'`);
  const left = icon.left ?? set.left ?? 0,
    top = icon.top ?? set.top ?? 0;
  const width = icon.width ?? set.width ?? 16,
    height = icon.height ?? set.height ?? 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}">${icon.body}</svg>`;
};

/** `count` names spread evenly over the sorted list: the same input always picks the same icons. */
export const selectIcons = (names, count) => {
  const sorted = names.toSorted();
  if (sorted.length <= count) return sorted;
  return Array.from({ length: count }, (_, i) => sorted[Math.floor((i * sorted.length) / count)]);
};
