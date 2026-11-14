// Rebuild only; ordinary site builds use the checked-in, hash-verified artifacts.
// Linux x64: node bench/wasm-engine/build.mjs IMAGE.tar.gz WASI-SDK.tar.gz [--write]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkPath } from '../path.mjs';
import { compareEngines, loadImage } from './parity.mjs';

const revision = 'a57319b7506405d991696459830f1a0e60cc88bf';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const defaultCargoHome = join(homedir(), '.cargo');
// Cargo's standard home is trusted; custom homes obey the same physical path
// boundary as archive inputs. Validate before archive reads or tool execution.
const cargoHome =
  !process.env.CARGO_HOME || resolve(process.env.CARGO_HOME) === defaultCargoHome
    ? defaultCargoHome
    : benchmarkPath(process.env.CARGO_HOME);
const archives = [
  { path: benchmarkPath(process.argv[2]), sha: '40489c6d73249797aa8efb0ff029b94c8ec269b33c8f72ff759714f611e608e1' },
  { path: benchmarkPath(process.argv[3]), sha: '0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce' },
];
if (process.argv.length > 5 || (process.argv[4] && process.argv[4] !== '--write'))
  throw new Error('Expected source archive, SDK archive and optional --write');
for (const { path, sha } of archives)
  if (hash(readFileSync(path)) !== sha) throw new Error(`Archive checksum mismatch: ${path}`);
const rustc = execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim();
if (rustc !== 'rustc 1.99.0 (b940084d7 2026-09-28)')
  throw new Error('Rebuild requires the reviewed Rust 1.99.0 toolchain');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Rebuild requires Linux x64');
const here = fileURLToPath(new URL('./', import.meta.url));
const destination = fileURLToPath(new URL('../../site/vendor/image/', import.meta.url));

// Both loaders start at 1024 pages (64 MiB) of growable memory. A module whose link-time floor
// (static data plus the 16 MiB stack) exceeds that would fail to instantiate, so the build reads
// each module's memory import rather than trusting the setting. The image 1.16.0 engines import
// 993 (threaded) and 992 (compatibility) pages; the published threaded 1.16.0 module imports 1012.
const initialPages = 1024;
// One engine per mode. The threaded one is built as upstream's CI builds it (default features, so
// oxipng's `parallel` is on); the compatibility one has no threads, so it drops oxipng's
// `parallel` with the default features and keeps `binding`.
const engines = [
  {
    name: 'threaded',
    target: 'wasm32-wasip1-threads',
    cflags: '--target=wasm32-wasi-threads -pthread',
    features: [],
    loader: 'image.wasi.cjs',
    files: ['image.wasi-browser.js', 'wasi-worker-browser.mjs', 'image.wasm32-wasi.wasm'],
    node: ['wasi-worker.mjs'],
  },
  {
    name: 'compatibility',
    target: 'wasm32-wasip1',
    cflags: '--target=wasm32-wasi',
    features: ['--no-default-features', '--features', 'binding'],
    loader: 'image.wasip1.cjs',
    files: ['image.wasip1-browser.js', 'image.wasm32-wasip1.wasm'],
    node: [],
  },
];

// The minimum page count of a module's imported memory, from its import section. The JS API
// lists imports without their limits, so this reads the binary.
const importedMemoryPages = (bytes) => {
  let at = 8;
  const leb = () => {
    let value = 0,
      shift = 0,
      byte;
    do {
      byte = bytes[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const skipName = () => {
    const length = leb();
    at += length;
  };
  const skipLimits = () => {
    const flags = bytes[at++];
    leb();
    if (flags & 1) leb();
  };
  while (at < bytes.length) {
    const id = bytes[at++],
      size = leb(),
      end = at + size;
    if (id === 2) {
      for (let count = leb(); count > 0; count--) {
        skipName();
        skipName();
        const kind = bytes[at++];
        if (kind === 2) {
          at++;
          return leb();
        }
        if (kind === 0) leb();
        else if (kind === 1) {
          at++;
          skipLimits();
        } else if (kind === 3) at += 2;
        else if (kind === 4) {
          at++;
          leb();
        } else throw new Error(`Unknown import kind ${kind}`);
      }
    }
    at = end;
  }
  throw new Error('Module imports no memory');
};

const scratch = mkdtempSync(join(tmpdir(), 'favseed-image-build.'));
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
try {
  for (const { path } of archives) run('tar', ['-xzf', path, '-C', scratch]);
  const source = join(scratch, `Image-${revision}`),
    binding = join(source, 'packages/binding');
  const sdk = join(scratch, 'wasi-sdk-33.0-x86_64-linux'),
    tooling = join(scratch, 'tooling');
  // The threaded target links against the threads sysroot specifically, not the plain one the
  // compatibility target uses; an SDK archive built without wasm32-wasip1-threads support fails
  // deep inside the link step with an unrelated-looking error, so check for it up front instead.
  const threadsSysroot = join(sdk, 'share/wasi-sysroot/lib/wasm32-wasip1-threads');
  if (!existsSync(threadsSysroot))
    throw new Error(`WASI SDK archive has no threads sysroot at ${threadsSysroot}; need wasi-sdk 33 or later`);
  // Leave out the codecs favseed never calls (AVIF, WebP encoding, lossless JPEG, JPEG XL); every
  // export stays and rejects. No fuzz, so an upstream change under a hunk stops the build.
  const patch = join(here, 'slim.patch');
  run('patch', ['-p1', '--forward', '--fuzz=0', '--no-backup-if-mismatch', '-i', patch], { cwd: binding });
  mkdirSync(tooling);
  const lock = JSON.parse(readFileSync(join(here, 'package-lock.json')));
  writeFileSync(
    join(tooling, 'package.json'),
    JSON.stringify({ private: true, dependencies: lock.packages[''].dependencies }),
  );
  copyFileSync(join(here, 'package-lock.json'), join(tooling, 'package-lock.json'));
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', tooling]);
  symlinkSync(join(tooling, 'node_modules'), join(source, 'node_modules'));
  // The loaders' runtime is what the tooling lock installed, so the manifest cannot drift from it.
  const runtime = Object.fromEntries(
    ['@emnapi/core', '@emnapi/runtime', '@napi-rs/wasm-runtime'].map((name) => [
      name,
      lock.packages[`node_modules/${name}`].version,
    ]),
  );
  // emnapi's link-time library and its JS runtime are released together and must match.
  const emnapi = lock.packages['node_modules/emnapi'].version;
  if (runtime['@emnapi/core'] !== emnapi || runtime['@emnapi/runtime'] !== emnapi)
    throw new Error(`Tooling lock pairs emnapi ${emnapi} with a different @emnapi runtime`);
  copyFileSync(join(here, 'Cargo.lock'), join(source, 'Cargo.lock'));
  const pkg = JSON.parse(readFileSync(join(binding, 'package.json')));
  pkg.napi.wasm.threadlessInitialMemory = initialPages;
  pkg.napi.wasm.initialMemory = initialPages;
  writeFileSync(join(binding, 'package.json'), JSON.stringify(pkg, null, 2));
  const prefixMaps = `-ffile-prefix-map=${scratch}=/favseed-build -ffile-prefix-map=${cargoHome}=/cargo`;
  const env = {
    ...process.env,
    CARGO_HOME: cargoHome,
    WASI_SDK_PATH: sdk,
    BINDGEN_EXTRA_CLANG_ARGS: `--sysroot=${sdk}/share/wasi-sysroot`,
    CMAKE_BUILD_PARALLEL_LEVEL: '2',
    CARGO_BUILD_JOBS: '8',
    CARGO_TARGET_DIR: join(scratch, 'target'),
    CARGO_NET_OFFLINE: 'true',
    SOURCE_DATE_EPOCH: '0',
    RUSTFLAGS: `-C target-feature=+simd128 -C link-arg=-zstack-size=16777216 --remap-path-prefix=${scratch}=/favseed-build --remap-path-prefix=${cargoHome}=/cargo`,
  };
  // Fetch only the locked Rust inputs, then build with networking disabled.
  for (const { target } of engines)
    run('cargo', ['fetch', '--locked', '--target', target], {
      cwd: source,
      env: { ...process.env, CARGO_HOME: cargoHome },
    });
  const pages = {};
  for (const engine of engines) {
    const flags = `${engine.cflags} --sysroot=${sdk}/share/wasi-sysroot -mllvm -wasm-enable-sjlj -lsetjmp ${prefixMaps}`;
    run(
      'node',
      [
        join(tooling, 'node_modules/@napi-rs/cli/dist/cli.js'),
        'build',
        '--cwd',
        binding,
        '--target',
        engine.target,
        '--platform',
        '--no-const-enum',
        '--release',
        ...engine.features,
      ],
      { env: { ...env, TARGET_CFLAGS: flags, TARGET_CXXFLAGS: flags } },
    );
    // Each build removes the other WASI flavour's outputs from the package directory, so every
    // engine moves to its own directory inside the source tree, where its Node loader still
    // resolves the tooling runtime.
    engine.dir = join(source, 'engines', engine.name);
    mkdirSync(engine.dir, { recursive: true });
    for (const name of [...engine.files, engine.loader, ...engine.node])
      copyFileSync(join(binding, name), join(engine.dir, name));
    const wasm = engine.files.find((name) => name.endsWith('.wasm'));
    pages[engine.name] = importedMemoryPages(readFileSync(join(engine.dir, wasm)));
    if (pages[engine.name] > initialPages)
      throw new Error(`${wasm} needs ${pages[engine.name]} pages, more than the loader's ${initialPages}`);
  }
  console.log('Minimum memory pages imported', pages);
  if (hash(readFileSync(join(source, 'Cargo.lock'))) !== hash(readFileSync(join(here, 'Cargo.lock'))))
    throw new Error('Build changed the reviewed Cargo.lock');
  // Nothing is written or accepted unless both engines reproduce the native module byte for byte.
  const native = loadImage();
  for (const engine of engines) {
    const { total, mismatches, skipped, hostDependent } = await compareEngines(
      native,
      loadImage(join(engine.dir, engine.loader)),
    );
    // total === 0 would mean every fixture was skipped or host-dependent, so the gate compared
    // nothing and could not have caught a real divergence; skipped > 0 means native itself
    // rejected a fixture parity expected it to render, which is a broken comparison, not a pass.
    if (total === 0) throw new Error(`${engine.name}: parity compared nothing; every fixture was skipped`);
    if (skipped) throw new Error(`${engine.name}: native rejected ${skipped} non-host-dependent fixture(s)`);
    console.log(
      `${engine.name}: ${total - mismatches.length} of ${total} identical` +
        (hostDependent ? `; host-dependent, skipped: ${hostDependent}` : ''),
    );
    if (mismatches.length)
      throw new Error(
        `${engine.name} differs from native:\n` +
          mismatches
            .slice(0, 10)
            .map(({ case: label, nativeSha, wasmSha }) => `  ${label}: native ${nativeSha} != wasm ${wasmSha}`)
            .join('\n'),
      );
  }
  const shipped = engines.flatMap((engine) => engine.files.map((name) => ({ name, path: join(engine.dir, name) })));
  const artifacts = Object.fromEntries(shipped.map(({ name, path }) => [name, hash(readFileSync(path))]));
  const manifest = {
    sourceDateEpoch: 0,
    imageVersion: pkg.version,
    revision,
    rustc,
    sourceArchiveSha256: archives[0].sha,
    sdkArchiveSha256: archives[1].sha,
    cargoLockSha256: hash(readFileSync(join(here, 'Cargo.lock'))),
    toolingLockSha256: hash(readFileSync(join(here, 'package-lock.json'))),
    patchSha256: hash(readFileSync(patch)),
    runtime,
    artifacts,
  };
  if (process.argv[4] === '--write') {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    for (const { name, path } of shipped) copyFileSync(path, join(destination, name));
    writeFileSync(join(destination, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
    copyFileSync(join(source, 'LICENSE'), join(destination, 'LICENSE'));
    // Include the locked Rust dependencies' notices for both engines' targets and features.
    const crates = new Set();
    for (const { target, features } of engines) {
      const tree = execFileSync(
        'cargo',
        [
          'tree',
          '--locked',
          '--target',
          target,
          ...features,
          '--edges',
          'normal',
          '--prefix',
          'none',
          '--format',
          '{p}',
        ],
        { cwd: source, env, encoding: 'utf8' },
      );
      for (const [, name, version] of tree.matchAll(/^([\w-]+) v([\w.+-]+)/gm)) crates.add(`${name}-${version}`);
    }
    const registry = join(cargoHome, 'registry/src');
    const roots = readdirSync(registry).map((name) => join(registry, name));
    const notices = new Map();
    const collect = (root, label) => {
      const walk = (path, relative = '') => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
          const file = join(path, entry.name),
            name = join(relative, entry.name);
          if (entry.isDirectory()) walk(file, name);
          else if (/^(?:licen[cs]e|copying|copyright|notice|patents)(?:[._-]|$)/i.test(entry.name)) {
            const bytes = readFileSync(file);
            if (bytes.includes(0)) continue;
            const text = bytes.toString('utf8');
            const key = hash(bytes);
            if (!notices.has(key)) notices.set(key, { labels: [], text });
            notices.get(key).labels.push(`${label}/${name}`);
          }
        }
      };
      walk(root);
    };
    for (const crate of [...crates].toSorted()) {
      const root = roots.map((root) => join(root, crate)).find(existsSync);
      if (root) collect(root, crate);
    }
    for (const name of ['emnapi', '@napi-rs/cli']) {
      const file = join(tooling, 'node_modules', name, 'LICENSE');
      if (existsSync(file)) notices.set(name, { labels: [name + '/LICENSE'], text: readFileSync(file, 'utf8') });
    }
    notices.set('wasi-libc', {
      labels: ['WASI SDK33 libc (see bench/wasm-engine/WASI-LICENSE)'],
      text: readFileSync(join(here, 'WASI-LICENSE'), 'utf8'),
    });
    const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
    for (const name of ['COPYRIGHT-library.html']) {
      const file = join(sysroot, 'share/doc/rust', name);
      notices.set(name, { labels: ['Rust standard library/' + name], text: readFileSync(file, 'utf8') });
    }
    writeFileSync(
      join(destination, 'THIRD-PARTY-NOTICES.txt'),
      'Notices for the vendored image WASM engines and generated loaders. Some dependencies include notices for code not linked into this build.\n\n' +
        [...notices.values()]
          .map(({ labels, text }) => labels.join('\n') + '\n\n' + text)
          .join('\n\n----------------\n\n'),
    );
    console.log('Wrote reviewed engines', manifest);
  } else {
    const committed = JSON.parse(readFileSync(join(destination, 'build.json')));
    for (const { name } of shipped)
      if (
        committed.artifacts[name] !== artifacts[name] ||
        hash(readFileSync(join(destination, name))) !== artifacts[name]
      )
        throw new Error(`Rebuild differs: ${name}`);
    for (const key of Object.keys(manifest))
      if (JSON.stringify(committed[key]) !== JSON.stringify(manifest[key]))
        throw new Error(`Rebuild inputs differ from build.json: ${key}`);
    console.log('Rebuild matches every committed artifact', artifacts);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
