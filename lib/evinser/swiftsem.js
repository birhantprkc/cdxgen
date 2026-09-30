import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { SWIFT_CMD } from "../core/env.js";
import {
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeSpawnSync,
} from "../core/fs.js";
import { splitCommandArgs } from "../ecosystems/parsers-js.js";
import { isSwiftTestTarget } from "../ecosystems/parsers-misc.js";
import { runSwiftCommand } from "../inventory/envcontext.js";
import { executeSourcekitten } from "../managers/binary.js";

// Swift entity kinds
// https://github.com/swiftlang/swift/blob/main/tools/SourceKit/docs/SwiftSupport.txt
const SWIFT_ENTITY_KINDS = {
  IMPORT_CLANG: "source.lang.swift.import.module.clang",
  IMPORT_SWIFT: "source.lang.swift.import.module.swift",
  IMPORT_SOURCE: "source.lang.swift.import.sourcefile",
  DECL_EXTN_STRUCT: "source.lang.swift.decl.extension.struct",
  DECL_EXTN_CLASS: "source.lang.swift.decl.extension.class",
  DECL_EXTN_ENUM: "source.lang.swift.decl.extension.enum",
  DECL_FREE: "source.lang.swift.decl.function.free",
  REF_FREE: "source.lang.swift.ref.function.free",
  DECL_METHOD_INSTANCE: "source.lang.swift.decl.function.method.instance",
  REF_METHOD_INSTANCE: "source.lang.swift.ref.function.method.instance",
  DECL_METHOD_STATIC: "source.lang.swift.decl.function.method.static",
  REF_METHOD_STATIC: "source.lang.swift.ref.function.method.static",
  DECL_CONSTRUCTOR: "source.lang.swift.decl.function.constructor",
  REF_CONSTRUCTOR: "source.lang.swift.ref.function.constructor",
  DECL_DESTRUCTOR: "source.lang.swift.decl.function.destructor",
  REF_DESTRUCTOR: "source.lang.swift.ref.function.destructor",
  DECL_OPERATOR: "source.lang.swift.decl.function.operator",
  REF_OPERATOR: "source.lang.swift.ref.function.operator",
  DECL_SUBSCRIPT: "source.lang.swift.decl.function.subscript",
  REF_SUBSCRIPT: "source.lang.swift.ref.function.subscript",
  DECL_GETTER: "source.lang.swift.decl.function.accessor.getter",
  REF_GETTER: "source.lang.swift.ref.function.accessor.getter",
  DECL_SETTER: "source.lang.swift.decl.function.accessor.setter",
  REF_SETTER: "source.lang.swift.ref.function.accessor.setter",
  DECL_CLASS: "source.lang.swift.decl.class",
  REF_CLASS: "source.lang.swift.ref.class",
  DECL_STRUCT: "source.lang.swift.decl.struct",
  REF_STRUCT: "source.lang.swift.ref.struct",
  DECL_ENUM: "source.lang.swift.decl.enum",
  REF_ENUM: "source.lang.swift.ref.enum",
  DECL_ENUM_ELEMENT: "source.lang.swift.decl.enumelement",
  REF_ENUM_ELEMENT: "source.lang.swift.ref.enumelement",
  DECL_PROTOCOL: "source.lang.swift.decl.protocol",
  REF_PROTOCOL: "source.lang.swift.ref.protocol",
  DECL_TYPE_ALIAS: "source.lang.swift.decl.typealias",
  REF_TYPE_ALIAS: "source.lang.swift.ref.typealias",
  DECL_VAR_GLOBAL: "source.lang.swift.decl.var.global",
  REF_VAR_GLOBAL: "source.lang.swift.ref.var.global",
  DECL_VAR_INSTANCE: "source.lang.swift.decl.var.instance",
  REF_VAR_INSTANCE: "source.lang.swift.ref.var.instance",
  DECL_VAR_STATIC: "source.lang.swift.decl.var.static",
  REF_VAR_STATIC: "source.lang.swift.ref.var.static",
  DECL_VAR_LOCAL: "source.lang.swift.decl.var.local",
  REF_VAR_LOCAL: "source.lang.swift.ref.var.local",
};

// Array of standard types that can be ignored
const IGNORABLE_TYPES = [
  "Bool",
  "Error?",
  "AnyObject",
  "()",
  "Any?",
  "Void",
  "[String]",
  "String?",
  "String",
];

// Swift Build build engine (default from Swift 6.4/Xcode 27) writes per-target
// output file maps named `<target>-OutputFileMap.json` under
// `.build/out/Intermediates.noindex/`, while the classic llbuild backend writes
// lowercase `output-file-map.json` files next to the module artifacts.
const SWIFT_BUILD_FILEMAP_SUFFIX = "-OutputFileMap.json";
// SwiftPM sanitises target names into module names by replacing every
// character that is not valid in a C identifier with an underscore, so the
// target `argparser-demo` produces the module `argparser_demo`.
const NON_IDENTIFIER_CHARS = /[^A-Za-z0-9_]/g;

/**
 * Convert a SwiftPM target or package name into its module name.
 *
 * @param {String} name Target or package name
 * @returns {String} Module name
 */
export function toModuleName(name) {
  return (name || "").replace(NON_IDENTIFIER_CHARS, "_");
}

/**
 * Decide whether a module belongs to tests or to an aggregate product and so
 * must not contribute build symbols or semantic context.
 *
 * @param {String} moduleName Module name
 * @returns {boolean} `true` when the module should be skipped
 */
export function isTestOrAggregateModule(moduleName) {
  return (
    !moduleName ||
    moduleName.endsWith("Tests") ||
    moduleName.endsWith("PackageTests") ||
    moduleName.endsWith("_test_runner") ||
    moduleName.endsWith("-test-runner") ||
    moduleName.endsWith("_product") ||
    moduleName.endsWith("-product")
  );
}

let cachedSourcekittenEnv;

/**
 * Determine the extra environment variables needed to make sourcekitten use
 * the same Swift toolchain that will build the project.
 *
 * sourcekitten resolves SourceKit through `xcrun`, so without guidance it uses
 * the active Xcode toolchain even when `swift` comes from swiftly or another
 * `.xctoolchain`. Indexing then fails with errors such as `module compiled
 * with Swift 6.4 cannot be imported by the Swift 6.1 compiler` or
 * `unknown argument`. The toolchain identifier is passed via `TOOLCHAINS`; an
 * explicitly configured `TOOLCHAINS`/`DEVELOPER_DIR` always wins.
 *
 * @returns {undefined|Object} Environment overrides for sourcekitten or undefined.
 */
export function sourcekittenToolchainEnv() {
  if (cachedSourcekittenEnv !== undefined) {
    return cachedSourcekittenEnv;
  }
  cachedSourcekittenEnv = undefined;
  if (process?.env?.TOOLCHAINS || process?.env?.DEVELOPER_DIR) {
    return cachedSourcekittenEnv;
  }
  if (!SWIFT_CMD) {
    return cachedSourcekittenEnv;
  }
  const toolchainDir = resolveSwiftToolchainDir();
  if (!toolchainDir) {
    return cachedSourcekittenEnv;
  }
  const identifier = readToolchainIdentifier(toolchainDir);
  if (identifier) {
    if (DEBUG_MODE) {
      console.log(
        `Aligning sourcekitten with the toolchain '${identifier}' at '${toolchainDir}'.`,
      );
    }
    cachedSourcekittenEnv = { TOOLCHAINS: identifier };
  }
  return cachedSourcekittenEnv;
}

/**
 * Locate the `.xctoolchain` directory that backs the configured swift command.
 *
 * When `swift` points directly into a toolchain bundle the path is enough;
 * swiftly's shim binary hides it, so in that case the toolchain directory is
 * looked up from the reported swift version among the installed toolchains.
 *
 * @returns {undefined|String} Toolchain directory or undefined.
 */
function resolveSwiftToolchainDir() {
  let realSwiftPath;
  try {
    realSwiftPath = realpathSync(SWIFT_CMD);
  } catch (_e) {
    realSwiftPath = SWIFT_CMD;
  }
  const directMatch = realSwiftPath.match(
    /^(.*\/Toolchains\/[^/]+\.xctoolchain)\//,
  );
  if (directMatch) {
    return directMatch[1];
  }
  // swiftly (and similar shims) dispatch to a toolchain that cannot be seen
  // from the command path; find it by the swift version instead
  const versionResult = safeSpawnSync(SWIFT_CMD, ["--version"]);
  const versionOutput = `${versionResult?.stdout || ""}${
    versionResult?.stderr || ""
  }`;
  const versionMatch = versionOutput.match(
    /Apple Swift version (\d+\.\d+(?:\.\d+)?(?:-\w+)?)/,
  );
  if (!versionMatch) {
    return undefined;
  }
  const toolchainsRoot = join(homedir(), "Library", "Developer", "Toolchains");
  let candidates = [];
  try {
    candidates = readdirSync(toolchainsRoot).filter(
      (name) => name.endsWith(".xctoolchain") && name.includes(versionMatch[1]),
    );
  } catch (_e) {
    return undefined;
  }
  for (const candidate of candidates) {
    const candidateDir = join(toolchainsRoot, candidate);
    if (safeExistsSync(join(candidateDir, "Info.plist"))) {
      return candidateDir;
    }
  }
  return undefined;
}

function readToolchainIdentifier(toolchainDir) {
  const infoPlist = join(toolchainDir, "Info.plist");
  if (!safeExistsSync(infoPlist)) {
    return undefined;
  }
  const result = safeSpawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    infoPlist,
  ]);
  const identifier = result?.stdout?.toString().trim();
  return result?.status === 0 && identifier ? identifier : undefined;
}

/**
 * Retrieve the structure information of a .swift file in json format
 *
 * @param {String} filePath Path to .swift file
 *
 * @returns {undefined|Object} JSON representation of the swift file or undefined.
 */
export function getStructure(filePath) {
  return executeSourcekitten(["structure", "--file", filePath]);
} /**
 * Parse the data from the structure command
 *
 * @param {Object} structureJson Json from the structure command
 * @returns {Object|undefined} Parsed value
 */
export function parseStructure(structureJson) {
  if (
    structureJson?.["key.diagnostic_stage"] !==
      "source.diagnostic.stage.swift.parse" ||
    !structureJson["key.substructure"]
  ) {
    return undefined;
  }
  const metadata = {};
  const refTypes = new Set();
  collectStructureTypes(structureJson["key.substructure"], refTypes);
  if (refTypes.size) {
    metadata["referredTypes"] = Array.from(refTypes).sort();
  }
  return metadata;
}

/**
 * Recursively collect referred types from the sub-structure
 *
 * @param substructures {Object} Sub structures
 * @param refTypes {Set<String>} Identified reference types
 */
function collectStructureTypes(substructures, refTypes) {
  if (!substructures || !Array.isArray(substructures)) {
    return;
  }
  for (const asubstruct of substructures) {
    if (
      asubstruct["key.typename"] &&
      !IGNORABLE_TYPES.includes(asubstruct["key.typename"])
    ) {
      refTypes.add(asubstruct["key.typename"]);
    }
    if (asubstruct["key.inheritedtypes"]) {
      for (const inheritedType of asubstruct["key.inheritedtypes"]) {
        if (!IGNORABLE_TYPES.includes(inheritedType["key.name"])) {
          refTypes.add(inheritedType["key.name"]);
        }
      }
    }
    // Recurse
    if (asubstruct["key.substructure"]) {
      collectStructureTypes(asubstruct["key.substructure"], refTypes);
    }
  }

  if (substructures["key.substructure"]) {
    collectStructureTypes(substructures["key.substructure"], refTypes);
  }
}

/**
 * Method to perform swift build in verbose mode.
 *
 * @param {String} basePath Path
 * @returns {undefined|String} Verbose build output
 */
export function verboseBuild(basePath) {
  runSwiftCommand(basePath, ["package", "clean"]);
  console.log("Extracting compiler arguments from swift build...");
  return runSwiftCommand(basePath, [
    "build",
    "-c",
    "debug",
    "--verbose",
    "-Xcc",
    "-Wno-error",
  ]);
}

// Compiler arguments that accept exactly one value. The value of the longest
// driver line wins so that the arguments match the primary module
const SWIFT_COMPILER_SINGLETON_ARGS = new Set([
  "-sdk",
  "-target",
  "-swift-version",
  "-package-description-version",
  "-module-cache-path",
]);
// Compiler arguments that accumulate values across every driver line
const SWIFT_COMPILER_CUMULATIVE_ARGS = new Set([
  "-F",
  "-I",
  "-L",
  "-vfsoverlay",
  "-Xllvm",
  "-external-plugin-path",
  "-plugin-path",
]);
// Compiler arguments whose values keep their line order (`-Xcc` is followed
// by exactly one clang argument)
const SWIFT_COMPILER_ORDERED_ARGS = new Set(["-Xcc"]);
const SWIFT_COMPILER_BOOL_ARGS = new Set([
  "-parse-as-library",
  "-incremental",
  "-track-system-dependencies",
  "-suppress-remarks",
  "-suppress-warnings",
  "-stack-check",
  "-no-color-diagnostics",
  "-enable-testing",
  "-enable-library-evolution",
]);
// Flags that alter plugin behaviour or emit build-system bookkeeping. They
// are irrelevant when sourcekitten re-parses the sources, and a sourcekitten
// build linked against an older Swift may reject them outright (for example
// `-disable-clang-spi` in toolchains that predate clang SPI support).
const SWIFT_COMPILER_IGNORED_ARGS = new Set([
  "-o",
  "-output-file-map",
  "-emit-module-path",
  "-emit-module-doc-path",
  "-emit-dependencies-path",
  "-emit-reference-dependencies-path",
  "-emit-objc-header-path",
  "-primary-file",
  "-main-file",
  "-num-threads",
  "-enable-objc-interop",
  "-empty-abi-descriptor",
  "-target-sdk-version",
  "-target-sdk-name",
  "-incremental",
  "-module-name",
  "-j",
  "-disable-clang-spi",
  "-validate-clang-modules-once",
  "-clang-build-session-file",
  "-in-process-plugin-server-path",
  "-index-store-path",
  "-index-system-modules",
  "-const-gather-protocols-file",
  "-file-compilation-dir",
  "-serialize-debugging-options",
  "-debug-info-format",
  "-dwarf-version",
  "-package-name",
  "-no-auto-bridging-header-chaining",
  "-enable-anonymous-context-mangled-names",
  "-index-unit-output-path",
  "-enable-experimental-feature",
]);

/**
 * Validates a parameter value to ensure it's not a garbage string or full command.
 */
function isValidSwiftParamValue(val) {
  if (!val) return false;
  if (val.length > 2048) return false;
  return !(val.includes(" -cc1") || val.includes('clang"'));
}

/**
 * Tokenize a single swiftc/swift-frontend driver line into compiler
 * parameters. See SWIFT_COMPILER_* for the argument classes.
 *
 * @param {String} driverLine Verbose build output line
 * @returns {Object} Parameters of this line
 */
function parseDriverLine(driverLine) {
  const lineParams = {};
  const tokens = splitCommandArgs(driverLine);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (SWIFT_COMPILER_IGNORED_ARGS.has(token)) {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i++;
      }
      continue;
    }
    if (SWIFT_COMPILER_SINGLETON_ARGS.has(token)) {
      if (i + 1 < tokens.length) {
        const val = tokens[i + 1];
        if (isValidSwiftParamValue(val)) {
          lineParams[token] = val;
        }
        i++;
      }
    } else if (SWIFT_COMPILER_ORDERED_ARGS.has(token)) {
      if (i + 1 < tokens.length) {
        const val = tokens[i + 1];
        if (isValidSwiftParamValue(val)) {
          if (!lineParams[token]) {
            lineParams[token] = [];
          }
          lineParams[token].push(val);
        }
        i++;
      }
    } else if (SWIFT_COMPILER_CUMULATIVE_ARGS.has(token)) {
      if (i + 1 < tokens.length) {
        const val = tokens[i + 1];
        if (isValidSwiftParamValue(val)) {
          if (!lineParams[token]) {
            lineParams[token] = new Set();
          }
          lineParams[token].add(val);
        }
        i++;
      }
    } else if (SWIFT_COMPILER_BOOL_ARGS.has(token)) {
      lineParams[token] = true;
    } else if (token.startsWith("-D")) {
      if (!lineParams["-D"]) lineParams["-D"] = new Set();
      if (token === "-D" && i + 1 < tokens.length) {
        lineParams["-D"].add(tokens[i + 1]);
        i++;
      } else {
        lineParams["-D"].add(token.substring(2));
      }
    }
  }
  return lineParams;
}

/**
 * Merge the parameters of one driver line into the accumulated parameters.
 * Single-value flags of earlier (longer) lines win; ordered values repeat
 * within a line but not between lines.
 *
 * @param {Object} params Accumulated parameters
 * @param {Object} lineParams Parameters of one driver line
 */
function mergeDriverParams(params, lineParams) {
  for (const key of Object.keys(lineParams)) {
    const value = lineParams[key];
    if (value === true) {
      params[key] = true;
    } else if (value instanceof Set) {
      if (!params[key]) {
        params[key] = new Set();
      }
      for (const v of value) {
        params[key].add(v);
      }
    } else if (Array.isArray(value)) {
      if (!params[key]) {
        // The first (longest) line establishes the baseline verbatim,
        // keeping its intra-line repeats such as `-Xcc -F`
        params[key] = [...value];
      } else {
        for (const v of value) {
          if (!params[key].includes(v)) {
            params[key].push(v);
          }
        }
      }
    } else if (params[key] === undefined) {
      params[key] = value;
    }
  }
}

/**
 * Method to parse the verbose swift build output to identify key compiler parameters.
 *
 * @param {String} buildOutput Verbose build output
 * @returns {Object} compiler build parameters
 */
export function extractCompilerParamsFromBuild(buildOutput) {
  const params = {};
  if (!buildOutput) {
    console.log("No build output. Returning empty compilerArgs");
    return { params, compilerArgs: [] };
  }

  const lines = buildOutput.split("\n");
  const driverLines = [];
  for (const rawLine of lines) {
    const l = rawLine.trim();
    if (!l.includes("swiftc") && !l.includes("swift-frontend")) {
      continue;
    }
    if (l === "/usr/bin/swift-frontend" || l.endsWith("swift-frontend")) {
      continue;
    }
    // Package.swift manifest and build-plugin compilations target the
    // manifest/plugin APIs instead of the workspace's build products, so the
    // arguments they carry cannot resolve the project's dependency modules.
    if (
      l.includes("-package-description-version") ||
      l.includes("-vfsoverlay")
    ) {
      continue;
    }
    // The Swift Build engine prints several bookkeeping commands that mention
    // the compiler; only `builtin-SwiftDriver` lines carry the complete
    // per-module compilation arguments (include paths, module maps)
    if (l.startsWith("builtin-") && !l.startsWith("builtin-SwiftDriver")) {
      continue;
    }
    driverLines.push(l);
  }

  // Every driver line describes one module of the workspace, and each module
  // contributes its own include paths and clang module maps, so the arguments
  // of all lines are merged. Lines of the root package's own modules are
  // parsed first so that their single-value flags (`-target`, `-sdk`, ...)
  // win: dependency modules can be built for older deployment targets than
  // the root package, and indexing the root sources with a dependency's
  // target cannot load the newer modules. Repeated values between lines are
  // dropped; repeats within one line are preserved as the compiler expects
  // them (for example `-Xcc -F` before each framework path)
  const isCheckoutLine = (l) => l.includes("/checkouts/");
  const isRootFileLine = (l) => {
    // A root compile line's own source file sits outside the checkouts;
    // its include paths may still reference checkouts for C module maps
    const tokens = splitCommandArgs(l);
    const idx = tokens.indexOf("-primary-file");
    return idx >= 0 && !String(tokens[idx + 1]).includes("/checkouts/");
  };
  const byLengthDesc = (a, b) => b.length - a.length;
  const rootFileLines = driverLines.filter(isRootFileLine).sort(byLengthDesc);
  const rootModuleLines = driverLines
    .filter((l) => !isRootFileLine(l) && !isCheckoutLine(l))
    .sort(byLengthDesc);
  const checkoutLines = driverLines
    .filter((l) => !isRootFileLine(l) && isCheckoutLine(l))
    .sort(byLengthDesc);
  for (const driverLine of [
    ...rootFileLines,
    ...rootModuleLines,
    ...checkoutLines,
  ]) {
    mergeDriverParams(params, parseDriverLine(driverLine));
  }
  const compilerArgsList = [];
  if (process?.env?.SWIFT_COMPILER_EXTRA_ARGS) {
    compilerArgsList.push(...process.env.SWIFT_COMPILER_EXTRA_ARGS.split(" "));
  }
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value instanceof Set) {
      for (const v of Array.from(value)) {
        compilerArgsList.push(key);
        compilerArgsList.push(v);
      }
    } else if (Array.isArray(value)) {
      for (const v of value) {
        compilerArgsList.push(key);
        compilerArgsList.push(v);
      }
    } else if (typeof value === "string") {
      compilerArgsList.push(key);
      compilerArgsList.push(value);
    } else if (value === true) {
      compilerArgsList.push(key);
    }
  }
  return { params, compilerArgs: compilerArgsList };
}

/**
 * Method to index a swift file and extract metadata
 *
 * @param {String} filePath Path to .swift file
 * @param {String|Array<string>} compilerArgs Compiler arguments extracted from verbose build log
 * @returns {undefined|Object} metadata
 */
export function index(filePath, compilerArgs) {
  const skArgs = ["index", "--file", filePath];
  if (compilerArgs) {
    skArgs.push("--");
    if (Array.isArray(compilerArgs)) {
      skArgs.push(...compilerArgs);
    } else {
      skArgs.push(...compilerArgs.split(" "));
    }
  }
  skArgs.push(filePath);
  return executeSourcekitten(skArgs, sourcekittenToolchainEnv());
}

/**
 * Parse the data from the index command
 *
 * @param {Object} indexJson Json from the index command
 * @returns {Object|undefined} Parsed value
 */
export function parseIndex(indexJson) {
  if (!indexJson) {
    return undefined;
  }
  // Some modules can be in both swift and clang
  const swiftModules = new Set();
  const clangModules = new Set();
  collectIndexedModules(
    indexJson["key.dependencies"],
    swiftModules,
    clangModules,
  );
  // Maps the given symbols with this obfuscated version
  const obfuscatedSymbols = {};
  // Line numbers where the given symbols are found
  const symbolLocations = {};
  buildIndexedObfuscatedSymbols(
    indexJson["key.entities"],
    obfuscatedSymbols,
    symbolLocations,
  );
  return {
    swiftModules: Array.from(swiftModules).sort(),
    clangModules: Array.from(clangModules).sort(),
    obfuscatedSymbols,
    symbolLocations,
  };
}

/**
 * Recursively collect the swift and llvm modules from the index data
 *
 * @param dependencies {Array} dependencies array as per the index command
 * @param swiftModules {Set<String>} Swift modules used
 * @param clangModules {Set<String>} clang modules
 */
function collectIndexedModules(dependencies, swiftModules, clangModules) {
  for (const adep of dependencies) {
    if (adep["key.kind"] === SWIFT_ENTITY_KINDS.IMPORT_SWIFT) {
      swiftModules.add(adep["key.name"]);
    } else if (adep["key.kind"] === SWIFT_ENTITY_KINDS.IMPORT_CLANG) {
      clangModules.add(adep["key.name"]);
    }
    if (adep["key.dependencies"]) {
      collectIndexedModules(
        adep["key.dependencies"],
        swiftModules,
        clangModules,
      );
    }
  }
}

/**
 * Recursively collect the obfuscated symbols from the index data
 *
 * @param entities {Array} Entities found in the index data
 * @param obfuscatedSymbols {Object} Obfuscated symbols map
 * @param symbolLocations {Object} Symbol locations
 */
function buildIndexedObfuscatedSymbols(
  entities,
  obfuscatedSymbols,
  symbolLocations,
) {
  if (!entities) {
    return;
  }
  for (const aentity of entities) {
    if (aentity["key.name"] && aentity["key.usr"]) {
      obfuscatedSymbols[aentity["key.name"]] = aentity["key.usr"];
    }
    if (aentity["key.line"]) {
      const symbolLocationsKey = aentity["key.name"] || aentity["key.usr"];
      if (!symbolLocationsKey) {
        continue;
      }
      if (
        !symbolLocations[symbolLocationsKey] ||
        !Array.isArray(symbolLocations[symbolLocationsKey])
      ) {
        symbolLocations[symbolLocationsKey] = [];
      }
      if (!symbolLocations[symbolLocationsKey].includes(aentity["key.line"])) {
        symbolLocations[symbolLocationsKey].push(aentity["key.line"]);
      }
    }
    if (aentity["key.entities"]) {
      buildIndexedObfuscatedSymbols(
        aentity["key.entities"],
        obfuscatedSymbols,
        symbolLocations,
      );
    }
  }
}

/**
 * Method to execute dump-package package command.
 *
 * @param {String} basePath Path
 * @returns {undefined|Object} Output from dump-package command
 */
export function dumpPackage(basePath) {
  const cmdOutput = runSwiftCommand(basePath, ["package", "dump-package"]);
  if (!cmdOutput) {
    return undefined;
  }
  try {
    return JSON.parse(cmdOutput);
  } catch (_e) {
    return undefined;
  }
}

/**
 * Parse the data from dump-package command
 *
 * @param {Object} dumpJson Json from dump-package command
 * @returns {Object|undefined} Parsed value
 */
export function parseDumpPackage(dumpJson) {
  if (!dumpJson) {
    return undefined;
  }
  const metadata = {
    rootModule: dumpJson?.name,
    rootDir: dumpJson?.packageKind?.root,
    platforms: dumpJson?.platforms,
  };
  const rootPkgDependencies = [];
  const rootModules = new Set();
  if (dumpJson.targets) {
    for (const atarget of dumpJson.targets) {
      const ref = atarget.name.replace("+", "_");
      // Test targets never contribute runtime symbols
      if (!isSwiftTestTarget(atarget)) {
        rootModules.add(toModuleName(ref));
      }
      if (atarget.dependencies) {
        // Product dependencies such as `.product(name:package:)` record both
        // the product (module) name and the package identity; `byName`
        // entries only record the product or target name.
        const dependsOn = atarget.dependencies
          .map(
            (v) =>
              v?.byName?.[0]?.replace("+", "_") ??
              v?.product?.[0]?.replace("+", "_"),
          )
          .filter((v) => v !== undefined);
        rootPkgDependencies.push({
          ref,
          dependsOn,
        });
      }
    }
  }
  metadata.dependencies = rootPkgDependencies;
  if (rootModules.size) {
    metadata.rootModules = Array.from(rootModules).sort();
  }
  return metadata;
}

/**
 * Retrieve the module information of the swift project
 *
 * @param {String} moduleName Module name
 * @param {String|Array<string>} compilerArgs Compiler arguments extracted from verbose build log
 * @returns {undefined|Object} JSON representation of the swift module or undefined.
 */
export function moduleInfo(moduleName, compilerArgs) {
  const skArgs = ["module-info", "--module", moduleName];
  if (compilerArgs && compilerArgs.length > 0) {
    skArgs.push("--");
    if (Array.isArray(compilerArgs)) {
      skArgs.push(...compilerArgs);
    } else {
      skArgs.push(...compilerArgs.split(" "));
    }
  }
  return executeSourcekitten(skArgs, sourcekittenToolchainEnv());
}

/**
 * Parse the data from module-info command to replicate the swift interface
 *
 * @param {Object} moduleInfoJson Json from module-info command
 * @returns {Object|undefined} Parsed classes, protocols, enums and their functions
 */
export function parseModuleInfo(moduleInfoJson) {
  if (!moduleInfoJson?.["key.annotations"]) {
    return undefined;
  }
  const classes = new Set();
  const protocols = new Set();
  const enums = new Set();
  const obfuscationMap = {};
  const classMethods = {};
  const protocolMethods = {};
  // Collect the classes, protocols and enums first
  for (const annot of moduleInfoJson["key.annotations"] || []) {
    switch (annot["key.kind"]) {
      case SWIFT_ENTITY_KINDS.REF_CLASS:
        classes.add(annot["key.name"]);
        break;
      case SWIFT_ENTITY_KINDS.REF_PROTOCOL:
        protocols.add(annot["key.name"]);
        break;
      case SWIFT_ENTITY_KINDS.REF_ENUM:
        enums.add(annot["key.name"]);
        break;
    }
    // Build the obfuscation map
    if (
      [
        SWIFT_ENTITY_KINDS.REF_CLASS,
        SWIFT_ENTITY_KINDS.REF_PROTOCOL,
        SWIFT_ENTITY_KINDS.REF_ENUM,
      ].includes(annot["key.kind"])
    ) {
      obfuscationMap[annot["key.name"]] = annot["key.usr"];
    }
  }
  // Collect the class and protocol functions
  for (const aentity of moduleInfoJson["key.entities"] || []) {
    if (
      aentity["key.entities"] &&
      [
        SWIFT_ENTITY_KINDS.DECL_CLASS,
        SWIFT_ENTITY_KINDS.DECL_PROTOCOL,
      ].includes(aentity["key.kind"])
    ) {
      for (const centities of aentity["key.entities"] || []) {
        if (
          [SWIFT_ENTITY_KINDS.DECL_METHOD_INSTANCE].includes(
            centities["key.kind"],
          )
        ) {
          switch (aentity["key.kind"]) {
            case SWIFT_ENTITY_KINDS.DECL_CLASS:
              if (!classMethods[aentity["key.name"]]) {
                classMethods[aentity["key.name"]] = [];
              }
              classMethods[aentity["key.name"]].push(centities["key.name"]);
              break;
            case SWIFT_ENTITY_KINDS.DECL_PROTOCOL:
              if (!protocolMethods[aentity["key.name"]]) {
                protocolMethods[aentity["key.name"]] = [];
              }
              protocolMethods[aentity["key.name"]].push(centities["key.name"]);
              break;
          }
          obfuscationMap[centities["key.name"]] = centities["key.usr"];
        }
      }
    }
  }
  // Collect the imported modules and the free functions offered by the module
  const freeFunctions = new Set();
  const importedModules = [];
  for (const aline of (moduleInfoJson?.["key.sourcetext"] || "").split("\n")) {
    const line = aline.replaceAll("\r", "");
    if (line.startsWith("import ")) {
      importedModules.push(line.replace("import ", ""));
      continue;
    }
    // Free functions such as Yams' `dump(object:)` or ArgumentParser's
    // `exit(_:)` are only visible in the module interface text
    const funcMatch = line.match(
      /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|open\s+|final\s+|class\s+|static\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)/,
    );
    if (funcMatch) {
      freeFunctions.add(funcMatch[1]);
    }
  }
  return {
    classes: Array.from(classes).sort(),
    protocols: Array.from(protocols).sort(),
    enums: Array.from(enums).sort(),
    obfuscationMap,
    classMethods,
    protocolMethods,
    functions: Array.from(freeFunctions).sort(),
    importedModules: importedModules.sort(),
  };
}

/**
 * Method to collect the build symbols from the output file maps generated by
 * swift build.
 *
 * Both build engines are supported: the classic llbuild backend (default until
 * Swift 6.3) writes per-module `output-file-map.json` files, while the Swift
 * Build engine (default from Swift 6.4/Xcode 27) writes per-target
 * `<target>-OutputFileMap.json` files under `.build/out/Intermediates.noindex`.
 *
 * @param {String} basePath Path
 * @param {Object} options CLI options
 * @returns {Object} symbols map keyed by module name
 */
export function collectBuildSymbols(basePath, options) {
  const symbolsMap = {};
  const collectModule = (metadata) => {
    if (!metadata?.moduleName || isTestOrAggregateModule(metadata.moduleName)) {
      return;
    }
    const existing = symbolsMap[metadata.moduleName] || [];
    for (const asym of metadata.moduleSymbols) {
      if (!existing.includes(asym)) {
        existing.push(asym);
      }
    }
    symbolsMap[metadata.moduleName] = existing;
  };
  for (const afilemap of getAllFiles(
    basePath,
    ".build/**/debug/**/output-file-map.json",
    options,
  )) {
    collectModule(parseOutputFileMap(afilemap));
  }
  for (const afilemap of getAllFiles(
    basePath,
    `.build/**/*${SWIFT_BUILD_FILEMAP_SUFFIX}`,
    options,
  )) {
    collectModule(parseOutputFileMap(afilemap));
  }
  return symbolsMap;
}

/**
 * Method to parse output file map to identify the module and their symbols.
 * This list is imprecise when compared with the data from module-info command.
 *
 * The module name is derived from the containing directory for llbuild maps
 * (`<Module>.build` and, since Swift 6.4, `<Module>-tool.build`) and from the
 * file name for Swift Build maps (`<target>-OutputFileMap.json`, where the
 * target name still needs to be sanitised into a module name).
 *
 * @param filemap {String} File name
 * @returns {Object} parsed module metadata
 */
export function parseOutputFileMap(filemap) {
  const fileMapObj = JSON.parse(readFileSync(filemap, { encoding: "utf-8" }));
  const fileMapName = basename(filemap);
  let moduleName;
  if (fileMapName.endsWith(SWIFT_BUILD_FILEMAP_SUFFIX)) {
    // Swift Build engine: `<target>-OutputFileMap.json`
    moduleName = toModuleName(
      fileMapName.slice(0, -SWIFT_BUILD_FILEMAP_SUFFIX.length),
    );
  } else {
    // llbuild engine: `<Module>.build/output-file-map.json`
    moduleName = basename(dirname(filemap))
      .replace(/\.build$/, "")
      .replace(/-tool$/, "");
  }
  return { moduleName, moduleSymbols: collectFileMapSymbols(fileMapObj) };
}

/**
 * Extract the coarse per-source symbols recorded in an output file map. The
 * `.swiftdeps` artifacts are named after the source files, so the resulting
 * list is imprecise and is only used until module-info data is available.
 *
 * @param fileMapObj {Object} Parsed output file map
 * @returns {Array<String>} module symbols
 */
function collectFileMapSymbols(fileMapObj) {
  const moduleSymbols = [];
  for (const akey of Object.keys(fileMapObj)) {
    // The empty key describes module-level outputs rather than a source file
    if (!akey.length) {
      continue;
    }
    const swiftDeps = fileMapObj[akey]?.["swift-dependencies"];
    if (!swiftDeps) {
      continue;
    }
    moduleSymbols.push(
      basename(swiftDeps).replace(".swiftdeps", "").replace("+", "_"),
    );
  }
  return moduleSymbols;
}

/**
 * Parse the Swift Build manifest (`manifest.pif`) emitted by the Swift Build
 * engine under `.build/`.
 *
 * The manifest is a list of workspace, project, and target objects linked
 * through their `signature` hashes. Project objects carry the package
 * identity (`PACKAGE:<identity>` guid) and the Package.swift path, while
 * target objects record the exact `PRODUCT_MODULE_NAME`. This is the only
 * artifact that maps the modules built from a dependency checkout back to its
 * package identity without re-running `swift package dump-package`.
 *
 * @param {Array} manifestJson Parsed manifest.pif contents
 * @returns {undefined|Object} `{ packageModules }` keyed by package aliases or undefined.
 */
export function parseSwiftBuildManifest(manifestJson) {
  if (!Array.isArray(manifestJson)) {
    return undefined;
  }
  const objectsBySignature = new Map();
  for (const obj of manifestJson) {
    if (obj?.signature) {
      objectsBySignature.set(obj.signature, obj);
    }
  }
  const packageModules = {};
  for (const obj of manifestJson) {
    if (obj?.type !== "project") {
      continue;
    }
    const contents = obj.contents || {};
    const identity = contents.guid?.replace(/^PACKAGE:/, "");
    if (!identity) {
      continue;
    }
    const checkoutDir = basename(dirname(contents.path || "")) || identity;
    const modules = new Set();
    for (const targetSignature of contents.targets || []) {
      const target = objectsBySignature.get(targetSignature);
      const targetContents = target?.contents;
      if (target?.type !== "target" || !targetContents?.name) {
        continue;
      }
      // Aggregate product and test runner targets own no Swift sources
      if (isTestOrAggregateModule(toModuleName(targetContents.name))) {
        continue;
      }
      let moduleName;
      for (const buildConfig of targetContents.buildConfigurations || []) {
        moduleName = buildConfig?.buildSettings?.PRODUCT_MODULE_NAME;
        if (moduleName) {
          break;
        }
      }
      if (moduleName) {
        modules.add(moduleName);
      }
    }
    if (modules.size) {
      addPackageModules(packageModules, [identity, checkoutDir], modules);
    }
  }
  return Object.keys(packageModules).length ? { packageModules } : undefined;
}

/**
 * Register a package's module list under several aliases (identity, package
 * name, and their lowercase forms) so components can be matched regardless of
 * whether they were named after the repository, the package, or the identity.
 *
 * @param packageModules {Object} Map to mutate
 * @param aliases {Array<String>} Package aliases
 * @param modules {Set<String>} Module names offered by the package
 */
function addPackageModules(packageModules, aliases, modules) {
  const sortedModules = Array.from(modules).sort();
  const aliasSet = new Set();
  for (const alias of aliases) {
    if (alias) {
      aliasSet.add(alias);
      aliasSet.add(alias.toLowerCase());
    }
  }
  for (const alias of aliasSet) {
    packageModules[alias] = mergeUnique(packageModules[alias], sortedModules);
  }
}

function mergeUnique(existing, values) {
  const merged = new Set(existing || []);
  for (const value of values) {
    merged.add(value);
  }
  return Array.from(merged).sort();
}

/**
 * Parse a `Package.resolved` document (both v1 `object.pins` and the current
 * `pins` shapes) into a lookup of dependency identities and repository names.
 *
 * @param resolvedJson {Object} Parsed Package.resolved contents
 * @returns {Object} `{ aliases }` mapping every known package alias to the identity
 */
export function parseSwiftResolvedAliases(resolvedJson) {
  const resolvedList = resolvedJson?.pins || resolvedJson?.object?.pins || [];
  const aliases = {};
  for (const apin of resolvedList) {
    const location = apin.location || apin.repositoryURL || "";
    const repoName = decodeURIComponent(
      location.split("?")[0].split("#")[0].split("/").pop() || "",
    ).replace(/\.git$/, "");
    const identity = apin.identity || repoName;
    if (!identity) {
      continue;
    }
    for (const alias of new Set([
      identity,
      identity.toLowerCase(),
      repoName,
      repoName.toLowerCase(),
    ])) {
      if (alias) {
        aliases[alias] = identity;
      }
    }
  }
  return { aliases };
}

/**
 * Build a package name/identity to module names map for the workspace.
 *
 * The Swift Build engine exposes the mapping directly through `manifest.pif`;
 * for the llbuild engine the map is assembled from `swift package
 * dump-package` of the root package and of every dependency checkout.
 *
 * @param {String} basePath Path
 * @param {Object} options CLI options
 * @param {Object} rootPackageMetadata Parsed dump-package metadata of the root package
 * @returns {Object} Map of package aliases to module names
 */
export function collectPackageModules(basePath, options, rootPackageMetadata) {
  const packageModules = {};
  // Swift Build engine: the PIF manifest describes every target of every
  // package, including the precise module names
  if (safeExistsSync(join(basePath, ".build", "manifest.pif"))) {
    try {
      const manifest = parseSwiftBuildManifest(
        JSON.parse(
          readFileSync(join(basePath, ".build", "manifest.pif"), {
            encoding: "utf-8",
          }),
        ),
      );
      if (manifest?.packageModules) {
        return manifest.packageModules;
      }
    } catch (_e) {
      // Fall through to the dump-package based collection
    }
  }
  // llbuild engine: ask each package directly
  const resolvedAliases = {};
  for (const resolvedFile of getAllFiles(
    basePath,
    `${options.multiProject ? "**/" : ""}Package.resolved`,
    options,
  )) {
    try {
      const parsed = parseSwiftResolvedAliases(
        JSON.parse(readFileSync(resolvedFile, { encoding: "utf-8" })),
      );
      Object.assign(resolvedAliases, parsed.aliases);
    } catch (_e) {
      // Ignore unreadable lock files
    }
  }
  const dumpPackageByDir = new Map();
  const collectFromPackageDir = (packageDir, aliases) => {
    let dumpJson = dumpPackageByDir.get(packageDir);
    if (dumpJson === undefined) {
      dumpJson = dumpPackage(packageDir) || null;
      dumpPackageByDir.set(packageDir, dumpJson);
    }
    const modules = new Set();
    // Products give the module names other packages actually import
    for (const aproduct of dumpJson?.products || []) {
      for (const atarget of aproduct.targets || []) {
        modules.add(toModuleName(atarget));
      }
    }
    for (const atarget of dumpJson?.targets || []) {
      // Clang targets and test targets cannot be understood by module-info
      if (atarget.moduleType === "ClangTarget" || isSwiftTestTarget(atarget)) {
        continue;
      }
      modules.add(toModuleName(atarget.name));
    }
    if (modules.size) {
      addPackageModules(
        packageModules,
        aliases,
        filterSwiftModules(modules, dumpJson),
      );
    }
  };
  if (rootPackageMetadata?.rootModule) {
    // The root package was already dumped while parsing the manifest
    const rootModules = new Set(rootPackageMetadata.rootModules || []);
    rootModules.add(toModuleName(rootPackageMetadata.rootModule));
    addPackageModules(
      packageModules,
      [rootPackageMetadata.rootModule],
      rootModules,
    );
  }
  for (const checkoutPkgFile of getAllFiles(
    basePath,
    ".build/checkouts/*/Package.swift",
    options,
  )) {
    const checkoutDir = dirname(checkoutPkgFile);
    const checkoutName = basename(checkoutDir);
    const identity = resolvedAliases[checkoutName] || checkoutName;
    collectFromPackageDir(checkoutDir, [identity, checkoutName]);
  }
  return packageModules;
}

/**
 * Drop module names that belong to test or aggregate targets.
 *
 * @param modules {Set<String>} Candidate module names
 * @param dumpJson {Object} dump-package document
 * @returns {Set<String>} Filtered module names
 */
function filterSwiftModules(modules, dumpJson) {
  const skipped = new Set();
  for (const atarget of dumpJson?.targets || []) {
    if (isSwiftTestTarget(atarget)) {
      skipped.add(toModuleName(atarget.name));
    }
  }
  const filtered = new Set();
  for (const amodule of modules) {
    if (!skipped.has(amodule) && !isTestOrAggregateModule(amodule)) {
      filtered.add(amodule);
    }
  }
  return filtered;
}

/**
 * Point the given compiler arguments at a scratch module cache.
 *
 * The build's own `-module-cache-path` is shared with every compiler
 * invocation that ever touched the project, including other toolchains, and a
 * cache holding modules from a mismatched Swift version makes sourcekitten
 * silently return empty module interfaces. A private cache per evinse run
 * avoids that poisoning at the cost of rebuilding the SDK clang modules once.
 *
 * @param {Array<String>} compilerArgs Compiler arguments
 * @returns {Array<String>} Compiler arguments with an isolated module cache
 */
export function withFreshModuleCache(compilerArgs) {
  const args = [...(compilerArgs || [])];
  const cachePath = safeMkdtempSync(join(getTmpDir(), "swiftsem-cache-"));
  const cacheIndex = args.indexOf("-module-cache-path");
  if (cacheIndex >= 0 && cacheIndex + 1 < args.length) {
    args[cacheIndex + 1] = cachePath;
  } else {
    args.push("-module-cache-path", cachePath);
  }
  return args;
}

/**
 * Create a precise semantics slices file for a swift project.
 *
 * @param basePath basePath Path
 * @param options options CLI options
 */
export function createSemanticsSlices(basePath, options) {
  let compilerArgs = process?.env?.SWIFT_COMPILER_ARGS;
  let sdkArgs = process?.env?.SWIFT_SDK_ARGS;
  const pkgSwiftFiles = getAllFiles(
    basePath,
    `${options.multiProject ? "**/" : ""}Package*.swift`,
    options,
  );
  if (!pkgSwiftFiles.length) {
    return undefined;
  }
  const hasSwiftVersionFile = basePath
    ? safeExistsSync(join(basePath, ".swift-version"))
    : false;
  if (!compilerArgs || !sdkArgs) {
    // We begin by performing a clean verbose debug build to learn the compiler arguments needed for a successful build
    // We do this because most users would not know the compiler arguments themselves!
    const paramsObj = extractCompilerParamsFromBuild(verboseBuild(basePath));
    // Our auto-detection attempt has failed.
    if (!paramsObj) {
      if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
        console.log(
          "Automatic swift build has failed. Check if the appropriate version of swift is installed. Try using the cdxgen container image, which bundles the latest Swift 6 compiler.",
        );
      } else {
        console.log(
          "Automatic swift build has failed. Check if this project is compatible with Swift 5/6 that is bundled with the cdxgen container image.",
        );
      }
      return;
    }
    compilerArgs = withFreshModuleCache(paramsObj.compilerArgs);
    if (paramsObj?.params?.["-sdk"]) {
      sdkArgs = Array.from(paramsObj.params["-sdk"]).join(" ");
    }
    if (DEBUG_MODE && !sdkArgs && !hasSwiftVersionFile) {
      console.log(
        "TIP: Unable to detect the swift sdk needed to build this project. Try running the swift build command to check if this project builds successfully.",
      );
      console.log(
        "Check whether the project requires xcodebuild to build. Such projects are currently unsupported.",
      );
    }
  }
  if (DEBUG_MODE) {
    console.log("Detected swift compiler arguments", compilerArgs);
  }
  // Package.swift file contains useful information needed to understand the semantic context
  // Let's use the dump-package command to retriev this information in json format
  const packageMetadata = parseDumpPackage(dumpPackage(basePath));
  // Map each package (root and dependencies) to the module names it offers so
  // that SBOM components named after the repository can be matched with the
  // differently named modules, e.g. `swift-argument-parser` -> `ArgumentParser`
  const packageModules = collectPackageModules(
    basePath,
    options,
    packageMetadata,
  );
  // Our attempt to build must have yielded some output file maps.
  // These can be used to understand the symbols offered by each of the dependency
  const buildSymbols = collectBuildSymbols(basePath, options);
  // Now let's attempt to learn about each module (internal and external) in detail
  // Information about the classes, protocols, enums, and methods exported by each module is valuable
  const moduleInfos = {};
  // Only modules that were actually built (present in the build artifacts) or
  // referenced by the root package are worth a sourcekitten module-info call;
  // dependency checkouts declare many targets (examples, extra tools) that
  // never take part in this workspace's build
  const allModules = new Set([
    packageMetadata?.rootModule?.trim(),
    ...(packageMetadata?.rootModules || []),
    ...(packageMetadata?.dependencies || []).flatMap((d) =>
      (d.dependsOn || []).map((dep) => dep.trim()),
    ),
    ...Object.keys(buildSymbols),
  ]);
  for (const moduleName of Array.from(allModules)) {
    // Skip the testing modules
    if (
      !moduleName ||
      moduleName?.length === 0 ||
      isTestOrAggregateModule(moduleName)
    ) {
      continue;
    }
    const moduleInfoObj = parseModuleInfo(moduleInfo(moduleName, compilerArgs));
    if (moduleInfoObj) {
      moduleInfos[moduleName] = moduleInfoObj;
    } else if (DEBUG_MODE) {
      console.log(
        "Unable to obtain the semantic context for the module",
        moduleName,
      );
    }
  }
  // Finally, let's do some structural analysis of swift source codes
  const swiftFiles = getAllFiles(basePath, "**/*.swift", options);
  const fileStructures = {};
  const fileIndexes = {};
  for (const afile of swiftFiles) {
    // Skip testing files and package manifests, including version-specific
    // ones such as `Package@swift-5.7.swift`
    if (
      afile.includes("Tests") ||
      /^Package(@.+)?\.swift$/.test(basename(afile))
    ) {
      continue;
    }
    fileStructures[afile] = parseStructure(getStructure(afile));
    fileIndexes[afile] = parseIndex(index(afile, compilerArgs));
  }
  return {
    packageMetadata,
    packageModules,
    buildSymbols,
    moduleInfos,
    fileStructures,
    fileIndexes,
  };
}
