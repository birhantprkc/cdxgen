import { readFileSync } from "node:fs";

import { assert, it } from "poku";

import {
  constructServiceName,
  detectServicesFromUsages,
  extractEndpoints,
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

it("parseSemanticSlices maps Swift package components to their modules", () => {
  const semanticsSlice = JSON.parse(
    readFileSync("./test/data/swiftsem/semantics-swiftbuild.slices.json", {
      encoding: "utf-8",
    }),
  );
  const { components } = JSON.parse(
    readFileSync("./test/data/swiftsem/bom-argparser-demo-components.json", {
      encoding: "utf-8",
    }),
  );
  const retMap = parseSemanticSlices("swift", components, semanticsSlice);
  // swift-argument-parser exports the ArgumentParser module, so the
  // occurrences recorded against it must resolve through packageModules
  const argumentParserPurl =
    "pkg:swift/github.com/apple/swift-argument-parser@1.8.2";
  assert.ok(retMap.purlLocationMap[argumentParserPurl]?.length >= 3);
  for (const location of retMap.purlLocationMap[argumentParserPurl]) {
    assert.ok(location.includes("main.swift#"));
  }
  // Mixed C/Swift packages: the free function `dump` is matched through its
  // full selector `dump(object:...)`
  const yamsPurl = "pkg:swift/github.com/jpsim/Yams@5.4.0";
  assert.ok(retMap.purlLocationMap[yamsPurl]?.length >= 1);
  const swxmlhashPurl = "pkg:swift/github.com/drmohundro/SWXMLHash@7.0.2";
  assert.ok(retMap.purlLocationMap[swxmlhashPurl]?.length >= 1);
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
