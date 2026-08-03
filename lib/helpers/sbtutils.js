import { constants, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { PackageURL } from "packageurl-js";
import { valid } from "semver";

/**
 * A lightweight parser for Java .properties files, replacing the properties-reader library.
 * Reads the file, parses key-value pairs separated by '=' or ':', and ignores comments.
 *
 * @param {string} filePath Path to the properties file
 * @returns {{ get: (key: string) => string | null }} An object containing a get method
 */
function propertiesReader(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const props = {};
    const lines = content.split(/\r?\n/);
    for (let line of lines) {
      line = line.trim();
      // Skip empty lines and comments starting with '#' or '!'
      if (!line || line.startsWith("#") || line.startsWith("!")) {
        continue;
      }
      const eqIdx = line.indexOf("=");
      const colIdx = line.indexOf(":");
      let sepIdx = -1;
      if (eqIdx !== -1 && colIdx !== -1) {
        sepIdx = Math.min(eqIdx, colIdx);
      } else if (eqIdx !== -1) {
        sepIdx = eqIdx;
      } else if (colIdx !== -1) {
        sepIdx = colIdx;
      }
      if (sepIdx !== -1) {
        const key = line.substring(0, sepIdx).trim();
        const val = line.substring(sepIdx + 1).trim();
        props[key] = val;
      }
    }
    return {
      get: (key) => props[key] ?? null,
    };
  } catch (_err) {
    return {
      get: () => null,
    };
  }
}

import {
  cdxgenAgent,
  DEBUG_MODE,
  getAllFiles,
  multiChecksumFile,
  readEnvironmentVariable,
  safeCopyFileSync,
  safeExistsSync,
  safeUnlinkSync,
  safeWriteSync,
} from "./utils.js";

/**
 * Returns a default location of the plugins file.
 *
 * @param {string} projectPath Path to the SBT project
 */
export function sbtPluginsPath(projectPath) {
  return join(projectPath, "project", "plugins.sbt");
}

/**
 * Determine the version of SBT used in compilation of this project.
 * By default it looks into a standard SBT location i.e.
 * <path-project>/project/build.properties
 * Returns `null` if the version cannot be determined.
 *
 * @param {string} projectPath Path to the SBT project
 */
export function determineSbtVersion(projectPath) {
  const buildPropFile = join(projectPath, "project", "build.properties");
  if (DEBUG_MODE) {
    console.log("Looking for", buildPropFile);
  }
  if (safeExistsSync(buildPropFile)) {
    const properties = propertiesReader(buildPropFile);
    const property = properties.get("sbt.version");
    if (property != null && valid(property)) {
      return property;
    }
  }
  return null;
}

/**
 * Adds a new plugin to the SBT project by amending its plugins list.
 * Only recommended for SBT < 1.2.0 or otherwise use `addPluginSbtFile`
 * parameter.
 * The change manipulates the existing plugins' file by creating a copy of it
 * and returning a path where it is moved to.
 * Once the SBT task is complete one must always call `cleanupPlugin` to remove
 * the modifications made in place.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} plugin Name of the plugin to add
 */
export function addPlugin(projectPath, plugin) {
  const pluginsFile = sbtPluginsPath(projectPath);
  let originalPluginsFile = null;
  if (safeExistsSync(pluginsFile)) {
    originalPluginsFile = `${pluginsFile}.cdxgen`;
    safeCopyFileSync(
      pluginsFile,
      originalPluginsFile,
      constants.COPYFILE_FICLONE,
    );
  }

  safeWriteSync(pluginsFile, plugin, { flag: "a" });
  return originalPluginsFile;
}

/**
 * Cleans up modifications to the project's plugins' file made by the
 * `addPlugin` function.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} originalPluginsFile Location of the original plugins file, if any
 */
export function cleanupPlugin(projectPath, originalPluginsFile) {
  const pluginsFile = sbtPluginsPath(projectPath);
  if (safeExistsSync(pluginsFile)) {
    if (!originalPluginsFile) {
      // just remove the file, it was never there
      safeUnlinkSync(pluginsFile);
      return !safeExistsSync(pluginsFile);
    }
    // Bring back the original file
    safeCopyFileSync(
      originalPluginsFile,
      pluginsFile,
      constants.COPYFILE_FICLONE,
    );
    safeUnlinkSync(originalPluginsFile);
    return true;
  }
  return false;
}

/**
 * Returns the root directory of the local Coursier cache, or null when it
 * cannot be determined or does not exist.
 *
 * @returns {string|null} Absolute path to the cache root
 */
function coursierCacheRoot() {
  const configured = readEnvironmentVariable("COURSIER_CACHE");
  let cacheRoot = configured;
  if (!cacheRoot) {
    const home =
      readEnvironmentVariable("HOME") || readEnvironmentVariable("USERPROFILE");
    if (!home) {
      return null;
    }
    if (process.platform === "darwin") {
      cacheRoot = join(home, "Library", "Caches", "Coursier", "v1");
    } else if (process.platform === "win32") {
      const localAppData = readEnvironmentVariable("LOCALAPPDATA");
      if (localAppData) {
        cacheRoot = join(localAppData, "Coursier", "Cache", "v1");
      } else {
        cacheRoot = join(home, "AppData", "Local", "Coursier", "Cache", "v1");
      }
    } else {
      cacheRoot = join(home, ".cache", "coursier", "v1");
    }
  }
  return safeExistsSync(cacheRoot) ? cacheRoot : null;
}

// Coursier stores an artifact at
// <cacheRoot>/<protocol>/<host>/<repo path...>/<groupPath>/<name>/<version>/,
// so the only unknown part of the path is the repository prefix. Those prefixes
// are enumerated once per cache root with a shallow, depth-bounded scan and then
// probed directly. The previous implementation instead ran a recursive `**` glob
// across the whole cache for every single coordinate - twice, once for the
// registry URL and once for the jar - which costs O(cache size) per lookup
// regardless of whether the artifact is present. On a large shared CI cache that
// turned a few hundred packages into tens of minutes of directory walking.
// See https://github.com/cdxgen/cdxgen/issues/4291
const _repoRootsCache = new Map();

// A repository prefix always starts with <protocol>/<host>, and in practice adds
// at most a couple of path segments ("maven2", "content/repositories/releases").
// The scan stops at this depth so that it never descends into the group-id
// directories, which is where the bulk of a cache lives.
const MAX_REPO_PREFIX_DEPTH = 5;

function coursierRepoRoots(cacheRoot) {
  if (_repoRootsCache.has(cacheRoot)) {
    return _repoRootsCache.get(cacheRoot);
  }
  const roots = [];
  // Breadth-first so that shallower prefixes, which are the more common ones,
  // are probed first.
  let frontier = [[]];
  for (let depth = 1; depth <= MAX_REPO_PREFIX_DEPTH; depth++) {
    const next = [];
    for (const parts of frontier) {
      let entries;
      try {
        entries = readdirSync(join(cacheRoot, ...parts), {
          withFileTypes: true,
        });
      } catch (_err) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const childParts = [...parts, entry.name];
        // <protocol>/<host> is the shortest thing that can be a repository.
        if (depth >= 2) {
          roots.push(childParts);
        }
        next.push(childParts);
      }
    }
    frontier = next;
    if (!frontier.length) {
      break;
    }
  }
  _repoRootsCache.set(cacheRoot, roots);
  return roots;
}

/**
 * Converts a repository prefix in the Coursier cache layout into a URL.
 *
 * @param {string[]} parts Path segments of the prefix, relative to the cache root
 * @returns {string|null} The repository URL
 */
function repoPrefixToUrl(parts) {
  if (!parts || parts.length < 2) {
    return null;
  }
  const protocol = parts[0];
  if (protocol === "file") {
    let localPath = parts.slice(1).join("/");
    if (!localPath.startsWith("/")) {
      localPath = `/${localPath}`;
    }
    return `file://${localPath}`;
  }
  const host = parts[1];
  const repoPath = parts.slice(2).join("/");
  let repoUrl = `${protocol}://${host}`;
  if (repoPath) {
    repoUrl += `/${repoPath}`;
  }
  if (repoUrl.endsWith("/")) {
    repoUrl = repoUrl.substring(0, repoUrl.length - 1);
  }
  return repoUrl;
}

// Memoized so that the registry URL and the jar path for one coordinate cost a
// single lookup between them.
const _coursierLocationCache = new Map();

/**
 * Locate a Maven coordinate in the local Coursier cache.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix if applicable)
 * @param {string} version Package version
 * @returns {{ repoUrl: string, dir: string }|null} The repository URL and the artifact directory
 */
function locateInCoursierCache(group, name, version) {
  if (!group || !name || !version) {
    return null;
  }
  const cacheRoot = coursierCacheRoot();
  if (!cacheRoot) {
    return null;
  }
  // The cache root is part of the key so that a changed COURSIER_CACHE is never
  // answered from a memo built against the previous one.
  const cacheKey = `${cacheRoot}|${group}:${name}:${version}`;
  if (_coursierLocationCache.has(cacheKey)) {
    return _coursierLocationCache.get(cacheKey);
  }
  const groupParts = group.split(".");
  const roots = coursierRepoRoots(cacheRoot);
  let result = null;
  for (let i = 0; i < roots.length; i++) {
    const dir = join(cacheRoot, ...roots[i], ...groupParts, name, version);
    if (safeExistsSync(dir)) {
      const repoUrl = repoPrefixToUrl(roots[i]);
      if (repoUrl) {
        result = { repoUrl, dir };
        // Most coordinates in a build come from the same handful of
        // repositories, so keeping the one that just matched at the front makes
        // the common case a single stat call.
        if (i > 0) {
          roots.unshift(roots.splice(i, 1)[0]);
        }
        break;
      }
    }
  }
  _coursierLocationCache.set(cacheKey, result);
  return result;
}

/**
 * Find the repository URL from the local Coursier cache for a given Maven package.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix if applicable)
 * @param {string} version Package version
 * @returns {string|null} The repository URL or null if not found
 */
export function findCoursierRegistryUrl(group, name, version) {
  return locateInCoursierCache(group, name, version)?.repoUrl || null;
}

/**
 * Test if a given URL exists (returns 2xx/3xx for http/https, or exists on disk for file)
 *
 * @param {string} url URL to test
 * @returns {Promise<boolean>} true if URL exists
 */
export async function testUrlExists(url) {
  if (!url) {
    return false;
  }
  if (url.startsWith("file://")) {
    let localPath = url.substring(7);
    if (process.platform === "win32" && localPath.startsWith("/")) {
      localPath = localPath.substring(1);
    }
    return safeExistsSync(localPath);
  }
  try {
    const response = await cdxgenAgent.head(url, {
      timeout: { request: 3000 },
      retry: { limit: 0 },
      followRedirect: true,
    });
    return response.statusCode >= 200 && response.statusCode < 400;
  } catch (_err) {
    return false;
  }
}

/**
 * Find the local jar path in Coursier cache if it exists.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix)
 * @param {string} version Package version
 * @returns {string|null} local jar path or null
 */
export function findLocalJarPath(group, name, version) {
  const location = locateInCoursierCache(group, name, version);
  if (!location) {
    return null;
  }
  // The conventionally named jar is checked first so that the directory only has
  // to be listed for the unusual layouts.
  const conventional = join(location.dir, `${name}-${version}.jar`);
  if (safeExistsSync(conventional)) {
    return conventional;
  }
  let entries;
  try {
    entries = readdirSync(location.dir);
  } catch (_err) {
    return null;
  }
  for (const entry of entries) {
    // A sources or javadoc jar is not the artifact and must not be hashed as if
    // it were.
    if (
      entry.endsWith(".jar") &&
      !entry.endsWith("-sources.jar") &&
      !entry.endsWith("-javadoc.jar")
    ) {
      return join(location.dir, entry);
    }
  }
  return null;
}

/**
 * Resolves the direct download URL for a Maven jar package if found in the local cache,
 * and validates that the URL exists.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix)
 * @param {string} version Package version
 * @returns {Promise<{ repoUrl: string, jarUrl: string, hashes?: Array }|null>} resolved URLs or null
 */
// Memoization cache for resolveJarDistribution. The sbt dependency tree
// repeats the same coordinates many times (thousands of lines resolving to a
// few hundred unique packages), and each resolution performs recursive globs
// over the Coursier cache plus jar hashing. Without this cache, parsing a
// large tree performed the same expensive lookups over and over, which could
// take many minutes and appear as a hang. See
// https://github.com/cdxgen/cdxgen/issues/4291
const _jarDistributionCache = new Map();

export async function resolveJarDistribution(group, name, version) {
  const cacheKey = `${coursierCacheRoot()}|${group}:${name}:${version}`;
  if (_jarDistributionCache.has(cacheKey)) {
    return _jarDistributionCache.get(cacheKey);
  }
  const repoUrl = findCoursierRegistryUrl(group, name, version);
  if (!repoUrl) {
    _jarDistributionCache.set(cacheKey, null);
    return null;
  }
  const groupPath = group.replace(/\./g, "/");
  const jarUrl = `${repoUrl}/${groupPath}/${name}/${version}/${name}-${version}.jar`;
  const result = { repoUrl, jarUrl };
  const localJarPath = findLocalJarPath(group, name, version);
  if (localJarPath) {
    try {
      const hashValues = await multiChecksumFile(
        ["md5", "sha1", "sha256", "sha512"],
        localJarPath,
      );
      result.hashes = [
        { alg: "MD5", content: hashValues["md5"] },
        { alg: "SHA-1", content: hashValues["sha1"] },
        { alg: "SHA-256", content: hashValues["sha256"] },
        { alg: "SHA-512", content: hashValues["sha512"] },
      ];
    } catch (_err) {
      // ignore
    }
  }
  _jarDistributionCache.set(cacheKey, result);
  return result;
}

/**
 * Parse an sbt dependency tree output file and return the package list and dependency tree.
 *
 * Reads a file produced by the sbt `dependencyTree` command and extracts Maven artifact
 * coordinates, building a hierarchical dependency graph. Evicted packages and ranges are ignored.
 *
 * @param {string} sbtTreeFile Path to the sbt dependency tree output file
 * @returns {{ pkgList: Object[], dependenciesList: Object[] }}
 */
export async function parseSbtTree(sbtTreeFile) {
  const pkgList = [];
  const dependenciesList = [];
  const keys_cache = {};
  const level_trees = {};
  const tmpA = readFileSync(sbtTreeFile, { encoding: "utf-8" }).split("\n");
  let last_level = 0;
  let last_purl = "";
  let stack = [];
  let first_purl = "";
  // Depth of the shallowest node whose subtree is being discarded, so that the
  // transitive dependencies of an evicted version are dropped with it rather
  // than being reparented onto whichever node happened to be emitted last.
  let skipBelowLevel = -1;
  for (let l of tmpA) {
    l = l.replace("\r", "");
    if (!l.trim().length) {
      continue;
    }
    let level = 0;
    const tmpB = l.split("+-");
    if (tmpB.length > 1) {
      level = Math.floor(tmpB[0].length / 2);
    } else if (l.trimStart() !== l) {
      // An indented line without a `+-` marker is a cycle back-reference (`#-`)
      // or the blank spacer sbt emits between sibling groups. Neither is a node
      // and neither may disturb the level bookkeeping.
      continue;
    }
    if (skipBelowLevel >= 0) {
      if (level > skipBelowLevel) {
        continue;
      }
      skipBelowLevel = -1;
    }
    // Ignore evicted packages: the version that won the conflict is listed
    // separately, so the evicted node and everything under it is noise.
    // | +-org.scala-lang:scala3-library_3:3.1.3 (evicted by: 3.3.0)
    if (l.includes("(evicted")) {
      skipBelowLevel = level;
      continue;
    }
    let isLibrary = false;
    if (l.endsWith("[S]")) {
      isLibrary = true;
    }
    const pkgLine = tmpB[tmpB.length - 1].split(" ")[0];
    if (!pkgLine.includes(":")) {
      continue;
    }
    // A version range rather than a resolved version, and a coordinate that the
    // ascii graph truncated because it did not fit the configured width, are both
    // unusable. Emitting them would produce a component with a bogus version - or,
    // when the truncation cut into the artifact id, an invalid purl.
    // | | | | | | +-org.eclipse.platform:org.eclipse.equinox.common:[3.15.100,4.0...
    // | | | | | +-com.fasterxml.jackson.module:jackson-module-jakarta-xmlbind-anno..
    if (
      pkgLine.includes(",") ||
      pkgLine.includes("[") ||
      pkgLine.endsWith("..")
    ) {
      skipBelowLevel = level;
      continue;
    }
    const pkgParts = pkgLine.split(":");
    let group = "";
    let name = "";
    let version = "";
    if (pkgParts.length === 3) {
      group = pkgParts[0];
      name = pkgParts[1];
      version = pkgParts[2];
    }
    // A maven purl requires a namespace, so a coordinate that did not yield all
    // three parts is skipped rather than turned into an invalid component.
    if (!group.length || !name.length || !version.length) {
      if (DEBUG_MODE) {
        console.log(pkgLine, "was not parsed correctly!");
      }
      skipBelowLevel = level;
      continue;
    }
    const originalName = name;
    const scalaSuffixRegex = /_(2\.\d+|3)$/;
    const match = name.match(scalaSuffixRegex);
    let compilerVersion = null;
    if (match) {
      compilerVersion = match[1];
      name = name.replace(scalaSuffixRegex, "");
    }
    const distInfo = await resolveJarDistribution(group, originalName, version);
    const qualifiers = { type: "jar" };
    if (distInfo && !distInfo.repoUrl.startsWith("file://")) {
      qualifiers.repository_url = distInfo.repoUrl;
    }
    const purlString = new PackageURL(
      "maven",
      group,
      name,
      version,
      qualifiers,
      null,
    ).toString();
    // The dependency graph has to be keyed on the same string the components use
    // as their `bom-ref`. `repository_url` percent-encodes the `//` of the
    // repository URL, so using the raw purl here left every cached package with a
    // ref that matched no component and the whole tree was dropped downstream.
    // See https://github.com/cdxgen/cdxgen/issues/4291
    const bomRef = decodeURIComponent(purlString);
    // Filter duplicates
    if (!keys_cache[purlString]) {
      const adep = {
        group,
        name,
        version,
        purl: purlString,
        "bom-ref": bomRef,
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
            concludedValue: purlString,
            methods: [
              {
                technique: "manifest-analysis",
                confidence: 1,
                value: sbtTreeFile,
              },
            ],
          },
        },
      };
      if (isLibrary) {
        adep["type"] = "library";
      }
      const props = [];
      if (compilerVersion) {
        props.push({
          name: "cdx:scala:compilerVersion",
          value: compilerVersion,
        });
      }
      if (props.length > 0) {
        adep.properties = props;
      }
      if (distInfo) {
        if (!distInfo.jarUrl.startsWith("file://")) {
          adep.externalReferences = [
            {
              type: "distribution",
              url: distInfo.jarUrl,
            },
          ];
        }
        if (distInfo.hashes) {
          adep.hashes = distInfo.hashes;
        }
      }
      pkgList.push(adep);
      keys_cache[purlString] = true;
    }
    // From here the logic is similar to parsing gradle tree
    if (!level_trees[bomRef]) {
      level_trees[bomRef] = [];
    }
    if (level === 0) {
      first_purl = bomRef;
      stack = [bomRef];
    } else if (last_purl === "") {
      stack.push(bomRef);
    } else if (level > last_level) {
      const cnodes = level_trees[last_purl] || [];
      if (!cnodes.includes(bomRef)) {
        cnodes.push(bomRef);
      }
      level_trees[last_purl] = cnodes;
      if (stack[stack.length - 1] !== bomRef) {
        stack.push(bomRef);
      }
    } else {
      for (let i = 0; i < last_level - level + 1; i++) {
        stack.pop();
      }
      const last_stack =
        stack.length > 0 ? stack[stack.length - 1] : first_purl;
      const cnodes = level_trees[last_stack] || [];
      if (!cnodes.includes(bomRef)) {
        cnodes.push(bomRef);
      }
      level_trees[last_stack] = cnodes;
      stack.push(bomRef);
    }
    last_level = level;
    last_purl = bomRef;
  }
  for (const lk of Object.keys(level_trees)) {
    dependenciesList.push({
      ref: lk,
      dependsOn: [...new Set(level_trees[lk])].sort(),
    });
  }
  return { pkgList, dependenciesList };
}

/**
 * Parse sbt lock file
 *
 * @param {string} pkgLockFile build.sbt.lock file
 */
export async function parseSbtLock(pkgLockFile) {
  const pkgList = [];
  if (safeExistsSync(pkgLockFile)) {
    const lockData = JSON.parse(
      readFileSync(pkgLockFile, { encoding: "utf-8" }),
    );
    if (lockData?.dependencies) {
      for (const pkg of lockData.dependencies) {
        const artifacts = pkg.artifacts || undefined;
        let integrity = "";
        if (artifacts?.length) {
          integrity = artifacts[0].hash.replace("sha1:", "sha1-");
        }
        let compScope;
        if (pkg.configurations) {
          if (pkg.configurations.includes("runtime")) {
            compScope = "required";
          } else {
            compScope = "optional";
          }
        }
        const originalName = pkg.name;
        let name = pkg.name;
        const scalaSuffixRegex = /_(2\.\d+|3)$/;
        const match = name.match(scalaSuffixRegex);
        let compilerVersion = null;
        if (match) {
          compilerVersion = match[1];
          name = name.replace(scalaSuffixRegex, "");
        }
        const distInfo = await resolveJarDistribution(
          pkg.org,
          originalName,
          pkg.version,
        );
        const props = [
          {
            name: "SrcFile",
            value: pkgLockFile,
          },
        ];
        if (compilerVersion) {
          props.push({
            name: "cdx:scala:compilerVersion",
            value: compilerVersion,
          });
        }
        const qualifiers = { type: "jar" };
        if (distInfo && !distInfo.repoUrl.startsWith("file://")) {
          qualifiers.repository_url = distInfo.repoUrl;
        }
        const purlString = new PackageURL(
          "maven",
          pkg.org,
          name,
          pkg.version,
          qualifiers,
          null,
        ).toString();
        const adep = {
          group: pkg.org,
          name,
          version: pkg.version,
          _integrity: integrity,
          scope: compScope,
          properties: props,
          purl: purlString,
          "bom-ref": decodeURIComponent(purlString),
          evidence: {
            identity: {
              field: "purl",
              confidence: 1,
              concludedValue: purlString,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: pkgLockFile,
                },
              ],
            },
          },
        };
        if (distInfo) {
          if (!distInfo.jarUrl.startsWith("file://")) {
            adep.externalReferences = [
              {
                type: "distribution",
                url: distInfo.jarUrl,
              },
            ];
          }
          if (distInfo.hashes) {
            adep.hashes = distInfo.hashes;
          }
        }
        pkgList.push(adep);
      }
    }
  }
  return pkgList;
}

/**
 * Parse the root build.sbt to extract the aggregate project name, organization, and version.
 *
 * @param {string} projectPath Directory path of the project
 * @returns {{ name: string, group: string, version: string }|null}
 */
export function parseSbtRootProject(projectPath) {
  const buildSbt = join(projectPath, "build.sbt");
  if (!safeExistsSync(buildSbt)) {
    return null;
  }
  try {
    const content = readFileSync(buildSbt, { encoding: "utf-8" });
    const nameMatch = content.match(/^name\s*:=\s*"([^"]+)"/m);
    const orgMatch = content.match(
      /ThisBuild\s*\/\s*organization\s*:=\s*"([^"]+)"/m,
    );
    const versionMatch = content.match(
      /ThisBuild\s*\/\s*version\s*:=\s*"([^"]+)"/m,
    );
    if (!nameMatch || !versionMatch) {
      return null;
    }
    return {
      name: nameMatch[1],
      group: orgMatch ? orgMatch[1] : "",
      version: versionMatch[1],
    };
  } catch (_err) {
    return null;
  }
}

/**
 * Discover SBT subproject names statically by parsing build.sbt and project files.
 *
 * @param {string} projectPath Directory path of the project
 * @returns {string[]} List of discovered subproject names
 */
export function discoverSbtProjects(projectPath) {
  const projects = new Set();
  const sbtFiles = getAllFiles(projectPath, "**/*.sbt");
  const scalaFiles = getAllFiles(projectPath, "project/**/*.scala");
  const allFiles = [...sbtFiles, ...scalaFiles];

  const projectRegex =
    /(?:lazy\s+val|val)\s+([a-zA-Z0-9_-]+)\s*=\s*(?:project|Projects\.|(project\s+in))/g;

  for (const file of allFiles) {
    try {
      const content = readFileSync(file, { encoding: "utf-8" });
      let match;
      projectRegex.lastIndex = 0;
      while ((match = projectRegex.exec(content)) !== null) {
        const projName = match[1].trim();
        if (projName && projName !== "root") {
          projects.add(projName);
        }
      }
    } catch (_err) {
      // ignore
    }
  }
  return [...projects];
}

/**
 * Parse the output of the sbt `projects` command to extract the real project
 * identifiers as understood by sbt. This is more accurate than scraping the
 * build files with a regex (see {@link discoverSbtProjects}), since it relies
 * on sbt's own project resolution and therefore avoids false positives from
 * commented-out code, examples or values that merely look like project
 * definitions.
 *
 * A typical `sbt projects` output looks like:
 *
 * ```
 * [info] In file:/path/to/build/
 * [info] 	   * chen
 * [info] 	     platform
 * [info] 	     dataflowengineoss
 * ```
 *
 * The project marked with `*` is the currently selected (usually the
 * aggregating root) project.
 *
 * @param {string} stdout Raw stdout captured from `sbt projects`
 * @returns {{projects: string[], root: string | undefined}} The discovered
 *  project ids and the currently selected (root) project id, if any.
 */
export function parseSbtProjects(stdout) {
  const projects = [];
  let root;
  if (!stdout) {
    return { projects, root };
  }
  const lines = stdout.split(/\r?\n/);
  // Matches lines such as `[info]    * name` or `[info]      name`.
  // The optional `[info]` prefix is stripped first so we can tolerate
  // different sbt log levels/formats.
  const projectLineRegex = /^(\*)?\s*([a-zA-Z0-9_.-]+)\s*$/;
  let inProjectsBlock = false;
  for (const rawLine of lines) {
    // Strip the leading `[info]`/`[warn]` log prefix, if any.
    const line = rawLine.replace(/^\[[a-z]+\]\s?/i, "");
    if (/^In\s+\S+/.test(line.trim())) {
      inProjectsBlock = true;
      continue;
    }
    if (!inProjectsBlock) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      // A blank line terminates the projects listing.
      break;
    }
    const match = projectLineRegex.exec(trimmed);
    if (!match) {
      continue;
    }
    const isCurrent = Boolean(match[1]);
    const projName = match[2];
    if (!projName || projName === "info" || projName === "warn") {
      continue;
    }
    projects.push(projName);
    if (isCurrent) {
      root = projName;
    }
  }
  return { projects, root };
}

/**
 * Parse plugins.sbt files to extract sbt plugins as development dependencies.
 *
 * @param {string} projectPath Directory path of the project
 * @returns {Object[]} List of parsed dependency components
 */
export function parseSbtPlugins(projectPath) {
  const plugins = [];
  const pluginFiles = getAllFiles(projectPath, "**/plugins.sbt");

  const pluginRegex =
    /addSbtPlugin\(\s*(["'])([^"'\s]+)\1\s*(%%?)\s*(["'])([^"'\s]+)\4\s*%\s*(["'])([^"'\s]+)\6\s*\)/g;

  for (const file of pluginFiles) {
    try {
      const content = readFileSync(file, { encoding: "utf-8" });
      let match;
      pluginRegex.lastIndex = 0;
      while ((match = pluginRegex.exec(content)) !== null) {
        const group = match[2];
        const name = match[5];
        const version = match[7];
        const purl = `pkg:maven/${group}/${name}@${version}?type=jar`;

        const adep = {
          group,
          name,
          version,
          purl,
          "bom-ref": decodeURIComponent(purl),
          scope: "optional",
          properties: [
            {
              name: "cdx:sbt:package:development",
              value: "true",
            },
          ],
          evidence: {
            identity: {
              field: "purl",
              confidence: 1,
              concludedValue: purl,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: file,
                },
              ],
            },
          },
        };
        plugins.push(adep);
      }
    } catch (_err) {
      // ignore
    }
  }
  return plugins;
}
