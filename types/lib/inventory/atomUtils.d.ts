/**
 * Platform-specific @appthreat/atom-* native package names that carry the
 * bundled native `atom` binary.
 */
export declare const ATOM_NATIVE_PACKAGES: Set<string>;
/**
 * Locate the JSON compilation database (`compile_commands.json`) of a C/C++
 * project, which lets atom parse each file with the include paths, macros and
 * language its build uses.
 *
 * An explicit `options.compileCommands` (a file, or a directory holding one
 * directly or under `build/`) wins. Otherwise the scan root, `build/`, `out/`,
 * `builddir/`, `cmake-build-*` and the directory of `options.cmakeCache` are
 * searched. A database can come with the code it describes, and atom asks the
 * GCC or Clang driver it names (from the PATH, or an absolute path outside
 * the project) for its predefined macros, so in secure mode only an explicit
 * database is used.
 *
 * @param {string} src Project scan root
 * @param {Object} options CLI options
 * @returns {string|undefined} Absolute path of the database
 */
export declare function findCompileCommands(src: string, options?: Object): string | undefined;
/**
 * The `--frontend-args` keys the installed atom accepts for a language, as
 * `atom --frontend-args-keys -l <language>` lists them. Asked once per atom
 * command and language. An atom that cannot list them (a release without
 * `--frontend-args`, or one that fails to start) accepts none.
 *
 * @param {string} language atom `-l` value
 * @returns {Set<string>} Supported keys
 */
export declare function atomFrontendArgKeys(language: string): Set<string>;
/**
 * The `--frontend-args` atom takes for a C/C++ language: the project's
 * compilation database, when there is one and the installed atom reads it
 * (atom 4 and later). An older atom is given the arguments it has always
 * been given, and parses the sources without the database.
 *
 * @param {string} src Project scan root
 * @param {string} language atom `-l` value
 * @param {Object} options CLI options
 * @returns {string[]} Arguments to add to the atom command
 */
export declare function atomCompileCommandsArgs(src: string, language: string, options?: Object): string[];
/**
 * Convert cdxgen's glob-style exclude patterns to a Scala/Java regex string.
 *
 * @param {string[]} patterns Glob patterns from cdxgen's `--exclude` option
 * @returns {string|undefined} Scala-compatible regex or undefined when empty
 */
export declare function globPatternsToAtomIgnoreRegex(patterns?: string[]): string | undefined;
/**
 * Determine whether a file path is excluded by the given atom-style glob
 * exclude patterns.
 *
 * @param {string} filePath File path to test.
 * @param {string[]} [patterns=[]] Glob exclude patterns.
 * @returns {boolean} True when the path matches an exclude pattern.
 */
export declare function isPathExcludedByGlobPatterns(filePath: string, patterns?: string[]): boolean;
/**
 * Remove atom-slice entries whose source file matches the given glob exclude
 * patterns, preserving the original slice structure otherwise.
 *
 * Filters `objectSlices`, `userDefinedTypes`, `reachables`, and reachable
 * `paths`/`graph` nodes/edges that reference excluded files.
 *
 * @param {object|Array} sliceData Atom slice data object or array.
 * @param {string[]} [patterns=[]] Glob exclude patterns.
 * @returns {object|Array} Filtered slice data (shallow copy when an object).
 */
export declare function filterAtomSlicesByExcludePatterns(sliceData: object | any[], patterns?: string[]): object | any[];
/**
 * Build additional environment variables for Atom from cdxgen CLI options.
 *
 * @param {Object} options CLI options
 * @param {string} language Atom language name
 * @returns {Object} Environment variables to pass to Atom
 */
export declare function buildAtomCommandEnv(options?: Object, language?: string): Object;
/**
 * Resolve the atom platform sub-package name and provider kind for the current
 * (or supplied) runtime. This is a cdxgen-side reimplementation of atom's own
 * `resolveAtomProvider`, kept here rather than imported from
 * `@appthreat/atom/resolve.js` so it is safe under every cdxgen runtime
 * (node, bun, deno, caxa) and inside the extracted caxa tree where the
 * dispatcher's own resolver may not find a sibling sub-package.
 *
 * The returned `preferredPkg`/`kind` pair must agree with atom's
 * `resolveAtomProvider` and `NATIVE_PACKAGES`; the parity test in
 * atomUtils.poku.js asserts the agreement for all eight published triples.
 *
 * @param {Object} [opts] Optional overrides for testability
 * @param {string} [opts.platform] Defaults to `process.platform`
 * @param {string} [opts.arch] Defaults to `process.arch`
 * @param {string} [opts.libc] Defaults to detected libc on linux
 * @returns {{preferredPkg: string, kind: "native"|"jar", platform: string, arch: string, libc?: string}}
 */
export declare function resolveAtomProvider(opts?: {
    platform?: string;
    arch?: string;
    libc?: string;
}): {
    preferredPkg: string;
    kind: "native" | "jar";
    platform: string;
    arch: string;
    libc?: string;
};
/**
 * Returns `"native"` or `"jar"` for the atom provider that will actually run.
 *
 * The platform decides which provider atom prefers, but the dispatcher falls
 * back to the jar package when the platform's native package is not installed
 * (optional dependencies skipped, a failed download). The two take the heap
 * ceiling differently, and a native-image runtime option on a jar run reaches
 * atom as an unknown argument that fails every slice. So the kind follows what
 * is installed where cdxgen can see it: the native binary means native, the jar
 * package without it means jar. With neither in view (a custom `ATOM_CMD`, an
 * install elsewhere) the platform's kind stands.
 *
 * Also used to gate Java/JDK advice, so users on the five native platforms are
 * not told to install a JDK for a failure that has nothing to do with Java.
 */
export declare function atomProviderKind(): "jar" | "native";
/**
 * Locate the `php-parse` binary that the PHP frontend needs.
 *
 * atom 3's dispatcher unconditionally sets `PHP_PARSER_BIN=<ATOM_HOME>/bin/php-parse`,
 * which for a native sub-package does not exist and also clobbers a caller-set
 * value. cdxgen therefore resolves the real location and forwards it through
 * the child env (see `buildAtomCommandEnv`); `executeAtom` then spawns the
 * native binary directly for PHP so the dispatcher cannot clobber it (see
 * `resolveDirectAtomBinaryPath`). Resolution order:
 *   1. explicit `PHP_PARSER_BIN` env var (operators / container images)
 *   2. `@appthreat/atom-parsetools/plugins/bin/php-parse` under cdxgen's own
 *      node_modules, then under `GLOBAL_NODE_MODULES_PATH` for global installs
 *
 * Returns `undefined` when neither is found, in which case PHP analysis runs
 * through the dispatcher unchanged (and fails on native platforms until atom
 * fixes the clobber).
 *
 * @returns {string|undefined}
 */
export declare function resolvePhpParseBin(): string | undefined;
/**
 * Resolve the atom native binary path directly, bypassing the dispatcher.
 *
 * This is required for the PHP frontend: the dispatcher clobbers
 * `PHP_PARSER_BIN` with a path that does not exist on native platforms, and
 * atom 3.0.x crashes in `defaultPhpParserBin` parsing that bogus value before
 * any `--frontend-args php-parser-bin=` override is consulted. Spawning the
 * native binary directly lets cdxgen control the child env, so the correct
 * `PHP_PARSER_BIN` reaches atom. Returns `undefined` when the provider is the
 * jar kind or the native binary cannot be located (in which case the dispatcher
 * is used as-is).
 *
 * @returns {string|undefined}
 */
export declare function resolveDirectAtomBinaryPath(): string | undefined;
/**
 * Retrieves the atom command by referring to various environment variables
 */
export declare function getAtomCommand(): any;
/**
 * Compute the maximum heap atom may grow to, in bytes.
 *
 * Neither of atom's two runtimes bounds itself to anything a machine can
 * comfortably back: a GraalVM native image defaults to
 * `MaximumHeapSizePercent=80` of physical memory, and HotSpot to a quarter of
 * it. Both use a collector that grows the heap in preference to collecting, so
 * on a large host atom reserves tens of gigabytes and the machine, not atom,
 * is what runs out of memory.
 *
 * The ceiling is therefore the smaller of half of physical memory and
 * `ATOM_MAX_HEAP_CAP_BYTES`, with a floor so that a small container still gets
 * a workable heap. `ATOM_MAX_HEAP` overrides the whole calculation and accepts
 * a plain byte count or a `k`/`m`/`g` suffix.
 *
 * @returns {number|undefined} Heap ceiling in bytes, or `undefined` to leave the runtime default in place
 */
export declare function atomMaxHeapBytes(): number | undefined;
/**
 * Compute how long atom may run, and how long cdxgen waits for it.
 *
 * cdxgen's spawn timeout kills only the process cdxgen started, and for atom
 * that is the npm dispatcher. The runtime under it (the native binary or the
 * JVM) used to survive that kill, re-parented and still holding its heap. atom
 * therefore gets its own limit, `ATOM_TIMEOUT`, which the dispatcher enforces on
 * the runtime, and cdxgen's spawn timeout sits a grace period beyond it as the
 * last resort.
 *
 * An explicit `ATOM_TIMEOUT` (milliseconds) sets atom's limit independently of
 * `CDXGEN_TIMEOUT_MS`, which keeps bounding every other tool. Otherwise atom's
 * limit is `CDXGEN_TIMEOUT_MS` less the grace period.
 *
 * @returns {{atomTimeoutMs: number, spawnTimeoutMs: number}} atom's own limit and cdxgen's spawn timeout for it
 */
export declare function atomTimeouts(): {
    atomTimeoutMs: number;
    spawnTimeoutMs: number;
};
/**
 * Whether an atom run ended because it ran out of time.
 *
 * The dispatcher reports its own limit with status 124. cdxgen's spawn timeout
 * shows up as `ETIMEDOUT`. A dispatcher older than the status code stops atom
 * with SIGTERM and exits 1, so status 1 at or past the limit counts as well,
 * unless atom's own output shows it failed for another reason first (an
 * exhausted heap, a crash), which deserves its own diagnosis.
 *
 * @param {Object} result spawnSync result
 * @param {number} elapsedMs How long the run took
 * @param {number} atomTimeoutMs atom's time limit
 * @returns {boolean} true when the run hit a time limit
 */
export declare function atomRunTimedOut(result: Object, elapsedMs: number, atomTimeoutMs: number): boolean;
/**
 * Execute the atom tool against a source directory or file with the given arguments.
 *
 * Resolves the atom binary via `getAtomCommand`, sets up the required environment
 * (including `JAVA_HOME` from `ATOM_JAVA_HOME` if set), and spawns the process.
 * Logs diagnostic messages for common failure modes such as unsupported Java versions,
 * missing `astgen`, and JVM crashes.
 *
 * @param {string} src Path to the source directory or file to analyse
 * @param {string[]} args Arguments to pass to the atom command
 * @param {Object} extra_env Additional environment variables to merge into the process environment
 * @returns {boolean} `true` if atom executed successfully and the language is supported; `false` otherwise
 */
export declare function executeAtom(src: string, args: string[], extra_env?: Object): boolean;
/**
 * The numbered chunks atom wrote beside a reachables slices file.
 *
 * atom writes reachables at most 1000 flows per file: `<base>.json`, then
 * `<base>_1.json`, `<base>_2.json` and so on. Chunks are taken until the first
 * gap. A chunk older than the base file was left by an earlier run with more
 * flows (atom before 4.0.0 did not remove those), so it ends the sequence
 * instead of being merged.
 *
 * @param {string} slicesFile Path of the base reachables slices file
 * @returns {string[]} Chunk file paths, in order
 */
export declare function reachablesChunkFiles(slicesFile: string): string[];
/**
 * Remove the numbered chunks beside a reachables slices file, before atom
 * writes a new set there, so no chunk of an earlier run survives next to it.
 *
 * @param {string} slicesFile Path of the base reachables slices file
 */
export declare function removeReachablesChunkFiles(slicesFile: string): void;
/**
 * Read an atom slices file, or warn and return `undefined` when it cannot be
 * parsed. A run stopped while writing (a timeout, a kill) can leave a
 * truncated file, and the evidence from the other slices is still worth
 * keeping.
 *
 * @param {string} slicesFile Path of the slices file
 * @param {string} sliceType Slice type, for the warning
 * @returns {*} The parsed slices, or `undefined`
 */
export declare function readSlicesFile(slicesFile: string, sliceType: string): any;
/**
 * Read a reachables slices file together with its chunks.
 *
 * Reading only the base file silently dropped every flow past the first
 * thousand. A chunk that cannot be parsed ends the sequence, keeping the flows
 * read before it.
 *
 * @param {string} slicesFile Path of the base reachables slices file
 * @returns {Object[]|Object|undefined} Every flow, in the base file's shape (an array, or an object with `reachables`)
 */
export declare function readReachablesSlices(slicesFile: string): Object[] | Object | undefined;
/**
 * Find the imported modules in the application with atom parsedeps command
 *
 * @param {string} src
 * @param {string} language
 * @param {string} methodology
 * @param {string} slicesFile
 * @param {Object} options CLI options
 * @returns List of imported modules
 */
export declare function findAppModules(src: string, language: string, methodology?: string, slicesFile?: string, options?: Object): any;
//# sourceMappingURL=atomUtils.d.ts.map