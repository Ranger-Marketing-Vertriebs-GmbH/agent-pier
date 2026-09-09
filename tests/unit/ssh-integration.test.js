import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pidStart } from "../../vendor/agentbus/core/proc.js";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import {
  authorizeSsh,
  capabilityFile,
} from "../../server/features/ssh/ssh-capability.js";
import { writePrivate } from "../../server/lib/storage.js";

for (const tool of ["codex", "claude", "opencode"]) {
  test(`scoped SSH launch for ${tool} rotates and requires live initialization`, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-integration-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const integration = new SshIntegration({ dataDir });
    const input = {
      id: "session-one",
      account: { id: "account", tool },
      cwd: dataDir,
      launch: { command: tool, args: [], env: {} },
    };
    const launch = await integration.prepare(input);
    assert.equal(launch.sshTools.enabled, true);
    const session = {
      id: input.id,
      accountId: "account",
      tool,
      status: "running",
      sshTools: launch.sshTools,
    };
    writePrivate(path.join(dataDir, "sessions", `${session.id}.json`), session);
    const capability = JSON.parse(
      fs.readFileSync(capabilityFile(dataDir, session.id), "utf8"),
    );
    assert.equal(authorizeSsh(dataDir, capability).id, session.id);
    assert.throws(() => authorizeSsh(dataDir, { ...capability, sessionId: "other" }));
    assert.equal(integration.status(session).state, "starting");
    writePrivate(
      path.join(path.dirname(capabilityFile(dataDir, session.id)), "ready.json"),
      {
        generation: launch.sshTools.generation,
        pid: process.pid,
        pidStart: pidStart(process.pid),
        parentPid: process.ppid,
        parentStart: pidStart(process.ppid),
      },
    );
    assert.equal(integration.status(session).state, "ready");
    const readyFile = path.join(
      path.dirname(capabilityFile(dataDir, session.id)),
      "ready.json",
    );
    const ready = JSON.parse(fs.readFileSync(readyFile));
    writePrivate(readyFile, { ...ready, pidStart: "reused" });
    assert.equal(integration.status(session).ready, false);
    if (tool === "codex")
      assert.match(launch.args.join(" "), /mcp_servers.agentpier_ssh=/);
    if (tool === "claude") assert.ok(launch.args.includes("--plugin-dir"));
    if (tool === "opencode")
      assert.ok(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).mcp.agentpier_ssh.enabled);
    const second = await integration.prepare(input);
    assert.notEqual(second.sshTools.generation, launch.sshTools.generation);
    assert.throws(() => authorizeSsh(dataDir, capability));
    integration.discard(session.id);
    assert.equal(integration.status(session).state, "reload-required");
  });
}
test("SSH skips login, shell and headless sessions", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-integration-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const integration = new SshIntegration({ dataDir });
  const launch = { args: [] };
  for (const extra of [
    { account: { tool: "shell" } },
    { purpose: "login" },
    { pipeline: { headless: true } },
  ])
    assert.equal(await integration.prepare({ launch, ...extra }), launch);
});
