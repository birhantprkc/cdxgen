import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { build } from "@cdxgen/cdx-purl";

import { DEBUG_MODE } from "../core/activity.js";
import { DOTNET_CMD } from "../core/env.js";
import { safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { isWin } from "../core/paths.js";
import { readZipEntry } from "../inventory/deps.js";
import { applyPurl, concreteVersion, nugetPurl } from "../inventory/purl.js";
import { findLicenseId } from "../inventory/spdx.js";
import { xml2js } from "../parsers/xml.js";
import { extractPackageInfoFromHintPath } from "./dotnetutils.js";

/**
 * Apply a version to a NuGet component so that the `version` field and the purl
 * always agree.
 *
 * A .NET manifest can state a version that is not a version: an MSBuild property
 * such as `$(JsonVersion)`, a range such as `[3.13.3,4.0)`, a wildcard such as
 * `2.0.*`, or nothing at all. Such a declaration cannot go into a purl, so a
 * component that kept it in `version` while its purl carried none described one
 * package two ways. A scanner range matching on the versionless purl then reports
 * every advisory published against the package name.
 *
 * The declaration is not lost: callers record it as `cdx:nuget:declared_version_range`.
 *
 * @param {Object} pkg Component to update in place. `name` must already be set.
 * @param {String} [version] Version as stated or resolved, concrete or not
 *
 * @returns {Object} The same component
 */
export function applyNugetVersion(pkg, version) {
  const concrete = concreteVersion(version);
  if (concrete) {
    pkg.version = concrete;
  } else {
    delete pkg.version;
  }
  return applyPurl(pkg, nugetPurl(pkg.name, concrete));
}

/**
 * Method to parse .nupkg files
 *
 * @param {String} nupkgFile .nupkg file
 * @returns {Object} Object containing package list and dependencies
 */
export async function parseNupkg(nupkgFile) {
  let nuspecData = await readZipEntry(nupkgFile, ".nuspec");
  if (!nuspecData) {
    return [];
  }
  if (nuspecData.charCodeAt(0) === 65533) {
    nuspecData = await readZipEntry(nupkgFile, ".nuspec", "ucs2");
  }
  return parseNuspecData(nupkgFile, nuspecData);
}

/**
 * Method to parse .nuspec files
 *
 * @param {String} nupkgFile .nupkg file
 * @param {String} nuspecData Raw nuspec data
 * @returns {Object} Object containing package list and dependencies
 */
export function parseNuspecData(nupkgFile, nuspecData) {
  const pkgList = [];
  const pkg = { group: "" };
  let npkg;
  const dependenciesMap = {};
  const addedMap = {};
  try {
    npkg = xml2js(nuspecData, {
      compact: true,
      alwaysArray: false,
      spaces: 4,
      textKey: "_",
      attributesKey: "$",
      commentKey: "value",
    }).package;
  } catch (_e) {
    // If we are parsing with invalid encoding, unicode replacement character is used
    if (nuspecData.charCodeAt(0) === 65533) {
      console.log(`Unable to parse ${nupkgFile} in utf-8 mode`);
    } else {
      console.log(
        "Unable to parse this package. Tried utf-8 and ucs2 encoding.",
      );
    }
  }
  if (!npkg) {
    return {
      pkgList,
      dependenciesMap,
    };
  }
  const m = npkg.metadata;
  pkg.name = m.id._;
  pkg.version = m.version._;
  pkg.description = m.description._;
  applyPurl(pkg, nugetPurl(pkg.name, pkg.version));
  if (m.licenseUrl) {
    pkg.license = findLicenseId(m.licenseUrl._);
  }
  if (m.authors) {
    pkg.author = m.authors._;
  }
  pkg.properties = [
    {
      name: "internal:SrcFile",
      value: nupkgFile,
    },
  ];
  pkg.evidence = {
    identity: {
      field: "purl",
      confidence: 1,
      methods: [
        {
          technique: "binary-analysis",
          confidence: 1,
          value: nupkgFile,
        },
      ],
    },
  };
  pkg.scope = "required";
  pkgList.push(pkg);
  if (m?.dependencies?.dependency) {
    const dependsOn = [];
    if (Array.isArray(m.dependencies.dependency)) {
      for (const adep of m.dependencies.dependency) {
        const d = adep.$;
        dependsOn.push(d.id);
      }
    } else {
      const d = m.dependencies.dependency.$;
      dependsOn.push(d.id);
    }
    dependenciesMap[pkg["bom-ref"]] = dependsOn;
  } else if (m?.dependencies?.group) {
    let dependencyGroups;
    if (Array.isArray(m.dependencies.group)) {
      dependencyGroups = m.dependencies.group;
    } else {
      dependencyGroups = [m.dependencies.group];
    }
    const dependsOn = [];
    for (const agroup of dependencyGroups) {
      let targetFramework;
      if (agroup?.$?.targetFramework) {
        targetFramework = agroup.$.targetFramework;
      }
      if (agroup?.dependency) {
        let groupDependencies = [];
        // This dependency can be an array or object
        if (Array.isArray(agroup.dependency)) {
          groupDependencies = agroup.dependency;
        } else if (agroup?.dependency?.$) {
          groupDependencies = [agroup.dependency];
        }
        for (let agroupdep of groupDependencies) {
          agroupdep = agroupdep.$;
          const groupPkg = {};
          if (!agroupdep.id) {
            continue;
          }
          groupPkg.name = agroupdep.id;
          let declaredRange;
          if (agroupdep?.version) {
            let versionStr = agroupdep.version;
            // version could have square brackets around them
            if (versionStr.startsWith("[") && versionStr.endsWith("]")) {
              versionStr = versionStr.replace(/[\[\]]/g, "");
            }
            // A nuspec dependency states the range the package accepts, not the
            // version installed. Anything that is not a single version stays a
            // declaration so the component and its purl agree - #4359.
            if (!concreteVersion(versionStr)) {
              declaredRange = agroupdep.version;
            }
            applyNugetVersion(groupPkg, versionStr);
          } else {
            applyNugetVersion(groupPkg);
          }
          groupPkg.scope = "optional";
          groupPkg.properties = [
            {
              name: "internal:SrcFile",
              value: nupkgFile,
            },
          ];
          if (declaredRange) {
            groupPkg.properties.push({
              name: "cdx:nuget:declared_version_range",
              value: declaredRange,
            });
          }
          if (targetFramework) {
            groupPkg.properties.push({
              name: "cdx:dotnet:target_framework",
              value: targetFramework,
            });
          }
          groupPkg.evidence = {
            identity: {
              field: "purl",
              confidence: 0.7,
              methods: [
                {
                  technique: "binary-analysis",
                  confidence: 1,
                  value: nupkgFile,
                },
              ],
            },
          };
          pkgList.push(groupPkg);
          if (!addedMap[groupPkg.purl]) {
            dependsOn.push(groupPkg.name);
            addedMap[groupPkg.purl] = true;
          }
        } // for
      } // group dependency block
      dependenciesMap[pkg["bom-ref"]] = dependsOn;
    } // for
  }
  return {
    pkgList,
    dependenciesMap,
  };
}

/**
 * Parse a C# packages.config XML file and return a list of NuGet package components.
 *
 * @param {string} pkgData Raw XML string of a packages.config file
 * @param {string} pkgFile Path to the packages.config file, used for evidence properties
 * @param {Object} pkgNameVersions Package name - version map of versions already resolved
 *        from more precise manifests (project.assets.json / packages.lock.json), used to
 *        backfill templated or missing versions
 * @returns {Object[]} Array of NuGet package objects with purl, name, and version
 */
export function parseCsPkgData(pkgData, pkgFile, pkgNameVersions = {}) {
  const pkgList = [];
  if (!pkgData) {
    return pkgList;
  }
  // Remove byte order mark
  if (pkgData.charCodeAt(0) === 0xfeff) {
    pkgData = pkgData.slice(1);
  }
  let packages = xml2js(pkgData, {
    compact: true,
    alwaysArray: true,
    spaces: 4,
    textKey: "_",
    attributesKey: "$",
    commentKey: "value",
  }).packages;
  if (!packages || packages.length === 0) {
    return pkgList;
  }
  packages = packages[0].package;
  for (const i in packages) {
    const p = packages[i].$;
    const pkg = { group: "" };
    pkg.name = p.id;
    pkg.version = p.version;
    // packages.config versions can be imprecise: missing entirely, templated
    // msbuild properties such as $(FooVersion), NuGet ranges such as [1.0,2.0),
    // or wildcards such as 1.0.*. Track such packages at a lower confidence.
    let confidence = 0.7;
    // A bracketed single version such as [4.4.1] pins an exact version
    const exactPin = pkg.version?.match(/^\[([^,[\]()]+)\]$/);
    if (exactPin) {
      pkg.version = exactPin[1];
    }
    // A range such as [1.0,2.0) or a wildcard such as 1.0.* is a declared
    // constraint rather than an installed version. The constraint is recorded
    // so the declaration stays visible, and the version is resolved from a
    // more precise manifest so the purl names the package that is present.
    let declaredRange;
    if (!concreteVersion(pkg.version)) {
      confidence = 0.5;
      declaredRange = pkg.version;
      // Backfill from a version already resolved by a more precise manifest.
      // Concrete versions are never overridden - a disagreement means both
      // versions must be tracked.
      pkg.version = pkgNameVersions[pkg.name];
    }
    applyNugetVersion(pkg, pkg.version);
    if (pkgFile) {
      pkg.properties = [
        {
          name: "internal:SrcFile",
          value: pkgFile,
        },
      ];
      if (declaredRange) {
        pkg.properties.push({
          name: "cdx:nuget:declared_version_range",
          value: declaredRange,
        });
      }
      pkg.evidence = {
        identity: {
          field: "purl",
          confidence,
          methods: [
            {
              technique: "manifest-analysis",
              confidence,
              value: pkgFile,
            },
          ],
        },
      };
    }
    pkgList.push(pkg);
  }
  return pkgList;
}

/**
 * Parse a Directory.Packages.props file and return the package versions it declares
 * centrally via NuGet Central Package Management.
 *
 * @param {String} propsFile Path to a Directory.Packages.props file
 *
 * @returns {Object} Map of lowercased package id to version. NuGet package ids are
 *          case-insensitive, so callers must lowercase before looking up.
 */
export function parseDirectoryPackagesProps(propsFile) {
  const versions = {};
  let projects;
  try {
    const data = readFileSync(propsFile, { encoding: "utf-8" });
    projects = xml2js(data, {
      compact: true,
      spaces: 4,
      alwaysArray: true,
      textKey: "_",
      attributesKey: "$",
      commentKey: "value",
    }).Project;
  } catch (_e) {
    console.log(`Unable to parse ${propsFile} with utf-8 encoding!`);
    return versions;
  }
  if (!projects?.length) {
    return versions;
  }
  const project = projects[0];
  // A project can keep the file around with central management switched off, in
  // which case the PackageVersion entries are inert and must not be applied. An
  // absent property is treated as enabled, because it is commonly set in
  // Directory.Build.props which is not read here.
  for (const propertyGroup of project.PropertyGroup || []) {
    const managed = propertyGroup.ManagePackageVersionsCentrally?.[0]?._?.[0];
    if (managed && `${managed}`.trim().toLowerCase() === "false") {
      return versions;
    }
  }
  for (const item of project.ItemGroup || []) {
    for (const pv of item.PackageVersion || []) {
      const attrs = pv.$ || {};
      // Update is the documented way to change a version declared by an
      // imported props file, and is as authoritative as Include here.
      const name = attrs.Include || attrs.Update;
      const version = attrs.Version || pv.Version?.[0]?._?.[0];
      if (name && version) {
        versions[name.toLowerCase()] = version;
      }
    }
  }
  return versions;
}

/**
 * Method to collect the versions declared by NuGet Central Package Management for a
 * given project file, by walking up to the nearest Directory.Packages.props.
 *
 * MSBuild imports the first Directory.Packages.props found while walking up from the
 * project directory, and that file is often at the repository root - above the
 * directory cdxgen was invoked with. The walk therefore deliberately continues past
 * the scan root rather than stopping at it.
 *
 * @param {String} projFile Path to a .csproj like project file
 * @param {Object} cache Optional per-scan cache keyed by props file path, so that a
 *        repository with many projects parses each props file once
 *
 * @returns {Object} Map of lowercased package id to version. Empty when the project
 *          does not use central package management.
 */
export function getCentralPackageVersions(projFile, cache = {}) {
  if (!projFile) {
    return {};
  }
  let dir = dirname(resolve(projFile));
  for (;;) {
    const propsFile = join(dir, "Directory.Packages.props");
    if (safeExistsSync(propsFile)) {
      if (!(propsFile in cache)) {
        cache[propsFile] = parseDirectoryPackagesProps(propsFile);
      }
      return cache[propsFile];
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return {};
    }
    dir = parent;
  }
}

/**
 * Method to find all text nodes in PropertyGroup elements in .props files.
 *
 * @param {String} propsFiles .props files in this project
 *
 * @returns {Object} Containing text nodes from PropertyGroup elements and their values
 */
export function getPropertyGroupTextNodes(propsFiles) {
  const matches = {};
  for (const f of propsFiles) {
    if (!f) {
      continue;
    }
    let projects;
    try {
      const data = readFileSync(f, { encoding: "utf-8" });
      projects = xml2js(data, {
        compact: true,
        spaces: 4,
        alwaysArray: true,
        textKey: "_",
        attributesKey: "$",
        commentKey: "value",
      }).Project;
    } catch (_e) {
      console.log(`Unable to parse ${f} with utf-8 encoding!`);
    }
    if (!projects || projects.length === 0) {
      continue;
    }
    const project = projects[0];
    if (project?.PropertyGroup) {
      for (const propertyGroup of project.PropertyGroup) {
        for (const [key, value] of Object.entries(propertyGroup)) {
          if (value?.length && Object.keys(value[0]).includes("_")) {
            if (key in matches) {
              if (!matches[key].includes(value[0]._[0])) {
                matches[key].push(value[0]._[0]);
              }
            } else {
              matches[key] = [value[0]._[0]];
            }
          }
        }
      }
    }
  }
  return matches;
}

/**
 * Read the trimmed text of an MSBuild property from a parsed PropertyGroup.
 *
 * @param {Object} propertyGroup PropertyGroup parsed by xml2js in compact mode
 * @param {string} key Property name
 * @returns {string|undefined} The text, or undefined when absent or empty
 */
function propertyGroupText(propertyGroup, key) {
  const text = propertyGroup?.[key]?.[0]?._?.[0];
  if (typeof text !== "string" || !text.trim().length) {
    return undefined;
  }
  return text.trim();
}

/**
 * Method to parse .csproj like xml files
 *
 * @param {String} csProjData Raw data
 * @param {String} projFile File name
 * @param {Object} pkgNameVersions Package name - version map object
 * @param {Boolean} msbuildInstalled Whether msbuild is available to resolve properties
 * @param {Object} pkgVersionLabelCandidates Candidate values for msbuild version properties
 * @param {Object} centralVersions Versions declared centrally in Directory.Packages.props,
 *        keyed by lowercased package id. See {@link getCentralPackageVersions}.
 *
 * @returns {Object} Containing parent component, package, and dependencies
 */
export function parseCsProjData(
  csProjData,
  projFile,
  pkgNameVersions = {},
  msbuildInstalled = false,
  pkgVersionLabelCandidates = {},
  centralVersions = {},
) {
  const pkgList = [];
  const parentComponent = { type: "application", properties: [] };
  if (!csProjData) {
    return pkgList;
  }
  // Remove byte order mark
  if (csProjData.charCodeAt(0) === 0xfeff) {
    csProjData = csProjData.slice(1);
  }
  const projectTargetFrameworks = [];
  let projects;
  try {
    projects = xml2js(csProjData, {
      compact: true,
      alwaysArray: true,
      spaces: 4,
      textKey: "_",
      attributesKey: "$",
      commentKey: "value",
    }).Project;
  } catch (_e) {
    console.log(`Unable to parse ${projFile} with utf-8 encoding!`);
  }
  if (!projects || projects.length === 0) {
    return pkgList;
  }
  const project = projects[0];
  // SDK-style projects declare their version through the MSBuild properties
  // that `dotnet pack` reads: PackageVersion, which defaults to Version, which
  // in turn defaults to VersionPrefix plus an optional `-VersionSuffix`. A
  // property may be set in any PropertyGroup, so they are collected first.
  const sdkVersionProps = {};
  for (const apg of project?.PropertyGroup || []) {
    for (const key of [
      "PackageVersion",
      "Version",
      "VersionPrefix",
      "VersionSuffix",
    ]) {
      const value = propertyGroupText(apg, key);
      if (value !== undefined) {
        sdkVersionProps[key] = value;
      }
    }
  }
  let sdkVersion =
    sdkVersionProps.PackageVersion ||
    sdkVersionProps.Version ||
    (sdkVersionProps.VersionPrefix
      ? `${sdkVersionProps.VersionPrefix}${sdkVersionProps.VersionSuffix ? `-${sdkVersionProps.VersionSuffix}` : ""}`
      : undefined);
  // An MSBuild property reference such as $(BuildNumber) is only known at
  // build time, so a version that still contains one is not reported.
  if (sdkVersion?.includes("$(")) {
    sdkVersion = undefined;
  }
  // First make up a parentcomponent name based on the .csproj file name
  if (projFile) {
    parentComponent.name = basename(projFile).replaceAll(
      /.(cs|fs|vb|ts|plc|hmi)proj$/g,
      "",
    );
  }
  // Collect details about the parent component
  if (project?.PropertyGroup?.length) {
    for (const apg of project.PropertyGroup) {
      if (
        apg?.AssemblyName &&
        Array.isArray(apg.AssemblyName) &&
        apg.AssemblyName[0]._ &&
        Array.isArray(apg.AssemblyName[0]._)
      ) {
        parentComponent.name = apg.AssemblyName[0]._[0];
      } else if (
        apg?.Name &&
        Array.isArray(apg.Name) &&
        apg.Name[0]._ &&
        Array.isArray(apg.Name[0]._)
      ) {
        parentComponent.name = apg.Name[0]._[0];
      }
      if (
        apg?.ProductVersion &&
        Array.isArray(apg.ProductVersion) &&
        apg.ProductVersion[0]._ &&
        Array.isArray(apg.ProductVersion[0]._)
      ) {
        parentComponent.version = apg.ProductVersion[0]._[0];
      } else if (
        apg?.ProgramVersion &&
        Array.isArray(apg.ProgramVersion) &&
        apg.ProgramVersion[0]._ &&
        Array.isArray(apg.ProgramVersion[0]._)
      ) {
        parentComponent.version = apg.ProgramVersion[0]._[0];
      } else if (
        apg?.HmiVersion &&
        Array.isArray(apg.HmiVersion) &&
        apg.HmiVersion[0]._ &&
        Array.isArray(apg.HmiVersion[0]._)
      ) {
        parentComponent.version = apg.HmiVersion[0]._[0];
      }
      if (
        apg?.OutputType &&
        Array.isArray(apg.OutputType) &&
        apg.OutputType[0]._ &&
        Array.isArray(apg.OutputType[0]._)
      ) {
        const outputType = apg.OutputType[0]._[0];
        if (outputType === "Library") {
          parentComponent.type = "library";
        }
        // The MSBuild OutputType (Exe, WinExe, …) used to ride along as an
        // `output_type` purl qualifier, which nuget does not define — every such
        // purl was invalid. It is project metadata, so it belongs in properties.
        if (outputType !== "Library") {
          parentComponent.properties = parentComponent.properties || [];
          parentComponent.properties.push({
            name: "cdx:dotnet:output_type",
            value: outputType,
          });
        }
      }
      if (
        apg?.ProjectGuid &&
        Array.isArray(apg.ProjectGuid) &&
        apg.ProjectGuid[0]._ &&
        Array.isArray(apg.ProjectGuid[0]._)
      ) {
        parentComponent.properties.push({
          name: "cdx:dotnet:project_guid",
          value: apg.ProjectGuid[0]._[0],
        });
      }
      if (
        apg?.RootNamespace &&
        Array.isArray(apg.RootNamespace) &&
        apg.RootNamespace[0]._ &&
        Array.isArray(apg.RootNamespace[0]._)
      ) {
        parentComponent.properties.push({
          name: "internal:Namespaces",
          value: apg.RootNamespace[0]._[0],
        });
      }
      if (
        apg?.TargetFramework &&
        Array.isArray(apg.TargetFramework) &&
        apg.TargetFramework[0]._ &&
        Array.isArray(apg.TargetFramework[0]._)
      ) {
        for (const apgtf of apg.TargetFramework[0]._) {
          projectTargetFrameworks.push(apgtf);
          parentComponent.properties.push({
            name: "cdx:dotnet:target_framework",
            value: apgtf,
          });
        }
      } else if (
        apg?.TargetFrameworkVersion &&
        Array.isArray(apg.TargetFrameworkVersion) &&
        apg.TargetFrameworkVersion[0]._ &&
        Array.isArray(apg.TargetFrameworkVersion[0]._)
      ) {
        for (const apgtf of apg.TargetFrameworkVersion[0]._) {
          projectTargetFrameworks.push(apgtf);
          parentComponent.properties.push({
            name: "cdx:dotnet:target_framework",
            value: apgtf,
          });
        }
      } else if (
        apg?.TargetFrameworks &&
        Array.isArray(apg.TargetFrameworks) &&
        apg.TargetFrameworks[0]._ &&
        Array.isArray(apg.TargetFrameworks[0]._)
      ) {
        for (const apgtf of apg.TargetFrameworks[0]._) {
          projectTargetFrameworks.push(apgtf);
          parentComponent.properties.push({
            name: "cdx:dotnet:target_framework",
            value: apgtf,
          });
        }
      }
      if (
        apg?.AzureFunctionsVersion &&
        Array.isArray(apg.AzureFunctionsVersion) &&
        apg.AzureFunctionsVersion[0]._ &&
        Array.isArray(apg.AzureFunctionsVersion[0]._)
      ) {
        parentComponent.properties.push({
          name: "cdx:dotnet:azure_functions_version",
          value: apg.AzureFunctionsVersion[0]._[0],
        });
      }
      if (
        apg?.Description &&
        Array.isArray(apg.Description) &&
        apg.Description[0]._ &&
        Array.isArray(apg.Description[0]._)
      ) {
        parentComponent.description = apg.Description[0]._[0];
      } else if (
        apg?.PackageDescription &&
        Array.isArray(apg.PackageDescription) &&
        apg.PackageDescription[0]._ &&
        Array.isArray(apg.PackageDescription[0]._)
      ) {
        parentComponent.description = apg.PackageDescription[0]._[0];
      }
    }
  }
  if (project.ItemGroup?.length) {
    for (const i in project.ItemGroup) {
      const item = project.ItemGroup[i];
      // .net core use PackageReference
      for (const j in item.PackageReference) {
        const pref = item.PackageReference[j].$;
        const pkg = { group: "" };
        if (!pref.Include || pref.Include.includes(".csproj")) {
          continue;
        }
        pkg.name = pref.Include;
        // Under central package management a PackageReference carries no Version at
        // all, and VersionOverride is the documented way for a project to opt out of
        // the central version, so it wins over everything else. The central version
        // is consulted only after pkgNameVersions, which holds versions already
        // resolved from project.assets.json / packages.lock.json and is therefore
        // more precise than a central declaration that may be a floating range.
        pkg.version =
          pref.VersionOverride ||
          item.PackageReference[j].VersionOverride?.[0]._?.[0] ||
          pref.Version ||
          item.PackageReference[j].Version?.[0]._?.[0] ||
          pkgNameVersions[pkg.name] ||
          centralVersions[pkg.name.toLowerCase()];
        if (pkg.version) {
          const version_label_match = pkg.version.match(/^\$\((.*)\)$/)?.[1];
          if (version_label_match) {
            let version_resolved = false;
            if (msbuildInstalled) {
              const result = safeSpawnSync(
                DOTNET_CMD,
                [
                  `msbuild ${projFile} -nologo -getProperty:${version_label_match}`,
                ],
                { shell: isWin },
              );
              if (
                result.status === 0 &&
                !result.error &&
                result.stdout.trim()
              ) {
                pkg.version = result.stdout.trim();
                version_resolved = true;
              }
            }
            if (!version_resolved) {
              if (
                pkgVersionLabelCandidates[version_label_match]?.length === 1
              ) {
                // Prioritizing correctness over completeness: reject resolved package version label if it has more than one possible values.
                pkg.version = pkgVersionLabelCandidates[version_label_match][0];
              } else if (DEBUG_MODE) {
                console.log(
                  `Could not resolve package version label ${version_label_match} for ${pkg.name}`,
                );
              }
            }
          }
        }
        // A `Version` attribute holds whatever the project declares, which may
        // be an MSBuild property that did not resolve, a floating range such as
        // `1.0-*`, or a range such as `[1.0,2.0)`. A bracketed single version
        // pins one version and is unwrapped; any other non-concrete form is
        // resolved from project.assets.json / packages.lock.json or central
        // package management so the purl names the version that is installed,
        // with the declaration kept as a property.
        let declaredRange;
        if (pkg.version) {
          const exactPin = pkg.version.match(/^\[([^,[\]()]+)\]$/);
          if (exactPin) {
            pkg.version = exactPin[1];
          } else if (!concreteVersion(pkg.version)) {
            declaredRange = pkg.version;
            pkg.version =
              pkgNameVersions[pkg.name] ||
              centralVersions[pkg.name.toLowerCase()];
          }
        }
        // A version that could not be resolved from any source must not be
        // stringified into the purl - `@undefined` is not a version and makes the
        // component unmatchable. Mirrors parseCsPkgData.
        applyNugetVersion(pkg, pkg.version);
        if (projFile) {
          pkg.properties = [
            {
              name: "internal:SrcFile",
              value: projFile,
            },
          ];
          if (declaredRange) {
            pkg.properties.push({
              name: "cdx:nuget:declared_version_range",
              value: declaredRange,
            });
          }
          pkg.evidence = {
            identity: {
              field: "purl",
              confidence: 0.7,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 0.7,
                  value: projFile,
                },
              ],
            },
          };
        }
        pkgList.push(pkg);
      }
      // .net framework use Reference
      for (const j in item.Reference) {
        const hintPaths = item.Reference[j]?.HintPath;
        let hintPath;
        let hintVersion;
        let assemblyName;
        let assemblyVersion;
        let packageFileName;

        if (hintPaths && Array.isArray(hintPaths)) {
          const tmpHintPathValues = hintPaths[0]._;
          if (Array.isArray(tmpHintPathValues)) {
            hintPath = tmpHintPathValues[0];
            packageFileName = basename(hintPath);
            if (packageFileName.includes("\\")) {
              packageFileName = packageFileName.split("\\").pop();
            }
          }
        }
        const pref = item.Reference[j].$;
        const pkg = { group: "" };
        if (!pref.Include || pref.Include.includes(".csproj")) {
          continue;
        }
        const incParts = pref.Include.split(",");
        pkg.name = incParts[0];
        pkg.properties = [];
        // Prefer the version from the hint path if available, falling back to assembly version
        if (hintPath) {
          const packageInfo = extractPackageInfoFromHintPath(hintPath);
          if (packageInfo) {
            hintVersion = packageInfo.version;
            // Assembly name is different to package name
            if (packageInfo.name && pkg.name !== packageInfo.name) {
              assemblyName = pkg.name;
              pkg.name = packageInfo.name;
            }
          }
        }
        let declaredAssemblyVersion;
        if (incParts.length > 1 && incParts[1].includes("Version")) {
          const declared = incParts[1].replace("Version=", "").trim();
          // An assembly reference carries the version inline, and that value can
          // be an MSBuild property such as `Version=$(TargetFSharpCoreVersion)`
          // which only a build evaluates. Anything that is not a concrete
          // version is resolved from the manifests that pin one, keeping the
          // declaration as a property.
          if (declared && !concreteVersion(declared)) {
            declaredAssemblyVersion = declared;
            assemblyVersion =
              pkgNameVersions[pkg.name] ||
              centralVersions[pkg.name.toLowerCase()];
          } else {
            assemblyVersion = declared || pkgNameVersions[pkg.name];
          }
        }
        if (declaredAssemblyVersion) {
          pkg.properties.push({
            name: "cdx:nuget:declared_version_range",
            value: declaredAssemblyVersion,
          });
        }
        const version = hintVersion ?? assemblyVersion;
        // An assembly reference that states no version anywhere - no HintPath to
        // read one from and no `Version=` on the Include - leaves the component
        // versionless in both fields. The registry's latest release is not a
        // stand-in: `<Reference>` resolves an assembly from a targeting pack, a
        // lib folder or the GAC, and the project does not say which package it
        // came from. See #4359.
        applyNugetVersion(pkg, version);
        if (
          !pkg.version &&
          (pkg.name.startsWith("System.") ||
            pkg.name.startsWith("Mono.") ||
            pkg.name.startsWith("Microsoft."))
        ) {
          // If this is a System package, then track the target frameworks
          for (const tf of projectTargetFrameworks) {
            pkg.properties.push({
              name: "cdx:dotnet:target_framework",
              value: tf,
            });
          }
        }
        if (assemblyName) {
          pkg.properties.push({
            name: "cdx:dotnet:assembly_name",
            value: assemblyName,
          });
        }
        if (hintVersion && assemblyVersion) {
          pkg.properties.push({
            name: "cdx:dotnet:assembly_version",
            value: assemblyVersion,
          });
        }
        if (projFile) {
          pkg.properties.push({
            name: "internal:SrcFile",
            value: projFile,
          });
          pkg.evidence = {
            identity: {
              field: "purl",
              confidence: hintVersion ? 0.7 : 0.3,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: hintVersion ? 0.7 : 0.3,
                  value: projFile,
                },
              ],
            },
          };
        }
        if (hintPath) {
          // The same component could be referred by a slightly different name.
          // Use the hint_path to figure out the aliases in such cases.
          // Example:
          // <Reference Include="Microsoft.AI.Agent.Intercept, Version=2.0.6.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35, processorArchitecture=MSIL">
          //   <HintPath>..\packages\Microsoft.ApplicationInsights.Agent.Intercept.2.0.6\lib\net45\Microsoft.AI.Agent.Intercept.dll</HintPath>
          // </Reference>
          // cdxgen would create two components Microsoft.AI.Agent.Intercept@2.0.6.0 and Microsoft.ApplicationInsights.Agent.Intercept@2.0.6
          // They're The Same Picture meme goes here
          pkg.properties.push({
            name: "cdx:dotnet:hint_path",
            value: hintPath,
          });
          pkg.properties.push({
            name: "internal:PackageFiles",
            value: packageFileName,
          });
        }
        pkgList.push(pkg);
      }
    }
  }
  if (sdkVersion) {
    parentComponent.version = sdkVersion;
  }
  // The purl is built once every PropertyGroup has been read, so a version
  // declared after OutputType is not lost.
  if (parentComponent.name) {
    applyPurl(
      parentComponent,
      nugetPurl(parentComponent.name, parentComponent.version || "latest"),
    );
  }
  let dependencies = [];
  if (parentComponent?.["bom-ref"]) {
    dependencies = [
      {
        ref: parentComponent["bom-ref"],
        dependsOn: [...new Set(pkgList.map((p) => p["bom-ref"]))].sort(),
      },
    ];
  }
  return {
    pkgList,
    parentComponent,
    dependencies,
  };
}

/**
 * Parse a .NET project.assets.json file and return the package list and dependency tree.
 *
 * Extracts NuGet packages and their transitive dependency relationships from the
 * `libraries` and `targets` sections of a project.assets.json file produced by
 * the .NET restore process.
 *
 * @param {string} csProjData Raw JSON string of the project.assets.json file
 * @param {string} assetsJsonFile Path to the project.assets.json file, used for evidence properties
 * @returns {{ pkgList: Object[], dependenciesList: Object[] }}
 */
export function parseCsProjAssetsData(csProjData, assetsJsonFile) {
  // extract name, operator, version from .NET package representation
  // like "NLog >= 4.5.0"
  function extractNameOperatorVersion(inputStr) {
    if (!inputStr) {
      return null;
    }
    const extractNameOperatorVersion = /([\w.-]+)\s*([><=!]+)\s*(.*)/;
    let match = inputStr.match(extractNameOperatorVersion);
    if (match) {
      return {
        name: match[1],
        operator: match[2],
        version: match[3],
      };
    }
    match = inputStr.split(" ");
    if (match && match.length === 3) {
      return {
        name: match[1],
        operator: match[2],
        version: match[3],
      };
    }
    return null;
  }

  const pkgList = [];
  const dependenciesList = [];
  let rootPkg = {};
  // This tracks the resolved version
  const pkgNameVersionMap = {};
  const pkgAddedMap = {};

  if (!csProjData) {
    return { pkgList, dependenciesList };
  }
  csProjData = JSON.parse(csProjData);
  let purlString;
  if (csProjData.project?.restore?.projectName) {
    purlString = build({
      type: "nuget",
      namespace: "" || null,
      name: csProjData.project?.restore?.projectName,
      version: csProjData.project.version || "latest" || null,
    });
    rootPkg = {
      group: "",
      name: csProjData.project.restore.projectName,
      version: csProjData.project.version || "latest",
      type: "application",
      purl: purlString,
      "bom-ref": decodeURIComponent(purlString),
    };
    pkgList.push(rootPkg);
  }
  const rootPkgDeps = new Set();
  // create root pkg deps
  if (csProjData.targets && csProjData.projectFileDependencyGroups) {
    for (const frameworkTarget in csProjData.projectFileDependencyGroups) {
      for (const dependencyName of csProjData.projectFileDependencyGroups[
        frameworkTarget
      ]) {
        const nameOperatorVersion = extractNameOperatorVersion(dependencyName);
        if (nameOperatorVersion == null) {
          continue;
        }
        const targetNameVersion = `${nameOperatorVersion.name}/${nameOperatorVersion.version}`;
        let nameToUse = nameOperatorVersion.name;
        // Due to the difference in casing, we might arrive this case where a simple lookup doesn't succeed.
        // Instead of skipping, let's work harder to find a match.
        if (!csProjData.targets[frameworkTarget][targetNameVersion]) {
          let matchFound = false;
          for (const fkeys of Object.keys(
            csProjData.targets[frameworkTarget],
          )) {
            const tmpParts = fkeys.split("/");
            const tname = tmpParts[0];
            const tversion = tmpParts[1];
            if (
              tname.toLowerCase() === nameOperatorVersion.name.toLowerCase() &&
              tversion === nameOperatorVersion.version.replace("-*", "")
            ) {
              nameToUse = tname;
              matchFound = true;
              break;
            }
          }
          if (!matchFound) {
            if (DEBUG_MODE) {
              console.log(
                "Unable to match",
                dependencyName,
                "with a target name. The dependency tree will be imprecise.",
              );
            }
            continue;
          }
        }

        const dpurl = decodeURIComponent(
          build({
            type: "nuget",
            namespace: "" || null,
            name: nameToUse,
            version: nameOperatorVersion.version || null,
          }),
        );
        rootPkgDeps.add(dpurl);
      }
    }
    if (purlString && rootPkgDeps.size) {
      dependenciesList.push({
        ref: purlString,
        dependsOn: Array.from(rootPkgDeps).sort(),
      });
    }
  }

  if (csProjData.libraries && csProjData.targets) {
    const lib = csProjData.libraries;
    // Pass 1: Construct pkgList alone and track name and resolved version
    for (const framework in csProjData.targets) {
      for (const rootDep of Object.keys(csProjData.targets[framework])) {
        // if (rootDep.startsWith("runtime")){
        //   continue;
        // }
        const [name, version] = rootDep.split("/");
        const dpurl = build({
          type: "nuget",
          namespace: "" || null,
          name: name,
          version: version || null,
        });
        const pkg = {
          group: "",
          name: name,
          version: version,
          description: "",
          type: csProjData.targets[framework][rootDep].type,
          purl: dpurl,
          "bom-ref": decodeURIComponent(dpurl),
        };
        if (lib[rootDep]) {
          if (lib[rootDep].sha512) {
            pkg["_integrity"] = `sha512-${lib[rootDep].sha512}`;
          } else if (lib[rootDep].sha256) {
            pkg["_integrity"] = `sha256-${lib[rootDep].sha256}`;
          }
          if (lib[rootDep].files && Array.isArray(lib[rootDep].files)) {
            const dllFiles = new Set();
            lib[rootDep].files.forEach((f) => {
              if (
                f.endsWith(".dll") ||
                f.endsWith(".exe") ||
                f.endsWith(".so")
              ) {
                dllFiles.add(basename(f));
              }
            });
            pkg.properties = [
              {
                name: "internal:SrcFile",
                value: assetsJsonFile,
              },
              {
                name: "internal:PackageFiles",
                value: Array.from(dllFiles).join(", "),
              },
            ];
          }
        }
        if (assetsJsonFile) {
          pkg.evidence = {
            identity: {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: assetsJsonFile,
                },
              ],
            },
          };
        }
        pkgList.push(pkg);
        pkgNameVersionMap[name + framework] = version;
        pkgAddedMap[name] = true;
      }
    }
    // Pass 2: Fix the dependency tree
    for (const framework in csProjData.targets) {
      for (const rootDep of Object.keys(csProjData.targets[framework])) {
        const depList = new Set();
        const [name, version] = rootDep.split("/");
        const dpurl = decodeURIComponent(
          build({
            type: "nuget",
            namespace: "" || null,
            name: name,
            version: version || null,
          }),
        );
        const dependencies =
          csProjData.targets[framework][rootDep].dependencies;
        if (dependencies) {
          for (const p of Object.keys(dependencies)) {
            // This condition is not required for assets json that are well-formed.
            if (!pkgNameVersionMap[p + framework]) {
              continue;
            }
            const dversion = pkgNameVersionMap[p + framework];
            const ipurl = build({
              type: "nuget",
              namespace: "" || null,
              name: p,
              version: dversion || null,
            });
            depList.add(ipurl);
            if (!pkgAddedMap[p]) {
              pkgList.push({
                group: "",
                name: p,
                version: dversion,
                description: "",
                purl: ipurl,
                "bom-ref": decodeURIComponent(ipurl),
              });
              pkgAddedMap[p] = true;
            }
          }
        }
        dependenciesList.push({
          ref: dpurl,
          dependsOn: Array.from(depList).sort(),
        });
      }
    }
  }
  return {
    pkgList,
    dependenciesList,
  };
}

/**
 * Parse a .NET packages.lock.json file and return the package list, dependency tree,
 * and list of direct/root dependencies.
 *
 * @param {string} csLockData Raw JSON string of the packages.lock.json file
 * @param {string} pkgLockFile Path to the packages.lock.json file, used for evidence properties
 * @returns {{ pkgList: Object[], dependenciesList: Object[], rootList: Object[] }}
 */
export function parseCsPkgLockData(csLockData, pkgLockFile) {
  const pkgList = [];
  const dependenciesList = [];
  const rootList = [];
  let pkg = null;
  if (!csLockData) {
    return {
      pkgList,
      dependenciesList,
      rootList,
    };
  }
  const assetData = JSON.parse(csLockData);
  if (!assetData?.dependencies) {
    return {
      pkgList,
      dependenciesList,
      rootList,
    };
  }
  for (const aversion of Object.keys(assetData.dependencies)) {
    for (const alib of Object.keys(assetData.dependencies[aversion])) {
      const libData = assetData.dependencies[aversion][alib];
      const purl = build({
        type: "nuget",
        namespace: "" || null,
        name: alib,
        version: libData.resolved || null,
      });
      pkg = {
        group: "",
        name: alib,
        version: libData.resolved,
        purl,
        "bom-ref": decodeURIComponent(purl),
        _integrity: libData.contentHash
          ? `sha512-${libData.contentHash}`
          : undefined,
        properties: [
          {
            name: "internal:SrcFile",
            value: pkgLockFile,
          },
        ],
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
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
      pkgList.push(pkg);
      if (["Direct", "Project"].includes(libData.type)) {
        rootList.push(pkg);
      }
      const dependsOn = new Set();
      if (libData.dependencies) {
        for (let adep of Object.keys(libData.dependencies)) {
          let adepResolvedVersion = libData.dependencies[adep];
          const aversionNoRuntime = aversion.split("/")[0];
          // Try to get the resolved version of the dependency. See #930 and #937
          if (assetData.dependencies[aversion]?.[adep]?.resolved) {
            adepResolvedVersion =
              assetData.dependencies[aversion][adep].resolved;
          } else if (
            aversion.includes("/") &&
            assetData.dependencies[aversionNoRuntime]?.[adep]?.resolved
          ) {
            adepResolvedVersion =
              assetData.dependencies[aversionNoRuntime][adep].resolved;
          } else if (
            (assetData.dependencies[aversion]?.[adep.toLowerCase()] &&
              assetData.dependencies[aversion][adep.toLowerCase()].type ===
                "Project") ||
            (assetData.dependencies[aversionNoRuntime]?.[adep.toLowerCase()] &&
              assetData.dependencies[aversionNoRuntime][adep.toLowerCase()]
                .type === "Project")
          ) {
            adepResolvedVersion = undefined;
            adep = adep.toLowerCase();
          } else if (DEBUG_MODE) {
            console.warn(
              `Unable to find the resolved version for ${adep} ${aversion}. Using ${adepResolvedVersion} which may be incorrect.`,
            );
          }
          const adpurl = build({
            type: "nuget",
            namespace: "" || null,
            name: adep,
            version: adepResolvedVersion || null,
          });
          dependsOn.add(decodeURIComponent(adpurl));
        }
      }
      dependenciesList.push({
        ref: decodeURIComponent(purl),
        dependsOn: [...dependsOn].sort(),
      });
    }
  }
  return {
    pkgList,
    dependenciesList,
    rootList,
  };
}

/**
 * Parse a Paket dependency manager lock file (paket.lock) and return the package list
 * and dependency tree.
 *
 * @param {string} paketLockData Raw text contents of the paket.lock file
 * @param {string} pkgLockFile Path to the paket.lock file, used for evidence properties
 * @returns {{ pkgList: Object[], dependenciesList: Object[] }}
 */
export function parsePaketLockData(paketLockData, pkgLockFile) {
  const pkgList = [];
  const dependenciesList = [];
  const dependenciesMap = {};
  const pkgNameVersionMap = {};
  let group = null;
  let pkg = null;
  if (!paketLockData) {
    return { pkgList, dependenciesList };
  }

  const packages = paketLockData.split("\n");
  const groupRegex = /^GROUP\s(\S*)$/;
  const pkgRegex = /^\s{4}([\w.-]+) \(((?=.*?\.)[\w.-]+)\)/;
  const depRegex = /^\s{6}([\w.-]+) \([><= \w.-]+\)/;

  // Gather all packages
  packages.forEach((l) => {
    let match = l.match(groupRegex);
    if (match) {
      group = match[1];
      return;
    }

    match = l.match(pkgRegex);
    if (match) {
      const name = match[1];
      const version = match[2];
      const purl = build({
        type: "nuget",
        namespace: "" || null,
        name: name,
        version: version || null,
      });
      pkg = {
        group: "",
        name,
        version,
        purl,
        "bom-ref": decodeURIComponent(purl),
        properties: [
          {
            name: "internal:SrcFile",
            value: pkgLockFile,
          },
        ],
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
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
      pkgList.push(pkg);
      dependenciesMap[purl] = new Set();
      pkgNameVersionMap[name + group] = version;
    }
  });

  let purl = null;
  group = null;

  // Construct the dependency tree
  packages.forEach((l) => {
    let match = l.match(groupRegex);
    if (match) {
      group = match[1];
      return;
    }

    match = l.match(pkgRegex);
    if (match) {
      const pkgName = match[1];
      const pkgVersion = match[2];
      purl = decodeURIComponent(
        build({
          type: "nuget",
          namespace: "" || null,
          name: pkgName,
          version: pkgVersion || null,
        }),
      );
      return;
    }

    match = l.match(depRegex);
    if (match) {
      const depName = match[1];
      const depVersion = pkgNameVersionMap[depName + group];
      const dpurl = decodeURIComponent(
        build({
          type: "nuget",
          namespace: "" || null,
          name: depName,
          version: depVersion || null,
        }),
      );
      dependenciesMap[purl].add(dpurl);
    }
  });

  for (const ref in dependenciesMap) {
    dependenciesList.push({
      ref: ref,
      dependsOn: Array.from(dependenciesMap[ref]).sort(),
    });
  }

  return {
    pkgList,
    dependenciesList,
  };
}
