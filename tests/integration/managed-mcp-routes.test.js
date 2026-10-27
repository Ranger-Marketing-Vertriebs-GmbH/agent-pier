import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { CliMcpBindings } from "../../server/features/mcp-servers/cli-bindings.js";
import { packageService } from "../helpers/mcp-packages-service.js";

const managed = { tool: "rea", lockedEnv: ["JAVA_HOME"] };

/** The real routes over the real store, central changes, packages, CLIs and audit. */
async function app(t) {
  const s = await packageService(t);
  const audit = new AuditStore({ dataDir: s.dataDir });
  t.after(() => audit.close());
  const cliMcp = new CliMcpBindings({
    servers: s.servers,
    extensions: s.extensions,
    home: s.home,
    dataDir: s.dataDir,
    warn: () => {},
  });
  const application = express();
  application.use(express.json());
  application.use(
    "/api",
    mcpServerRoutes({
      audit,
      cliMcp,
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
  const row = s.servers.create(
    {
      name: "rea",
      transport: "stdio",
      command: s.executable("rea"),
      args: ["--stdio"],
      env: { JAVA_HOME: "/jdk", MY_KEY: "own" },
    },
    { managed },
  );
  return { s, cliMcp, request, row, events: () => audit.export() };
}

const refused = (response, key) => {
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.messageKey, `mcpServers.${key}`);
};

test("PUT a locked field or managed env key of a managed row answers 409 managedLocked", async (t) => {
  const { request, row, s } = await app(t);
  const url = `/api/mcp-servers/${row.id}`;
  for (const patch of [
    { name: "renamed" },
    { args: ["--evil"] },
    { command: "/bin/sh", confirmStdio: true },
    { cwd: "/tmp", confirmStdio: true },
    { env: { JAVA_HOME: null } },
    { env: { JAVA_HOME: "/other" }, confirmStdio: true },
    { source: null, command: "/bin/sh" },
    { source: { registry: "npm", name: "x", version: "1.0.0" }, confirmInstall: true },
  ])
    refused(
      await request("PUT", url, { revision: row.revision, ...patch }),
      "managedLocked",
    );
  const after = s.servers.get(row.id);
  assert.equal(after.revision, row.revision);
  assert.deepEqual(after.args, ["--stdio"]);
  assert.equal(s.servers.secrets(row.id).env.JAVA_HOME, "/jdk");
});

test("PUT an own env key on a managed row succeeds and keeps the managed keys", async (t) => {
  const { request, row, s } = await app(t);
  const response = await request("PUT", `/api/mcp-servers/${row.id}`, {
    revision: row.revision,
    env: { MY_KEY: null, OTHER: "x" },
    toolTimeoutSec: 120,
    confirmStdio: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.envNames, ["JAVA_HOME", "OTHER"]);
  assert.deepEqual(response.body.managed, managed);
  assert.equal(response.body.toolTimeoutSec, 120);
  assert.equal(s.servers.secrets(row.id).env.JAVA_HOME, "/jdk");
});

test("DELETE and package update/reinstall/program on a managed row answer 409", async (t) => {
  const { request, row, s } = await app(t);
  refused(
    await request("DELETE", `/api/mcp-servers/${row.id}`),
    "managedRemoveThroughTool",
  );
  for (const action of ["update", "reinstall", "program"])
    refused(
      await request("POST", `/api/mcp-servers/${row.id}/package/${action}`, {
        version: "2.0.0",
        confirmInstall: true,
        program: "x",
      }),
      "managedLocked",
    );
  assert.equal(s.servers.get(row.id).managed.tool, "rea");
});

test("binding a managed row to a CLI through PUT /mcp-servers/:id/clis works", async (t) => {
  const { request, row, s } = await app(t);
  const response = await request("PUT", `/api/mcp-servers/${row.id}/clis`, {
    clis: ["claude"],
    confirmStdio: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(s.servers.targetsOf(row.id).clis, ["claude"]);
  assert.deepEqual(s.servers.get(row.id).managed, managed);
});

test("adopting a CLI's edit of a managed row is refused; overwriting it works", async (t) => {
  const { request, row, s, cliMcp } = await app(t);
  s.servers.setClis(row.id, ["claude"]);
  cliMcp.reconcileAll();
  s.write("claude", { rea: { type: "stdio", command: "/bin/sh", args: ["-c", "x"] } });
  const url = `/api/mcp-servers/${row.id}/clis/claude/resolve`;
  refused(
    await request("POST", url, { choice: "adopt", confirmStdio: true }),
    "managedLocked",
  );
  assert.deepEqual(s.servers.get(row.id).args, ["--stdio"]);
  const overwritten = await request("POST", url, { choice: "overwrite" });
  assert.equal(overwritten.status, 200, JSON.stringify(overwritten.body));
  assert.deepEqual(s.entries("claude").rea.args, ["--stdio"]);
});

test("POST /mcp-servers with origin 'managed' creates an unmanaged row audited as 'manual'", async (t) => {
  const { request, events, s } = await app(t);
  const created = await request("POST", "/api/mcp-servers", {
    name: "sneaky",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    origin: "managed",
    managed,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.managed, undefined);
  assert.equal(s.servers.managed.get(created.body.id), null);
  const event = events().find(
    (entry) => entry.action === "mcp.created" && entry.resourceId === created.body.id,
  );
  assert.equal(event.details.origin, "manual");
});
