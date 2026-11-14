// Each `##` section of a Markdown page becomes one <section>: the layout draws every direct
// child of <main> as a card, which is how the hand-written .astro pages are built. Text before
// the first `##` gets a card of its own. Runs after the other visitors, on the whole tree.
const blank = (node) => node.type === 'text' && !node.value.trim();

export default {
  name: 'favseed-sections',
  after(root, ctx) {
    const groups = [];
    for (const child of root.children) {
      const opens = child.type === 'element' && child.tagName === 'h2';
      if (opens || groups.length === 0) groups.push([]);
      groups.at(-1).push(child);
    }
    const cards = groups
      .filter((children) => !children.every(blank))
      .map((children) => ({ type: 'element', tagName: 'section', properties: {}, children }));
    ctx.setField(root, 'children', cards);
  },
};
