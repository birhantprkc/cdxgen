import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import {
  constructServiceName,
  detectServicesFromUsages,
  extractEndpoints,
  loadReusableSemanticsSlice,
  mergeAnalyzerMetadataProperties,
  parseSemanticSlices,
  sliceFileOption,
} from "./evinser.js";

it("Service detection test", () => {
  const usageSlice = JSON.parse(
    readFileSync("./test/data/usages.json", { encoding: "utf-8" }),
  );
  const objectSlices = usageSlice.objectSlices;
  const servicesMap = {};
  for (const slice of objectSlices) {
    detectServicesFromUsages("java", slice, servicesMap);
    assert.ok(servicesMap);
    const serviceName = constructServiceName("java", slice);
    assert.ok(serviceName);
  }
});

it("extract endpoints test", () => {
  assert.deepStrictEqual(
    extractEndpoints("java", '@GetMapping(value = { "/", "/home" })'),
    ["/", "/home"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@PostMapping(value = "/issue", consumes = MediaType.APPLICATION_XML_VALUE)',
    ),
    ["/issue"],
  );
  assert.deepStrictEqual(extractEndpoints("java", '@GetMapping("/token")'), [
    "/token",
  ]);
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      'router.use("/api/v2/users",userRoutes.routes(),userRoutes.allowedMethods())',
    ),
    ["/api/v2/users"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/encryptionkeys', serveIndexMiddleware, serveIndex('encryptionkeys', { icons: true, view: 'details' }))",
    ),
    ["/encryptionkeys"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use(express.static(path.resolve('frontend/dist/frontend')))",
    ),
    ["frontend/dist/frontend"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/ftp(?!/quarantine)/:file', fileServer())",
    ),
    ["/ftp(?!/quarantine)/:file"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/rest/basket/:id', security.isAuthorized())",
    ),
    ["/rest/basket/:id"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.get(['/.well-known/security.txt', '/security.txt'], verify.accessControlChallenges())",
    ),
    ["/.well-known/security.txt", "/security.txt"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      'router.post("/convert",async(ctx:Context):Promise<void>=>{constparameters=ctx.request.body;constbatchClient=newBatchClient({region:"us-west-1"});constcommand=newSubmitJobCommand({jobName:parameters?.jobName,jobQueue:"FOO-ARN",jobDefinition:"BAR-ARN",parameters,});try{constobjectsOutput=awaitbatchClient.send(command);ctx.response.body=objectsOutput;}catch(err){//Poorexceptionhandlingctx.response.body=err;}})',
    ),
    ["/convert"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@RequestMapping(path = "/{name}", method = RequestMethod.GET)',
    ),
    ["/{name}"],
  );
  assert.deepStrictEqual(
    extractEndpoints("java", "@RequestMapping(method = RequestMethod.POST)"),
    [],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@RequestMapping(value = "/{accountName}", method = RequestMethod.GET)',
    ),
    ["/{accountName}"],
  );
});

it("parseSemanticSlices", () => {
  const semanticsSlice = JSON.parse(
    readFileSync("./test/data/swiftsem/semantics.slices.json", {
      encoding: "utf-8",
    }),
  );
  const bomJson = JSON.parse(
    readFileSync("./test/data/swiftsem/bom-hakit.json", {
      encoding: "utf-8",
    }),
  );
  const retMap = parseSemanticSlices(
    "swift",
    bomJson.components,
    semanticsSlice,
  );
  assert.ok(retMap);
});

it("parseSemanticSlices attributes Swift usages through resolved module references", () => {
  // Created by cdxgen from a real build of a package that depends on
  // swift-argument-parser, SWXMLHash, and Yams
  const semanticsSlice = JSON.parse(
    readFileSync("./test/data/swiftsem/semantics-swift-argparser-demo.json", {
      encoding: "utf-8",
    }),
  );
  const { components } = JSON.parse(
    readFileSync("./test/data/swiftsem/bom-argparser-demo-components.json", {
      encoding: "utf-8",
    }),
  );
  const retMap = parseSemanticSlices("swift", components, semanticsSlice);
  const main = "/src/argparser-demo/Sources/argparser-demo/main.swift";
  // swift-argument-parser provides the ArgumentParser module: the import, the
  // ParsableCommand conformance, and the @Option property wrapper
  assert.deepStrictEqual(
    retMap.purlLocationMap[
      "pkg:swift/github.com/apple/swift-argument-parser@1.8.2"
    ],
    [`${main}#1`, `${main}#6`, `${main}#7`],
  );
  assert.deepStrictEqual(
    retMap.purlLocationMap["pkg:swift/github.com/drmohundro/SWXMLHash@7.0.2"],
    [`${main}#12`, `${main}#13`, `${main}#2`],
  );
  // Packages match by repository location, so a different version in the
  // SBOM still resolves; `dump(object:)` is on line 15
  assert.deepStrictEqual(
    retMap.purlLocationMap["pkg:swift/github.com/jpsim/Yams@5.4.0"],
    [`${main}#15`, `${main}#3`],
  );
  // The root package has no purl and gets no evidence
  assert.strictEqual(Object.keys(retMap.purlLocationMap).length, 3);
  // A same-named fork the build did not use gets nothing
  const fork = parseSemanticSlices(
    "swift",
    [{ name: "Yams", purl: "pkg:swift/github.com/someone/Yams@1.0.0" }],
    semanticsSlice,
  );
  assert.deepStrictEqual(fork.purlLocationMap, {});
});

it("parseSemanticSlices tolerates slices without swift symbols", () => {
  // A semantics file from another analyzer (dosai/rusi/golem shape) must not
  // crash the swift evidence flow
  const retMap = parseSemanticSlices(
    "swift",
    [{ name: "Yams", purl: "pkg:swift/github.com/jpsim/Yams@5.4.0" }],
    { Metadata: {}, methods: [], dataflows: [] },
  );
  assert.deepStrictEqual(retMap.purlLocationMap, {});
});

it("loadReusableSemanticsSlice only reuses slices of this project", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "evinse-semantics-"));
  try {
    const bomFile = join(tempDir, "bom.json");
    const slicesFile = join(tempDir, "semantics.slices.json");
    const swiftSlice = readFileSync(
      "./test/data/swiftsem/semantics-swift-argparser-demo.json",
      { encoding: "utf-8" },
    );
    writeFileSync(bomFile, "{}");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bomFile, past, past);
    writeFileSync(slicesFile, swiftSlice);
    // Same project, newer than the SBOM
    assert.ok(
      loadReusableSemanticsSlice(
        "swift",
        slicesFile,
        bomFile,
        "/src/argparser-demo",
      ),
    );
    // Another project's slice left behind in the working directory
    assert.strictEqual(
      loadReusableSemanticsSlice("swift", slicesFile, bomFile, "/src/other"),
      undefined,
    );
    // Older than the SBOM that cdxgen --evidence just wrote
    utimesSync(slicesFile, new Date(past - 60_000), new Date(past - 60_000));
    assert.strictEqual(
      loadReusableSemanticsSlice(
        "swift",
        slicesFile,
        bomFile,
        "/src/argparser-demo",
      ),
      undefined,
    );
    // A dosai report under the default file name is not a swift slice
    writeFileSync(
      slicesFile,
      JSON.stringify({ Metadata: { padding: "x".repeat(2048) }, methods: [] }),
    );
    assert.strictEqual(
      loadReusableSemanticsSlice("swift", slicesFile, bomFile, tempDir),
      undefined,
    );
    // Scala slices cannot be regenerated by evinse and are reused by shape,
    // even when older than the SBOM
    writeFileSync(
      slicesFile,
      JSON.stringify({
        "src/main/scala/App.scala": {
          usedTypes: ["cats.effect.IO"],
          padding: "x".repeat(2048),
        },
      }),
    );
    utimesSync(slicesFile, new Date(past - 60_000), new Date(past - 60_000));
    assert.ok(
      loadReusableSemanticsSlice("scala", slicesFile, bomFile, tempDir),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("names the slice-file option every slice type reads", () => {
  // The CLI declares these flags; yargs camel-cases them before evinse sees
  // them, so a hyphenated slice type has to be camel-cased to match.
  const declared = new Set([
    "usagesSlicesFile",
    "dataFlowSlicesFile",
    "reachablesSlicesFile",
    "semanticsSlicesFile",
  ]);
  for (const sliceType of ["usages", "data-flow", "reachables", "semantics"]) {
    assert.ok(
      declared.has(sliceFileOption(sliceType)),
      `${sliceType} resolves to ${sliceFileOption(sliceType)}, which no CLI flag provides`,
    );
  }
  assert.strictEqual(sliceFileOption("data-flow"), "dataFlowSlicesFile");
});

it("replaces an earlier analyzer run's metadata instead of appending", () => {
  const component = {
    name: "app",
    properties: [
      { name: "cdx:rusi:backend", value: "stable" },
      { name: "cdx:rusi:requestedBackend", value: "compiler" },
      { name: "cdx:rusi:dataFlowCategories", value: "env->process-exec" },
      { name: "cdx:golem:toolVersion", value: "1.0.0" },
      { name: "SrcFile", value: "Cargo.toml" },
    ],
  };
  mergeAnalyzerMetadataProperties(component, [
    { name: "cdx:rusi:backend", value: "compiler" },
    { name: "cdx:rusi:dataFlowCategories", value: "param-0->network-request" },
  ]);
  assert.deepStrictEqual(
    component.properties.map((p) => `${p.name}=${p.value}`),
    [
      "cdx:golem:toolVersion=1.0.0",
      "SrcFile=Cargo.toml",
      "cdx:rusi:backend=compiler",
      "cdx:rusi:dataFlowCategories=param-0->network-request",
    ],
  );
});

it("leaves metadata untouched when an analyzer run emits nothing", () => {
  const component = {
    properties: [{ name: "cdx:rusi:backend", value: "stable" }],
  };
  mergeAnalyzerMetadataProperties(component, []);
  mergeAnalyzerMetadataProperties(undefined, [
    { name: "cdx:rusi:backend", value: "compiler" },
  ]);
  assert.deepStrictEqual(component.properties, [
    { name: "cdx:rusi:backend", value: "stable" },
  ]);
});
