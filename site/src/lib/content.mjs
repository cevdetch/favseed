// URLs, breadcrumbs and neighbours for the Markdown pages, from their collection entries.
export const slugOf = (entry) => entry.id.replace(/(^|\/)index$/, '');
export const pathOf = (entry) => `/${slugOf(entry)}`;
export const sectionOf = (entry) => slugOf(entry).split('/')[0];

const siblings = (entry, entries) =>
  entries.filter((other) => sectionOf(other) === sectionOf(entry)).toSorted((a, b) => a.data.order - b.data.order);

// The ancestors between Home and the page: a section page has its hub, a hub has none.
export const trailOf = (entry, entries) => {
  const hub = entries.find((other) => slugOf(other) === sectionOf(entry));
  return hub && hub !== entry ? [[pathOf(hub), hub.data.label]] : [];
};

const link = (entry) => entry && [pathOf(entry), entry.data.label];

export const pagerOf = (entry, entries) => {
  const list = siblings(entry, entries);
  const at = list.indexOf(entry);
  return { prev: link(list[at - 1]), next: link(list[at + 1]) };
};

// The raw page for the .md alternate and llms-full.txt: the heading and lede the layout shows,
// then the Markdown as written.
export const markdownOf = (entry) => `# ${entry.data.heading}\n\n${entry.data.lede}\n\n${entry.body.trim()}\n`;
