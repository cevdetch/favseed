// Shared structured data for the cevdet.ch sites, copy f37f0f86ac3b.
// Installed from the shared source: do not edit here, the next install replaces it.

// Structured data for every cevdet.ch site: the identity of the person behind
// them and one builder per schema.org type the sites emit. Types Google no
// longer uses (FAQ, HowTo, SearchAction) and types that need ratings this
// work does not have (SoftwareApplication) have no builder on purpose.
//
// Each node stands on its own. Google reads one page at a time and does not
// follow an @id to another domain, so a page that credits the person repeats
// name and url inline instead of pointing at cevdet.ch.

import type {
  Article, BlogPosting, BreadcrumbList, CreativeWork, Graph, ImageObject, Person, ProfilePage, SoftwareSourceCode,
  TechArticle, Thing, WebSite,
} from 'schema-dts';

type Node<T> = Exclude<T, string>;

/** The person behind every site. cevdet.ch carries the full node; other pages carry `personReference()`. */
export const identity = {
  id: 'https://cevdet.ch/#person',
  name: 'Cevdet Haran',
  givenName: 'Cevdet',
  familyName: 'Haran',
  alternateName: ['Cevdet', 'cevdetch'],
  url: 'https://cevdet.ch/',
  image: 'https://cevdet.ch/cevdet-haran.jpg',
  sameAs: ['https://github.com/cevdetch', 'https://www.linkedin.com/in/cevdetch/', 'https://www.npmjs.com/~cevdetch'],
} as const;

/** Who a page credits: a name, the person's own site and, optionally, a fixed @id. */
export interface PersonRef {
  name: string;
  url: string;
  id?: string | undefined;
}

/** The person behind every site, as a PersonRef. */
export const owner: PersonRef = { id: identity.id, name: identity.name, url: identity.url };

/** `url` with `#fragment`, the form every @id here takes: https://one.cevdet.ch/#website. */
export function nodeId(url: string | URL, fragment: string): string {
  const id = new URL(url);
  id.hash = fragment;
  return id.href;
}

/** A Person by @id, name and url: enough for Google to credit an author without the full node. */
export function personReference(person: PersonRef = owner): Node<Person> {
  return { '@type': 'Person', '@id': person.id ?? nodeId(person.url, 'person'), name: person.name, url: person.url };
}

/** What only cevdet.ch adds to the identity: the facts its own pages show. */
export interface PersonDetails {
  jobTitle?: string | undefined;
  description?: string | undefined;
  email?: string | undefined;
  knowsAbout?: readonly string[] | undefined;
  /** The portrait's pixel size; omit while public/ has no portrait, and the node names no image. */
  image?: { width: number; height: number } | undefined;
}

/** The full Person. Only cevdet.ch emits it, on the page that shows these facts. */
export function personNode(details: PersonDetails = {}): Node<Person> {
  const image: Node<ImageObject> | undefined = details.image && {
    '@type': 'ImageObject', '@id': nodeId(identity.url, 'portrait'), url: identity.image, contentUrl: identity.image,
    width: `${details.image.width}`, height: `${details.image.height}`, caption: identity.name,
  };
  return {
    '@type': 'Person', '@id': identity.id, name: identity.name, givenName: identity.givenName,
    familyName: identity.familyName, alternateName: identity.alternateName, url: identity.url, sameAs: identity.sameAs,
    ...(details.jobTitle ? { jobTitle: details.jobTitle } : {}),
    ...(details.description ? { description: details.description } : {}),
    ...(details.email ? { email: `mailto:${details.email}` } : {}),
    ...(details.knowsAbout?.length ? { knowsAbout: details.knowsAbout } : {}),
    ...(image ? { image } : {}),
  };
}

export interface WebSiteInput {
  /** The home page URL; the node's @id is this URL with #website. */
  url: string;
  name: string;
  alternateName?: string | readonly string[] | undefined;
  description?: string | undefined;
  inLanguage?: string | undefined;
  /** Who publishes the site. Default: the owner; null for no publisher. */
  publisher?: PersonRef | null | undefined;
}

/** The home page's WebSite, which Google reads for the site name. Only on the root of a domain or subdomain. */
export function websiteNode(input: WebSiteInput): Node<WebSite> {
  return {
    '@type': 'WebSite', '@id': nodeId(input.url, 'website'), url: input.url, name: input.name,
    ...(input.alternateName ? { alternateName: input.alternateName } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.inLanguage ? { inLanguage: input.inLanguage } : {}),
    ...(input.publisher === null ? {} : { publisher: personReference(input.publisher) }),
  };
}

export interface ProfilePageInput {
  url: string;
  name: string;
  dateCreated?: string | undefined;
  dateModified?: string | undefined;
}

/** cevdet.ch's profile page: its main entity is the owner, and the full Person goes on the same page. */
export function profilePageNode(input: ProfilePageInput): Node<ProfilePage> {
  return {
    '@type': 'ProfilePage', '@id': nodeId(input.url, 'profile'), url: input.url, name: input.name,
    isPartOf: { '@id': nodeId(input.url, 'website') }, mainEntity: { '@id': identity.id },
    ...(input.dateCreated ? { dateCreated: input.dateCreated } : {}),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
  };
}

export interface ArticleInput {
  /** The page's canonical URL. */
  url: string;
  headline: string;
  description?: string | undefined;
  datePublished: string;
  /** Default: datePublished. */
  dateModified?: string | undefined;
  /** Absolute URL of the page's social image. */
  image?: string | undefined;
  inLanguage?: string | undefined;
  /** Default: the owner. */
  author?: PersonRef | undefined;
  /** The site's home page URL, for isPartOf. */
  site?: string | undefined;
  /** Sources a TechArticle cites. */
  citation?: readonly string[] | undefined;
}

type ArticleType = 'Article' | 'BlogPosting' | 'TechArticle';

/** An essay (Article), a post (BlogPosting) or technical documentation (TechArticle). */
export function articleNode(type: ArticleType, input: ArticleInput): Node<Article | BlogPosting | TechArticle> {
  return {
    '@type': type, '@id': nodeId(input.url, 'article'), url: input.url, mainEntityOfPage: input.url,
    headline: input.headline,
    ...(input.description ? { description: input.description } : {}),
    datePublished: input.datePublished, dateModified: input.dateModified ?? input.datePublished,
    ...(input.image ? { image: input.image } : {}),
    ...(input.inLanguage ? { inLanguage: input.inLanguage } : {}),
    author: personReference(input.author),
    ...(input.site ? { isPartOf: { '@id': nodeId(input.site, 'website') } } : {}),
    ...(input.citation?.length ? { citation: input.citation } : {}),
  };
}

export interface CreativeWorkInput {
  url: string;
  name: string;
  description?: string | undefined;
  datePublished?: string | undefined;
  dateModified?: string | undefined;
  inLanguage?: string | undefined;
  /** Default: the owner. Pass a Person for a writer with no site of their own. */
  author?: PersonRef | Node<Person> | undefined;
  /** The site's home page URL, or a node the work belongs to, such as a Book. */
  partOf?: string | Node<CreativeWork> | undefined;
}

/** A poem, a piece of art or any other work that is not an article. */
export function creativeWorkNode(input: CreativeWorkInput): Node<CreativeWork> {
  const author = input.author && '@type' in input.author ? input.author : personReference(input.author);
  const partOf = typeof input.partOf === 'string' ? { '@id': nodeId(input.partOf, 'website') } : input.partOf;
  return {
    '@type': 'CreativeWork', '@id': nodeId(input.url, 'work'), url: input.url, name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.datePublished ? { datePublished: input.datePublished } : {}),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    ...(input.inLanguage ? { inLanguage: input.inLanguage } : {}),
    author,
    ...(partOf ? { isPartOf: partOf } : {}),
  };
}

export interface SoftwareSourceCodeInput {
  /** The page that describes the code; the node's @id is this URL with #code. */
  url: string;
  name: string;
  description?: string | undefined;
  /** Public repository URL. Omit for private source. */
  codeRepository?: string | undefined;
  programmingLanguage?: string | readonly string[] | undefined;
  /** SPDX identifier, e.g. MIT; written as its spdx.org URL. */
  license?: string | undefined;
  /** Where the project lives besides this page: its site, its npm package. */
  sameAs?: readonly string[] | undefined;
  /** Default: the owner; null for no author. */
  author?: PersonRef | null | undefined;
}

/** A project's source code. Descriptive only: Google shows no rich result for it. */
export function softwareSourceCodeNode(input: SoftwareSourceCodeInput): Node<SoftwareSourceCode> {
  return {
    '@type': 'SoftwareSourceCode', '@id': nodeId(input.url, 'code'), url: input.url, mainEntityOfPage: input.url,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.codeRepository ? { codeRepository: input.codeRepository } : {}),
    ...(input.programmingLanguage ? { programmingLanguage: input.programmingLanguage } : {}),
    ...(input.license ? { license: `https://spdx.org/licenses/${input.license}.html` } : {}),
    ...(input.sameAs?.length ? { sameAs: input.sameAs } : {}),
    ...(input.author === null ? {} : { author: personReference(input.author) }),
  };
}

export interface Crumb {
  name: string;
  /** Absolute URL; the last crumb, the current page, may omit it. */
  url?: string | undefined;
}

/** The trail from the home page to the current page, as its visible breadcrumbs show it. */
export function breadcrumbNode(pageUrl: string, crumbs: readonly Crumb[]): Node<BreadcrumbList> {
  return {
    '@type': 'BreadcrumbList', '@id': nodeId(pageUrl, 'breadcrumb'),
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem', position: index + 1, name: crumb.name, ...(crumb.url ? { item: crumb.url } : {}),
    })),
  };
}

/** One page's nodes in a single script element. */
export function graph(...nodes: readonly Node<Thing>[]): Graph {
  return { '@context': 'https://schema.org', '@graph': nodes };
}

/** JSON for a <script type="application/ld+json">; escaping < keeps the text from closing the element. */
export function serializeJsonLd(value: Graph | Node<Thing>): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * True when a site outside cevdet.ch still credits the owner, as a fork of a template does until its config changes.
 * Templates warn at build time so a fork does not publish someone else as its author.
 */
export function creditsOwnerElsewhere(site: string | URL, person: PersonRef | undefined): boolean {
  if (!person || new URL(person.url).href !== identity.url) return false;
  const host = new URL(site).hostname;
  return host !== 'cevdet.ch' && !host.endsWith('.cevdet.ch');
}
