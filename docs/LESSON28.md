# Lesson 28 - Swift and Objective-C SBOMs

Apple-platform projects pose two problems for SBOM generation. First, Swift
Package Manager has a manifest (`Package.swift`) and a resolved file
(`Package.resolved`), but the resolved file is only produced after a build or
resolve step. Second, a lot of iOS and macOS apps use CocoaPods or raw Xcode
projects instead of (or alongside) SwiftPM. cdxgen handles both, and this lesson
explains how each path contributes to the BOM.

## Goal

By the end of this lesson you should be able to:

1. Generate an SBOM for a Swift Package Manager project with `cdxgen -t swift`.
2. Produce a dependency tree even when `Package.resolved` is missing.
3. Choose the right project type alias for iOS, macOS, and Objective-C work.
4. Decide when to reach for SourceKitten-backed evidence via `evinse`.

## Learning Objective

Understand the Swift BOM lifecycle: how `createSwiftBom` combines
`Package.resolved` with `swift package show-dependencies`, how Objective-C and
CocoaPods fit in, and what the platform aliases actually select.

## 1) Project type aliases

Swift has the widest set of aliases in `PROJECT_TYPE_ALIASES`
(`lib/core/env.js`):

```
swift: ["swift", "ios", "macos", "swiftpm", "ipados", "tvos", "watchos", "visionos"]
cocoa: ["cocoa", "cocoapods", "objective-c", "swift", "ios"]
```

Every alias in the `swift` group routes to `createSwiftBom` in
`lib/cli/nativeBom.js:1525`. The alias you pass does not change which files are
parsed (the file globs are identical); it exists so you can express intent and so
multi-type scans can target the right toolchain. Use the most specific alias for
your target:

```bash
cdxgen -t ios -o bom.json .        # an iOS app
cdxgen -t macos -o bom.json .      # a macOS app
cdxgen -t swiftpm -o bom.json .    # a pure Swift package
```

For an Objective-C project that uses CocoaPods, use `-t cocoa` (or
`-t objective-c`), which routes to `createCocoaBom` and parses `Podfile` and
`Podfile.lock`.

## 2) Swift Package Manager parsing

`createSwiftBom` looks for two file globs:

- `Package.resolved` (the lockfile), parsed by `parseSwiftResolved`.
- `Package*.swift` (the manifest), which triggers a `swift package
show-dependencies --format json` invocation parsed by `parseSwiftJsonTree`.

### The resolved file

`parseSwiftResolved` accepts both the modern shape (`pins[]` at the top level)
and the older shape (`object.pins[]`). Each pin becomes a component with a
`pkg:swift/<host>/<owner>/<name>@<version>` purl built from the repository URL
and the resolved version (or revision). Every entry carries manifest-analysis
evidence pointing at the resolved file.

### The dependency tree

The resolved file gives you versions but not a tree. To compute the tree, cdxgen
runs the Swift toolchain:

```bash
swift package show-dependencies --format json
```

The resulting JSON is recursive and `parseSwiftJsonTreeObject` walks it. Each
node becomes a component and each `dependencies[]` edge becomes a `dependencies`
entry. Two properties capture Swift-specific nuance:

- `cdx:swift:packageName` when the Swift module name differs from the purl name.
- `cdx:swift:localCheckoutPath` for a dependency resolved from a local
  `SourcePackages/checkouts/...` path, recorded relative to the manifest.

Remote dependencies get a `pkg:swift/...` purl and a `repository.url`. Local
package dependencies (those with a `path` instead of a `url`) get no purl,
because `cdx-purl` requires a host and owner that a relative path cannot supply.
They are emitted as `type: application` components with an `internal:SrcPath`
property.

On macOS, cdxgen detects when `SWIFT_CMD` resolves through `xcrun` and invokes
`xcrun swift package ...` so the active Xcode toolchain is used.

## 3) Generating the resolved file

A fresh checkout often has no `Package.resolved`. When you pass `--deep` (or
trigger the `post-build` lifecycle), the pre-generation step in
`lib/stages/pregen/pregen.js` runs:

```bash
swift package -v resolve
```

for each `Package.swift` it finds, then checks that `Package.resolved` was
created. If the resolve fails, cdxgen prints guidance: build the project
manually first, or check whether a private registry needs to be configured.

You can pass extra arguments to the Swift command through the `SWIFT_PACKAGE_ARGS`
environment variable. They are forwarded to both the resolve and the
show-dependencies invocations, which is how you point at a custom SDK path:

```bash
SWIFT_PACKAGE_ARGS="--swift-sdks-path /opt/swift-sdks" cdxgen -t swift --deep -o bom.json .
```

## 4) Objective-C and Xcode projects

Objective-C sources are not parsed directly. cdxgen relies on the dependency
manifests the build system produces:

- **CocoaPods.** Use `-t cocoa`. `createCocoaBom` parses `Podfile` and
  `Podfile.lock`. If the lock is missing, `--install-deps` will run
  `pod install` for you; with `--deep` it always re-installs to capture the
  latest resolved tree.
- **Xcode projects.** A `.xcodeproj` or `.xcworkspace` that uses SwiftPM produces
  a `Package.resolved`, which `createSwiftBom` picks up via the `**/` glob when
  `--multiProject` is set. Raw Xcode projects without SwiftPM or CocoaPods are
  not a source cdxgen can scan, so export a resolved file first.

For a mixed Swift and Objective-C app, scan with both types in a multi-project
pass so each manifest contributes:

```bash
cdxgen -t swift,cocoa --multiProject --deep -o bom.json .
```

## 5) iOS versus macOS targeting

The platform aliases (`ios`, `macos`, `ipados`, `tvos`, `watchos`, `visionos`)
exist for filtering and intent, not for switching parsers. They all route to
`createSwiftBom`. Where the platform matters is the toolchain: an iOS app built
against an iOS SDK needs the right simulator or device SDK available, and the
`swift package resolve` step will fail without it.

If you are building on Linux (for example in CI without a Mac), pass
`--platform=linux/amd64` when using the cdxgen container image, because Swift
for Linux has known issues on non-x64 hosts. When the Swift command fails on a
non-Mac host, cdxgen suggests either the container image or building from a Mac.

## 6) SourceKitten-backed evidence

Plain `cdxgen -t swift` does not invoke SourceKitten. SourceKitten is used by
the evidence-generation command `evinse`, and only for Swift semantics slicing.

Run it over an existing BOM:

```bash
cdxgen -t swift -o bom.json .
evinse -l swift -i bom.json -o bom.evinse.json .
```

`evinse -l swift` (and `cdxgen -t swift --evidence`) calls
`createSemanticsSlices` in `lib/evinser/swiftsem.js`, which:

- runs `swift -print-target-info` in the project directory to find the
  toolchain that builds it (honouring swiftly's `.swift-version`) and points
  SourceKitten at the same toolchain;
- performs a clean verbose debug build, with either SwiftPM build engine, and
  reads each module's compiler arguments and sources from llbuild's
  `description.json` or the Swift Build driver lines;
- maps modules to packages through `.build/workspace-state.json` (and
  `.build/manifest.pif` for Swift Build);
- runs SourceKitten `index` over every non-test source of the root package with
  that module's own arguments, and attributes each resolved reference to the
  package that declares it by demangling its USR.

Note that Swift only produces **semantics** slices through this path. Unlike
JVM or Python, there is no atom-based usages or data-flow slice for Swift, so
occurrence evidence comes from the SourceKitten-backed semantics slice alone.
Projects that require `xcodebuild` to build (rather than `swift build`) are not
supported by the semantics slicer today.

Packages that only the tests use are scoped `optional`, so
`cdxgen -t swift --evidence --required-only` keeps just the packages the
shipped code needs.

You can override the detected compiler and SDK with `SWIFT_COMPILER_ARGS` and
`SWIFT_SDK_ARGS`, and pass extra build arguments such as
`--build-system native` with `SWIFT_BUILD_ARGS`.

## 7) CI sketch for an iOS app

A realistic iOS pipeline builds first (so `Package.resolved` exists), then
generates the BOM, optionally enriches it:

```yaml
jobs:
  sbom:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - name: Resolve packages
        run: swift package resolve
      - name: Generate SBOM
        run: cdxgen -t ios -o bom.json .
        env:
          FETCH_LICENSE: "true"
      - name: Enrich with SourceKitten evidence
        run: evinse -l swift -i bom.json -o bom.evinse.json .
        continue-on-error: true
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: |
            bom.json
            bom.evinse.json
```

`FETCH_LICENSE=true` triggers `getSwiftPackageMetadata`, which fetches license
and metadata for each resolved package.

## What to take away

1. `cdxgen -t swift` parses `Package.resolved` for versions and runs
   `swift package show-dependencies` for the tree.
2. Without a resolved file, pass `--deep` so the pre-generation step runs
   `swift package resolve` for you.
3. Objective-C needs CocoaPods (`-t cocoa`) or a SwiftPM-resolved Xcode project;
   raw `.xcodeproj` files are not scanned directly.
4. The platform aliases express intent and select the toolchain path; they do not
   change the file globs.
5. SourceKitten is an `evinse` concern (semantics slices only), not a `cdxgen`
   one, and only works for `swift build` projects.
