/**
 * Method to return the gradle command to use.
 *
 * Project-local wrapper scripts (`gradlew`) are attacker-controlled files in
 * the scanned project, so they are only used when dependency tooling is
 * allowed (`options.installDeps !== false`); otherwise the system Gradle is
 * used.
 *
 * @param {string} srcPath Path to look for gradlew wrapper
 * @param {string|null} rootPath Root directory to look for gradlew wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export declare function getGradleCommand(srcPath: string, rootPath: string | null, options?: Object): string;
/**
 * Method to combine the general gradle arguments, the sub-commands and the sub-commands' arguments in the correct way
 *
 * @param {string[]} gradleArguments The general gradle arguments, which must only be added once
 * @param {string[]} gradleSubCommands The sub-commands that are to be executed by gradle
 * @param {string[]} gradleSubCommandArguments The arguments specific to the sub-command(s), which much be added PER sub-command
 * @param {int} gradleCommandLength The length of the full gradle-command
 *
 * @returns {string[]} Array of arrays of arguments to be added to the gradle command
 */
export declare function buildGradleCommandArguments(gradleArguments: string[], gradleSubCommands: string[], gradleSubCommandArguments: string[], gradleCommandLength: int): string[];
/**
 * Method to split the output produced by Gradle using parallel processing by project
 *
 * @param {string} rawOutput Full output produced by Gradle using parallel processing
 * @param {string[]} relevantTasks The list of gradle tasks whose output need to be considered.
 * @returns {map} Map with subProject names as keys and corresponding dependency task outputs as values.
 */
export declare function splitOutputByGradleProjects(rawOutput: string, relevantTasks: string[]): map;
/**
 * Parse gradle projects output
 *
 * @param {string} rawOutput Raw string output
 */
export declare function parseGradleProjects(rawOutput: string): {
    rootProject: string;
    projects: any[];
};
/**
 * Parse gradle properties output
 *
 * @param {string} rawOutput Raw string output
 * @param {string} gradleModuleName The name (or 'path') of the module as seen from the root of the project
 */
export declare function parseGradleProperties(rawOutput: string, gradleModuleName?: string): {
    rootProject: string;
    projects: any[];
    metadata: {
        group: string;
        version: string;
        properties: never[];
    };
};
/**
 * Execute gradle properties command using multi-threading and return parsed output
 *
 * @param {string} dir Directory to execute the command
 * @param {array} allProjectsStr List of all sub-projects (including the preceding `:`)
 * @param {array} extraArgs List of extra arguments to use when calling gradle
 *
 * @returns {string} The combined output for all subprojects of the Gradle properties task
 */
export declare function executeParallelGradleProperties(dir: string, allProjectsStr: array, extraArgs?: array, options?: {}): string;
/**
 * Forget the causes diagnosed so far, so a process that generates more than
 * one BOM diagnoses each run on its own.
 *
 * @returns {void}
 */
export declare function resetGradleFailureCauses(): void;
/**
 * Whether a gradle invocation has already failed outright this run, so a
 * caller can skip reporting a consequence of that failure as its own
 * degradation.
 *
 * @returns {boolean} True once an invocation failure has been recorded.
 */
export declare function hasGradleInvocationFailure(): boolean;
/**
 * Record why a gradle invocation failed. Every failure also records the
 * `jvm.gradle.invocation-failed` degradation so the reflection can rank the
 * repair; version-incompatibility causes additionally record a
 * `tool.mismatch` event naming the versions, which is the fact the report
 * cannot derive from an empty BOM alone. Diagnosis events are recorded once
 * per cause per run; the degradation dedupes in the reflection by id.
 *
 * @param {Object} result The spawnSync result of the failed invocation.
 * @param {Object} context Call-site facts.
 * @param {string} [context.command] The redacted command that was attempted.
 * @param {string} [context.gradleVersion] The gradle version in play, when the caller knows it.
 * @returns {void}
 */
export declare function recordGradleInvocationFailure(result: Object, context?: {
    command?: string;
    gradleVersion?: string;
}): void;
/**
 * Method to resolve dependencies from a gradle output
 *
 * @param {string} rawOutput Text output from gradle dependencies task
 * @param {string} rootProjectName Name of the root project
 * @param {map} gradleModules Cache with all gradle modules that have already been read
 * @param {string} gradleRootPath Root path where Gradle is to be run when getting module information
 */
export declare function parseGradleDep(rawOutput: string, rootProjectName?: string, gradleModules?: map, gradleRootPath?: string): Promise<{
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
} | {
    pkgList?: undefined;
    dependenciesList?: undefined;
}>;
/**
 * Method that handles object creation for gradle modules.
 *
 * @param {string} name The simple name of the module
 * @param {object} metadata Object with all other parsed data for the gradle module
 * @returns {object} An object representing the gradle module in SBOM-format
 */
export declare function buildObjectForGradleModule(name: string, metadata: object): object;
/**
 * Extract Gradle repository URLs from the evaluation output properties.
 *
 * @param {string} propertiesOutput Properties command output containing repository lines
 * @returns {Object} Map of repository names to their URLs
 */
export declare function extractGradleRepositoryUrls(propertiesOutput: string): Object;
/**
 * Parse the distribution URLs resolved by the init script when the
 * `resolve-gradle-distribution` feature flag is enabled. The init script emits lines of
 * the form `<CDXGEN:distribution>:group:name:version -> https://.../name-version.jar`.
 *
 * @param {string} stdout Gradle stdout logs containing the distribution markers
 * @returns {Object} Map of `group:name:version` keys to their resolved distribution URLs
 */
export declare function parseGradleResolvedDistributions(stdout: string): Object;
/**
 * Parse Gradle info logs to capture HTTP URLs of resolved dependency artifacts.
 *
 * @param {string} stdout Gradle stdout logs under --info
 * @returns {Object} Map of filenames to their resolved distribution URLs
 */
export declare function parseGradleInfoLogsForUrls(stdout: string): Object;
/**
 * Collect Gradle project dependencies by scanning the Gradle cache directory for JAR files
 * and their associated POM files.
 *
 * Uses the `GRADLE_CACHE_DIR` or `GRADLE_USER_HOME` environment variables to locate the
 * Gradle files-2.1 cache, then delegates to {@link collectJarNS} to extract namespace
 * and purl information from those JARs.
 *
 * @param {string} _gradleCmd Gradle command (unused; reserved for future use)
 * @param {string} _basePath Base project path (unused; reserved for future use)
 * @param {boolean} _cleanup Whether to clean up temporary files (unused; reserved for future use)
 * @param {boolean} _includeCacheDir Whether to include cache directory (unused; reserved for future use)
 * @returns {Promise<Object>} JAR namespace mapping object returned by collectJarNS
 */
export declare function collectGradleDependencies(_gradleCmd: string, _basePath: string, _cleanup?: boolean, // eslint-disable-line no-unused-vars
_includeCacheDir?: boolean): Promise<Object>;
/**
 * Method to return the mill command to use.
 *
 * The project-local `mill` script is an attacker-controlled file in the
 * scanned project, so it is only used when dependency tooling is allowed
 * (`options.installDeps !== false`).
 *
 * @param {string} srcPath Path to look for mill wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export declare function getMillCommand(srcPath: string, options?: Object): string;
/**
 * Method to return the maven command to use.
 *
 * Project-local wrapper scripts (`mvnw`) are attacker-controlled files in the
 * scanned project, so they are only used when dependency tooling is allowed
 * (`options.installDeps !== false`); otherwise the installed Maven is used.
 *
 * @param {string} srcPath Path to look for maven wrapper
 * @param {string} rootPath Root directory to look for maven wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export declare function getMavenCommand(srcPath: string, rootPath: string, options?: Object): string;
/**
 * Parse a Gradle version catalog (`gradle/libs.versions.toml`).
 *
 * A catalog declares coordinates the build scripts then reference by alias.
 * It is a declaration, not a resolution: entries may go unused, and their
 * versions may be references into the `[versions]` table. Because of that,
 * catalog components are emitted only as a fallback when Gradle itself
 * produced no dependency information, and every component carries a
 * `cdx:gradle:catalog=true` property so consumers can tell declared catalog
 * entries from a resolved graph.
 *
 * Only libraries whose version resolves to a literal (inline or via
 * `version.ref`) are emitted; rich or unresolved versions would produce purls
 * that identify no artifact. Plugins are skipped because they are build-time
 * only.
 *
 * @param {string} catalogFile Path to `libs.versions.toml`
 * @returns {Object[]} Package records for resolvable library entries
 */
export declare function parseGradleVersionCatalog(catalogFile: string): Object[];
//# sourceMappingURL=gradleutils.d.ts.map