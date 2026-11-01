import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { hermesManifest } from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";
import { hermesIdentityCheck } from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import { createHermesAgentHost } from "../../server/features/assistants/runtimes/hermes/hermes-host.js";
import { contractRecord } from "../helpers/hermes-native.js";

// Native Hermes contract: AGENTPIER_HERMES_CONTRACT_RUNTIME names an installation
// that scripts/provision-hermes-contracts.mjs made from the pinned manifest.
const runtime = process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME;
const skip = runtime ? false : "AGENTPIER_HERMES_CONTRACT_RUNTIME is not set";

function privateEnvironment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-install-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "hermes", "tmp", "work"])
    fs.mkdirSync(path.join(root, name));
  return {
    root,
    env: {
      HOME: path.join(root, "home"),
      HERMES_HOME: path.join(root, "hermes"),
      TMPDIR: path.join(root, "tmp"),
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
  };
}

test(
  "the pinned installation runs hermes and serves AgentPier's RPC bridge",
  { skip, timeout: 300000 },
  async (t) => {
    const { python, hermes } = hermesExecutables(runtime);
    const { root, env } = privateEnvironment(t);
    const version = execFileSync(hermes, ["--version"], {
      env,
      cwd: path.join(root, "work"),
      encoding: "utf8",
    });
    assert.match(
      version,
      new RegExp(`\\(${hermesManifest.releaseDate.replaceAll(".", "\\.")}\\)`),
    );
    assert.match(
      version,
      new RegExp(`Python: ${hermesManifest.pythonVersion.replaceAll(".", "\\.")}`),
    );
    // The bridge's imports, as the installer's identity check runs them.
    await hermesIdentityCheck(
      { pythonPath: python, hermesPath: hermes },
      { scratch: path.join(root, "work") },
    );
    // Its messaging gateway serves AgentPier's RPC bridge in a home of its own.
    const { supervisor, host } = createHermesAgentHost({
      dataDir: path.join(root, "data"),
      agentId: "install-contract",
      runtime: async () => contractRecord(runtime),
      readyTimeoutMs: 180000,
    });
    t.after(() => host.stop());
    await host.start();
    assert.ok(await supervisor.client.call("gateway.capabilities", {}));
    await host.stop();
    const agentHome = supervisor.agentPaths().hermesHome;
    assert.ok(fs.existsSync(path.join(agentHome, "state.db")));
    // Nothing reached the scratch HERMES_HOME of the version check but Hermes's own.
    assert.equal(fs.existsSync(path.join(env.HERMES_HOME, "gateway.lock")), false);
  },
);
