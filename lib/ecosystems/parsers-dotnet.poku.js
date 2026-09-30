import { readFileSync } from "node:fs";

import { assert, it } from "poku";

// Imported directly rather than through the deprecated ./utils.js barrel, which is
// kept only for backward compatibility and must not grow new exports.
import {
  getCentralPackageVersions,
  parseDirectoryPackagesProps,
} from "./parsers-dotnet.js";
import {
  getPropertyGroupTextNodes,
  parseCsPkgData,
  parseCsPkgLockData,
  parseCsProjAssetsData,
  parseCsProjData,
  parseNupkg,
  parseNuspecData,
  parsePaketLockData,
} from "./utils.js";

it("parse cs pkg data", () => {
  assert.deepStrictEqual(parseCsPkgData(null), []);
  const dep_list = parseCsPkgData(
    readFileSync("./test/data/packages.config", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 21);
  assert.deepStrictEqual(dep_list[0], {
    "bom-ref": "pkg:nuget/Antlr@3.5.0.2",
    group: "",
    name: "Antlr",
    version: "3.5.0.2",
    purl: "pkg:nuget/Antlr@3.5.0.2",
  });
});

it("parse cs pkg data 2", () => {
  assert.deepStrictEqual(parseCsPkgData(null), []);
  const dep_list = parseCsPkgData(
    readFileSync("./test/data/packages2.config", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    "bom-ref": "pkg:nuget/EntityFramework@6.2.0",
    group: "",
    name: "EntityFramework",
    version: "6.2.0",
    purl: "pkg:nuget/EntityFramework@6.2.0",
  });
});

it("parse cs pkg data with imprecise versions", () => {
  const pkgFile =
    "test/data/csharp-mixed-manifests/ImpreciseVersions/packages.config";
  const dep_list = parseCsPkgData(
    readFileSync(`./${pkgFile}`, { encoding: "utf-8" }),
    pkgFile,
  );
  assert.deepStrictEqual(dep_list.length, 10);
  const byName = {};
  for (const d of dep_list) {
    byName[d.name] = d;
  }
  // Exact version keeps the regular manifest confidence
  assert.deepStrictEqual(byName.Antlr.version, "3.5.0.2");
  assert.deepStrictEqual(byName.Antlr.purl, "pkg:nuget/Antlr@3.5.0.2");
  assert.deepStrictEqual(byName.Antlr.evidence.identity.confidence, 0.7);
  assert.deepStrictEqual(
    byName.Antlr.evidence.identity.methods[0].confidence,
    0.7,
  );
  // Prerelease versions are precise
  assert.deepStrictEqual(byName.Moq.version, "4.20.70-beta1");
  assert.deepStrictEqual(byName.Moq.purl, "pkg:nuget/Moq@4.20.70-beta1");
  assert.deepStrictEqual(byName.Moq.evidence.identity.confidence, 0.7);
  // A bracketed single version such as [4.4.1] pins an exact version in
  // NuGet - it is precise and must be normalized to the inner version
  assert.deepStrictEqual(byName["Castle.Core"].version, "4.4.1");
  assert.deepStrictEqual(
    byName["Castle.Core"].purl,
    "pkg:nuget/Castle.Core@4.4.1",
  );
  assert.deepStrictEqual(
    byName["Castle.Core"].evidence.identity.confidence,
    0.7,
  );
  // A NuGet range is a constraint, not an installed version. With nothing
  // pinning one, the constraint is kept as a property and the version field
  // stays empty so it cannot disagree with the versionless purl - #4359.
  assert.deepStrictEqual(byName.NUnit.version, undefined);
  assert.deepStrictEqual(byName.NUnit.purl, "pkg:nuget/NUnit");
  assert.deepStrictEqual(
    byName.NUnit.properties.find(
      (p) => p.name === "cdx:nuget:declared_version_range",
    ).value,
    "[3.13.3,4.0)",
  );
  assert.deepStrictEqual(byName.NUnit.evidence.identity.confidence, 0.5);
  assert.deepStrictEqual(
    byName.NUnit.evidence.identity.methods[0].confidence,
    0.5,
  );
  // Wildcards are treated the same way
  assert.deepStrictEqual(byName.log4net.version, undefined);
  assert.deepStrictEqual(
    byName.log4net.properties.find(
      (p) => p.name === "cdx:nuget:declared_version_range",
    ).value,
    "2.0.*",
  );
  assert.deepStrictEqual(byName.log4net.evidence.identity.confidence, 0.5);
  assert.deepStrictEqual(byName.jQuery.version, undefined);
  assert.deepStrictEqual(
    byName.jQuery.properties.find(
      (p) => p.name === "cdx:nuget:declared_version_range",
    ).value,
    "*",
  );
  assert.deepStrictEqual(byName.jQuery.evidence.identity.confidence, 0.5);
  // Unresolved templated versions must not appear in the purl,
  // whether fully or partially templated
  assert.deepStrictEqual(
    byName["Newtonsoft.Json"].purl,
    "pkg:nuget/Newtonsoft.Json",
  );
  assert.deepStrictEqual(byName["Newtonsoft.Json"].version, undefined);
  assert.deepStrictEqual(
    byName["Newtonsoft.Json"].evidence.identity.confidence,
    0.5,
  );
  assert.deepStrictEqual(byName.Serilog.purl, "pkg:nuget/Serilog");
  assert.deepStrictEqual(byName.Serilog.version, undefined);
  assert.deepStrictEqual(byName.Serilog.evidence.identity.confidence, 0.5);
  // Missing and empty versions must not produce a purl with @undefined
  assert.deepStrictEqual(byName.bootstrap.purl, "pkg:nuget/bootstrap");
  assert.deepStrictEqual(byName.bootstrap.version, undefined);
  assert.deepStrictEqual(byName.bootstrap.evidence.identity.confidence, 0.5);
  assert.deepStrictEqual(byName.WebGrease.purl, "pkg:nuget/WebGrease");
  assert.deepStrictEqual(byName.WebGrease.version, undefined);
  assert.deepStrictEqual(byName.WebGrease.evidence.identity.confidence, 0.5);
  // bom-ref must stay in sync with the purl, since trimComponents keys on it
  for (const d of dep_list) {
    assert.deepStrictEqual(d["bom-ref"], d.purl);
  }
});

it("parse cs pkg data backfills templated and missing versions", () => {
  const pkgFile =
    "test/data/csharp-mixed-manifests/ImpreciseVersions/packages.config";
  const dep_list = parseCsPkgData(
    readFileSync(`./${pkgFile}`, { encoding: "utf-8" }),
    pkgFile,
    {
      "Newtonsoft.Json": "13.0.3",
      Serilog: "2.10.0",
      bootstrap: "5.3.3",
      WebGrease: "1.6.0",
      Antlr: "9.9.9",
      NUnit: "3.14.0",
      "Castle.Core": "5.0.0",
    },
  );
  const byName = {};
  for (const d of dep_list) {
    byName[d.name] = d;
  }
  // Templated version resolved from more precise manifests, still lower confidence
  assert.deepStrictEqual(byName["Newtonsoft.Json"].version, "13.0.3");
  assert.deepStrictEqual(
    byName["Newtonsoft.Json"].purl,
    "pkg:nuget/Newtonsoft.Json@13.0.3",
  );
  assert.deepStrictEqual(
    byName["Newtonsoft.Json"]["bom-ref"],
    "pkg:nuget/Newtonsoft.Json@13.0.3",
  );
  assert.deepStrictEqual(
    byName["Newtonsoft.Json"].evidence.identity.confidence,
    0.5,
  );
  // Partially templated versions are backfilled the same way
  assert.deepStrictEqual(byName.Serilog.version, "2.10.0");
  assert.deepStrictEqual(byName.Serilog.purl, "pkg:nuget/Serilog@2.10.0");
  assert.deepStrictEqual(byName.Serilog.evidence.identity.confidence, 0.5);
  // Missing and empty versions resolved the same way
  assert.deepStrictEqual(byName.bootstrap.version, "5.3.3");
  assert.deepStrictEqual(byName.bootstrap.purl, "pkg:nuget/bootstrap@5.3.3");
  assert.deepStrictEqual(
    byName.bootstrap["bom-ref"],
    "pkg:nuget/bootstrap@5.3.3",
  );
  assert.deepStrictEqual(byName.bootstrap.evidence.identity.confidence, 0.5);
  assert.deepStrictEqual(byName.WebGrease.version, "1.6.0");
  assert.deepStrictEqual(byName.WebGrease.purl, "pkg:nuget/WebGrease@1.6.0");
  // Concrete versions are never overridden by the resolved map,
  // even when they disagree - both versions must be tracked
  assert.deepStrictEqual(byName.Antlr.version, "3.5.0.2");
  assert.deepStrictEqual(byName.Antlr.evidence.identity.confidence, 0.7);
  // Exact-pin ranges are concrete too
  assert.deepStrictEqual(byName["Castle.Core"].version, "4.4.1");
  // A range is a declared constraint, so the installed version resolved from a
  // more precise manifest wins and the constraint is kept as a property
  assert.deepStrictEqual(byName.NUnit.version, "3.14.0");
  assert.deepStrictEqual(byName.NUnit.purl, "pkg:nuget/NUnit@3.14.0");
  assert.deepStrictEqual(
    byName.NUnit.properties.find(
      (p) => p.name === "cdx:nuget:declared_version_range",
    ).value,
    "[3.13.3,4.0)",
  );
  assert.deepStrictEqual(byName.NUnit.evidence.identity.confidence, 0.5);
});

it("get property group text nodes", () => {
  console.log("getPropertyGroupTextNodes");
  assert.deepStrictEqual(getPropertyGroupTextNodes([null]), {});
  assert.deepStrictEqual(
    getPropertyGroupTextNodes(["./test/Directory.Build.props"]),
    {
      Test_MicrosoftAspNetCore_PackageVersion: ["4.8.0"],
      Test_AdaptiveCards_PackageVersion: ["1.0.3"],
    },
  );
});

it("parse cs proj", () => {
  assert.deepStrictEqual(parseCsProjData(null), []);
  let retMap = parseCsProjData(
    readFileSync("./test/sample.csproj", { encoding: "utf-8" }),
    "./test/sample.csproj",
    {},
    true,
    {
      Test_MicrosoftAspNetCore_PackageVersion: ["4.8.0"],
      Test_AdaptiveCards_PackageVersion: ["1.0.3"],
    },
  );
  assert.deepStrictEqual(
    retMap?.parentComponent["bom-ref"],
    "pkg:nuget/sample@latest",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 5);
  assert.deepStrictEqual(retMap.pkgList[0], {
    "bom-ref": "pkg:nuget/Microsoft.AspNetCore.Mvc.NewtonsoftJson@3.1.1",
    group: "",
    name: "Microsoft.AspNetCore.Mvc.NewtonsoftJson",
    version: "3.1.1",
    purl: "pkg:nuget/Microsoft.AspNetCore.Mvc.NewtonsoftJson@3.1.1",
    properties: [{ name: "internal:SrcFile", value: "./test/sample.csproj" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.7,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.7,
            value: "./test/sample.csproj",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(retMap.pkgList[1], {
    "bom-ref": "pkg:nuget/Microsoft.Bot.Builder.Dialogs@4.8.0",
    group: "",
    name: "Microsoft.Bot.Builder.Dialogs",
    version: "4.8.0",
    purl: "pkg:nuget/Microsoft.Bot.Builder.Dialogs@4.8.0",
    properties: [{ name: "internal:SrcFile", value: "./test/sample.csproj" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.7,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.7,
            value: "./test/sample.csproj",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(retMap.pkgList[2], {
    "bom-ref": "pkg:nuget/Microsoft.Bot.Builder.Integration.AspNet.Core@4.8.0",
    group: "",
    name: "Microsoft.Bot.Builder.Integration.AspNet.Core",
    version: "4.8.0",
    purl: "pkg:nuget/Microsoft.Bot.Builder.Integration.AspNet.Core@4.8.0",
    properties: [{ name: "internal:SrcFile", value: "./test/sample.csproj" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.7,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.7,
            value: "./test/sample.csproj",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(retMap.pkgList[4], {
    "bom-ref": "pkg:nuget/AdaptiveCards@1.0.3",
    group: "",
    name: "AdaptiveCards",
    version: "1.0.3",
    purl: "pkg:nuget/AdaptiveCards@1.0.3",
    properties: [{ name: "internal:SrcFile", value: "./test/sample.csproj" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.7,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.7,
            value: "./test/sample.csproj",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(retMap?.parentComponent.properties, [
    { name: "cdx:dotnet:target_framework", value: "netcoreapp3.1" },
  ]);
  retMap = parseCsProjData(
    readFileSync("./test/data/WindowsFormsApplication1.csproj", {
      encoding: "utf-8",
    }),
  );
  // The MSBuild OutputType is a property, not a purl qualifier: nuget does not
  // define `output_type`, so the old purl was invalid.
  assert.deepStrictEqual(retMap.parentComponent, {
    type: "application",
    properties: [
      { name: "cdx:dotnet:output_type", value: "WinExe" },
      {
        name: "cdx:dotnet:project_guid",
        value: "{3336A23A-6F2C-46D4-89FA-93C726CEB23D}",
      },
      {
        name: "internal:Namespaces",
        value: "WindowsFormsApplication1",
      },
      { name: "cdx:dotnet:target_framework", value: "v4.8" },
    ],
    name: "WindowsFormsApplication1",
    version: "8.0.30703",
    purl: "pkg:nuget/WindowsFormsApplication1@8.0.30703",
    "bom-ref": "pkg:nuget/WindowsFormsApplication1@8.0.30703",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 53);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "",
    name: "activeup.net.common",
    purl: "pkg:nuget/activeup.net.common",
    "bom-ref": "pkg:nuget/activeup.net.common",
    properties: [
      {
        name: "cdx:dotnet:hint_path",
        value: "..\\activeup.net.common.dll",
      },
      {
        name: "internal:PackageFiles",
        value: "activeup.net.common.dll",
      },
    ],
  });
  assert.deepStrictEqual(retMap.dependencies, [
    {
      dependsOn: [
        "pkg:nuget/BouncyCastle@1.7.0",
        "pkg:nuget/Bunifu_UI_v1.5.3",
        "pkg:nuget/Google.Apis.Auth@1.10.0",
        "pkg:nuget/Google.Apis.Calendar.v3",
        "pkg:nuget/Google.Apis.Core@1.10.0",
        "pkg:nuget/Google.Apis.Oauth2.v2",
        "pkg:nuget/Google.Apis.Sheets.v4@1.35.2.1356",
        "pkg:nuget/Google.Apis.Tasks.v1",
        "pkg:nuget/Google.Apis@1.10.0",
        "pkg:nuget/Google.GData.Apps",
        "pkg:nuget/Google.GData.Client",
        "pkg:nuget/Google.GData.Contacts",
        "pkg:nuget/Google.GData.Extensions",
        "pkg:nuget/Google.GData.Spreadsheets",
        "pkg:nuget/HtmlAgilityPack@1.4.6.0",
        "pkg:nuget/MailKit",
        "pkg:nuget/MaterialMessageBox@1.0.0.11",
        "pkg:nuget/Microsoft.Bcl.Async@1.0.168",
        "pkg:nuget/Microsoft.Bcl@1.1.10",
        "pkg:nuget/Microsoft.CSharp",
        "pkg:nuget/Microsoft.Net.Http@2.2.29",
        "pkg:nuget/Microsoft.VisualBasic",
        "pkg:nuget/MimeKit",
        "pkg:nuget/NUnit@3.10.1",
        "pkg:nuget/Newtonsoft.Json@7.0.1",
        "pkg:nuget/Proxy@3.0.16061.1530",
        "pkg:nuget/S22.Imap",
        "pkg:nuget/SKGL",
        "pkg:nuget/Selenium.WebDriver@3.13.1",
        "pkg:nuget/System",
        "pkg:nuget/System.Core",
        "pkg:nuget/System.Data",
        "pkg:nuget/System.Data.DataSetExtensions",
        "pkg:nuget/System.Deployment",
        "pkg:nuget/System.Drawing",
        "pkg:nuget/System.Management",
        "pkg:nuget/System.Net",
        "pkg:nuget/System.Windows.Forms",
        "pkg:nuget/System.Xml",
        "pkg:nuget/System.Xml.Linq",
        "pkg:nuget/Zlib.Portable.Signed@1.11.0",
        "pkg:nuget/activeup.net.common",
        "pkg:nuget/activeup.net.imap4",
        "pkg:nuget/log4net@2.0.3",
      ],
      ref: "pkg:nuget/WindowsFormsApplication1@8.0.30703",
    },
  ]);
  assert.deepStrictEqual(retMap?.parentComponent.properties, [
    { name: "cdx:dotnet:output_type", value: "WinExe" },
    {
      name: "cdx:dotnet:project_guid",
      value: "{3336A23A-6F2C-46D4-89FA-93C726CEB23D}",
    },
    {
      name: "internal:Namespaces",
      value: "WindowsFormsApplication1",
    },
    {
      name: "cdx:dotnet:target_framework",
      value: "v4.8",
    },
  ]);
  retMap = parseCsProjData(
    readFileSync("./test/data/Server.csproj", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    type: "library",
    properties: [
      {
        name: "cdx:dotnet:project_guid",
        value: "{6BA9F9E1-E43C-489D-A3B4-8916CA2D4C5F}",
      },
      { name: "internal:Namespaces", value: "OutputMgr.Server" },
      { name: "cdx:dotnet:target_framework", value: "v4.8" },
    ],
    name: "Server",
    version: "9.0.21022",
    purl: "pkg:nuget/Server@9.0.21022",
    "bom-ref": "pkg:nuget/Server@9.0.21022",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 34);
  assert.deepStrictEqual(retMap?.parentComponent.properties, [
    {
      name: "cdx:dotnet:project_guid",
      value: "{6BA9F9E1-E43C-489D-A3B4-8916CA2D4C5F}",
    },
    {
      name: "internal:Namespaces",
      value: "OutputMgr.Server",
    },
    {
      name: "cdx:dotnet:target_framework",
      value: "v4.8",
    },
  ]);
  retMap = parseCsProjData(
    readFileSync("./test/data/Logging.csproj", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap?.parentComponent["bom-ref"], undefined);
  assert.deepStrictEqual(retMap?.parentComponent.properties, [
    { name: "internal:Namespaces", value: "Sample.OData" },
    { name: "cdx:dotnet:target_framework", value: "$(TargetFrameworks);" },
  ]);
});

it("parse Directory.Packages.props central versions", () => {
  const versions = parseDirectoryPackagesProps(
    "./test/data/csharp-mixed-manifests/CentralPackageManagement/Directory.Packages.props",
  );
  // Keys are lowercased because NuGet package ids are case-insensitive
  assert.deepStrictEqual(versions.wix, "3.14.1");
  assert.deepStrictEqual(versions["newtonsoft.json"], "13.0.3");
  // A later Update entry overrides the version an earlier Include declared
  assert.deepStrictEqual(versions.nunit, "4.0.1");
  // An explicit opt-out makes the PackageVersion entries inert
  assert.deepStrictEqual(
    parseDirectoryPackagesProps(
      "./test/data/csharp-mixed-manifests/CpmDisabled/Directory.Packages.props",
    ),
    {},
  );
  // A missing file must not throw
  assert.deepStrictEqual(
    parseDirectoryPackagesProps("./test/data/no-such-Directory.Packages.props"),
    {},
  );
});

it("find central package versions by walking up from a project file", () => {
  const projFile =
    "./test/data/csharp-mixed-manifests/CentralPackageManagement/src/App/App.csproj";
  // The props file is two directories above the project, and above the directory a
  // user would typically point cdxgen at
  const cache = {};
  const versions = getCentralPackageVersions(projFile, cache);
  assert.deepStrictEqual(versions.serilog, "3.1.1");
  // The cache is keyed by props file so sibling projects parse it once
  assert.deepStrictEqual(Object.keys(cache).length, 1);
  assert.deepStrictEqual(getCentralPackageVersions(projFile, cache), versions);
  assert.deepStrictEqual(Object.keys(cache).length, 1);
  // A project with no Directory.Packages.props anywhere above it resolves to nothing
  assert.deepStrictEqual(
    getCentralPackageVersions("./test/data/Logging.csproj"),
    {},
  );
  assert.deepStrictEqual(getCentralPackageVersions(undefined), {});
});

it("parse cs proj resolves central package management versions", () => {
  const projFile =
    "./test/data/csharp-mixed-manifests/CentralPackageManagement/src/App/App.csproj";
  const retMap = parseCsProjData(
    readFileSync(projFile, { encoding: "utf-8" }),
    projFile,
    {},
    false,
    {},
    getCentralPackageVersions(projFile),
  );
  const byName = {};
  for (const p of retMap.pkgList) {
    byName[p.name] = p;
  }
  // A PackageReference with no Version attribute at all - the CPM case from #4303
  assert.deepStrictEqual(byName.WiX.version, "3.14.1");
  assert.deepStrictEqual(byName.WiX.purl, "pkg:nuget/WiX@3.14.1");
  assert.deepStrictEqual(byName.WiX["bom-ref"], "pkg:nuget/WiX@3.14.1");
  assert.deepStrictEqual(byName.Serilog.version, "3.1.1");
  // Lookup is case-insensitive against the central declaration
  assert.deepStrictEqual(byName["Newtonsoft.Json"].version, "13.0.3");
  // VersionOverride wins over the central version
  assert.deepStrictEqual(byName.Moq.version, "4.18.4");
  assert.deepStrictEqual(byName.NUnit.version, "4.0.1");
  // A package that is not declared centrally must still be tracked, and must not
  // get a purl containing @undefined
  assert.deepStrictEqual(byName["Unlisted.Package"].version, undefined);
  assert.deepStrictEqual(
    byName["Unlisted.Package"].purl,
    "pkg:nuget/Unlisted.Package",
  );
  assert.deepStrictEqual(
    byName["Unlisted.Package"]["bom-ref"],
    "pkg:nuget/Unlisted.Package",
  );
  // Versions already resolved from a precise manifest stay authoritative, since a
  // central declaration can be a floating range
  const withResolved = parseCsProjData(
    readFileSync(projFile, { encoding: "utf-8" }),
    projFile,
    { WiX: "3.11.2" },
    false,
    {},
    getCentralPackageVersions(projFile),
  );
  assert.deepStrictEqual(
    withResolved.pkgList.find((p) => p.name === "WiX").version,
    "3.11.2",
  );
});

it("parse cs proj assembly references state no version they cannot back up", () => {
  // #4359: a `<Reference>` names an assembly, so the project states no package
  // version. The component must not state one either - a version in the field
  // with none in the purl is one package described two ways, and a scanner range
  // matching on the versionless purl reports every advisory against the name.
  const projFile =
    "./test/data/csharp-mixed-manifests/AssemblyReferences/src/App/App.csproj";
  const retMap = parseCsProjData(
    readFileSync(projFile, { encoding: "utf-8" }),
    projFile,
    {},
    false,
    {},
    getCentralPackageVersions(projFile),
  );
  const byName = {};
  for (const p of retMap.pkgList) {
    byName[p.name] = p;
  }
  assert.deepStrictEqual(byName["Newtonsoft.Json"].version, undefined);
  assert.deepStrictEqual(
    byName["Newtonsoft.Json"].purl,
    "pkg:nuget/Newtonsoft.Json",
  );
  assert.deepStrictEqual(
    byName["Newtonsoft.Json"]["bom-ref"],
    "pkg:nuget/Newtonsoft.Json",
  );
  // A central pin applies to PackageReference, not to an assembly reference: the
  // assembly resolves from a lib folder or the GAC, and the project never says it
  // came from that package.
  assert.deepStrictEqual(
    byName["Newtonsoft.Json"].properties.find(
      (p) => p.name === "cdx:dotnet:target_framework",
    ),
    undefined,
  );
  // A framework assembly on net48 is serviced through the OS. The target
  // framework is recorded so the component stays explainable.
  assert.deepStrictEqual(byName["System.Net.Http"].version, undefined);
  assert.deepStrictEqual(
    byName["System.Net.Http"].purl,
    "pkg:nuget/System.Net.Http",
  );
  assert.deepStrictEqual(
    byName["System.Net.Http"].properties.find(
      (p) => p.name === "cdx:dotnet:target_framework",
    ).value,
    "net48",
  );
  // A concrete inline assembly version still reaches the purl
  assert.deepStrictEqual(byName.log4net.version, "2.0.15.0");
  assert.deepStrictEqual(byName.log4net.purl, "pkg:nuget/log4net@2.0.15.0");
  // An unresolvable MSBuild property is kept as a declaration, not as a version
  assert.deepStrictEqual(byName["FSharp.Core"].version, undefined);
  assert.deepStrictEqual(byName["FSharp.Core"].purl, "pkg:nuget/FSharp.Core");
  assert.deepStrictEqual(
    byName["FSharp.Core"].properties.find(
      (p) => p.name === "cdx:nuget:declared_version_range",
    ).value,
    "$(TargetFSharpCoreVersion)",
  );
  // Every component agrees with itself
  for (const p of retMap.pkgList) {
    assert.deepStrictEqual(p["bom-ref"], p.purl);
    assert.deepStrictEqual(p.purl.endsWith("@undefined"), false);
    if (p.version) {
      assert.deepStrictEqual(p.purl, `pkg:nuget/${p.name}@${p.version}`);
    }
  }
  // The sibling project's PackageReference does resolve centrally, and a range
  // there is a constraint rather than an installed version
  const libFile =
    "./test/data/csharp-mixed-manifests/AssemblyReferences/src/Lib/Lib.csproj";
  const libMap = parseCsProjData(
    readFileSync(libFile, { encoding: "utf-8" }),
    libFile,
    {},
    false,
    {},
    getCentralPackageVersions(libFile),
  );
  const libByName = {};
  for (const p of libMap.pkgList) {
    libByName[p.name] = p;
  }
  assert.deepStrictEqual(libByName["Newtonsoft.Json"].version, "12.0.3");
  assert.deepStrictEqual(
    libByName["Newtonsoft.Json"].purl,
    "pkg:nuget/Newtonsoft.Json@12.0.3",
  );
  assert.deepStrictEqual(libByName.NUnit.version, undefined);
  assert.deepStrictEqual(libByName.NUnit.purl, "pkg:nuget/NUnit");
  assert.deepStrictEqual(
    libByName.NUnit.properties.find(
      (p) => p.name === "cdx:nuget:declared_version_range",
    ).value,
    "[3.13.3,4.0)",
  );
});

it("parse cs proj hint path", () => {
  const retMap = parseCsProjData(
    readFileSync("./test/data/issue-2156/demo.csproj", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 36);
  assert.deepStrictEqual(retMap.pkgList[0], {
    "bom-ref": "pkg:nuget/Auth0.AuthenticationApi@7.26.1",
    group: "",
    name: "Auth0.AuthenticationApi",
    properties: [
      {
        name: "cdx:dotnet:assembly_version",
        value: "7.26.1.0",
      },
      {
        name: "cdx:dotnet:hint_path",
        value:
          "..\\packages\\Auth0.AuthenticationApi.7.26.1\\lib\\net462\\Auth0.AuthenticationApi.dll",
      },
      {
        name: "internal:PackageFiles",
        value: "Auth0.AuthenticationApi.dll",
      },
    ],
    purl: "pkg:nuget/Auth0.AuthenticationApi@7.26.1",
    version: "7.26.1",
  });
});

it("parse project.assets.json", () => {
  assert.deepStrictEqual(parseCsProjAssetsData(null), {
    dependenciesList: [],
    pkgList: [],
  });
  let dep_list = parseCsProjAssetsData(
    readFileSync("./test/data/project.assets.json", { encoding: "utf-8" }),
    "./test/data/project.assets.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 302);
  assert.deepStrictEqual(dep_list["pkgList"][0], {
    "bom-ref": "pkg:nuget/Castle.Core.Tests@0.0.0",
    purl: "pkg:nuget/Castle.Core.Tests@0.0.0",
    group: "",
    name: "Castle.Core.Tests",
    type: "application",
    version: "0.0.0",
  });
  assert.deepStrictEqual(dep_list["dependenciesList"].length, 302);
  assert.deepStrictEqual(dep_list["dependenciesList"][0], {
    dependsOn: [
      "pkg:nuget/Castle.Core-NLog@0.0.0",
      "pkg:nuget/Castle.Core-Serilog@0.0.0",
      "pkg:nuget/Castle.Core-log4net@0.0.0",
      "pkg:nuget/Castle.Core@0.0.0",
      "pkg:nuget/Microsoft.NET.Test.Sdk@17.1.0",
      "pkg:nuget/Microsoft.NETCore.App@2.1.0",
      "pkg:nuget/Microsoft.NETFramework.ReferenceAssemblies@1.0.0",
      "pkg:nuget/NLog@4.5.0",
      "pkg:nuget/NUnit.Console@3.11.1",
      "pkg:nuget/NUnit3TestAdapter@3.16.1",
      "pkg:nuget/NUnitLite@3.13.3",
      "pkg:nuget/PublicApiGenerator@10.1.2",
      "pkg:nuget/Serilog.Sinks.TextWriter@2.0.0",
      "pkg:nuget/Serilog@2.0.0",
      "pkg:nuget/System.Net.NameResolution@4.3.0",
      "pkg:nuget/System.Net.Primitives@4.3.0",
      "pkg:nuget/System.Security.Permissions@4.7.0",
      "pkg:nuget/System.Security.Permissions@6.0.0",
      "pkg:nuget/log4net@2.0.13",
    ],
    ref: "pkg:nuget/Castle.Core.Tests@0.0.0",
  });
  dep_list = parseCsProjAssetsData(
    readFileSync("./test/data/project.assets1.json", { encoding: "utf-8" }),
    "./test/data/project.assets1.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 43);
  assert.deepStrictEqual(dep_list["pkgList"][0], {
    "bom-ref": "pkg:nuget/Podcast.Server@1.0.0",
    purl: "pkg:nuget/Podcast.Server@1.0.0",
    group: "",
    name: "Podcast.Server",
    type: "application",
    version: "1.0.0",
  });
  /*
  const pkgList = addEvidenceForDotnet(
    dep_list.pkgList,
    "./test/data/dosai-methods.json"
  );
  assert.deepStrictEqual(pkgList.length, 43);
  */
});

it("parse packages.lock.json", () => {
  assert.deepStrictEqual(parseCsPkgLockData(null), {
    dependenciesList: [],
    pkgList: [],
    rootList: [],
  });
  let dep_list = parseCsPkgLockData(
    readFileSync("./test/data/packages.lock.json", { encoding: "utf-8" }),
    "./test/data/packages.lock.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 14);
  assert.deepStrictEqual(dep_list["pkgList"][0], {
    group: "",
    name: "Antlr",
    version: "3.5.0.2",
    purl: "pkg:nuget/Antlr@3.5.0.2",
    "bom-ref": "pkg:nuget/Antlr@3.5.0.2",
    _integrity:
      "sha512-CSfrVuDVMx3OrQhT84zed+tOdM1clljyRLWWlQM22fJsmG836RVDGQlE6tzysXh8X8p9UjkHbLr6OqEIVhtdEA==",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/packages.lock.json" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/packages.lock.json",
          },
        ],
      },
    },
  });
  dep_list = parseCsPkgLockData(
    readFileSync("./test/data/packages2.lock.json", { encoding: "utf-8" }),
    "./test/data/packages2.lock.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 34);
  assert.deepStrictEqual(dep_list["dependenciesList"].length, 34);
  assert.deepStrictEqual(dep_list["pkgList"][0], {
    group: "",
    name: "McMaster.Extensions.Hosting.CommandLine",
    version: "4.0.1",
    purl: "pkg:nuget/McMaster.Extensions.Hosting.CommandLine@4.0.1",
    "bom-ref": "pkg:nuget/McMaster.Extensions.Hosting.CommandLine@4.0.1",
    _integrity:
      "sha512-pZJF/zeXT3OC+3GUNO9ZicpCO9I7wYLmj0E2qPR8CRA6iUs0kGu6SCkmraB1sITx4elcVjMLiZDGMsBVMqaPhg==",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/packages2.lock.json" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/packages2.lock.json",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(dep_list["dependenciesList"][0], {
    ref: "pkg:nuget/McMaster.Extensions.Hosting.CommandLine@4.0.1",
    dependsOn: [
      "pkg:nuget/McMaster.Extensions.CommandLineUtils@4.0.1",
      "pkg:nuget/Microsoft.Extensions.Hosting.Abstractions@6.0.0",
      "pkg:nuget/Microsoft.Extensions.Logging.Abstractions@6.0.0",
    ],
  });
  dep_list = parseCsPkgLockData(
    readFileSync("./test/data/packages3.lock.json", { encoding: "utf-8" }),
    "./test/data/packages3.lock.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 15);
  assert.deepStrictEqual(dep_list["pkgList"][1], {
    group: "",
    name: "FSharp.Core",
    version: "4.5.2",
    purl: "pkg:nuget/FSharp.Core@4.5.2",
    "bom-ref": "pkg:nuget/FSharp.Core@4.5.2",
    _integrity:
      "sha512-apbdQOjzsjQ637kTWQuW29jqwY18jsHMyNC5A+TPJZKFEIE2cIfQWf3V7+mXrxlbX69BueYkv293/g70wuXuRw==",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/packages3.lock.json" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/packages3.lock.json",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(dep_list["dependenciesList"].length, 15);
});

it("parse paket.lock", () => {
  assert.deepStrictEqual(parsePaketLockData(null), {
    pkgList: [],
    dependenciesList: [],
  });
  const dep_list = parsePaketLockData(
    readFileSync("./test/data/paket.lock", { encoding: "utf-8" }),
    "./test/data/paket.lock",
  );
  assert.deepStrictEqual(dep_list.pkgList.length, 13);
  assert.deepStrictEqual(dep_list.pkgList[0], {
    group: "",
    name: "0x53A.ReferenceAssemblies.Paket",
    version: "0.2",
    purl: "pkg:nuget/0x53A.ReferenceAssemblies.Paket@0.2",
    "bom-ref": "pkg:nuget/0x53A.ReferenceAssemblies.Paket@0.2",
    properties: [{ name: "internal:SrcFile", value: "./test/data/paket.lock" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/paket.lock",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(dep_list.dependenciesList.length, 13);
  assert.deepStrictEqual(dep_list.dependenciesList[2], {
    ref: "pkg:nuget/FSharp.Compiler.Service@17.0.1",
    dependsOn: [
      "pkg:nuget/System.Collections.Immutable@1.4",
      "pkg:nuget/System.Reflection.Metadata@1.5",
    ],
  });
});

it("parse .net cs proj", () => {
  assert.deepStrictEqual(parseCsProjData(null), []);
  const retMap = parseCsProjData(
    readFileSync("./test/data/sample-dotnet.csproj", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    type: "library",
    properties: [
      { name: "internal:Namespaces", value: "Calculator" },
      { name: "cdx:dotnet:target_framework", value: "v4.6.2" },
    ],
    name: "Calculator",
    purl: "pkg:nuget/Calculator@latest",
    "bom-ref": "pkg:nuget/Calculator@latest",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 19);
  assert.deepStrictEqual(retMap.pkgList[0], {
    "bom-ref": "pkg:nuget/Antlr@3.5.0.2",
    group: "",
    name: "Antlr",
    properties: [
      {
        name: "cdx:dotnet:assembly_name",
        value: "Antlr3.Runtime",
      },
      {
        name: "cdx:dotnet:assembly_version",
        value: "3.5.0.2",
      },
      {
        name: "cdx:dotnet:hint_path",
        value: "..\\packages\\Antlr.3.5.0.2\\lib\\Antlr3.Runtime.dll",
      },
      {
        name: "internal:PackageFiles",
        value: "Antlr3.Runtime.dll",
      },
    ],
    purl: "pkg:nuget/Antlr@3.5.0.2",
    version: "3.5.0.2",
  });
  for (const apkg of retMap.pkgList) {
    if (
      (apkg.name.startsWith("System.") ||
        apkg.name.startsWith("Mono.") ||
        apkg.name.startsWith("Microsoft.")) &&
      !apkg.version
    ) {
      assert.ok(apkg.properties.length >= 1);
      assert.deepStrictEqual(
        apkg.properties[0].name,
        "cdx:dotnet:target_framework",
      );
    }
  }
  assert.deepStrictEqual(retMap.dependencies, [
    {
      dependsOn: [
        "pkg:nuget/Antlr@3.5.0.2",
        "pkg:nuget/Microsoft.ApplicationInsights.Agent.Intercept@2.4.0",
        "pkg:nuget/Microsoft.ApplicationInsights.DependencyCollector@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights.PerfCounterCollector@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights.Web@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights.WindowsServer.TelemetryChannel@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights.WindowsServer@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights@2.5.1",
        "pkg:nuget/Microsoft.AspNet.SessionState.SessionStateModule@1.1.0",
        "pkg:nuget/Microsoft.AspNet.TelemetryCorrelation@1.0.0",
        "pkg:nuget/Microsoft.CSharp",
        "pkg:nuget/Microsoft.CodeDom.Providers.DotNetCompilerPlatform@1.0.8",
        "pkg:nuget/Microsoft.Web.Infrastructure@1.0.0.0",
        "pkg:nuget/Microsoft.Web.RedisSessionStateProvider@4.0.1",
        "pkg:nuget/Microsoft.WindowsAzure.Diagnostics@2.8.0.0",
        "pkg:nuget/Newtonsoft.Json@11.0.1",
        "pkg:nuget/Pipelines.Sockets.Unofficial@1.0.7",
        "pkg:nuget/StackExchange.Redis@2.0.519",
        "pkg:nuget/WebGrease@1.6.0",
      ],
      ref: "pkg:nuget/Calculator@latest",
    },
  ]);
});

it("parse nupkg file", async () => {
  let retMap = await parseNupkg(
    "./test/data/Microsoft.Web.Infrastructure.1.0.0.0.nupkg",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(
    retMap.pkgList[0].name,
    "Microsoft.Web.Infrastructure",
  );
  assert.deepStrictEqual(retMap.dependenciesMap, {});
  retMap = parseNuspecData(
    "./test/data/Microsoft.Web.Infrastructure.1.0.0.0.nuspec",
    readFileSync(
      "./test/data/Microsoft.Web.Infrastructure.1.0.0.0.nuspec",
      "ascii",
    ),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(
    retMap.pkgList[0].name,
    "Microsoft.Web.Infrastructure",
  );
  assert.deepStrictEqual(retMap.dependenciesMap, {});
  retMap = await parseNupkg("./test/data/jquery.3.6.0.nupkg");
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(retMap.pkgList[0].name, "jQuery");
  assert.deepStrictEqual(retMap.dependenciesMap, {});
  retMap = parseNuspecData(
    "./test/data/xunit.nuspec",
    readFileSync("./test/data/xunit.nuspec", "utf-8"),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(retMap.dependenciesMap, {
    "pkg:nuget/xunit@2.2.0": ["xunit.core", "xunit.assert"],
  });
  retMap = parseNuspecData(
    "./test/data/xunit.nuspec",
    readFileSync("./test/data/xunit.runner.utility.nuspec", "utf-8"),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 8);
  assert.deepStrictEqual(retMap.pkgList[1].properties, [
    { name: "internal:SrcFile", value: "./test/data/xunit.nuspec" },
    { name: "cdx:dotnet:target_framework", value: ".NETFramework3.5" },
  ]);
  assert.deepStrictEqual(retMap.dependenciesMap, {
    "pkg:nuget/xunit.runner.utility@2.2.0": [
      "xunit.abstractions",
      "NETStandard.Library",
      "xunit.extensibility.core",
      "System.Reflection.TypeExtensions",
    ],
  });
});

it("parse cs proj reads the SDK-style version properties", () => {
  const csproj = (props) =>
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup><PropertyGroup>${props}</PropertyGroup><ItemGroup><PackageReference Include="Foo.Meta" Version="1.2.3" /></ItemGroup></Project>`;
  const rootOf = (props) =>
    parseCsProjData(csproj(props), "/src/app.csproj").parentComponent;
  // Version is read even when it follows the PropertyGroup holding OutputType.
  assert.deepStrictEqual(
    rootOf("<Version>1.0.0</Version>").purl,
    "pkg:nuget/app@1.0.0",
  );
  assert.deepStrictEqual(
    rootOf("<Version>1.0.0</Version><PackageVersion>1.1.0</PackageVersion>")
      .version,
    "1.1.0",
  );
  assert.deepStrictEqual(
    rootOf(
      "<VersionPrefix>2.0.0</VersionPrefix><VersionSuffix>beta.1</VersionSuffix>",
    ).version,
    "2.0.0-beta.1",
  );
  assert.deepStrictEqual(
    rootOf("<VersionPrefix>2.0.0</VersionPrefix>").version,
    "2.0.0",
  );
  // A version that depends on a build-time property is not guessed.
  assert.deepStrictEqual(
    rootOf("<Version>$(BuildVersion)</Version>").purl,
    "pkg:nuget/app@latest",
  );
  // NuGet accepts SemVer 2.0.0 build metadata: the purl escapes it, while the
  // bom-ref and the dependency ref keep the decoded form.
  const retMap = parseCsProjData(
    csproj("<Version>1.0.0+build.5</Version>"),
    "/src/app.csproj",
  );
  assert.deepStrictEqual(
    retMap.parentComponent.purl,
    "pkg:nuget/app@1.0.0%2Bbuild.5",
  );
  assert.deepStrictEqual(
    retMap.parentComponent["bom-ref"],
    "pkg:nuget/app@1.0.0+build.5",
  );
  assert.deepStrictEqual(retMap.dependencies, [
    {
      ref: "pkg:nuget/app@1.0.0+build.5",
      dependsOn: ["pkg:nuget/Foo.Meta@1.2.3"],
    },
  ]);
});
