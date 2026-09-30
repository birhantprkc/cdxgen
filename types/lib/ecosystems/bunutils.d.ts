/**
 * Split a bun.lock package descriptor (eg `@babel/parser@7.29.7`,
 * `left-pad@1.3.0` or `foo@git+https://github.com/foo/bar#abcdef`) into its
 * group, name and version/specifier components.
 *
 * @param {string} descriptor The `name@specifier` descriptor string.
 * @returns {{group: string, name: string, version: string}} Parsed pieces. The
 *   version is returned verbatim, so non-registry specifiers (git/tarball URLs)
 *   are preserved for the caller to handle.
 */
export declare function parseBunDescriptor(descriptor: string): {
    group: string;
    name: string;
    version: string;
};
/**
 * Parse a bun text lockfile (`bun.lock`, lockfileVersion 1-3; v1 was written
 * by the Zig implementation in bun 1.2.x-1.3.x and v2/v3 by the Rust one in
 * bun 1.4+ - the content shape is identical, only parse strictness changed).
 *
 * Bun's text lockfile is JSONC (JSON with trailing commas). It records the
 * workspace roots under `workspaces` and the fully resolved dependency tree
 * under `packages`, where nested duplicate versions are keyed by their
 * dependency path (eg `"parent/child"`). The entry layout after the leading
 * `"name@version"` descriptor depends on the resolution type (see the
 * Stringifier in bun's bun.lock.rs):
 * - npm: `["name@version", tarballUrlOrEmpty, { dependencies, bin, os, ... }, "sha512-..."]`
 * - git/github: `["name@git+repo", { ... }, ".bun-tag", "sha512-..."]`
 * - tarball/folder/symlink: `["name@url", { ... }, "sha512-..."]`
 * - workspace: `["name@workspace:path"]`
 * so the elements are recognised by shape instead of fixed indices.
 *
 * The binary lockfile (`bun.lockb`) is intentionally not supported - callers
 * should ask users to regenerate it with `bun install --save-text-lockfile`.
 *
 * @param {string} bunLockFile Path to the bun.lock file.
 * @param {Object} [options] Parsing options (`parentComponent`).
 * @returns {Promise<{pkgList: Array, dependenciesList: Array}>} Parsed packages
 *   and dependency graph, matching the shape of the other lockfile parsers.
 */
export declare function parseBunLock(bunLockFile: string, options?: Object): Promise<{
    pkgList: any[];
    dependenciesList: any[];
}>;
//# sourceMappingURL=bunutils.d.ts.map