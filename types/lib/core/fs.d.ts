import { Buffer } from "node:buffer";
/**
 * Safely check if a file path exists without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @Boolean True if the path exists. False otherwise
 */
export declare function safeExistsSync(filePath: string): any;
/**
 * Permission-aware check for whether a path exists and carries the executable
 * bit for the current user. Answers false instead of throwing when the path
 * is absent, unreadable, or blocked by secure mode.
 *
 * @param {string} filePath File path to check.
 * @returns {boolean} True when the path exists and is executable.
 */
export declare function safeIsExecutableSync(filePath: string): boolean;
/**
 * Permission- and dry-run-aware wrapper around writeFileSync. Records the
 * activity and returns undefined when blocked.
 *
 * @param {string} filePath File path to write.
 * @param {string|Buffer} data Data to write.
 * @param {Object} [options] writeFileSync options (encoding, mode, flag).
 * @returns {void}
 */
export declare function safeWriteSync(filePath: string, data: string | Buffer, options?: Object): void;
/**
 * Permission-aware wrapper around readFileSync that returns undefined instead
 * of throwing. Reads are allowed in dry-run mode, so unlike the write wrappers
 * this only guards secure-mode read permission; the read itself is not recorded
 * in the activity ledger because inspection of classified paths is already
 * recorded by safeExistsSync and a read has no side effect to audit.
 *
 * @param {string} filePath File path to read.
 * @param {Object|string} [options] readFileSync options; defaults to UTF-8 text.
 * @returns {string|Buffer|undefined} File content, or undefined when the path cannot be read.
 */
export declare function safeReadFileSync(filePath: string, options?: Object | string): string | Buffer | undefined;
/**
 * Safely create a directory without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @param options {Options} mkdir options
 * @Boolean True if the path exists. False otherwise
 */
export declare function safeMkdirSync(filePath: string, options: Options): undefined;
/**
 * Dry-run-aware wrapper around mkdtempSync that records the activity. In dry-run
 * mode, returns a synthetic path without touching the filesystem.
 *
 * @param {string} prefix Path prefix for the temporary directory.
 * @param {string|Object} [options] Encoding or mkdtempSync options.
 * @returns {string|undefined} The created directory path, a synthetic path in dry-run mode, or undefined when blocked.
 */
export declare function safeMkdtempSync(prefix: string, options?: string | Object): string | undefined;
/**
 * Dry-run-aware wrapper around rmSync. Records the activity and returns
 * undefined when blocked.
 *
 * @param {string} filePath Path to remove.
 * @param {Object} [options] rmSync options (recursive, force, etc.).
 * @returns {void}
 */
export declare function safeRmSync(filePath: string, options?: Object): void;
/**
 * Dry-run-aware wrapper around unlinkSync. Records the activity and returns
 * undefined when blocked.
 *
 * @param {string} filePath File path to unlink.
 * @returns {void}
 */
export declare function safeUnlinkSync(filePath: string): void;
/**
 * Dry-run-aware wrapper around copyFileSync. Records the activity and returns
 * undefined when blocked.
 *
 * @param {string} src Source file path.
 * @param {string} dest Destination file path.
 * @param {number} [mode] Optional copy mode bitmask.
 * @returns {void}
 */
export declare function safeCopyFileSync(src: string, dest: string, mode?: number): void;
/**
 * Run an archive extractor under dry-run/debug activity tracing. In dry-run
 * mode the extraction is recorded as blocked and resolves false without running.
 *
 * @param {string} sourcePath Path to the source archive.
 * @param {string} targetPath Path to extract into.
 * @param {() => Promise} extractor Async function performing the extraction.
 * @param {string} [kind="unzip"] Archive kind label for tracing.
 * @param {Object} [options] Optional tracing metadata, blockedReason, and failureReason.
 * @returns {Promise<boolean>} True when extraction succeeded, false when blocked by dry-run.
 */
export declare function safeExtractArchive(sourcePath: string, targetPath: string, extractor: () => Promise<any>, kind?: string, options?: Object): Promise<boolean>;
/** Set of temporary file paths written by cdxgen that are removed on process exit. */
export declare const temporaryFiles: Set<any>;
/** Set accumulating every executable command spawned via safeSpawnSync. */
export declare const commandsExecuted: Set<any>;
/**
 * Safe wrapper around spawnSync that enforces permission checks, injects default
 * options (maxBuffer, encoding, timeout), warns about unsafe Python and pip/uv
 * invocations, and records every executed command in the commandsExecuted set.
 *
 * @param {string} command The executable to spawn
 * @param {string[]} args Arguments to pass to the command
 * @param {Object} options Options forwarded to spawnSync (e.g. cwd, env, shell)
 * @returns {Object} spawnSync result object with status, stdout, stderr, and error fields
 */
export declare function safeSpawnSync(command: string, args: string[], options: Object): Object;
/** Default spawn timeout in milliseconds (20 minutes), overridable via CDXGEN_TIMEOUT_MS. */
export declare const TIMEOUT_MS: number;
/** Default maxBuffer size for spawned process stdout/stderr (100 MB), overridable via CDXGEN_MAX_BUFFER. */
export declare const MAX_BUFFER: number;
/**
 * Method to get files matching a pattern
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Object} options CLI options
 *
 * @returns {Array[string]} List of matched files
 */
export declare function getAllFiles(dirPath: string, pattern: string, options?: Object): any;
/**
 * Confine directory-walk caching to one subtree, or switch it off.
 *
 * @param {string|undefined} rootDir Subtree whose contents are fixed for the rest of the scan
 */
export declare function setDirWalkCacheRoot(rootDir: string | undefined): void;
/**
 * Release every cached directory walk.
 *
 * Called when a BOM generation cycle starts, so that a long-lived process such
 * as the server never serves a scan from an earlier scan's view of the
 * filesystem, and so the retained directory entries are freed.
 */
export declare function clearFileDiscoveryCache(): void;
/**
 * Method to get files matching a pattern
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Boolean} includeDot whether hidden files can be included.
 * @param {Array} ignoreList Directory patterns to ignore
 *
 * @returns {Array[string]} List of matched files
 */
export declare function getAllFilesWithIgnore(dirPath: string, pattern: string, includeDot: boolean, ignoreList: any[]): any;
/**
 * Return the current timestamp in YYYY-MM-DDTHH:MM:SSZ format.
 *
 * @returns {string} ISO formatted timestamp, without milliseconds.
 */
export declare function getTimestamp(): string;
/**
 * Return the temp directory, creating CDXGEN_TEMP_DIR when it is set but does
 * not yet exist. Falls back to the OS tmpdir when unset.
 *
 * @returns {string} Resolved temp directory path.
 */
export declare function getTmpDir(): string;
/**
 * Computes the checksum for a file path using the given hash algorithm
 *
 * @param {string} hashName name of hash algorithm
 * @param {string} path path to file
 * @returns {Promise<String>} hex value of hash
 */
export declare function checksumFile(hashName: string, path: string): Promise<string>;
/**
 * Computes multiple checksum for a file path using the given hash algorithms
 *
 * @param {Array[String]} algorithms Array of algorithms
 * @param {string} path path to file
 * @returns {Promise<Object>} hashes object
 */
export declare function multiChecksumFile(algorithms: any, path: string): Promise<Object>;
//# sourceMappingURL=fs.d.ts.map