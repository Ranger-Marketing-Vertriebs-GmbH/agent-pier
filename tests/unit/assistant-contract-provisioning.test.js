import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionContractRuntime } from "../../scripts/provision-assistant-contracts.mjs";

const fixture = (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-contracts-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const runtime = path.join(dataDir, "assistants/runtimes/2026.9.8-node26.7.0-lock1");
  return {
    dataDir,
    runtime,
    select: async () => ({
      nodePath: path.join(runtime, "node/bin/node"),
      entryPath: path.join(runtime, "app/node_modules/openclaw/openclaw.mjs"),
    }),
  };
};

test("contracts use the runtime the installer's --with-assistants step selected", async (t) => {
  const { dataDir, runtime, select } = fixture(t);
  const calls = [];
  const env = await provisionContractRuntime(dataDir, {
    provision: async (options) => {
      calls.push(options);
      return { status: "ready", version: "2026.9.8" };
    },
    select,
  });
  assert.deepEqual(calls, [{ dataDir, enable: true }]);
  assert.deepEqual(env, {
    AGENTPIER_ASSISTANT_CONTRACT_DIR: dataDir,
    AGENTPIER_ASSISTANT_QUALIFICATION: "1",
    AGENTPIER_ASSISTANT_PROVIDER_RUNTIME: runtime,
    AGENTPIER_ASSISTANT_ROUTINE_RUNTIME: runtime,
    AGENTPIER_ASSISTANT_MEMORY_RUNTIME: runtime,
    AGENTPIER_ASSISTANT_UPDATE_RUNTIME: runtime,
    AGENTPIER_TEAM_CONTRACT_RUNTIME: runtime,
  });
});

test("a failed or staged provisioning stops before any contract runs", async (t) => {
  const { dataDir, select } = fixture(t);
  for (const result of [
    { status: "failed", code: "RUNTIME_PROVISIONING_FAILED" },
    { status: "staged", version: "2026.9.8", selected: "2026.9.7" },
    null,
  ])
    await assert.rejects(
      provisionContractRuntime(dataDir, { provision: async () => result, select }),
      { message: new RegExp(result?.code || result?.status || "not enabled") },
    );
  await assert.rejects(provisionContractRuntime("relative/data", {}), /absolute/);
});

test("a selection whose entry is outside its runtime directory is refused", async (t) => {
  const { dataDir, runtime } = fixture(t);
  await assert.rejects(
    provisionContractRuntime(dataDir, {
      provision: async () => ({ status: "ready" }),
      select: async () => ({
        nodePath: path.join(runtime, "node/bin/node"),
        entryPath: path.join(dataDir, "elsewhere/openclaw/openclaw.mjs"),
      }),
    }),
    /runtime layout/,
  );
});
