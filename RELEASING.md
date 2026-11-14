# Releasing

favseed is one package, `favseed`. Registry commands use pnpm, which keeps its own login
(`pnpm login`, checked with `pnpm whoami`); pnpm 12 has `publish`, `stage`, `view` and
`deprecate`. No npm token is ever created for this project (decision 23).

- **1.0.0** is published by hand from a packed tarball: npm lets a package use trusted
  publishing only once it exists.
- **Every later release** starts from a tag. The Release workflow tests, packs, and **stages**
  the tarball on npm through trusted publishing (OIDC, with provenance). Nothing goes live until
  the maintainer approves it with 2FA.

Byte-output changes (a bumped `@napi-rs/image` or SVGO, a rebuilt `lib/zopfli.wasm`, or any
pipeline change) are **minor at minimum**, never patch: downstream users diff these files into git.

Before tagging, run `node test/hashes.mjs --release` in a checkout with full history and
tags (`git fetch --tags --unshallow` if shallow; otherwise `git fetch --tags`). This first
checks generated output against the reviewed `test/bytes.json`, then compares with the
highest stable version tag reachable from HEAD, excluding the candidate tag at HEAD.
The Release workflow fetches full history and runs this guard before packing or staging.

Patch releases must preserve sampled file hashes/sizes and encoder/profile identity,
including SVGO and the bundled Zopfli build. Intentional changes require a minor or major
version, measured size/accuracy review and an explicit `node test/hashes.mjs --write`;
see [Contributing](CONTRIBUTING.md). Updating today's baseline cannot bypass the comparison
with the previous release. The guard covers fixtures and profiles, not every possible input.

With no previous stable tag, the first protected release establishes the baseline.
If an older stable tag exists without a baseline, only a minor/major release may establish
one. Invalid historical baselines and shallow history fail closed. Previous prerelease
tags are ignored; prerelease candidates follow the same rules against the last stable core
version and must advance it. Historical manifests are read as JSON; old package code is
never executed.

## Before 1.0.0: one-time setup

1. **GitHub.** Verify the repository is `cevdetch/favseed`. `package.json`'s `repository` must
   name the repository the workflow runs in, or npm rejects the provenance.

   ```sh
   git remote get-url origin   # git@github.com:cevdetch/favseed.git
   ```

   Wait for CI to pass on `main` before going further.

2. **Cloudflare Pages** (the website, <https://favseed.cevdet.ch>). Create a Pages project
   connected to the repository, no adapter, no deploy workflow:

   | setting | value |
   |---|---|
   | Production branch | `main` |
   | Build command | `pnpm --filter favseed-site build` |
   | Build output directory | `site/dist` |
   | Environment variable | `NODE_VERSION` = `24` |

   pnpm is picked up from `packageManager` in `package.json`. Then **Custom domains → Set up a
   domain**: `favseed.cevdet.ch`. The site writes its own `_headers`.

## 1.0.0

On an up-to-date `main` with a clean working tree and CI green:

1. Check the login and that the name is free:

   ```sh
   pnpm whoami            # your npm user
   pnpm view favseed       # must fail with 404
   ```

2. Date the release in `CHANGELOG.md`: the `## [1.0.0] - YYYY-MM-DD` heading carries the day
   you publish. Commit that on its own.

3. Test and pack. The tarball `npm pack` writes is the file you publish.

   ```sh
   pnpm install
   pnpm test
   npm pack --dry-run     # read the list: bin/, lib/, astro/, README, LICENSE, CHANGELOG only
   npm pack
   ```

4. Try the tarball in an empty directory before it is public:

   ```sh
   cd "$(mktemp -d)" && npm init -y >/dev/null
   npm install /path/to/favseed/favseed-1.0.0.tgz
   npx favseed --version                        # 1.0.0
   npx favseed /path/to/favseed/test/fixtures/general.svg --out out && ls out
   ```

5. Publish it (pnpm asks for 2FA):

   ```sh
   pnpm publish favseed-1.0.0.tgz --access public
   ```

6. Set up trusted publishing for every later release, on npmjs.com, under the package:
   - **Settings → Trusted publishing → GitHub Actions**: repository `cevdetch/favseed`,
     workflow `release.yml`, environment `npm`, publishing mode **stage** (direct publishing
     off).
   - **Settings → Publishing access**: "Require two-factor authentication and disallow
     tokens".

7. Tag and push. The Release workflow runs the full chain, sees 1.0.0 already on npm and skips
   staging, then creates the GitHub Release from the changelog.

   ```sh
   git tag -s v1.0.0 -m v1.0.0
   git push origin v1.0.0
   ```

8. Check: the package on npmjs.com, and in an empty directory `npx favseed@1.0.0 --version`
   prints `1.0.0`.

9. Submit to the [Astro integrations directory](https://astro.build/integrations/): it indexes
   npm packages carrying the `astro-integration` keyword, which `package.json` has.

10. Point the docs at the published package, in one PR:
    - remove the "favseed is not on npm yet" sentences from `README.md` and
      `site/src/content/docs/index.md`;
    - add <https://www.npmjs.com/package/favseed> to the homepage's `SoftwareSourceCode`
      JSON-LD in `site/src/pages/index.astro` and to the links in
      `site/src/pages/llms.txt.ts`.

## Every later release

1. On a branch, set the new version in `package.json`, and move the `## [Unreleased]` entries
   of `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`. Open the release PR
   (`chore: release X.Y.Z`), merge it.
2. From an up-to-date `main`:

   ```sh
   git switch main && git pull --ff-only
   git tag -s vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

3. The Release workflow checks the tag against `package.json`, runs the test suite as CI does
   (the engine from the lockfile, resvg 0.49.0 as the render test's reference), packs, stages
   that exact tarball, and creates the GitHub Release from the changelog section.
4. Approve with 2FA:

   ```sh
   pnpm stage list
   pnpm stage view <stage-id>      # check name, version, file list
   pnpm stage approve <stage-id>
   ```

   `pnpm stage reject <stage-id>` drops a staged package instead.
5. Check the package on npmjs.com (provenance shown, `latest` moved) and run
   `npx favseed@X.Y.Z --version` in an empty directory.

The workflow runs in the GitHub environment `npm`, which the trusted publisher checks. GitHub
creates it on the first run; create it under Settings → Environments only to add protection
rules. Cloudflare Pages builds `main`, so the website follows `main`, not the release tags.
