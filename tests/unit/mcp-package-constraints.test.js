import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { toolchainRoot } from "../../server/features/mcp-packages/toolchains.js";
import { auditDetails } from "../../server/http/routes/mcp-packages.js";

const top = { registry: "pypi", name: "srv-x", version: "1.0" };

/** A PyPI stand-in that records the constraints of each resolve and each install. */
const recordingAdapter = (seen, { needsScripts = false } = {}) => ({
  toolchainKind: "python",
  preview: async ({ constraints, toolchain }) => {
    seen.resolves.push(constraints);
    await toolchain();
    return {
      integrity: "sha256:a",
      programs: [{ name: "srv-x", path: "srv-x" }],
      needsScripts,
      manifestText: "srv-x==1.0\n",
      lockText: "srv-x==1.0 --hash=sha256:a\n",
      digest: "d",
      dependencies: [],
    };
  },
  checkStored: () => ({ digest: "d", dependencies: [] }),
  manifestText: (ref) => `${ref.name}==${ref.version}\n`,
  install: async ({ preview }) => seen.installs.push(preview),
  programsAfterInstall: () => null,
  command: () => ({ command: "/bin/run", leading: [] }),
  toolchainVersion: () => "3.14.7+uv0.12.21",
});

function harness(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-constraints-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const servers = new McpServerStore({ dataDir, pathEnv: "", exists: () => true });
  const seen = { resolves: [], installs: [] };
  const packages = new McpPackages({
    dataDir,
    servers,
    changes: new CentralMcpChanges({ servers }),
    toolchain: async () => ({ directory: path.join(toolchainRoot(dataDir), "python-t") }),
    environment: {},
    adapters: { pypi: recordingAdapter(seen, options) },
  });
  return { dataDir, servers, packages, seen };
}

async function create(s, constraints) {
  const preview = await s.packages.preview({ ...top, constraints });
  const server = await s.packages.createServer(
    { name: "py", transport: "stdio", source: { ...top, constraints } },
    { previewId: preview.previewId },
  );
  await s.packages.jobs.idle();
  return { preview, id: server.id };
}

test("constraints reach the resolve canonical and are stored with the record", async (t) => {
  const s = harness(t);
  const { preview, id } = await create(s, ["FastMCP < 4", "httpx==0.28.*"]);
  assert.deepEqual(s.seen.resolves, [["fastmcp<4", "httpx==0.28.*"]]);
  assert.deepEqual(preview.constraints, ["fastmcp<4", "httpx==0.28.*"]);
  assert.equal(s.servers.get(id).source.status, "ready");
  assert.deepEqual(s.servers.get(id).source.constraints, ["fastmcp<4", "httpx==0.28.*"]);
  assert.deepEqual(s.seen.installs[0].constraints, ["fastmcp<4", "httpx==0.28.*"]);
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(
        s.dataDir,
        "mcp-packages",
        "installs",
        s.servers.packages.get(id).installId,
        "receipt.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(receipt.constraints, ["fastmcp<4", "httpx==0.28.*"]);
});

test("a confirmation with other constraints than its preview is expired", async (t) => {
  const s = harness(t);
  for (const confirmed of [undefined, [], ["fastmcp<5"], ["fastmcp<4", "x<1"]]) {
    const { previewId } = await s.packages.preview({
      ...top,
      constraints: ["fastmcp<4"],
    });
    assert.throws(
      () =>
        s.packages.confirmedPreview(
          previewId,
          { ...top, constraints: confirmed },
          "srv-x",
        ),
      { code: "MCP_PACKAGE_PREVIEW_EXPIRED" },
      JSON.stringify(confirmed),
    );
  }
  // Another spelling of the same constraints is the same confirmation.
  const { previewId } = await s.packages.preview({ ...top, constraints: ["fastmcp<4"] });
  const { preview } = s.packages.confirmedPreview(
    previewId,
    { ...top, constraints: [" FastMCP<4 "] },
    "srv-x",
  );
  assert.deepEqual(preview.constraints, ["fastmcp<4"]);
});

test("invalid constraints are refused before any resolve; npm takes none", async (t) => {
  const s = harness(t);
  for (const constraints of [["x @ http://e/x.whl"], ["srv-x<2"], "x<1"])
    await assert.rejects(s.packages.preview({ ...top, constraints }), {
      code: "MCP_PACKAGE_INVALID",
    });
  await assert.rejects(
    s.packages.preview({
      registry: "npm",
      name: "x",
      version: "1.0.0",
      constraints: ["y<1"],
    }),
    { code: "MCP_PACKAGE_INVALID" },
  );
  assert.deepEqual(s.seen.resolves, []);
});

test("an update keeps the stored constraints unless the owner sends new ones", async (t) => {
  const s = harness(t);
  const { id } = await create(s, ["fastmcp<4"]);
  const kept = await s.packages.preview({ ...top, version: "1.1", serverId: id });
  assert.deepEqual(kept.constraints, ["fastmcp<4"]);
  await s.packages.updatePackage(id, { version: "1.1", previewId: kept.previewId });
  await s.packages.jobs.idle();
  assert.deepEqual(s.servers.get(id).source.constraints, ["fastmcp<4"]);
  assert.equal(s.servers.get(id).source.version, "1.1");
  // An update preview with the stored constraints, confirmed with an edit: expired.
  const stale = await s.packages.preview({ ...top, version: "1.2", serverId: id });
  await assert.rejects(
    s.packages.updatePackage(id, {
      version: "1.2",
      constraints: [],
      previewId: stale.previewId,
    }),
    { code: "MCP_PACKAGE_PREVIEW_EXPIRED" },
  );
  const cleared = await s.packages.preview({
    ...top,
    version: "1.2",
    serverId: id,
    constraints: [],
  });
  assert.deepEqual(cleared.constraints, []);
  await s.packages.updatePackage(id, {
    version: "1.2",
    constraints: [],
    previewId: cleared.previewId,
  });
  await s.packages.jobs.idle();
  assert.deepEqual(s.servers.get(id).source.constraints, []);
  assert.deepEqual(s.seen.resolves, [["fastmcp<4"], ["fastmcp<4"], ["fastmcp<4"], []]);
});

test("reinstall keeps constraints and build mode from the record without resolving", async (t) => {
  const s = harness(t, { needsScripts: true });
  const preview = await s.packages.preview({
    ...top,
    allowScripts: true,
    constraints: ["fastmcp<4"],
  });
  const server = await s.packages.createServer(
    {
      name: "py",
      transport: "stdio",
      source: { ...top, allowScripts: true, constraints: ["fastmcp<4"] },
    },
    { previewId: preview.previewId },
  );
  await s.packages.jobs.idle();
  assert.equal(s.servers.packages.get(server.id).needsScripts, true);
  // Without the receipt the stored record still says the install was built.
  fs.rmSync(path.join(s.dataDir, "mcp-packages", "installs"), { recursive: true });
  s.packages.reinstall(server.id);
  await s.packages.jobs.idle();
  assert.equal(s.seen.resolves.length, 1);
  assert.equal(s.seen.installs.at(-1).needsScripts, true);
  assert.deepEqual(s.seen.installs.at(-1).constraints, ["fastmcp<4"]);
  assert.equal(s.servers.get(server.id).source.status, "ready");
  assert.deepEqual(s.servers.get(server.id).source.constraints, ["fastmcp<4"]);
});

test("the audit names the canonical constraints of a source", () => {
  assert.deepEqual(
    auditDetails({ ...top, allowScripts: false, constraints: ["FastMCP < 4"] }),
    { ...top, allowScripts: false, constraints: ["fastmcp<4"] },
  );
  assert.deepEqual(auditDetails({ ...top }).constraints, []);
  assert.deepEqual(auditDetails({ registry: "npm", name: "x" }).constraints, []);
  assert.deepEqual(auditDetails(undefined).constraints, []);
});
