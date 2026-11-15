// Where the competitors live, and how the adapters load them. They are installed only into
// bench/out/compare/deps/ (gitignored) by `node bench/compare/run.mjs --install`, from the pinned
// package.json and package-lock.json next to this file, never into favseed's own or the site's
// dependencies. Resolving from that directory, rather than by bare specifier, keeps them out of
// the repository's module graph: nothing here can pick up a copy installed anywhere else.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const depsDir = fileURLToPath(new URL('../out/compare/deps/', import.meta.url));
const root = join(depsDir, 'package.json');
/** The deps root's package.json: what resolves the hoisted copies, sharp 0.35.5 among them. */
export const depsManifest = root;

const installed = () => {
  if (!existsSync(join(depsDir, 'node_modules')))
    throw new Error('competitors not installed: run node bench/compare/run.mjs --install');
};

/**
 * The installed package.json of `name`, resolved from `from` (another package.json, for a copy
 * nested under one package) or from the deps root, plus its path.
 */
export const packageJson = (name, from = root) => {
  installed();
  const path = findPackageJSON(name, pathToFileURL(from));
  return { ...JSON.parse(readFileSync(path, 'utf8')), path };
};

/**
 * Import `name` as the ES module its package exports, resolved like packageJson. The `import`
 * condition is preferred: favicons ships both builds, and the require condition would load its
 * CommonJS copy instead of the one an ESM project runs.
 */
export const importDep = (name, from = root) => {
  const pkg = packageJson(name, from);
  const entry = pkg.exports?.['.']?.import;
  const file = entry ? join(dirname(pkg.path), entry) : createRequire(from).resolve(name);
  return import(pathToFileURL(file).href);
};

/** Load `name` through require, resolved like packageJson: sharp is CommonJS. */
export const requireDep = (name, from = root) => {
  installed();
  return createRequire(from)(name);
};

/** Assert the installed version is the pinned one, so a stale install cannot report as current. */
export const pinned = (name, version, from) => {
  const pkg = packageJson(name, from);
  if (pkg.version !== version) throw new Error(`${name} ${pkg.version} installed, ${version} pinned: rerun --install`);
  return pkg;
};
