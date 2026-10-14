import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitInstall,
  npmCommand,
  pruneInstalls,
  readInstall,
  stageInstall,
} from "../../server/features/mcp-packages/package-store.js";

const dataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-package-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const receipt = (extra = {}) => ({
  registry: "npm",
  name: "server-x",
  version: "1.1.0",
  lockDigest: "d".repeat(64),
  program: { name: "server-x", path: "dist/index.js" },
  ...extra,
});

test("a committed install is read back by its digest and pruned when unreferenced", (t) => {
  const dir = dataDir(t);
  const { installId, stage } = stageInstall(dir);
  fs.mkdirSync(path.join(stage, "node_modules/server-x/dist"), { recursive: true });
  fs.writeFileSync(path.join(stage, "node_modules/server-x/dist/index.js"), "");
  const final = commitInstall(dir, { installId, stage, receipt: receipt() });
  assert.equal(fs.existsSync(stage), false);
  assert.deepEqual(readInstall(dir, installId, "d".repeat(64)), receipt());
  assert.equal(readInstall(dir, installId, "e".repeat(64)), null);
  const node = { nodePath: "/managed/node" };
  assert.deepEqual(npmCommand(dir, { ...receipt(), installId }, node), {
    command: "/managed/node",
    leading: [path.join(final, "node_modules/server-x/dist/index.js")],
  });
  pruneInstalls(dir, new Set());
  assert.equal(fs.existsSync(final), false);
});

test("a program outside the install or missing is refused", (t) => {
  const dir = dataDir(t);
  const { installId, stage } = stageInstall(dir);
  commitInstall(dir, { installId, stage, receipt: receipt() });
  assert.throws(() => npmCommand(dir, { ...receipt(), installId }, { nodePath: "/n" }), {
    code: "MCP_PACKAGE_NO_PROGRAM",
  });
  fs.mkdirSync(path.join(dir, "outside"));
  fs.writeFileSync(path.join(dir, "outside/x.js"), "");
  fs.mkdirSync(
    path.join(dir, "mcp-packages/installs", installId, "node_modules/server-x"),
    { recursive: true },
  );
  fs.symlinkSync(
    path.join(dir, "outside"),
    path.join(dir, "mcp-packages/installs", installId, "node_modules/server-x/dist"),
  );
  assert.throws(
    () =>
      npmCommand(
        dir,
        { ...receipt(), program: { name: "x", path: "dist/x.js" }, installId },
        { nodePath: "/n" },
      ),
    { code: "MCP_PACKAGE_NO_PROGRAM" },
  );
});

test("an install directory that is a link to elsewhere is not trusted", (t) => {
  const dir = dataDir(t);
  const { installId, stage } = stageInstall(dir);
  commitInstall(dir, { installId, stage, receipt: receipt() });
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(outside, "node_modules/server-x/dist"), { recursive: true });
  fs.writeFileSync(path.join(outside, "node_modules/server-x/dist/index.js"), "");
  fs.writeFileSync(path.join(outside, "receipt.json"), JSON.stringify(receipt()));
  const link = path.join(dir, "mcp-packages/installs", installId);
  fs.rmSync(link, { recursive: true });
  fs.symlinkSync(outside, link);
  assert.equal(readInstall(dir, installId, "d".repeat(64)), null);
  assert.throws(() => npmCommand(dir, { ...receipt(), installId }, { nodePath: "/n" }), {
    code: "MCP_PACKAGE_NO_PROGRAM",
  });
});

test("a malformed receipt gives a coded error", (t) => {
  const dir = dataDir(t);
  const { installId, stage } = stageInstall(dir);
  commitInstall(dir, { installId, stage, receipt: receipt() });
  for (const bad of [{ installId }, { installId, name: "x" }, { installId, name: 5 }])
    assert.throws(() => npmCommand(dir, bad, { nodePath: "/n" }), {
      code: "MCP_PACKAGE_NO_PROGRAM",
    });
});

test("commit refuses a stage that does not belong to the install id", (t) => {
  const dir = dataDir(t);
  const one = stageInstall(dir);
  const two = stageInstall(dir);
  assert.throws(
    () =>
      commitInstall(dir, {
        installId: one.installId,
        stage: two.stage,
        receipt: receipt(),
      }),
    { code: "MCP_PACKAGE_INSTALL_FAILED" },
  );
});

test("prune keeps referenced installs and their stages", (t) => {
  const dir = dataDir(t);
  const kept = stageInstall(dir);
  const dropped = stageInstall(dir);
  pruneInstalls(dir, new Set([kept.installId]));
  assert.equal(fs.existsSync(kept.stage), true);
  assert.equal(fs.existsSync(dropped.stage), false);
});

test("a linked receipt is not read", (t) => {
  const dir = dataDir(t);
  const { installId, stage } = stageInstall(dir);
  const final = commitInstall(dir, { installId, stage, receipt: receipt() });
  const file = path.join(final, "receipt.json");
  fs.linkSync(file, path.join(dir, "second-name"));
  assert.equal(readInstall(dir, installId, "d".repeat(64)), null);
  fs.rmSync(path.join(dir, "second-name"));
  assert.notEqual(readInstall(dir, installId, "d".repeat(64)), null);
  fs.rmSync(file);
  fs.writeFileSync(path.join(dir, "elsewhere.json"), JSON.stringify(receipt()));
  fs.symlinkSync(path.join(dir, "elsewhere.json"), file);
  assert.equal(readInstall(dir, installId, "d".repeat(64)), null);
});

test("a scoped package program resolves inside the install", (t) => {
  const dir = dataDir(t);
  const { installId, stage } = stageInstall(dir);
  fs.mkdirSync(path.join(stage, "node_modules/@scope/x"), { recursive: true });
  fs.writeFileSync(path.join(stage, "node_modules/@scope/x/run.js"), "");
  const final = commitInstall(dir, { installId, stage, receipt: receipt() });
  assert.deepEqual(
    npmCommand(
      dir,
      {
        ...receipt(),
        name: "@scope/x",
        program: { name: "x", path: "run.js" },
        installId,
      },
      { nodePath: "/n" },
    ),
    { command: "/n", leading: [path.join(final, "node_modules/@scope/x/run.js")] },
  );
});
