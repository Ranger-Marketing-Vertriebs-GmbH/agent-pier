import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { packageService, ref } from "../helpers/mcp-packages-service.js";

/** The real routes over the real package service and the real audit store. */
async function app(t) {
  const s = await packageService(t);
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
  return { s, request, events: () => audit.export() };
}

test("a pasted remote server records its origin; values never reach the audit", async (t) => {
  const { request, events, s } = await app(t);
  const created = await request("POST", "/api/mcp-servers", {
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    headers: { Authorization: "Bearer secret" },
    origin: "paste",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.origin, undefined);
  const event = events().find((entry) => entry.action === "mcp.created");
  assert.equal(event.details.origin, "paste");
  assert.doesNotMatch(JSON.stringify(event), /secret/);
  assert.equal(s.servers.get(created.body.id).origin, undefined);
});

test("an unknown or missing origin is recorded as manual", async (t) => {
  const { request, events } = await app(t);
  for (const [name, origin] of [
    ["a", "evil"],
    ["b", undefined],
    ["c", { x: 1 }],
  ])
    await request("POST", "/api/mcp-servers", {
      name,
      transport: "http",
      url: "https://mcp.example.test/mcp",
      ...(origin === undefined ? {} : { origin }),
    });
  assert.deepEqual(
    events()
      .filter((entry) => entry.action === "mcp.created")
      .map((entry) => entry.details.origin),
    ["manual", "manual", "manual"],
  );
});

test("a package created from a paste records its origin with the package", async (t) => {
  const { request, events, s } = await app(t);
  const preview = await request("POST", "/api/mcp-packages/preview", ref());
  const created = await request("POST", "/api/mcp-servers", {
    name: "pkg",
    transport: "stdio",
    source: ref(),
    previewId: preview.body.previewId,
    confirmInstall: true,
    origin: "paste",
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  await s.packages.jobs.idle();
  const event = events().find((entry) => entry.action === "package.installed");
  assert.equal(event.details.origin, "paste");
  assert.equal(s.servers.get(created.body.id).origin, undefined);
});
