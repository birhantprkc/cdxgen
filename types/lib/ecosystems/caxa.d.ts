/**
 * Parse caxa self-extracting executable metadata.
 *
 * @param {string} mfile Path to the caxa metadata file.
 * @returns {Promise<Object>} Parsed metadata object.
 */
export declare function parseCaxaMetadata(mfile: string): Promise<Object>;
/**
 * Complete caxa metadata from the application the binary extracts (or was
 * built from): npm integrity from the lockfile pnpm or npm leaves in
 * node_modules, the native tools a cdxgen plugins manifest describes, with
 * their own dependencies, and the PHP, Ruby and Java packages vendored inside
 * npm packages. Everything found is linked from the npm package whose
 * directory contains it; npm packages that are not in the metadata are
 * ignored.
 *
 * @param {Object} mdata Parsed caxa metadata (see parseCaxaMetadata)
 * @param {string} appDir Directory of the extracted app
 * @returns {Promise<Object>} The metadata, with components and dependencies added
 */
export declare function enrichCaxaMetadataFromApp(mdata: Object, appDir: string): Promise<Object>;
//# sourceMappingURL=caxa.d.ts.map