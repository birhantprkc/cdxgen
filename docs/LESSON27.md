# Lesson 27 - C and C++ SBOMs with Conan, vcpkg, and meson

C and C++ are awkward ecosystems for SBOMs. There is no single lockfile that
describes the world. A project might use Conan, vcpkg, CMake `FetchContent`, git
submodules, meson WrapDB, or just vendor headers straight into the tree. cdxgen
handles all of these in one pass, but it pays to know which inputs it actually
reads and what it does with each.

This lesson walks through generating an SBOM for a C/C++ project, explains the
priority order cdxgen applies, and shows how to read the result.

## Goal

By the end of this lesson you should be able to:

1. Generate an SBOM for any C/C++ project with `cdxgen -t c++`.
2. Predict which files cdxgen will parse and which dependencies end up in the
   BOM.
3. Tell apart resolved dependencies, version requirements, and vendored code.
4. Wire a C/C++ SBOM step into CI.

## Learning Objective

Understand the C/C++ BOM lifecycle in cdxgen: what `createCppBom` reads, how
Conan, vcpkg, meson, and CMake contribute, and how to interpret the resulting
purls and properties.

## 1) The project type and what cdxgen parses

The project type alias is broad on purpose (see `PROJECT_TYPE_ALIASES` in
`lib/core/env.js`):

```
c: ["c", "cpp", "c++", "conan", "collider"]
```

Any of `c`, `cpp`, `c++`, `conan`, or `collider` routes to `createCppBom` in
`lib/cli/nativeBom.js:932`. From one project root, cdxgen looks for all of these
in a single scan:

| File                        | Parser                        | What it contributes                                  |
| --------------------------- | ----------------------------- | ---------------------------------------------------- |
| `conan.lock`                | `parseConanLockData`          | Resolved packages plus a dependency graph            |
| `conanfile.txt`             | `parseConanData`              | Flat requires/build_requires list, with scope        |
| `collider.lock`             | `parseColliderLockData`       | Resolved packages and graph                          |
| `CMakeLists.txt`, `*.cmake` | `parseCmakeLikeFile`          | Parent project, `find_package` requirements          |
| `meson.build`               | `parseCmakeLikeFile`          | Parent project, `dependency()` declarations          |
| `vcpkg.json`                | `getCppModules` (cppEvidence) | Parent project and declared dependencies             |
| `CMakeCache.txt`            | `resolveCmakeContext`         | Resolved versions, FetchContent pins, submodule pins |

There is a deliberate priority: Conan lock files come first because they carry
resolved versions and a real graph. If no lock exists, cdxgen falls back to
`conanfile.txt`. The CMake-like files are parsed afterwards and their entries are
collapsed separately so a `find_package` requirement never overwrites a resolved
Conan version.

Run it:

```bash
cdxgen -t c++ -o bom.json .
```

Use `--deep` to also run include analysis (see step 6).

## 2) Conan support

`parseConanLockData` understands both Conan formats:

- **Conan 1.x** (`graph_lock.nodes`): every node with a `ref` becomes a
  component, and the `requires` / `build_requires` edges become the dependency
  graph. Node `0` is the parent project.
- **Conan 2.x** (`requires` map): each entry becomes a flat component. The
  `%recipe` suffix is stripped before building the purl.

Conan references are converted to `pkg:conan/...` purls. From a lockfile you get
versions and a tree:

```bash
jq '.components[] | select(.purl | startswith("pkg:conan")) | {name, version, purl}' bom.json
```

When only `conanfile.txt` is present, `parseConanData` reads the `[requires]`
and `[build_requires]` sections. The scope is set accordingly:

- `[requires]` -> `scope: required`
- `[build_requires]` -> `scope: optional`

This is a flat list with no graph, because `conanfile.txt` does not encode one.

Note that `conanfile.py` is not parsed directly. If your project uses the Python
form, export a `conan.lock` first (`conan lock create`) so cdxgen can read
resolved coordinates.

## 3) vcpkg support

cdxgen reads the vcpkg manifest, `vcpkg.json`, inside `getCppModules`
(`lib/ecosystems/cppEvidence.js`). When present it is treated as a strong hint
about the parent project and its direct dependencies:

- The manifest `name` and `version` become the parent component.
- Each entry in `dependencies[]` becomes a `generic` component. String entries
  and object entries with a `name` are both accepted. A dependency that declares
  `host: true` is tagged `scope: optional`.

What cdxgen does **not** read is the vcpkg installed tree. There is no parsing
of `vcpkg.lock` or `vcpkg_installed/vcpkg/status`. The manifest is the source of
truth, so it is accurate for declared dependencies but carries no resolved
version. If you need resolved versions, prefer a Conan lock or let the include
analysis in step 6 resolve names against OS packages.

List the vcpkg-sourced components:

```bash
jq '.components[] | select(.evidence.identity.methods[0].value | endswith("vcpkg.json")) | .name' bom.json
```

## 4) Meson and the WrapDB

`meson.build` is parsed by the same `parseCmakeLikeFile` routine that handles
CMake. For meson it specifically recognises:

- `project(name, version: ...)` for the parent component.
- `dependency('foo', version: '...')` declarations. A `>=`/`<=` string is
  recorded as a version specifier; a plain number becomes the version.

Meson dependencies often arrive under a local name that differs from the
upstream package. cdxgen improves confidence here by consulting the bundled
Meson WrapDB (`data/wrapdb-releases.json`, loaded as `mesonWrapDB`). When a
scraped name matches a `PkgProvides` entry, the component is renamed to its
canonical WrapDB name and the wrap's properties are attached. Confidence rises
from 0 to 0.5 because the name and URL are now known.

## 5) CMake: cache resolution and FetchContent

`CMakeLists.txt` scraping gives you `find_package` names and version
requirements, but not resolved versions. To resolve them, cdxgen reads the build
tree through `resolveCmakeContext` in `lib/ecosystems/cmakeResolver.js`. It looks
for `CMakeCache.txt` under `build/`, `out/`, or `cmake-build-*/`, or at an
explicit path you pass with `--cmake-cache`.

From the cache and surrounding files it recovers:

- **Resolved versions** for `find_package` entries, recorded with the property
  `cdx:cmake:resolvedVia=cmake-cache`.
- **FetchContent dependencies**, by reading the generated
  `<name>-populate-gitclone.cmake` script for the `GIT_REPOSITORY` and `GIT_TAG`.
  These become components tagged `cdx:cmake:depKind=fetch` and
  `cdx:cmake:resolvedVia=gitclone-script`.
- **Git submodules**, via `git submodule status --recursive` combined with
  `.gitmodules`. These become components tagged
  `cdx:cmake:depKind=submodule`. An uninitialised submodule is flagged with
  `cdx:cmake:uninitialised=true`, which is the normal case for shallow CI
  clones; the version degrades to the commit SHA.

Without a build tree, the dependencies a project downloads at configure time are
read from the CMake files themselves: `FetchContent_Declare`,
`ExternalProject_Add` and the CPM.cmake `CPMAddPackage` family (shorthand and
keyword forms). A git repository becomes a `pkg:github` purl (or `pkg:generic`
with a `vcs_url`) at its `GIT_TAG`; a GitHub archive URL becomes a `pkg:github`
purl at the ref it names; any other URL becomes a `pkg:generic` purl with a
`download_url` (user information and query strings removed), and `URL_HASH` a
hash. These components are tagged `cdx:cmake:depKind` = `fetch`,
`external-project` or `cpm` and `cdx:cmake:resolvedVia=cmake-lists`. When the
build tree resolves the same dependency, the gitclone entry replaces the
declared one, and a `find_package` of a fetched name does not add a second
component. CMake command names are matched in any case (`FIND_PACKAGE`,
`PROJECT`).

When several `CMakeLists.txt` files request different versions of the same
package (`find_package(Boost 1.54)` in one, `find_package(Boost 1.64)` in
another), `collapseCmakeVersions` keeps one entry at the highest version and
records the full set under `cdx:cmake:versionRequirements`.

Inspect the CMake-resolved dependencies:

```bash
jq '.components[] | select(.purl | startswith("pkg:github")) | {name, version,
  depKind: (.properties[] | select(.name=="cdx:cmake:depKind") | .value)}' bom.json
```

## 6) Vendored libraries and build-vs-runtime scope

C/C++ projects routinely vendor third-party code as headers or static archives.
cdxgen addresses this in two ways:

1. **CMake context boundaries.** FetchContent and submodule entries are
   distinguished from plain `find_package` requirements by the `cdx:cmake:depKind`
   property. A submodule pinned to a commit SHA is a real, checked-out thing; a
   `find_package` line is a version requirement the build may or may not satisfy.
2. **Include analysis with atom.** When you pass `--deep` (and the project is not
   a container/OS scan), `getCppModules` invokes the `atom` companion helper to
   produce C usage slices. Every `#include` is resolved to a file, mapped to an
   OS package when possible, and otherwise emitted as a `generic` component with
   a `Filename` identity method. Imported symbols are recorded under
   `internal:ImportedSymbols`.

This step uses the atom companion — a native binary on most platforms, needing
Java 23+ only on the jar-based darwin-amd64, windows-arm64, and linux-arm64-musl
triples — which is why it is gated behind `--deep` and skipped entirely for
container and OS scans.

## 7) CI sketch

C/C++ benefits from building first, so the CMake cache and FetchContent scripts
exist for cdxgen to read:

```yaml
jobs:
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - name: Configure build
        run: cmake -S . -B build
      - name: Generate SBOM
        run: cdxgen -t c++ -o bom.json --deep .
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: bom.json
```

Checking out submodules recursively avoids the uninitialised-pinned-to-SHA case,
and a configured build tree lets cdxgen resolve real versions instead of
emitting requirements.

## What to take away

1. `cdxgen -t c++` scans for Conan, vcpkg, meson, CMake, and collider inputs in
   one pass, in that priority order.
2. Lock files (`conan.lock`, `collider.lock`) give resolved versions and a graph;
   manifest files (`conanfile.txt`, `vcpkg.json`, `CMakeLists.txt`,
   `meson.build`) give declared dependencies and requirements.
3. vcpkg support reads `vcpkg.json` only, not the installed tree.
4. CMake cache resolution turns `find_package` requirements into resolved
   components and separately captures FetchContent and submodule pins.
5. `--deep` adds include analysis via atom, which is how vendored headers and
   static libraries get represented.
