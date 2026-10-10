import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionEnabledRuntime } from "../../server/features/assistants/runtime-install.js";

test("enabled installation update preserves selection when provisioning fails", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-update-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "assistants"));
  fs.writeFileSync(path.join(dataDir, "assistants", "settings.json"), '{"enabled":true}');
  fs.writeFileSync(
    path.join(dataDir, "assistants", "runtime.json"),
    '{"version":"previous"}',
  );
  await assert.rejects(
    provisionEnabledRuntime({
      dataDir,
      download: async () => {
        throw Error("interrupted download");
      },
    }),
    /interrupted/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "assistants", "runtime.json"))).version,
    "previous",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "assistants", "settings.json")))
      .enabled,
    true,
  );
});

test("staging the selected manifest again records no candidate", async (t) => {
  const { assistantInstallFixture } =
    await import("../helpers/assistant-install-fixture.js");
  const { ensureAssistantRuntime, stageAssistantRuntime } =
    await import("../../server/features/assistants/runtime-install.js");
  const { RuntimeUpdates } =
    await import("../../server/features/assistants/runtime-updates.js");
  const { dataDir, manifest, options } = assistantInstallFixture(t);
  await ensureAssistantRuntime(options);
  const candidate = path.join(dataDir, "assistants", "candidate.json");
  assert.equal(fs.existsSync(candidate), false);
  await stageAssistantRuntime(options);
  assert.equal(fs.existsSync(candidate), false);
  const updates = new RuntimeUpdates({
    dataDir,
    manifest,
    runtime: { status: () => ({ availability: "disabled" }) },
    maintenance: {},
    stage: () => stageAssistantRuntime(options),
    affected: () => ({ agents: 2, teamMembers: 10 }),
  });
  await updates.stage();
  assert.equal(fs.existsSync(candidate), false);
  const status = updates.status();
  // Temporary team members are counted apart from the owner's agents.
  assert.equal(status.affectedAssistants, 2);
  assert.equal(status.affectedTeamMembers, 10);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.candidateReady, false);
  assert.equal(status.phase, "idle");
});

test("a second process installing concurrently gets RUNTIME_BUSY until its lock is stale", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { assistantInstallFixture } =
    await import("../helpers/assistant-install-fixture.js");
  const { stageAssistantRuntime } =
    await import("../../server/features/assistants/runtime-install.js");
  const { processIdentity } = await import("../../server/lib/process-identity.js");
  const { dataDir, options } = assistantInstallFixture(t);
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => other.kill("SIGKILL"));
  await once(other, "spawn");
  const lock = path.join(dataDir, "assistants", "runtimes", ".install.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(
    lock,
    JSON.stringify({ pid: other.pid, startTime: processIdentity(other.pid).startTime }),
  );
  await assert.rejects(stageAssistantRuntime(options), { code: "RUNTIME_BUSY" });
  assert.equal(fs.existsSync(lock), true);
  other.kill("SIGKILL");
  await once(other, "exit");
  assert.equal((await stageAssistantRuntime(options)).version, "2026.9.8");
  assert.equal(fs.existsSync(lock), false);
});
