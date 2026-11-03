// Release checks consume manifests as data; historical package code never runs.
import { execFileSync } from 'node:child_process';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

export function validateManifest(value) {
  if (!record(value) || value.schema !== 1) throw new Error('Unsupported byte manifest schema (expected 1)');
  if (!record(value.engines) || ['@napi-rs/image', 'svgo', '@gfx/zopfli'].some((key) =>
    typeof value.engines[key] !== 'string' || !value.engines[key])) throw new Error('Byte manifest is missing encoder identity');
  if (!record(value.profiles) || Object.keys(value.profiles).length === 0) throw new Error('Byte manifest has no build profiles');
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (!/^[a-z0-9-]+$/.test(name) || !record(profile) || !record(profile.options) || !Array.isArray(profile.marks)
      || profile.marks.length === 0 || new Set(profile.marks).size !== profile.marks.length
      || profile.marks.some((mark) => typeof mark !== 'string' || !/^[a-z0-9-]+$/.test(mark))) {
      throw new Error(`Invalid byte manifest profile: ${name}`);
    }
  }
  if (!record(value.files) || Object.keys(value.files).length === 0) throw new Error('Byte manifest has no files');
  for (const [name, file] of Object.entries(value.files)) {
    const [profile, mark] = name.split('/');
    if (!/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9.-]+$/.test(name)
      || !value.profiles[profile]?.marks.includes(mark) || !record(file)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Invalid byte manifest file: ${name}`);
    }
  }
  return value;
}

export function compareManifests(before, after) {
  validateManifest(before); validateManifest(after);
  const engines = [...new Set([...Object.keys(before.engines), ...Object.keys(after.engines)])].sort()
    .filter((key) => before.engines[key] !== after.engines[key])
    .map((name) => ({ name, before: before.engines[name], after: after.engines[name] }));
  const files = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort().flatMap((name) => {
    const old = before.files[name], current = after.files[name];
    if (old && current && old.sha256 === current.sha256 && old.bytes === current.bytes) return [];
    return [{ name, kind: !old ? 'added' : !current ? 'removed' : 'changed', before: old, after: current }];
  });
  return { engines, profiles: stable(before.profiles) !== stable(after.profiles), files };
}

export function formatDifferences(diff) {
  return [
    ...diff.engines.map(({ name, before, after }) => `encoder ${name}: ${before ?? '(absent)'} → ${after ?? '(absent)'}`),
    ...(diff.profiles ? ['Build profiles changed (options or fixtures)'] : []),
    ...diff.files.map(({ name, kind, before, after }) => {
      if (kind === 'added') return `added ${name}: ${after.bytes} B`;
      if (kind === 'removed') return `removed ${name}: ${before.bytes} B`;
      const delta = after.bytes - before.bytes;
      return `changed ${name}: ${before.bytes} → ${after.bytes} B (${delta >= 0 ? '+' : ''}${delta} B), SHA256 ${before.sha256.slice(0, 8)} → ${after.sha256.slice(0, 8)}`;
    }),
  ].join('\n');
}

const number = '(?:0|[1-9]\\d*)';
const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^(${number})\\.(${number})\\.(${number})(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
export function parseVersion(version) {
  const match = typeof version === 'string' && version.match(versionPattern);
  if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}
const compareCore = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

export function checkReleasePolicy({ current, version, previous = null }) {
  validateManifest(current);
  const candidate = parseVersion(version);
  if (!previous) return 'No previous stable release; establishing the first protected byte baseline';
  const prior = parseVersion(previous.version);
  if (prior.prerelease || compareCore(candidate, prior) <= 0) throw new Error(`Release ${version} must advance previous stable ${previous.tag}`);
  const minorOrMajor = candidate.major !== prior.major || candidate.minor !== prior.minor;
  if (previous.manifest === null) {
    if (!minorOrMajor) throw new Error(`Previous release ${previous.tag} has no byte baseline; a patch cannot establish compatibility. Use a minor/major release.`);
    return `Minor/major release ${version} establishes a byte baseline after unprotected ${previous.tag}`;
  }
  const report = formatDifferences(compareManifests(previous.manifest, current));
  if (report && !minorOrMajor) {
    throw new Error(`Patch release ${version} changes protected outputs or encoder/profile identity relative to ${previous.tag}:\n${report}\nUse a minor/major version for reviewed output changes.`);
  }
  return report ? `Minor/major release ${version} accepts reviewed changes since ${previous.tag}:\n${report}`
    : `Protected fixture bytes and encoder/profile identity are unchanged since ${previous.tag}`;
}

export function previousRelease(root, version) {
  parseVersion(version);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('Byte release guard requires full history and tags; this repository is shallow');
  const head = git('rev-parse', 'HEAD');
  const tags = git('tag', '--list', '--merged', 'HEAD').split('\n').flatMap((tag) => {
    if (!tag.startsWith('v')) return [];
    let parsed;
    try { parsed = parseVersion(tag.slice(1)); } catch { return []; }
    if (parsed.prerelease) return [];
    // The release workflow checks out the new tag at HEAD. An older same-version
    // ancestor must remain visible, so a repeated/downgraded version cannot hide it.
    if (tag === `v${version}` && git('rev-parse', `${tag}^{commit}`) === head) return [];
    return [{ tag, version: tag.slice(1), parsed }];
  }).sort((a, b) => compareCore(b.parsed, a.parsed) || a.tag.localeCompare(b.tag));
  if (tags.length === 0) return null;
  const { tag, version: previousVersion } = tags[0];
  const path = 'test/bytes.json';
  const exists = git('ls-tree', '--name-only', tag, '--', path);
  const manifest = exists ? validateManifest(JSON.parse(git('show', `${tag}:${path}`))) : null;
  return { tag, version: previousVersion, manifest };
}
