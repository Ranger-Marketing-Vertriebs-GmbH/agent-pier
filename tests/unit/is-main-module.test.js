import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../../server/lib/is-main-module.js";
test("entry identity canonicalizes both paths but excludes missing and different files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-main-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = path.join(root, "entry.mjs"),
    alias = path.join(root, "alias.mjs"),
    other = path.join(root, "other.mjs");
  fs.writeFileSync(module, "");
  fs.writeFileSync(other, "");
  fs.symlinkSync(module, alias);
  assert.equal(isMainModule(pathToFileURL(module), alias), true);
  assert.equal(isMainModule(pathToFileURL(alias), module), true);
  assert.equal(isMainModule(pathToFileURL(module), other), false);
  assert.equal(isMainModule(pathToFileURL(module), path.join(root, "absent")), false);
  assert.equal(isMainModule(pathToFileURL(module), ""), false);
  assert.equal(isMainModule("https://invalid.example/entry", module), false);
});
