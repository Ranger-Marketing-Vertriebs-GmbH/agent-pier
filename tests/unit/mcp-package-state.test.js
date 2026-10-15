import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { switchedTo } from "../../server/features/mcp-packages/package-install-job.js";
import { attach, harness } from "../helpers/mcp-packages-harness.js";

test("an owner edit racing the switch keeps the old leading args until it commits", async (t) => {
  let raced = false;
  let racedArgs;
  const { service, rows } = harness(t, {
    beforeSwitch: () => {
      if (raced) return;
      raced = true;
      // The owner saved first: the revision moved on, the old command is still stored.
      rows.set("s1", { ...rows.get("s1"), revision: rows.get("s1").revision + 1 });
      racedArgs = service.prepareUpdate("s1", {
        revision: rows.get("s1").revision,
        args: ["--new"],
      }).args;
    },
  });
  await attach(service);
  await service.jobs.idle();
  assert.equal(raced, true);
  // Before the first install there are no generated args to keep.
  assert.deepEqual(racedArgs, ["--new"]);
});

test("a restart skips the CLI reconcile while agents are in maintenance", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let reconciled = 0;
  const row = { serverId: "s1", status: "ready", installId: "x", lockDigest: "d" };
  const records = {
    all: () => [row],
    get: () => row,
    update: () => {},
    installIds: () => new Set(),
    computedStatus: () => "missing",
  };
  const service = new McpPackages({
    dataDir,
    servers: { packages: records },
    changes: { maintenance: () => true, onSaved: async () => (reconciled += 1) },
  });
  await service.start();
  assert.equal(reconciled, 0);
});

test("a start that cannot write a record logs a code, never the error text", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const errors = t.mock.method(console, "error", () => {});
  const row = { serverId: "s1", status: "installing", installId: null };
  const records = {
    all: () => [row],
    get: () => row,
    update: () => {
      throw Error("SQLITE_BUSY at /private/data/mcp.db");
    },
    installIds: () => new Set(),
    computedStatus: () => "failed",
  };
  const service = new McpPackages({
    dataDir,
    servers: { packages: records },
    changes: { onSaved: async () => {} },
  });
  await service.start();
  const logged = errors.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  assert.match(logged, /MCP_PACKAGE_INSTALL_FAILED/);
  assert.doesNotMatch(logged, /private|SQLITE/);
});

test("switchedTo needs the switch's command and its generated args in front", () => {
  // npm: the managed node stays the command; the program path leads the args.
  const node = "/data/toolchains/node/bin/node";
  const npm = { command: node, leading: ["/data/installs/new/node_modules/x/index.js"] };
  assert.equal(switchedTo({ command: node, args: [...npm.leading, "--x"] }, npm), true);
  assert.equal(
    switchedTo(
      { command: node, args: ["/data/installs/old/node_modules/x/index.js", "--x"] },
      npm,
    ),
    false,
  );
  assert.equal(switchedTo({ command: node, args: [] }, npm), false);
  // PyPI: the venv's program is the command; nothing is generated in front.
  const pypi = { command: "/data/installs/new/venv/bin/srv", leading: [] };
  assert.equal(switchedTo({ command: pypi.command, args: ["--x"] }, pypi), true);
  assert.equal(
    switchedTo({ command: "/data/installs/old/venv/bin/srv", args: [] }, pypi),
    false,
  );
  assert.equal(switchedTo(undefined, pypi), false);
});
