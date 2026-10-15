import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { packageProblem } from "../../server/features/mcp-packages/package-errors.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { deferred, harness, source } from "../helpers/mcp-packages-harness.js";

const twoPrograms = {
  toolchainKind: "node",
  preview: async () => ({
    integrity: "sha256:a",
    programs: [
      { name: "a-server", path: "a.js" },
      { name: "b-server", path: "b.js" },
    ],
    needsScripts: false,
    manifestText: "{}",
    lockText: "x",
    digest: "d",
    dependencies: [],
  }),
};

test("a refused program keeps the preview for a retry", async (t) => {
  const { service } = harness(t, { adapters: { npm: twoPrograms } });
  const { previewId } = await service.preview(source);
  assert.throws(() => service.confirmedPreview(previewId, source, "nope"), {
    code: "MCP_PACKAGE_PROGRAM_REQUIRED",
  });
  assert.ok(service.previews.has(previewId));
  const { program } = service.confirmedPreview(previewId, source, "b-server");
  assert.equal(program.name, "b-server");
});

test("a refused scripts check keeps the preview", async (t) => {
  const { service } = harness(t, {
    adapters: {
      npm: {
        ...twoPrograms,
        preview: async () => ({ ...(await twoPrograms.preview()), needsScripts: true }),
      },
    },
  });
  const { previewId } = await service.preview(source);
  assert.throws(() => service.confirmedPreview(previewId, source, "a-server"), {
    code: "MCP_PACKAGE_NEEDS_SCRIPTS",
  });
  assert.ok(service.previews.has(previewId));
});

test("a preview is consumed once", async (t) => {
  const { service } = harness(t);
  const { previewId } = await service.preview(source);
  service.consumePreview(previewId);
  assert.throws(() => service.consumePreview(previewId), {
    code: "MCP_PACKAGE_PREVIEW_EXPIRED",
  });
});

test("a rejected preview frees its resolve slot", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-preview-slot-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let calls = 0;
  const service = new McpPackages({
    dataDir,
    servers: { packages: { get: () => null } },
    changes: {},
    toolchain: async () => ({}),
    previewConcurrency: 1,
    adapters: {
      npm: {
        ...twoPrograms,
        preview: async () => {
          calls += 1;
          if (calls === 1) throw Error("uv exploded at /private/path");
          return twoPrograms.preview();
        },
      },
    },
  });
  await assert.rejects(service.preview(source), (error) => {
    assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
    assert.equal(error.message, serverMessages.mcpPackages.previewFailed);
    return true;
  });
  assert.equal(service.resolving, 0);
  assert.equal((await service.preview(source)).programs.length, 2);
});

test("a preview refusal with its own reason keeps it", async (t) => {
  const refusal = packageProblem("MCP_PACKAGE_UNSATISFIABLE", 400);
  const { service } = harness(t, {
    adapters: {
      npm: {
        ...twoPrograms,
        preview: async () => {
          throw refusal;
        },
      },
    },
  });
  await assert.rejects(service.preview(source), (error) => {
    assert.equal(error, refusal);
    assert.equal(error.message, serverMessages.mcpPackages.unsatisfiable);
    return true;
  });
});

test("a detach whose record cannot be removed answers with a package code", async (t) => {
  const { service, records } = harness(t);
  records.put("s1", { status: "ready", installId: null });
  records.remove = () => {
    throw Error("SQLITE_BUSY: database is locked at /private/data/mcp.db");
  };
  await assert.rejects(
    service.detach("s1", async () => {}),
    (error) => {
      assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
      assert.doesNotMatch(error.message, /private|SQLITE/);
      return true;
    },
  );
});

test("an attach whose record cannot be written keeps its preview", async (t) => {
  const { service, records } = harness(t);
  const { previewId } = await service.preview(source);
  records.put = () => {
    throw Error("SQLITE_FULL at /private/data/mcp.db");
  };
  await assert.rejects(service.attach("s1", { source, previewId }), {
    code: "MCP_PACKAGE_INSTALL_FAILED",
  });
  assert.ok(service.previews.has(previewId));
});

test("a losing concurrent attach keeps its preview", async (t) => {
  const { service } = harness(t);
  const first = await service.preview(source);
  const second = await service.preview(source);
  const gate = deferred();
  const one = service.attach(
    "s1",
    { source, previewId: first.previewId },
    () => gate.promise,
  );
  const two = service.attach(
    "s1",
    { source, previewId: second.previewId },
    () => gate.promise,
  );
  gate.resolve();
  await one;
  await assert.rejects(two, { code: "MCP_PACKAGE_BUSY" });
  assert.equal(service.previews.has(first.previewId), false);
  assert.equal(service.previews.has(second.previewId), true);
  await service.jobs.idle();
});
