import { readFileSync } from "node:fs";

import { assert, it } from "poku";

import {
  collectBuildSymbols,
  collectPackageModules,
  extractCompilerParamsFromBuild,
  isTestOrAggregateModule,
  parseDumpPackage,
  parseIndex,
  parseModuleInfo,
  parseOutputFileMap,
  parseStructure,
  parseSwiftBuildManifest,
  parseSwiftResolvedAliases,
  toModuleName,
} from "./swiftsem.js";

it("extractCompilerParamsFromBuild test", () => {
  let paramsObj = extractCompilerParamsFromBuild(
    readFileSync("./test/data/swiftsem/swift-build-output1.txt", {
      encoding: "utf-8",
    }),
  );
  assert.ok(paramsObj.params);
  assert.deepStrictEqual(paramsObj.compilerArgs, [
    "-parse-as-library",
    "-I",
    "/Volumes/Work/sandbox/HAKit/.build/x86_64-apple-macosx/debug/Modules",
    "-I",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib",
    "-target",
    "x86_64-apple-macosx10.14",
    "-enable-testing",
    "-D",
    "SWIFT_PACKAGE",
    "-D",
    "DEBUG",
    "-module-cache-path",
    "/Volumes/Work/sandbox/HAKit/.build/x86_64-apple-macosx/debug/ModuleCache",
    "-swift-version",
    "5",
    "-sdk",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.0.sdk",
    "-F",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Frameworks",
    "-L",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib",
    "-Xcc",
    "-isysroot",
    "-Xcc",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.0.sdk",
    "-Xcc",
    "-F",
    "-Xcc",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Frameworks",
    "-Xcc",
    "-fPIC",
    "-Xcc",
    "-g",
    // The Swift Build support merges the arguments of every driver line, so
    // flags seen only on a secondary module's line are appended
    "-suppress-warnings",
  ]);
  paramsObj = extractCompilerParamsFromBuild(
    readFileSync("./test/data/swiftsem/swift-build-output2.txt", {
      encoding: "utf-8",
    }),
  );
  assert.ok(paramsObj.params);
  assert.deepStrictEqual(paramsObj.compilerArgs, [
    "-target",
    "arm64-apple-macosx10.13",
    "-Xllvm",
    "-aarch64-use-tbi",
    "-sdk",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    "-I",
    "/Users/prabhu/sandbox/swift-docc-symbolkit/.build/arm64-apple-macosx/debug/Modules",
    "-I",
    "/Users/prabhu/Library/Developer/Toolchains/swift-6.2.3-RELEASE.xctoolchain/usr/lib/swift/macosx/testing",
    "-I",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib",
    "-F",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Frameworks",
    "-F",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/PrivateFrameworks",
    "-no-color-diagnostics",
    "-Xcc",
    "-fno-color-diagnostics",
    "-Xcc",
    "-isysroot",
    "-Xcc",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    "-Xcc",
    "-F",
    "-Xcc",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Frameworks",
    "-Xcc",
    "-F",
    "-Xcc",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/PrivateFrameworks",
    "-Xcc",
    "-fPIC",
    "-Xcc",
    "-g",
    "-enable-testing",
    "-module-cache-path",
    "/Users/prabhu/sandbox/swift-docc-symbolkit/.build/arm64-apple-macosx/debug/ModuleCache",
    "-swift-version",
    "5",
    "-D",
    "SWIFT_PACKAGE",
    "-D",
    "DEBUG",
    "-D",
    "SWIFT_MODULE_RESOURCE_BUNDLE_UNAVAILABLE",
    "-plugin-path",
    "/Users/prabhu/Library/Developer/Toolchains/swift-6.2.3-RELEASE.xctoolchain/usr/lib/swift/host/plugins/testing",
    "-plugin-path",
    "/Users/prabhu/Library/Developer/Toolchains/swift-6.2.3-RELEASE.xctoolchain/usr/lib/swift/host/plugins",
    "-plugin-path",
    "/Users/prabhu/Library/Developer/Toolchains/swift-6.2.3-RELEASE.xctoolchain/usr/local/lib/swift/host/plugins",
    "-external-plugin-path",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins#/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/bin/swift-plugin-server",
    "-external-plugin-path",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/local/lib/swift/host/plugins#/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/bin/swift-plugin-server",
    "-parse-as-library",
    // Merged from a secondary module's driver line
    "-L",
    "/Users/prabhu/Library/Developer/Toolchains/swift-6.2.3-RELEASE.xctoolchain/usr/lib/swift/macosx/testing",
    "-L",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib",
  ]);
});

it("parseDumpPackage", () => {
  const metadata = parseDumpPackage(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-dump-package.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.deepStrictEqual(metadata.rootModule, "HAKit");
  assert.deepStrictEqual(metadata.dependencies, [
    {
      dependsOn: ["Starscream"],
      ref: "HAKit",
    },
    {
      dependsOn: ["HAKit", "PromiseKit"],
      ref: "HAKit_PromiseKit",
    },
    {
      dependsOn: ["HAKit"],
      ref: "HAKit_Mocks",
    },
    {
      dependsOn: ["HAKit", "HAKit_PromiseKit", "HAKit_Mocks"],
      ref: "Tests",
    },
  ]);
});

it("collectBuildSymbols", () => {
  const metadata = parseOutputFileMap(
    "./test/data/swiftsem/output-file-map.json",
  );
  assert.deepStrictEqual(metadata, {
    moduleName: "swiftsem",
    moduleSymbols: [
      "Compression",
      "WSCompression",
      "Data_Extensions",
      "Engine",
      "NativeEngine",
      "WSEngine",
      "FoundationHTTPHandler",
      "FoundationHTTPServerHandler",
      "FrameCollector",
      "Framer",
      "HTTPHandler",
      "StringHTTPHandler",
      "FoundationSecurity",
      "Security",
      "Server",
      "WebSocketServer",
      "WebSocket",
      "FoundationTransport",
      "TCPTransport",
      "Transport",
      "resource_bundle_accessor",
    ],
  });
});

it("parseModuleInfo", () => {
  let metadata = parseModuleInfo(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-module-info2.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.classes.length, 13);
  assert.deepStrictEqual(metadata.protocols.length, 25);
  assert.deepStrictEqual(metadata.enums.length, 16);
  assert.deepStrictEqual(metadata.importedModules, [
    "CommonCrypto",
    "Foundation",
    "Network",
    "SwiftOnoneSupport",
    "_Concurrency",
    "_StringProcessing",
    "_SwiftConcurrencyShims",
    "zlib",
  ]);
  metadata = parseModuleInfo(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-module-info.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.classes.length, 8);
  assert.deepStrictEqual(metadata.protocols.length, 14);
  assert.deepStrictEqual(metadata.enums.length, 15);
  assert.deepStrictEqual(metadata.importedModules, [
    "Dispatch",
    "Foundation",
    "Network",
    "Starscream",
    "SwiftOnoneSupport",
    "_Concurrency",
    "_StringProcessing",
    "_SwiftConcurrencyShims",
  ]);
});

it("parseStructure", () => {
  let metadata = parseStructure(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-structure-starscream2.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.referredTypes, [
    "DispatchQueue",
    "Equatable",
    "HAData",
    "HARequestIdentifier",
    "HAResponseController",
    "HAResponseControllerDelegate?",
    "HAResponseControllerPhase",
    "HAWebSocketResponse",
    "Result<(HTTPURLResponse, Data?), Error>",
    "Result<HAData, HAError>",
    "Starscream.WebSocketEvent",
  ]);
  metadata = parseStructure(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-structure-starscream.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.referredTypes, [
    "@escaping () -> Void",
    "@escaping (HACancellable, T) -> Void",
    "@escaping (Result<T, HAError>) -> Void",
    "@escaping (Result<Void, Error>) -> Void",
    "@escaping RequestCompletion",
    "@escaping SubscriptionHandler",
    "@escaping SubscriptionInitiatedHandler",
    "Data",
    "DispatchQueue",
    "Error",
    "HACachesContainer",
    "HACancellable",
    "HAConnection",
    "HAConnectionConfiguration",
    "HAConnectionDelegate?",
    "HAConnectionState",
    "HAHTTPMethod",
    "HAReconnectManager",
    "HAReconnectManagerDelegate",
    "HARequest",
    "HARequestController",
    "HARequestIdentifier",
    "HARequestIdentifier?",
    "HAResponseController",
    "HATypedRequest<T>",
    "HATypedSubscription<T>",
    "Result<T, HAError>",
    "SubscriptionInitiatedHandler?",
    "UInt8",
    "URLSession",
    "WebSocket",
    "WebSocket?",
    "[HAEventType]",
    "[String: Any]",
  ]);
  metadata = parseStructure(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-structure-speech.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.referredTypes, [
    "AVSpeechSynthesizer",
    "AVSpeechSynthesizerDelegate",
    "AVSpeechUtterance",
    "NSObject",
  ]);
  metadata = parseStructure(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-structure-grdb.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.referredTypes, [
    "(URL, URL) throws -> Void",
    "@escaping (GRDBWriteTransaction) throws -> Result<Void, Error>",
    "CaseIterable",
    "Database",
    "DatabaseMigrator",
    "DatabaseMigratorWrapper",
    "DatabaseWriter",
    "GRDBReadTransaction",
    "GRDBWriteTransaction",
    "MigrationId",
    "NSObject",
    "Result<Void, Error>",
    "SDSAnyWriteTransaction",
    "SDSDatabaseStorage",
    "Set<SignalAccount>",
    "SignalRecipient.RowId",
    "StaticString",
    "TSThread",
    "TableAlteration",
    "TableDefinition",
    "UInt",
    "UInt32",
    "URL",
    "UnsafeMutablePointer<ObjCBool>",
    "[SignalServiceAddress: [String]]",
  ]);
});

it("parseIndex", () => {
  let metadata = parseIndex(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-index-starscream.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.ok(metadata.obfuscatedSymbols);
  assert.ok(metadata.symbolLocations);
  assert.deepStrictEqual(metadata.swiftModules, [
    "Combine",
    "CoreFoundation",
    "Darwin",
    "Dispatch",
    "Foundation",
    "ObjectiveC",
    "Observation",
    "Swift",
    "System",
    "_Builtin_float",
    "_Concurrency",
    "_StringProcessing",
    "_errno",
    "_math",
    "_signal",
    "_stdio",
    "_time",
    "sys_time",
    "unistd",
  ]);
  assert.deepStrictEqual(metadata.clangModules, [
    "CoreFoundation",
    "Darwin",
    "Dispatch",
    "Foundation",
    "Mach",
    "ObjectiveC",
    "SwiftShims",
    "_Builtin_float",
    "_SwiftConcurrencyShims",
    "_errno",
    "_math",
    "_signal",
    "_stdio",
    "_time",
    "sys_time",
    "sysdir",
    "timeval",
    "unistd",
    "uuid",
  ]);
  metadata = parseIndex(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-index-starscream2.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.ok(metadata.obfuscatedSymbols);
  assert.ok(metadata.symbolLocations);
  assert.deepStrictEqual(metadata.swiftModules, [
    "Combine",
    "CoreFoundation",
    "Darwin",
    "Dispatch",
    "Foundation",
    "ObjectiveC",
    "Observation",
    "Swift",
    "System",
    "_Builtin_float",
    "_Concurrency",
    "_StringProcessing",
    "_errno",
    "_math",
    "_signal",
    "_stdio",
    "_time",
    "sys_time",
    "unistd",
  ]);
  assert.deepStrictEqual(metadata.clangModules, [
    "CoreFoundation",
    "Darwin",
    "Dispatch",
    "Foundation",
    "Mach",
    "ObjectiveC",
    "SwiftShims",
    "_Builtin_float",
    "_SwiftConcurrencyShims",
    "_errno",
    "_math",
    "_signal",
    "_stdio",
    "_time",
    "sys_time",
    "sysdir",
    "timeval",
    "unistd",
    "uuid",
  ]);

  metadata = parseIndex(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-index-speech.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.ok(metadata.obfuscatedSymbols);
  assert.ok(metadata.symbolLocations);
  assert.deepStrictEqual(metadata.swiftModules, [
    "Swift",
    "_Concurrency",
    "_StringProcessing",
  ]);
  assert.deepStrictEqual(metadata.clangModules, [
    "AVFAudio",
    "SwiftShims",
    "_SwiftConcurrencyShims",
  ]);
});

it("extractCompilerParamsFromBuild handles Swift Build (swiftbuild) verbose output", () => {
  const paramsObj = extractCompilerParamsFromBuild(
    readFileSync("./test/data/swiftsem/swiftbuild-verbose-output.txt", {
      encoding: "utf-8",
    }),
  );
  assert.ok(paramsObj.params);
  const compilerArgs = paramsObj.compilerArgs;
  // The Swift Build engine must contribute the build products include path so
  // sourcekitten can resolve the dependency modules
  assert.ok(
    compilerArgs.some(
      (arg, i) =>
        arg === "-I" &&
        compilerArgs[i + 1].endsWith(".build/out/Products/Debug"),
    ),
  );
  // Clang module maps of C targets such as Yams' CYaml must survive so that
  // mixed C/Swift packages can be indexed
  assert.ok(
    compilerArgs.some(
      (arg, i) =>
        arg === "-Xcc" &&
        compilerArgs[i + 1].startsWith("-fmodule-map-file=") &&
        compilerArgs[i + 1].includes("CYaml"),
    ),
  );
  // Manifest and build-plugin compilations must not leak their arguments
  assert.ok(
    !compilerArgs.some(
      (arg) => arg.includes("pm/ManifestAPI") || arg.includes("pm/PluginAPI"),
    ),
  );
  // `-disable-clang-spi` is rejected by sourcekitten builds linked against
  // older toolchains and is irrelevant for indexing
  assert.ok(!compilerArgs.includes("-disable-clang-spi"));
  assert.ok(compilerArgs.includes("-enable-testing"));
});

it("collectBuildSymbols supports both build engines", () => {
  // Native llbuild file maps, including the `-tool.build` directories that
  // Swift 6.4 emits
  let metadata = parseOutputFileMap(
    "./test/data/swiftsem/build-tree/.build/arm64-apple-macosx/debug/ArgumentParser-tool.build/output-file-map.json",
  );
  assert.deepStrictEqual(metadata.moduleName, "ArgumentParser");
  assert.ok(metadata.moduleSymbols.length > 0);
  metadata = parseOutputFileMap(
    "./test/data/swiftsem/build-tree/.build/arm64-apple-macosx/debug/Yams.build/output-file-map.json",
  );
  assert.deepStrictEqual(metadata.moduleName, "Yams");
  // Swift Build per-target file maps: the file name carries the target name,
  // which must be sanitised into the module name
  metadata = parseOutputFileMap(
    "./test/data/swiftsem/swiftbuild/argparser-demo-OutputFileMap.json",
  );
  assert.deepStrictEqual(metadata.moduleName, "argparser_demo");
  assert.deepStrictEqual(metadata.moduleSymbols, ["main"]);
  metadata = parseOutputFileMap(
    "./test/data/swiftsem/swiftbuild/ArgumentParser-OutputFileMap.json",
  );
  assert.deepStrictEqual(metadata.moduleName, "ArgumentParser");
  assert.ok(metadata.moduleSymbols.length > 40);
  // A tree holding artifacts of both engines yields the union of modules,
  // with test modules skipped and the `-tool` duplicates merged away
  const symbolsMap = collectBuildSymbols("./test/data/swiftsem/build-tree", {});
  assert.deepStrictEqual(Object.keys(symbolsMap).sort(), [
    "ArgumentParser",
    "Yams",
    "argparser_demo",
  ]);
});

it("parseSwiftBuildManifest maps packages to their modules", () => {
  const manifest = parseSwiftBuildManifest(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swiftbuild-manifest.pif", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(manifest?.packageModules);
  const packageModules = manifest.packageModules;
  // swift-argument-parser provides the ArgumentParser module, not a module
  // named after the repository
  assert.ok(packageModules["swift-argument-parser"].includes("ArgumentParser"));
  assert.ok(
    packageModules["swift-argument-parser"].includes("ArgumentParserToolInfo"),
  );
  assert.deepStrictEqual(packageModules["argparser-demo"], ["argparser_demo"]);
  assert.ok(packageModules["yams"].includes("Yams"));
  assert.ok(packageModules["yams"].includes("CYaml"));
  assert.ok(packageModules["swxmlhash"].includes("SWXMLHash"));
  // Aliases are case-insensitive so SBOM components named after the
  // repository (`SWXMLHash`) also resolve
  assert.ok(packageModules["SWXMLHash"].includes("SWXMLHash"));
});

it("collectPackageModules prefers the Swift Build manifest", () => {
  // No `swift` invocation happens when manifest.pif is present
  const packageModules = collectPackageModules(
    "./test/data/swiftsem/build-tree",
    {},
    undefined,
  );
  assert.ok(packageModules["swift-argument-parser"].includes("ArgumentParser"));
  assert.deepStrictEqual(packageModules["argparser-demo"], ["argparser_demo"]);
});

it("parseSwiftResolvedAliases maps identities and repository names", () => {
  // Current pins format
  let aliases = parseSwiftResolvedAliases(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-package-resolved-v3.json", {
        encoding: "utf-8",
      }),
    ),
  ).aliases;
  assert.deepStrictEqual(
    aliases["swift-argument-parser"],
    "swift-argument-parser",
  );
  assert.deepStrictEqual(aliases["SWXMLHash"], "swxmlhash");
  assert.deepStrictEqual(aliases["Yams"], "yams");
  // Legacy object.pins format
  aliases = parseSwiftResolvedAliases(
    JSON.parse(
      readFileSync("./test/data/Package.resolved", {
        encoding: "utf-8",
      }),
    ),
  ).aliases;
  assert.ok(aliases["swift-argument-parser"]);
});

it("parseDumpPackage exposes root modules and product dependencies", () => {
  const metadata = parseDumpPackage(
    JSON.parse(
      readFileSync(
        "./test/data/swiftsem/swift-dump-package-argparser-demo.json",
        {
          encoding: "utf-8",
        },
      ),
    ),
  );
  assert.deepStrictEqual(metadata.rootModule, "argparser-demo");
  // Product dependencies record the product (module) name even though it does
  // not match the package name
  const mainTarget = metadata.dependencies.find(
    (d) => d.ref === "argparser-demo",
  );
  assert.deepStrictEqual(mainTarget.dependsOn, [
    "ArgumentParser",
    "SWXMLHash",
    "Yams",
  ]);
  // Test targets are excluded from the root module list and their module
  // names are sanitised
  assert.deepStrictEqual(metadata.rootModules, ["argparser_demo"]);
});

it("parseModuleInfo collects free functions", () => {
  const metadata = parseModuleInfo(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-module-info-yams.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  // `dump(object:)` is a free function of the Yams module
  assert.ok(metadata.functions.includes("dump"));
  assert.ok(metadata.functions.includes("load"));
  assert.ok(metadata.importedModules.includes("CYaml"));
});

it("module name helpers", () => {
  assert.deepStrictEqual(toModuleName("argparser-demo"), "argparser_demo");
  assert.deepStrictEqual(toModuleName("generate-manual"), "generate_manual");
  assert.deepStrictEqual(toModuleName("Yams"), "Yams");
  assert.strictEqual(isTestOrAggregateModule("argparser_demoTests"), true);
  assert.strictEqual(isTestOrAggregateModule("ArgumentParser"), false);
  assert.strictEqual(isTestOrAggregateModule("SWXMLHash-product"), true);
  assert.strictEqual(
    isTestOrAggregateModule("argparser_demoTests_test_runner"),
    true,
  );
  assert.strictEqual(isTestOrAggregateModule(""), true);
});
