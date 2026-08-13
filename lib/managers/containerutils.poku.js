import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { getOnlyDirs } from "./containerutils.js";

// chmod is a no-op for the superuser and unsupported on Windows
const canTestUnreadableDirs =
  process.platform !== "win32" &&
  typeof process.getuid === "function" &&
  process.getuid() !== 0;

function withUnreadableDir(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-eacces-"));
  const readable = join(root, "readable");
  const unreadable = join(root, "unreadable");
  mkdirSync(join(readable, "node_modules"), { recursive: true });
  mkdirSync(join(unreadable, "node_modules"), { recursive: true });
  chmodSync(unreadable, 0o000);
  try {
    fn(root, readable, unreadable);
  } finally {
    chmodSync(unreadable, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("directory walks with unreadable directories", () => {
  it("getOnlyDirs skips directories that cannot be read", () => {
    if (!canTestUnreadableDirs) {
      return;
    }
    withUnreadableDir((root, readable) => {
      const dirs = getOnlyDirs(root, "node_modules");
      assert.deepStrictEqual(dirs, [join(readable, "node_modules")]);
    });
  });

  // Bug #4310: an unreadable path passed in directly, such as /root when
  // generating an OBOM as a non-root user
  it("getOnlyDirs tolerates an unreadable root path", () => {
    if (!canTestUnreadableDirs) {
      return;
    }
    withUnreadableDir((_root, _readable, unreadable) => {
      assert.deepStrictEqual(getOnlyDirs(unreadable, "node_modules"), []);
    });
  });
});
