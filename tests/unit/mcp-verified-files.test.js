import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  regularFile,
  sha256Matches,
} from "../../server/features/mcp-packages/verified-files.js";

test("sha256Matches compares hex digests exactly", () => {
  const bytes = Buffer.from("abc");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256Matches(bytes, digest), true);
  assert.equal(sha256Matches(bytes, digest.toUpperCase()), false);
  assert.equal(sha256Matches(Buffer.from("abd"), digest), false);
});

test("regularFile refuses links and hard-linked files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "bin");
  fs.writeFileSync(file, "x");
  assert.doesNotThrow(() => regularFile(file));
  fs.symlinkSync(file, path.join(dir, "link"));
  assert.throws(() => regularFile(path.join(dir, "link")), {
    code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
  });
  fs.linkSync(file, path.join(dir, "hard"));
  assert.throws(() => regularFile(file), { code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE" });
});

test("regularFile refuses folders and missing files with the given code", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => regularFile(dir, "MCP_PACKAGE_INSTALL_FAILED"), {
    code: "MCP_PACKAGE_INSTALL_FAILED",
  });
  assert.throws(() => regularFile(path.join(dir, "missing")), {
    code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
  });
  assert.equal(sha256Matches(Buffer.from("abc"), ""), false);
  assert.equal(sha256Matches(Buffer.from("abc"), undefined), false);
});
