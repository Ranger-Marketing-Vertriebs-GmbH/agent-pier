import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { craftRoutes } from "../../server/http/routes/craft-anything.js";
import { registerResponses } from "../../server/http/responses.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { englishServerMessages } from "../../server/lib/i18n/catalog-en.js";
import { resolveMessage } from "../../server/lib/i18n/message-keys.js";
import {
  createCraftTool,
  createManagedTools,
  joinManagedTools,
  managedBindingsChanged,
} from "../../server/application/craft-wiring.js";
import { craftFixture } from "../helpers/craft-tool-fixture.js";

/** The real Craft Anything routes over `services` and a real audit store. */
async function app(t, f, services) {
  const audit = new AuditStore({ dataDir: f.s.dataDir });
  t.after(() => audit.close());
  if (services.craft) services.craft.audit = audit;
  const application = express();
  application.use(express.json());
  application.use("/api", craftRoutes(services));
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
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: text ? JSON.parse(text) : null,
    };
  };
  return { request, events: () => audit.export() };
}
const english = (key, args) => resolveMessage(englishServerMessages, key, args);

test("GET/POST/DELETE /craft-anything answer as the service does and audit origin managed", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  const { request, events } = await app(t, f, { craft });
  const initial = await request("GET", "/api/craft-anything");
  assert.equal(initial.status, 200);
  assert.equal(initial.cache, "no-store");
  assert.deepEqual(initial.body, craft.state());
  assert.equal(initial.body.installed, false);
  const unconfirmed = await request("POST", "/api/craft-anything", {
    components: { ghidra: false },
  });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.error, serverMessages.craft.confirmationRequired);
  assert.equal(unconfirmed.body.messageKey, "craft.confirmationRequired");
  assert.equal(
    english(unconfirmed.body.messageKey),
    "Confirm Craft Anything's installation first.",
  );
  const started = await request("POST", "/api/craft-anything", {
    components: { ghidra: false },
    confirmInstall: true,
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.status, "running");
  await craft.settled();
  const installed = await request("GET", "/api/craft-anything");
  assert.equal(installed.body.installed, true, installed.body.message);
  const serverId = installed.body.serverId;
  const update = await request("POST", "/api/craft-anything/update");
  assert.equal(update.status, 202);
  await craft.settled();
  f.busy.value = true;
  const inUse = await request("DELETE", "/api/craft-anything");
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.messageKey, "craft.inUse");
  assert.match(english(inUse.body.messageKey), /^Craft Anything is running in a session/);
  f.busy.value = false;
  const removed = await request("DELETE", "/api/craft-anything");
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

test("without the MCP server store /craft-anything answers 503", async (t) => {
  const f = await craftFixture(t);
  const { request } = await app(t, f, {});
  for (const [method, url] of [
    ["GET", "/api/craft-anything"],
    ["POST", "/api/craft-anything"],
    ["POST", "/api/craft-anything/update"],
    ["DELETE", "/api/craft-anything"],
  ]) {
    const answer = await request(method, url);
    assert.equal(answer.status, 503, `${method} ${url}`);
    assert.equal(answer.cache, "no-store");
  }
});

test("the wiring asks sessions for Craft Anything's own row", async (t) => {
  const f = await craftFixture(t);
  const sessions = { list: async () => [] };
  const services = { assistants: null };
  const options = {
    config: { dataDir: f.s.dataDir },
    servers: f.s.servers,
    changes: f.s.changes,
    packages: f.s.packages,
    extensions: f.s.extensions,
    audit: null,
    sessions,
    services: () => services,
  };
  const craft = createCraftTool(options);
  t.after(() => craft.close());
  assert.equal(createCraftTool({ ...options, servers: null }), null);
  assert.deepEqual(createManagedTools({ ...options, servers: null }), {
    rea: null,
    craft: null,
  });
  assert.equal(await craft.inUse(), false);
  // A REA row bound to Claude does not count for Craft Anything.
  f.s.servers.create(
    { name: "rea", transport: "stdio", command: "/fake/bin/rea", args: [] },
    { managed: { tool: "rea" }, bind: [["cli", "claude"]] },
  );
  sessions.list = async () => [{ tool: "claude", status: "running" }];
  assert.equal(await craft.inUse(), false);
  f.s.servers.create(
    { name: "craft-anything", transport: "stdio", command: "/fake/craft", args: [] },
    { managed: { tool: "craft-anything" }, bind: [["cli", "claude"]] },
  );
  assert.equal(await craft.inUse(), true);
  sessions.list = async () => [{ tool: "claude", status: "stopped" }];
  assert.equal(await craft.inUse(), false);
});

/** A stand-in tool: its hooks, job and syncEnvironment calls. */
function standIn(name, { ghidra = false, busy = false } = {}) {
  return {
    name,
    job: null,
    claimed: false,
    synced: 0,
    wantsGhidra: () => ghidra,
    inUse: async () => busy,
    async syncEnvironment() {
      this.synced += 1;
    },
  };
}

test("joinManagedTools joins the Ghidra hooks both ways and signals each topic", async () => {
  const rea = standIn("rea", { ghidra: true, busy: true });
  const craft = standIn("craft", { ghidra: false, busy: false });
  const signals = [];
  const live = { invalidate: (topic) => signals.push(topic) };
  joinManagedTools({ rea, craft, live: () => live });
  assert.equal(craft.keepsGhidra(), true);
  assert.equal(rea.keepsGhidra(), false);
  assert.equal(await craft.othersUseGhidra(), true);
  assert.equal(await rea.othersUseGhidra(), false);
  assert.equal(craft.othersBusy(), false);
  rea.claimed = true;
  assert.equal(craft.othersBusy(), true);
  rea.claimed = false;
  craft.job = Promise.resolve();
  assert.equal(rea.othersBusy(), true);
  craft.job = null;
  rea.onChange();
  craft.onChange();
  // Craft Anything's install state is part of the rebuild list too.
  assert.deepEqual(signals, ["job.rea", "job.craft-anything", "craft.rebuilds"]);
});

test("the end of one tool's job brings the other's environment in line", async () => {
  const rea = standIn("rea");
  const craft = standIn("craft");
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    joinManagedTools({ rea, craft, live: () => null });
    // Steps of a running job sync nothing; its end does, once.
    rea.job = Promise.resolve();
    rea.onChange();
    rea.onChange();
    assert.equal(craft.synced, 0);
    rea.job = null;
    rea.onChange();
    rea.onChange();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(craft.synced, 1);
    assert.equal(rea.synced, 0);
    // A failing sync is logged, never thrown.
    rea.syncEnvironment = async () => {
      throw new Error("broken");
    };
    craft.job = Promise.resolve();
    craft.onChange();
    craft.job = null;
    assert.doesNotThrow(() => craft.onChange());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1, JSON.stringify(errors));
  } finally {
    console.error = original;
  }
  // One tool alone keeps the defaults and still signals its topic.
  const alone = standIn("craft");
  const signals = [];
  joinManagedTools({
    rea: null,
    craft: alone,
    live: () => ({ invalidate: (topic) => signals.push(topic) }),
  });
  assert.equal(alone.keepsGhidra, undefined);
  alone.job = Promise.resolve();
  alone.onChange();
  alone.job = null;
  alone.onChange();
  assert.deepEqual(signals, [
    "job.craft-anything",
    "craft.rebuilds",
    "job.craft-anything",
    "craft.rebuilds",
  ]);
});

test("managedBindingsChanged tells both tools in turn", async () => {
  const calls = [];
  await managedBindingsChanged({
    rea: { bindingsChanged: async () => calls.push("rea") },
    craft: { bindingsChanged: async () => calls.push("craft") },
  });
  await managedBindingsChanged({});
  assert.deepEqual(calls, ["rea", "craft"]);
});

test("both states name the tool's own Ghidra choice", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  const rea = await f.reaTool();
  assert.equal(craft.state().components.ghidra.wanted, false);
  assert.equal(rea.state().components.ghidra.wanted, false);
  await f.install(craft, { components: { ghidra: true } });
  assert.equal(craft.state().components.ghidra.wanted, true);
  assert.equal(rea.state().components.ghidra.wanted, false);
});
