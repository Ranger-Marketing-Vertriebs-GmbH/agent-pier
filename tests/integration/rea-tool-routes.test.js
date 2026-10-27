import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import { reaRoutes } from "../../server/http/routes/rea.js";
import { registerResponses } from "../../server/http/responses.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { englishServerMessages } from "../../server/lib/i18n/catalog-en.js";
import { resolveMessage } from "../../server/lib/i18n/message-keys.js";
import { createReaTool, reaInUse } from "../../server/application/rea-wiring.js";
import { fakeBinding, reaFixture } from "../helpers/rea-tool-fixture.js";

/** The real REA routes over the fixture's ReaTool and a real audit store. */
async function app(t, f, rea) {
  const audit = new AuditStore({ dataDir: f.s.dataDir });
  t.after(() => audit.close());
  rea.audit = audit;
  const application = express();
  application.use(express.json());
  application.use("/api", reaRoutes({ rea }));
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
  return { request, events: () => audit.export() };
}
const english = (key, args) => resolveMessage(englishServerMessages, key, args);

test("GET/POST/DELETE /rea answer as the service does and audit origin managed", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const { request, events } = await app(t, f, rea);
  const initial = await request("GET", "/api/rea");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, rea.state());
  assert.equal(initial.body.installed, false);
  // The first install needs the confirmation; the refusal names its key for English.
  const unconfirmed = await request("POST", "/api/rea", { components: { ghidra: true } });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.error, serverMessages.rea.confirmationRequired);
  assert.equal(unconfirmed.body.messageKey, "rea.confirmationRequired");
  assert.equal(english(unconfirmed.body.messageKey), "Confirm REA's installation first.");
  const started = await request("POST", "/api/rea", {
    components: { ghidra: true, frida: true },
    confirmInstall: true,
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.status, "running");
  await rea.settled();
  const installed = await request("GET", "/api/rea");
  assert.equal(installed.body.installed, true, installed.body.message);
  const serverId = installed.body.serverId;
  const update = await request("POST", "/api/rea/update");
  assert.equal(update.status, 202);
  await rea.settled();
  f.busy.value = true;
  const inUse = await request("DELETE", "/api/rea");
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.messageKey, "rea.inUse");
  assert.match(english(inUse.body.messageKey), /^REA is running in a session/);
  f.busy.value = false;
  const removed = await request("DELETE", "/api/rea");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.installed, false);
  const audited = events()
    .filter((event) => event.resourceType === "mcp")
    .map((event) => [event.action, event.resourceId, event.details.origin]);
  assert.deepEqual(audited, [
    ["mcp.created", serverId, "managed"],
    ["mcp.deleted", serverId, "managed"],
  ]);
});

test("the state names the keys of its messages, so English owners read them in English", async (t) => {
  const f = await reaFixture(t);
  const intel = await f.tool({ arch: "x64" });
  const ghidra = intel.state().components.ghidra;
  assert.equal(ghidra.reason, serverMessages.rea.ghidraIntelMac);
  assert.match(
    english(ghidra.reasonKey),
    /^Ghidra for REA is not available on Intel Macs/,
  );
  const rea = await f.tool();
  const held = f.s.hold();
  await rea.apply({ components: { ghidra: false, frida: false }, confirmInstall: true });
  await held.reached;
  const running = rea.state();
  assert.equal(running.message, serverMessages.rea.installingCore);
  assert.equal(english(running.messageKey, running.messageArgs), "Installing REA Core …");
  held.release();
  await rea.settled();
  // A failure keeps a catalog text only, never a path or npm output.
  f.s.packages.afterInstall = async () => {
    throw Object.assign(new Error("/secret/path failed"), { status: 500 });
  };
  await rea.apply({ components: { frida: true } });
  await rea.settled();
  const failed = rea.state();
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(failed.message, /secret/);
  assert.ok(failed.messageKey, failed.message);
  assert.equal(typeof english(failed.messageKey, failed.messageArgs), "string");
});

test("the install hook places frida only in REA's own row, never in another package", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const { serverId } = await f.install(rea, {
    components: { ghidra: false, frida: true },
  });
  assert.equal(fs.readFileSync(f.bindingOf(serverId), "utf8"), fakeBinding);
  const checks = () => f.s.calls.filter((args) => args.includes("--input-type=module"));
  const before = checks().length;
  // The owner adds REA's npm package as an own row: same package name, other server.
  const preview = await f.s.packages.preview({
    registry: "npm",
    name: "rea-agents",
    version: "6.8.0",
  });
  const own = await f.s.packages.createServer(
    {
      name: "my-rea",
      transport: "stdio",
      args: ["mcp"],
      source: { registry: "npm", name: "rea-agents", version: "6.8.0" },
    },
    { previewId: preview.previewId, program: "rea", clis: [] },
  );
  await f.s.packages.jobs.idle();
  assert.equal(f.s.servers.packages.get(own.id).status, "ready");
  assert.equal(fs.existsSync(f.bindingOf(own.id)), false);
  assert.equal(checks().length, before);
  assert.equal(f.s.servers.get(own.id).managed, undefined);
  assert.equal(rea.serverId(), serverId);
});

test("the wiring hooks REA into the package installs and asks sessions and agents", async (t) => {
  const f = await reaFixture(t);
  const sessions = { list: async () => [] };
  const services = { assistants: null };
  const rea = createReaTool({
    config: { dataDir: f.s.dataDir },
    servers: f.s.servers,
    changes: f.s.changes,
    packages: f.s.packages,
    extensions: f.s.extensions,
    audit: null,
    sessions,
    services: () => services,
  });
  t.after(() => rea.close());
  assert.equal(typeof f.s.packages.afterInstall, "function");
  // A server REA does not manage passes the hook untouched.
  assert.equal(await f.s.packages.afterInstall("other", {}), undefined);
  assert.equal(await rea.inUse(), false);
  assert.equal(createReaTool({ config: {}, servers: null, packages: null }), null);
  const row = f.s.servers.create(
    { name: "rea", transport: "stdio", command: "/fake/bin/rea", args: [] },
    { managed: { tool: "rea" }, bind: [["cli", "claude"]] },
  );
  const ask = (list, assistants = null) =>
    reaInUse({
      serverId: row.id,
      servers: f.s.servers,
      sessions: { list: async () => list },
      assistants,
    });
  assert.equal(await ask([{ tool: "claude", status: "running" }]), true);
  assert.equal(await ask([{ tool: "claude", status: "stopped" }]), false);
  assert.equal(await ask([{ tool: "codex", status: "running" }]), false);
  sessions.list = async () => [{ tool: "claude", status: "running" }];
  assert.equal(await rea.inUse(), true);
  // An agent binding counts while the Gateway runs.
  const agentRow = f.s.servers.create(
    { name: "rea2", transport: "stdio", command: "/fake/bin/rea", args: [] },
    { bind: [["agent", "main"]] },
  );
  const agentAsk = (ready) =>
    reaInUse({
      serverId: agentRow.id,
      servers: f.s.servers,
      sessions: { list: async () => [] },
      assistants: { runtime: { client: { ready } } },
    });
  assert.equal(await agentAsk(true), true);
  assert.equal(await agentAsk(false), false);
  assert.equal(await reaInUse({ serverId: null, servers: f.s.servers, sessions }), false);
});
