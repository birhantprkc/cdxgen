import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";

// The tool-manager helpers below invoke an interactive shell so that shell
// functions such as nvm are loaded. Passing an args array together with a
// truthy `shell` option makes Node concatenate the args into a second shell
// invocation (DEP0190), which silently drops or re-splits arguments.
async function loadEnvcontext(calls) {
  return esmock("./envcontext.js", {
    "./utils.js": {
      safeSpawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "/nvm/versions/node/v22.11.0/bin/node" };
      },
    },
  });
}

function assertNoShellOption(calls) {
  for (const call of calls) {
    assert.ok(
      !call.options?.shell,
      `${call.command} ${JSON.stringify(call.args)} must not combine an args array with a shell option`,
    );
  }
}

describe("shell-based tool detection", () => {
  it("isNvmAvailable runs nvm in a single shell", async () => {
    const calls = [];
    const { isNvmAvailable } = await loadEnvcontext(calls);
    process.env.SHELL = "/bin/bash";
    isNvmAvailable();
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].args, ["-i", "-c", "nvm"]);
    assertNoShellOption(calls);
  });

  it("isRbenvAvailable passes --version to rbenv", async () => {
    const calls = [];
    const { isRbenvAvailable } = await loadEnvcontext(calls);
    process.env.SHELL = "/bin/bash";
    isRbenvAvailable();
    assert.deepStrictEqual(calls[0].args, ["-i", "-c", "rbenv --version"]);
    assertNoShellOption(calls);
  });

  it("getNvmToolDirectory queries nvm without extra quoting", async () => {
    const calls = [];
    const { getNvmToolDirectory } = await loadEnvcontext(calls);
    process.env.SHELL = "/bin/bash";
    getNvmToolDirectory("v22.11.0");
    assert.deepStrictEqual(calls[0].args, ["-i", "-c", "nvm which v22.11.0"]);
    assertNoShellOption(calls);
  });

  it("getOrInstallNvmTool installs without extra quoting", async () => {
    const calls = [];
    const envcontext = await esmock("./envcontext.js", {
      "./utils.js": {
        safeSpawnSync: (command, args, options) => {
          calls.push({ command, args, options });
          // Fail the `nvm which` probe so the install path is taken
          return calls.length === 1
            ? { status: 1, stdout: "" }
            : { status: 0, stdout: "" };
        },
      },
    });
    process.env.SHELL = "/bin/bash";
    envcontext.getOrInstallNvmTool("22");
    assert.deepStrictEqual(calls[1].args, ["-i", "-c", "nvm install 22"]);
    assertNoShellOption(calls);
  });
});
