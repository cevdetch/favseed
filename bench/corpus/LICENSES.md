# Corpus licences

The four Iconify JSON packages this corpus is drawn from, pinned exactly (versions checked on
npm on 2026-11-08). `manifest.json` records the same table, plus one SHA-256 per selected icon.

| prefix | package | version | licence | icons |
|---|---|---|---|---|
| `logos` | `@iconify-json/logos` | 1.2.19 | CC0-1.0 | 30 |
| `simple-icons` | `@iconify-json/simple-icons` | 1.2.101 | CC0-1.0 | 20 |
| `fluent-emoji` | `@iconify-json/fluent-emoji` | 1.2.7 | MIT | 20 |
| `flat-color-icons` | `@iconify-json/flat-color-icons` | 1.2.3 | MIT | 10 |

Only CC0-1.0 and MIT sets are used, per the project's licence policy for this bench-only
corpus. The icons themselves are never committed — only this table, the SHA-256 manifest, and
whatever `node bench/corpus/fetch.mjs` reconstructs under the gitignored `.cache/`.

## CC0-1.0 (`logos`, `simple-icons`)

CC0 1.0 Universal places these works in the public domain: no permission is required and no
attribution is owed, but it is given anyway for clarity. Full text:
<https://creativecommons.org/publicdomain/zero/1.0/legalcode>.

CC0 covers the copyright in the drawings only: it grants no trademark rights in the logos they
depict, which remain their owners' marks.

## MIT (`fluent-emoji`, `flat-color-icons`)

### `fluent-emoji` — Microsoft Corporation

Neither the `@iconify-json/fluent-emoji` tarball nor the `iconify/icon-sets` repository that
publishes it carries a `LICENSE` file; the package's own `package.json` declares `"license":
"MIT"`. The icon set is rebuilt from Microsoft's `fluentui-emoji` repository, whose `LICENSE`
is reproduced verbatim below.

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### `flat-color-icons` — Icons8

Neither the `@iconify-json/flat-color-icons` tarball nor `iconify/icon-sets` carries a
`LICENSE` file either, and the upstream `icons8/flat-Color-icons` repository's own
`LICENSE.md` names a non-standard "Good Boy License" alongside MIT rather than quoting MIT's
text. The npm package's `package.json` nonetheless declares `"license": "MIT"`, which is what
this corpus relies on; the standard MIT text is reproduced below with that attribution.

```
MIT License

Copyright (c) Icons8

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
