import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { issue, connect } from "../helpers/session-mcp.js";
import { capabilityDirectory } from "../../server/features/mcp/session-capability.js";

test("revoked session tools can be granted again and return with the next reload", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f);
  const id = issued.session.id;
  const client = await connect(t, f, issued);
  await f.application.sessionMcp.revoke(id);
  await assert.rejects(client.listTools());
  const revoked = path.join(capabilityDirectory(f.dataDir, id), "revoked.json");
  assert.equal(fs.existsSync(revoked), true);

  const restored = await f.application.sessionMcp.restore(id);
  assert.equal(fs.existsSync(revoked), false);
  // No live credential yet: the CLI's bridge only picks one up when it restarts.
  assert.equal(restored.agentpierTools.enabled, false);
  assert.equal(restored.agentpierTools.regranted, true);
  assert.deepEqual(
    restored.agentpierTools.selection,
    issued.launch.agentpierTools.selection,
  );
  await assert.rejects(client.listTools());
  // A reload prepares the session's selection again with a fresh credential.
  const launch = await f.application.sessionMcp.prepare({
    id,
    account: f.application.accounts.get("local-codex"),
    cwd: f.project,
    launch: { args: [], env: {} },
    selection: restored.agentpierTools.selection,
    replace: true,
  });
  assert.equal(launch.agentpierTools.enabled, true);
  assert.notEqual(
    launch.agentpierTools.generation,
    issued.launch.agentpierTools.generation,
  );
  const restoredEvents = f.application.audit.list({ action: "mcp.restored" }).events;
  assert.equal(restoredEvents.length, 1);
  assert.equal(restoredEvents[0].resourceId, id);
});

test("a session without tools or one still granted cannot be granted again", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f);
  await assert.rejects(f.application.sessionMcp.restore(issued.session.id), {
    status: 409,
  });
  const plain = await f.application.sessions.create({
    id: "plain-session",
    name: "Without tools",
    tool: "codex",
    accountId: "local-codex",
    cwd: f.project,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  await assert.rejects(f.application.sessionMcp.restore(plain.id), { status: 409 });
});
