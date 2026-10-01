import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import esmock from "esmock";
import { assert, it } from "poku";

import { dirNameStr } from "../core/paths.js";
import {
  ATOM_NATIVE_PACKAGES,
  atomMaxHeapBytes,
  atomProviderKind,
  atomRunTimedOut,
  atomTimeouts,
  buildAtomCommandEnv,
  executeAtom,
  filterAtomSlicesByExcludePatterns,
  getAtomCommand,
  globPatternsToAtomIgnoreRegex,
  isPathExcludedByGlobPatterns,
  resolveAtomProvider,
} from "./atomUtils.js";

it("converts cdxgen exclude globs to Scala-compatible regex", () => {
  const atomRegex = globPatternsToAtomIgnoreRegex([
    "**/*.spec.js",
    "src/**/fixtures/*.{js,ts}",
    "test/[!a-c]?.jsx",
    "packages/@(api|web)/**/*.test.ts",
  ]);
  const regex = new RegExp(atomRegex);
  assert.ok(regex.test("example.spec.js"));
  assert.ok(regex.test("src/example.spec.js"));
  assert.ok(regex.test("src\\example.spec.js"));
  assert.ok(regex.test("src/app/fixtures/demo.ts"));
  assert.ok(regex.test("test/z1.jsx"));
  assert.ok(regex.test("packages/api/src/foo.test.ts"));
  assert.ok(regex.test("packages/web/foo.test.ts"));
  assert.ok(!regex.test("src/app/fixtures/demo.py"));
  assert.ok(!regex.test("test/a1.jsx"));
  assert.ok(!regex.test("packages/mobile/foo.test.ts"));
  assert.ok(!regex.test("src/example.spec.jsx"));
});

it("treats escaped glob wildcards as literal characters", () => {
  const atomRegex = globPatternsToAtomIgnoreRegex(["src/escaped/\\*.js"]);
  const regex = new RegExp(atomRegex);
  assert.ok(regex.test("src/escaped/*.js"));
  assert.ok(!regex.test("src/escaped/index.js"));
});

it("matches paths against cdxgen exclude globs", () => {
  const patterns = ["**/*.spec.js", "src/generated/**"];
  assert.ok(isPathExcludedByGlobPatterns("src/foo.spec.js", patterns));
  assert.ok(isPathExcludedByGlobPatterns("src/generated/client.js", patterns));
  assert.ok(isPathExcludedByGlobPatterns("src\\foo.spec.js", patterns));
  assert.ok(!isPathExcludedByGlobPatterns("src/foo.test.js", patterns));
  assert.ok(!isPathExcludedByGlobPatterns("src/manual/client.js", patterns));
});

it("builds global Atom and JavaScript astgen exclude environment", () => {
  const originalAstgenIgnoreDirs = process.env.ASTGEN_IGNORE_DIRS;
  const originalAstgenIgnoreFilePattern =
    process.env.ASTGEN_IGNORE_FILE_PATTERN;
  const originalChenIgnoreDirs = process.env.CHEN_IGNORE_DIRS;
  try {
    delete process.env.ASTGEN_IGNORE_DIRS;
    delete process.env.ASTGEN_IGNORE_FILE_PATTERN;
    process.env.CHEN_IGNORE_DIRS = "vendor";
    const options = {
      exclude: [
        "**/ignored/**",
        "src/generated/**",
        "**/*.spec.js",
        "noxfile.py",
      ],
    };
    const env = buildAtomCommandEnv(options, "javascript");
    const chenIgnoreDirs = env.CHEN_IGNORE_DIRS.split(",");
    const astgenIgnoreDirs = env.ASTGEN_IGNORE_DIRS.split(",");
    assert.deepStrictEqual(Object.keys(env).sort(), [
      "ASTGEN_IGNORE_DIRS",
      "ASTGEN_IGNORE_FILE_PATTERN",
      "CHEN_IGNORE_DIRS",
    ]);
    assert.ok(chenIgnoreDirs.includes("vendor"));
    assert.ok(chenIgnoreDirs.includes("ignored"));
    assert.ok(chenIgnoreDirs.includes("generated"));
    assert.ok(chenIgnoreDirs.includes("noxfile.py"));
    assert.ok(!chenIgnoreDirs.includes("src"));
    assert.ok(astgenIgnoreDirs.includes("node_modules"));
    assert.ok(astgenIgnoreDirs.includes("ignored"));
    assert.ok(astgenIgnoreDirs.includes("generated"));
    assert.ok(!astgenIgnoreDirs.includes("noxfile.py"));
    assert.ok(!astgenIgnoreDirs.includes("src"));
    assert.ok(
      new RegExp(env.ASTGEN_IGNORE_FILE_PATTERN).test("src/foo.spec.js"),
    );

    const pythonEnv = buildAtomCommandEnv(options, "python");
    assert.deepStrictEqual(Object.keys(pythonEnv).sort(), ["CHEN_IGNORE_DIRS"]);
  } finally {
    if (originalAstgenIgnoreDirs === undefined) {
      delete process.env.ASTGEN_IGNORE_DIRS;
    } else {
      process.env.ASTGEN_IGNORE_DIRS = originalAstgenIgnoreDirs;
    }
    if (originalAstgenIgnoreFilePattern === undefined) {
      delete process.env.ASTGEN_IGNORE_FILE_PATTERN;
    } else {
      process.env.ASTGEN_IGNORE_FILE_PATTERN = originalAstgenIgnoreFilePattern;
    }
    if (originalChenIgnoreDirs === undefined) {
      delete process.env.CHEN_IGNORE_DIRS;
    } else {
      process.env.CHEN_IGNORE_DIRS = originalChenIgnoreDirs;
    }
  }
});

it("filters Atom slices using exclude globs", () => {
  const sliceData = {
    objectSlices: [
      { fileName: "src/index.js", fullName: "src/index.js::program" },
      { fileName: "src/index.spec.js", fullName: "src/index.spec.js::program" },
    ],
    userDefinedTypes: [
      { fileName: "src/generated/client.js", name: "GeneratedClient" },
      { fileName: "src/model.js", name: "Model" },
    ],
    reachables: [
      { flows: [{ parentFileName: "src/index.js" }] },
      { flows: [{ parentFileName: "src/index.spec.js" }] },
    ],
  };
  const filtered = filterAtomSlicesByExcludePatterns(sliceData, [
    "**/*.spec.js",
    "src/generated/**",
  ]);
  assert.deepStrictEqual(
    filtered.objectSlices.map((slice) => slice.fileName),
    ["src/index.js"],
  );
  assert.deepStrictEqual(
    filtered.userDefinedTypes.map((slice) => slice.fileName),
    ["src/model.js"],
  );
  assert.strictEqual(filtered.reachables.length, 1);
});

it("resolves the atom provider kind for all eight published platform triples", () => {
  // Every (os, arch, libc) triple atom publishes a sub-package for, with the
  // kind atom assigns it. This is the parity surface against atom's own
  // NATIVE_PACKAGES set in @appthreat/atom/resolve.js.
  const cases = [
    {
      platform: "win32",
      arch: "x64",
      expectedPkg: "@appthreat/atom-windows-amd64",
      expectedKind: "native",
    },
    {
      platform: "win32",
      arch: "arm64",
      expectedPkg: "@appthreat/atom-windows-arm64",
      expectedKind: "jar",
    },
    {
      platform: "darwin",
      arch: "arm64",
      expectedPkg: "@appthreat/atom-darwin-arm64",
      expectedKind: "native",
    },
    {
      platform: "darwin",
      arch: "x64",
      expectedPkg: "@appthreat/atom-darwin-amd64",
      expectedKind: "jar",
    },
    {
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      expectedPkg: "@appthreat/atom-linux-amd64",
      expectedKind: "native",
    },
    {
      platform: "linux",
      arch: "x64",
      libc: "musl",
      expectedPkg: "@appthreat/atom-linux-amd64-musl",
      expectedKind: "native",
    },
    {
      platform: "linux",
      arch: "arm64",
      libc: "glibc",
      expectedPkg: "@appthreat/atom-linux-arm64",
      expectedKind: "native",
    },
    {
      platform: "linux",
      arch: "arm64",
      libc: "musl",
      expectedPkg: "@appthreat/atom-linux-arm64-musl",
      expectedKind: "jar",
    },
  ];
  for (const c of cases) {
    const resolved = resolveAtomProvider(c);
    assert.strictEqual(
      resolved.preferredPkg,
      c.expectedPkg,
      `pkg for ${c.platform}/${c.arch}/${c.libc || ""}`,
    );
    assert.strictEqual(
      resolved.kind,
      c.expectedKind,
      `kind for ${c.platform}/${c.arch}/${c.libc || ""}`,
    );
    assert.strictEqual(
      ATOM_NATIVE_PACKAGES.has(resolved.preferredPkg),
      resolved.kind === "native",
      `NATIVE_PACKAGES membership mismatch for ${resolved.preferredPkg}`,
    );
  }
});

it("agrees with atom's own resolver for every platform triple", async () => {
  // The drift guard. The assertions above only compare cdxgen's table against
  // itself; this one compares it against @appthreat/atom's resolve.js, which is
  // the thing that actually decides which payload is loaded at runtime. atom is
  // an optional dependency, so skip rather than fail when it is absent.
  // atom's package.json declares `"exports": "./index.js"` (a bare string), so
  // the `@appthreat/atom/resolve.js` subpath is not importable by specifier.
  // Load it by path instead.
  const resolveJs = join(
    dirNameStr,
    "node_modules",
    "@appthreat",
    "atom",
    "resolve.js",
  );
  if (!existsSync(resolveJs)) {
    console.log(
      "@appthreat/atom not installed; skipping resolver parity test.",
    );
    return;
  }
  const atomResolve = await import(pathToFileURL(resolveJs).href);
  const triples = [
    { platform: "win32", arch: "x64" },
    { platform: "win32", arch: "arm64" },
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "x64", libc: "glibc" },
    { platform: "linux", arch: "x64", libc: "musl" },
    { platform: "linux", arch: "arm64", libc: "glibc" },
    { platform: "linux", arch: "arm64", libc: "musl" },
    { platform: "freebsd", arch: "x64" },
  ];
  for (const triple of triples) {
    const ours = resolveAtomProvider(triple);
    const theirs = atomResolve.resolveAtomProvider(triple);
    const label = `${triple.platform}/${triple.arch}/${triple.libc || ""}`;
    assert.strictEqual(
      ours.preferredPkg,
      theirs.preferredPkg,
      `package disagrees with atom for ${label}`,
    );
    assert.strictEqual(
      ours.kind,
      theirs.kind,
      `kind disagrees with atom for ${label}`,
    );
  }
});

it("falls back to the jar package for an unmapped triple", () => {
  const resolved = resolveAtomProvider({
    platform: "freebsd",
    arch: "x64",
  });
  assert.strictEqual(resolved.preferredPkg, "@appthreat/atom-jar");
  assert.strictEqual(resolved.kind, "jar");
});

it("reports a non-zero atom exit as failure (stub atom exits 1 with no output)", () => {
  const originalAtomCmd = process.env.ATOM_CMD;
  const stubPath = join(tmpdir(), `atom-stub-exit1-${process.pid}.js`);
  writeFileSync(stubPath, "process.exit(1);\n");
  try {
    process.env.ATOM_CMD = `${process.execPath} ${stubPath}`;
    const ok = executeAtom(process.cwd(), ["--help"], {});
    assert.strictEqual(
      ok,
      false,
      "a stub atom exiting 1 must be reported as failure",
    );
    assert.strictEqual(getAtomCommand().includes(stubPath), true);
  } finally {
    if (originalAtomCmd === undefined) {
      delete process.env.ATOM_CMD;
    } else {
      process.env.ATOM_CMD = originalAtomCmd;
    }
    try {
      unlinkSync(stubPath);
    } catch {
      // ignore
    }
  }
});

it("reports an unsupported language as failure (stub atom prints the unsupported banner)", () => {
  const originalAtomCmd = process.env.ATOM_CMD;
  const stubPath = join(tmpdir(), `atom-stub-unsupported-${process.pid}.js`);
  writeFileSync(
    stubPath,
    'console.log("No language frontend supported for language: foo");\n',
  );
  try {
    process.env.ATOM_CMD = `${process.execPath} ${stubPath}`;
    const ok = executeAtom(process.cwd(), ["usages", "-l", "foo"], {});
    assert.strictEqual(
      ok,
      false,
      "a stub atom printing the unsupported banner must be reported as failure",
    );
  } finally {
    if (originalAtomCmd === undefined) {
      delete process.env.ATOM_CMD;
    } else {
      process.env.ATOM_CMD = originalAtomCmd;
    }
    try {
      unlinkSync(stubPath);
    } catch {
      // ignore
    }
  }
});

function withEnv(name, value, body) {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return body();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

it("caps atom's heap below what the runtime would default to", () => {
  const bytes = withEnv("ATOM_MAX_HEAP", undefined, atomMaxHeapBytes);
  assert.ok(bytes > 0);
  // A native image defaults to 80% of physical memory and HotSpot to 25%, so
  // the ceiling has to sit under both to be doing anything.
  assert.ok(bytes <= Math.floor(totalmem() / 2));
  assert.ok(bytes <= 8 * 1024 ** 3);
  // The floor keeps a small container workable even though half its memory is
  // less than the floor.
  assert.ok(bytes >= 2 * 1024 ** 3);
});

it("reads an explicit heap ceiling with or without a unit suffix", () => {
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "4g", atomMaxHeapBytes),
    4 * 1024 ** 3,
  );
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "512m", atomMaxHeapBytes),
    512 * 1024 ** 2,
  );
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "6442450944", atomMaxHeapBytes),
    6 * 1024 ** 3,
  );
  // Zero is the runtime's own "unset", so it restores the unbounded default.
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "0", atomMaxHeapBytes),
    undefined,
  );
  // An unparseable value must not silently become a tiny heap.
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "lots", atomMaxHeapBytes),
    withEnv("ATOM_MAX_HEAP", undefined, atomMaxHeapBytes),
  );
});

it("passes the heap ceiling to atom ahead of its own arguments", () => {
  const stubPath = join(tmpdir(), `atom-stub-argv-${process.pid}.js`);
  const outPath = join(tmpdir(), `atom-stub-argv-${process.pid}.json`);
  writeFileSync(
    stubPath,
    `require("node:fs").writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({ argv: process.argv.slice(2), jto: process.env.JAVA_TOOL_OPTIONS }));\n`,
  );
  try {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_MAX_HEAP", "8g", () =>
        executeAtom(process.cwd(), ["usages", "-l", "java"], {}),
      ),
    );
    const out = JSON.parse(readFileSync(outPath, "utf-8"));
    if (atomProviderKind() === "native") {
      // The runtime consumes -XX: before atom's parser sees argv, so it has to
      // precede the subcommand.
      assert.deepStrictEqual(out.argv, [
        `-XX:MaxHeapSize=${8 * 1024 ** 3}`,
        "usages",
        "-l",
        "java",
      ]);
      assert.strictEqual(out.jto, undefined);
    } else {
      // A jar-kind provider owns the java command line, so the heap ceiling
      // reaches atom through JAVA_TOOL_OPTIONS and argv is untouched.
      assert.deepStrictEqual(out.argv, ["usages", "-l", "java"]);
      assert.ok(
        typeof out.jto === "string" && out.jto.includes("-Xmx"),
        `expected JAVA_TOOL_OPTIONS to contain -Xmx, got ${out.jto}`,
      );
    }
  } finally {
    for (const path of [stubPath, outPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }
});

it("leaves the heap alone when the caller already set a ceiling", () => {
  const stubPath = join(tmpdir(), `atom-stub-preset-${process.pid}.js`);
  const argvPath = join(tmpdir(), `atom-stub-preset-${process.pid}.json`);
  writeFileSync(
    stubPath,
    `require("node:fs").writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  try {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_MAX_HEAP", "8g", () =>
        executeAtom(process.cwd(), ["-XX:MaxHeapSize=123456789", "usages"], {}),
      ),
    );
    // On native kind the existing -XX: blocks the prepended ceiling; on jar
    // kind args are never touched. Either way argv must be unchanged.
    assert.deepStrictEqual(JSON.parse(readFileSync(argvPath, "utf-8")), [
      "-XX:MaxHeapSize=123456789",
      "usages",
    ]);
  } finally {
    for (const path of [stubPath, argvPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }
});

it("warns once per ceiling when the heap is below what slicing is comfortable with", () => {
  const stubPath = join(tmpdir(), `atom-stub-warn-${process.pid}.js`);
  writeFileSync(stubPath, "process.exit(0);\n");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () => {
      // Deliberately unround ceilings. The warning is latched per ceiling so
      // that this holds on a host whose own default is already tight enough to
      // have warned before this test ran - a 7 GB runner caps atom at 3.5 GiB
      // and says so - and a value no host default can land on keeps the latch
      // from being claimed by that earlier warning.
      withEnv("ATOM_MAX_HEAP", "3001m", () => {
        executeAtom(process.cwd(), ["usages"], {});
        executeAtom(process.cwd(), ["usages"], {});
      });
      // A different tight ceiling is a different warning.
      withEnv("ATOM_MAX_HEAP", "4001m", () =>
        executeAtom(process.cwd(), ["usages"], {}),
      );
    });
  } finally {
    console.warn = originalWarn;
    if (existsSync(stubPath)) {
      unlinkSync(stubPath);
    }
  }
  const tight = warnings.filter((line) => line.includes("atom is limited to"));
  assert.strictEqual(
    tight.filter((line) => line.includes("2.9 GiB heap")).length,
    1,
    "two spawns at one ceiling must warn once",
  );
  const four = tight.filter((line) => line.includes("3.9 GiB heap"));
  assert.strictEqual(four.length, 1);
  assert.ok(four[0].includes("7 GiB"));
  assert.ok(four[0].includes("ATOM_MAX_HEAP"));
});

it("gives atom its own time limit inside cdxgen's spawn timeout", () => {
  const derived = withEnv("ATOM_TIMEOUT", undefined, atomTimeouts);
  // atom stops itself first; cdxgen's own kill is the last resort.
  assert.ok(derived.atomTimeoutMs < derived.spawnTimeoutMs);
  assert.ok(derived.spawnTimeoutMs - derived.atomTimeoutMs <= 30_000);
  // An explicit ATOM_TIMEOUT is atom's limit, whatever CDXGEN_TIMEOUT_MS says.
  assert.deepStrictEqual(
    withEnv("ATOM_TIMEOUT", "7200000", atomTimeouts),
    { atomTimeoutMs: 7_200_000, spawnTimeoutMs: 7_230_000 },
  );
  // A short limit gets a proportional grace, not thirty seconds.
  assert.deepStrictEqual(withEnv("ATOM_TIMEOUT", "4000", atomTimeouts), {
    atomTimeoutMs: 4000,
    spawnTimeoutMs: 5000,
  });
  // Nonsense falls back to the derived limit.
  assert.deepStrictEqual(withEnv("ATOM_TIMEOUT", "soon", atomTimeouts), derived);
});

it("recognises every way an atom run can run out of time", () => {
  assert.strictEqual(atomRunTimedOut({ status: 124 }, 10, 1000), true);
  assert.strictEqual(
    atomRunTimedOut({ status: null, error: { code: "ETIMEDOUT" } }, 10, 1000),
    true,
  );
  // An older dispatcher exits 1 when it stops atom.
  assert.strictEqual(atomRunTimedOut({ status: 1 }, 1000, 1000), true);
  assert.strictEqual(atomRunTimedOut({ status: 1 }, 999, 1000), false);
  assert.strictEqual(atomRunTimedOut({ status: 0 }, 5000, 1000), false);
});

it("tells atom its time limit and names cdxgen as its supervisor", () => {
  const stubPath = join(tmpdir(), `atom-stub-env-${process.pid}.js`);
  const outPath = join(tmpdir(), `atom-stub-env-${process.pid}.json`);
  writeFileSync(
    stubPath,
    `require("node:fs").writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({ timeout: process.env.ATOM_TIMEOUT, parent: process.env.ATOM_PARENT_PID }));\n`,
  );
  try {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_TIMEOUT", "600000", () =>
        executeAtom(process.cwd(), ["usages"], {}),
      ),
    );
    assert.deepStrictEqual(JSON.parse(readFileSync(outPath, "utf-8")), {
      timeout: "600000",
      parent: String(process.pid),
    });
  } finally {
    for (const path of [stubPath, outPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }
});

it("reports an atom run stopped by its time limit as a timeout", () => {
  const stubPath = join(tmpdir(), `atom-stub-timeout-${process.pid}.js`);
  writeFileSync(stubPath, "process.exit(124);\n");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const ok = withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_TIMEOUT", "90000", () =>
        executeAtom(process.cwd(), ["reachables"], {}),
      ),
    );
    assert.strictEqual(ok, false);
  } finally {
    console.warn = originalWarn;
    unlinkSync(stubPath);
  }
  const timeout = warnings.filter((w) => w.includes("did not finish within"));
  assert.strictEqual(timeout.length, 1);
  assert.ok(timeout[0].includes("1.5 minutes"));
  assert.ok(timeout[0].includes("ATOM_TIMEOUT"));
});

it("stops atom when cdxgen's spawn timeout fires, and drops its half-written atom", () => {
  // A stand-in atom that ignores its time limit: cdxgen's spawn timeout kills it.
  const stubPath = join(tmpdir(), `atom-stub-hang-${process.pid}.js`);
  const atomFile = join(tmpdir(), `atom-stub-hang-${process.pid}.atom`);
  writeFileSync(stubPath, "setInterval(() => {}, 1000);\n");
  writeFileSync(atomFile, "partial");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const ok = withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_TIMEOUT", "800", () =>
        executeAtom(process.cwd(), ["reachables", "-o", atomFile], {}),
      ),
    );
    assert.strictEqual(ok, false);
  } finally {
    console.warn = originalWarn;
    unlinkSync(stubPath);
  }
  assert.ok(warnings.some((w) => w.includes("did not finish within")));
  // The next slice of the run must rebuild the atom rather than fail to load it.
  assert.strictEqual(existsSync(atomFile), false);
});

it("detects the jar fallback when the native atom package is not installed", async () => {
  const { kind, preferredPkg } = resolveAtomProvider();
  const root = mkdtempSync(join(tmpdir(), "atom-layout-"));
  try {
    mkdirSync(join(root, "node_modules", "@appthreat", "atom-jar", "plugins"), {
      recursive: true,
    });
    const { atomProviderKind: kindFor } = await esmock("./atomUtils.js", {
      "../core/paths.js": { dirNameStr: root },
    });
    const detected = withEnv("ATOM_CMD", undefined, () =>
      withEnv("ATOM_HOME", undefined, kindFor),
    );
    // Only the jar is installed, so atom runs as the jar on every platform.
    assert.strictEqual(detected, "jar");
    if (kind === "native") {
      const folder = preferredPkg.split("/")[1];
      const binDir = join(root, "node_modules", "@appthreat", folder, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, process.platform === "win32" ? "atom.exe" : "atom"), "");
      const withNative = withEnv("ATOM_CMD", undefined, () =>
        withEnv("ATOM_HOME", undefined, kindFor),
      );
      assert.strictEqual(withNative, "native");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
