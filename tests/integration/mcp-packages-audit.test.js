import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { packageService, ref } from "../helpers/mcp-packages-service.js";
import { pythonPackageService } from "../helpers/mcp-python-service.js";

/** The real routes over the real package service and the real audit store. */
async function app(t, s) {
  const audit = new AuditStore({ dataDir: s.dataDir });
  t.after(() => audit.close());
  const application = express();
  application.use(express.json());
  application.use(
    "/api",
    mcpServerRoutes({
      audit,
      mcpServerChanges: s.changes,
      mcpServers: s.servers,
      mcpPackages: s.packages,
    }),
  );
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const request = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  // Oldest first, as the owner did them.
  const events = () => audit.export();
  return { request, events };
}

const details = (version, extra = {}) => ({
  registry: "npm",
  name: "server-x",
  version,
  allowScripts: false,
  constraints: [],
  ...extra,
});

test("package installs, updates, reinstalls, attaches and detaches are audited", async (t) => {
  const s = await packageService(t);
  const { request, events } = await app(t, s);
  const preview = (body) => request("POST", "/api/mcp-packages/preview", body);

  const first = await preview(ref());
  const created = await request("POST", "/api/mcp-servers", {
    name: "pkg",
    transport: "stdio",
    env: { TOKEN: "secret-token" },
    args: ["--secret-arg"],
    source: ref(),
    previewId: first.body.previewId,
    confirmInstall: true,
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  await s.packages.jobs.idle();
  const id = created.body.id;

  const next = await preview({ ...ref("2.0.0"), serverId: id });
  const updated = await request("POST", `/api/mcp-servers/${id}/package/update`, {
    version: "2.0.0",
    previewId: next.body.previewId,
    confirmInstall: true,
  });
  assert.equal(updated.status, 202, JSON.stringify(updated.body));
  await s.packages.jobs.idle();

  const reinstalled = await request("POST", `/api/mcp-servers/${id}/package/reinstall`);
  assert.equal(reinstalled.status, 202, JSON.stringify(reinstalled.body));
  await s.packages.jobs.idle();

  const command = s.executable("own");
  const detached = await request("PUT", `/api/mcp-servers/${id}`, {
    revision: s.servers.get(id).revision,
    source: null,
    command,
    confirmStdio: true,
  });
  assert.equal(detached.status, 200, JSON.stringify(detached.body));
  assert.equal(s.servers.get(id).source, undefined);

  // D1: the same own-command server goes back to a package.
  const again = await preview(ref());
  const attached = await request("PUT", `/api/mcp-servers/${id}`, {
    revision: s.servers.get(id).revision,
    source: ref(),
    previewId: again.body.previewId,
    confirmInstall: true,
  });
  assert.equal(attached.status, 202, JSON.stringify(attached.body));
  await s.packages.jobs.idle();
  assert.equal(s.servers.get(id).source.status, "ready");

  const recorded = events();
  assert.deepEqual(
    recorded.map(({ action, resourceType, resourceId, outcome, source }) => ({
      action,
      resourceType,
      resourceId,
      outcome,
      source,
    })),
    [
      "package.installed",
      "package.updated",
      "package.reinstalled",
      "package.detached",
      "package.installed",
    ].map((action) => ({
      action,
      resourceType: "mcp",
      resourceId: id,
      outcome: "success",
      source: "user",
    })),
  );
  assert.deepEqual(
    recorded.map((event) => event.details),
    [
      // Only the create path records how the server was set up.
      details("1.0.0", { origin: "manual" }),
      details("2.0.0"),
      details("2.0.0"),
      details("2.0.0"),
      details("1.0.0"),
    ],
  );
  assert.doesNotMatch(JSON.stringify(recorded), /secret-token|secret-arg|TOKEN/);
});

test(
  "a PyPI install audits its version and constraints",
  { skip: process.env.AGENTPIER_MCP_PYTHON_TESTS !== "1" },
  async (t) => {
    const s = await pythonPackageService(t, [
      { name: "srv-x", version: "1.0", script: "srv-x", requires: ["helper-x"] },
      { name: "helper-x", version: "2.0", script: "helper-tool" },
      { name: "helper-x", version: "3.0", script: "helper-tool" },
    ]);
    const { request, events } = await app(t, s);
    const source = {
      registry: "pypi",
      name: "srv-x",
      version: "1.0",
      constraints: ["Helper_X < 3"],
    };
    const preview = await request("POST", "/api/mcp-packages/preview", source);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const created = await request("POST", "/api/mcp-servers", {
      name: "py",
      transport: "stdio",
      source,
      previewId: preview.body.previewId,
      confirmInstall: true,
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    await s.packages.jobs.idle();
    assert.deepEqual(events().at(-1).details, {
      // Only the create path records how the server was set up.
      origin: "manual",
      registry: "pypi",
      name: "srv-x",
      version: "1.0",
      allowScripts: false,
      constraints: ["helper-x<3"],
    });
  },
);
