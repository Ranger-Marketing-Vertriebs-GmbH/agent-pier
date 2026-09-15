import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { busFixture, requestBus } from "../helpers/agentbus-broker.js";
import { registerPeer, toolsFor } from "../../vendor/agentbus/agentpier/runtime.js";

test("AgentBus revocation survives permission drift and does not resurrect grants", async (t) => {
  const f = await busFixture(t),
    a = await f.prepare("permissions");
  const credential = JSON.parse(
    fs.readFileSync(a.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE),
  );
  fs.chmodSync(path.join(f.bus.root, "sessions"), 0o755);
  assert.doesNotThrow(() => f.bus.revoke(a.id));
  fs.chmodSync(path.join(f.bus.root, "sessions"), 0o700);
  assert.ok((await requestBus(a.launch.env, "tools/list", {}, credential)).error);
  assert.equal(fs.existsSync(a.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE), false);
});

test("AgentBus failed credential issuance leaves no launch or usable partial grant", async (t) => {
  const f = await busFixture(t),
    account = f.accounts.create({ name: "Failure", tool: "claude" });
  const issue = f.bus.broker.access.issue.bind(f.bus.broker.access);
  t.mock.method(f.bus.broker.access, "issue", (record) => {
    issue(record);
    throw Error("fixture disk failure");
  });
  await assert.rejects(
    f.bus.prepare({
      id: "failed",
      account,
      cwd: f.cwd,
      launch: { command: process.execPath, env: { HOME: f.home } },
    }),
    /fixture disk failure/,
  );
  const projectId = (await import("node:crypto"))
    .createHash("sha256")
    .update(f.cwd)
    .digest("hex");
  const home = path.join(f.bus.root, "projects", projectId);
  assert.equal(fs.existsSync(path.join(home, "launches", "failed.json")), false);
  assert.equal(fs.existsSync(path.join(home, "adapters", "failed")), false);
  assert.equal(
    fs.existsSync(path.join(f.bus.root, "sessions", "failed", "capability.json")),
    false,
  );
  t.mock.restoreAll();
  const retried = await f.bus.prepare({
    id: "failed",
    account,
    cwd: f.cwd,
    launch: { command: process.execPath, env: { HOME: f.home } },
  });
  assert.equal(retried.agentbus.enabled, true);
});

test("legacy AgentBus sessions require reload and cannot discover broker peers", async (t) => {
  const f = await busFixture(t),
    old = await f.prepare("old"),
    fresh = await f.prepare("fresh");
  const oldCtx = f.bus.broker.access.record(old.id);
  registerPeer(oldCtx, "legacy-native", { pid: old.native.pid });
  f.rows.get(old.id).agentbus.version = "agentpier-1";
  assert.equal(
    (
      await requestBus(fresh.launch.env, "agentbus/register", {
        nativeSessionId: "fresh-native",
        pid: fresh.native.pid,
      })
    ).error,
    undefined,
  );
  const overview = await f.bus.list();
  const legacy = overview.projects[0].sessions.find((row) => row.id === old.id);
  assert.equal(legacy.registered, false);
  assert.equal(legacy.reasonCode, "AGENTBUS_RELOAD_REQUIRED");
  const oldPeers = await toolsFor(oldCtx)
    .find((tool) => tool.name === "peers_list")
    .run({ __agentpierSession: "legacy-native" });
  assert.doesNotMatch(oldPeers, /fresh/);
  const newPeers = await requestBus(fresh.launch.env, "tools/call", {
    name: "peers_list",
    arguments: { __agentpierSession: "fresh-native" },
  });
  assert.doesNotMatch(newPeers.result.content[0].text, /legacy-native/);
  assert.ok((await requestBus(old.launch.env, "tools/list")).error);
});

test("AgentBus revocation preserves a symlink target and keeps a failed cleanup revoked", async (t) => {
  const f = await busFixture(t),
    a = await f.prepare("symlink");
  const folder = path.dirname(a.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE);
  const moved = path.join(f.root, "preserved-grant");
  fs.renameSync(folder, moved);
  fs.symlinkSync(moved, folder);
  assert.doesNotThrow(() => f.bus.revoke(a.id));
  assert.equal(fs.existsSync(path.join(moved, "capability.json")), true);
  fs.unlinkSync(folder);
  fs.renameSync(moved, folder);
  assert.throws(() => f.bus.broker.access.record(a.id), /unavailable/);
});

test("AgentBus permission drift cannot block session shutdown and reconciliation", async (t) => {
  const { applicationFixture } = await import("../helpers/application.js");
  const app = await applicationFixture(t);
  const program = path.join(app.home, "agent-fixture.cjs");
  fs.writeFileSync(program, "setInterval(() => {}, 1000);");
  app.application.accounts.command = () => ({
    command: process.execPath,
    args: [program],
    env: { HOME: app.home, PATH: path.dirname(process.execPath) },
    launchMode: "default",
  });
  const response = await app.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-claude",
      name: "AgentBus cleanup fixture",
      cwd: app.home,
    },
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  const busRoot = path.join(app.dataDir, "agentbus", "sessions");
  fs.chmodSync(busRoot, 0o755);
  assert.equal(
    (await app.request(`/api/sessions/${session.id}/stop`, { method: "POST", body: {} }))
      .status,
    200,
  );
  assert.equal((await app.application.sessions.get(session.id)).status, "stopped");
  assert.equal((await app.request("/api/state")).status, 200);
  fs.chmodSync(busRoot, 0o700);
  assert.equal(fs.existsSync(path.join(busRoot, session.id)), false);
});
