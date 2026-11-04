// Rebuild only; ordinary site builds use the checked-in, hash-verified artifact.
// Linux x64: node bench/browser-compat/build.mjs IMAGE.tar.gz WASI-SDK.tar.gz [--write]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkPath } from '../path.mjs';

const revision = '7bad478bfe647bca75d4c05db8726ca3d5335e80';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archives = [
  { path: benchmarkPath(process.argv[2]), sha: '9be63180155c7f4fc77caf856dba5d4f75acf4980d8c18fe6b1efedda02ee8aa' },
  { path: benchmarkPath(process.argv[3]), sha: '0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce' },
];
if (process.argv.length > 5 || (process.argv[4] && process.argv[4] !== '--write')) throw new Error('Expected source archive, SDK archive and optional --write');
for (const { path, sha } of archives) if (hash(readFileSync(path)) !== sha) throw new Error(`Archive checksum mismatch: ${path}`);
const rustc = execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim();
if (rustc !== 'rustc 1.99.0 (b940084d7 2026-09-28)') throw new Error('Rebuild requires the reviewed Rust 1.99.0 toolchain');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Rebuild requires Linux x64');
const here = fileURLToPath(new URL('./', import.meta.url));
const destination = fileURLToPath(new URL('../../site/vendor/image-wasm32-wasip1/', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'favseed-image-build.'));
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
try {
  for (const { path } of archives) run('tar', ['-xzf', path, '-C', scratch]);
  const source = join(scratch, `Image-${revision}`), binding = join(source, 'packages/binding');
  const sdk = join(scratch, 'wasi-sdk-33.0-x86_64-linux'), tooling = join(scratch, 'tooling');
  mkdirSync(tooling);
  const lock = JSON.parse(readFileSync(join(here, 'package-lock.json')));
  writeFileSync(join(tooling, 'package.json'), JSON.stringify({ private: true, dependencies: lock.packages[''].dependencies }));
  copyFileSync(join(here, 'package-lock.json'), join(tooling, 'package-lock.json'));
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', tooling]);
  symlinkSync(join(tooling, 'node_modules'), join(source, 'node_modules'));
  copyFileSync(join(here, 'Cargo.lock'), join(source, 'Cargo.lock'));
  const pkg = JSON.parse(readFileSync(join(binding, 'package.json')));
  pkg.napi.wasm.threadlessInitialMemory = 1024;
  writeFileSync(join(binding, 'package.json'), JSON.stringify(pkg, null, 2));
  const flags = `--target=wasm32-wasi --sysroot=${sdk}/share/wasi-sysroot -mllvm -wasm-enable-sjlj -lsetjmp -ffile-prefix-map=${scratch}=/favseed-build -ffile-prefix-map=${cargoHome}=/cargo`;
  const env = { ...process.env, WASI_SDK_PATH: sdk, BINDGEN_EXTRA_CLANG_ARGS: `--sysroot=${sdk}/share/wasi-sysroot`,
    CMAKE_BUILD_PARALLEL_LEVEL: '2', CARGO_BUILD_JOBS: '8', CARGO_TARGET_DIR: join(scratch, 'target'),
    CARGO_NET_OFFLINE: 'true', SOURCE_DATE_EPOCH: '0', TARGET_CFLAGS: flags, TARGET_CXXFLAGS: flags,
    RUSTFLAGS: `-C target-feature=+simd128 -C link-arg=-zstack-size=16777216 --remap-path-prefix=${scratch}=/favseed-build --remap-path-prefix=${cargoHome}=/cargo` };
  // Fetch only the locked Rust inputs, then build with networking disabled.
  run('cargo', ['fetch', '--locked', '--target', 'wasm32-wasip1'], { cwd: source });
  run('node', [join(tooling, 'node_modules/@napi-rs/cli/dist/cli.js'), 'build', '--cwd', binding,
    '--target', 'wasm32-wasip1', '--platform', '--no-const-enum', '--release', '--no-default-features', '--features', 'binding'], { env });
  if (hash(readFileSync(join(source, 'Cargo.lock'))) !== hash(readFileSync(join(here, 'Cargo.lock')))) throw new Error('Build changed the reviewed Cargo.lock');
  const names = ['image.wasip1-browser.js', 'image.wasm32-wasip1.wasm'];
  const artifacts = Object.fromEntries(names.map(name => [name, hash(readFileSync(join(binding, name)))]));
  const manifest = { sourceDateEpoch: 0, imageVersion: '1.15.0', revision, rustc,
    sourceArchiveSha256: archives[0].sha, sdkArchiveSha256: archives[1].sha,
    cargoLockSha256: hash(readFileSync(join(here, 'Cargo.lock'))), toolingLockSha256: hash(readFileSync(join(here, 'package-lock.json'))),
    runtime: { '@emnapi/core': '2.0.0-alpha.5', '@emnapi/runtime': '2.0.0-alpha.5', '@napi-rs/wasm-runtime': '1.2.5' }, artifacts };
  if (process.argv[4] === '--write') {
    mkdirSync(destination, { recursive: true });
    for (const name of names) copyFileSync(join(binding, name), join(destination, name));
    writeFileSync(join(destination, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
    copyFileSync(join(source, 'LICENSE'), join(destination, 'LICENSE'));
    // Include the locked Rust dependencies' notices, including bundled C codecs.
    const tree = execFileSync('cargo', ['tree', '--locked', '--target', 'wasm32-wasip1', '--no-default-features', '--features', 'binding',
      '--edges', 'normal', '--prefix', 'none', '--format', '{p}'], { cwd: source, env, encoding: 'utf8' });
    const registry = join(cargoHome, 'registry/src');
    const roots = readdirSync(registry).map(name => join(registry, name));
    const notices = new Map();
    const collect = (root, label) => {
      const walk = (path, relative = '') => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
          const file = join(path, entry.name), name = join(relative, entry.name);
          if (entry.isDirectory()) walk(file, name);
          else if (/^(?:licen[cs]e|copying|copyright|notice|patents)(?:[._-]|$)/i.test(entry.name)) {
            const bytes = readFileSync(file); if (bytes.includes(0)) continue;
            const text = bytes.toString('utf8'); const key = hash(bytes);
            if (!notices.has(key)) notices.set(key, { labels: [], text });
            notices.get(key).labels.push(`${label}/${name}`);
          }
        }
      }; walk(root);
    };
    const crates = [...new Set([...tree.matchAll(/^([\w-]+) v([\w.+-]+)/gm)].map(([,name,version])=>`${name}-${version}`))].sort();
    for (const crate of crates) {
      const root = roots.map(root=>join(root,crate)).find(existsSync);
      if (root) collect(root, crate);
    }
    for (const name of ['emnapi', '@napi-rs/cli']) {
      const file = join(tooling, 'node_modules', name, 'LICENSE');
      if (existsSync(file)) notices.set(name, { labels: [name+'/LICENSE'], text: readFileSync(file,'utf8') });
    }
    notices.set('wasi-libc', { labels: ['WASI SDK33 libc (see bench/browser-compat/WASI-LICENSE)'], text: readFileSync(join(here, 'WASI-LICENSE'),'utf8') });
    const sysroot = execFileSync('rustc', ['--print','sysroot'], { encoding:'utf8' }).trim();
    for (const name of ['COPYRIGHT-library.html']) {
      const file = join(sysroot,'share/doc/rust',name);
      notices.set(name, { labels:['Rust standard library/'+name],text:readFileSync(file,'utf8') });
    }
    writeFileSync(join(destination, 'THIRD-PARTY-NOTICES.txt'), 'Notices for the vendored image WASM and generated loader. Some dependencies include notices for code not linked into this build.\n\n'+[...notices.values()].map(({labels,text})=>labels.join('\n')+'\n\n'+text).join('\n\n----------------\n\n'));
    console.log('Wrote reviewed candidate', manifest);
  } else {
    for (const name of names) if (hash(readFileSync(join(destination, name))) !== artifacts[name]) throw new Error(`Rebuild differs: ${name}`);
    console.log('Rebuild matches both committed artifacts', artifacts);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
