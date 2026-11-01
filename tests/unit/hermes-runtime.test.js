import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hermesFakeRuntime } from "../helpers/hermes-fake-runtime.js";
import { createHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-runtime.js";
import { contractAgent } from "../helpers/hermes-native.js";
import { RUNTIME_CAPABILITIES } from "../../server/features/assistants/runtimes/agent-runtime.js";

function hermes(t, fake, options = {}) {
  const made = createHermesRuntime({
    dataDir: fake.dataDir,
    agentId: "agent-1",
    runtime: async () => fake.runtime,
    stopTimeoutMs: 3000,
    ...options,
  });
  t.after(() => made.supervisor.stop());
  return made;
}

test("each start writes the agent's compiled home before any Hermes process runs", async (t) => {
  const fake = hermesFakeRuntime(t);
  let reads = 0;
  const { supervisor, runtime, written } = hermes(t, fake, {
    desired: () => {
      reads++;
      // Nothing of the set runs while the home is written.
      assert.equal(fake.starts("agent-1").length, reads - 1);
      assert.deepEqual(supervisor.pids(), []);
      return contractAgent("agent-1", { baseUrl: "http://127.0.0.1:9/v1" });
    },
  });
  const home = supervisor.agentPaths().hermesHome;
  // A key Hermes wrote itself survives the compile.
  fs.writeFileSync(path.join(home, "config.yaml"), "_config_version: 7\n");
  await runtime.host.start();
  assert.equal(reads, 1);
  assert.deepEqual(written(), [".env", "SOUL.md", "config.yaml"]);
  const config = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
  assert.match(config, /^_config_version: 7$/m);
  assert.match(config, /base_url: http:\/\/127\.0\.0\.1:9\/v1/);
  assert.match(config, new RegExp(`cwd: ${supervisor.agentPaths().workspace}`));
  assert.match(fs.readFileSync(path.join(home, ".env"), "utf8"), /contract-key/);
  assert.equal(fs.statSync(path.join(home, ".env")).mode & 0o777, 0o600);
  // An unchanged home is not written again by the next start.
  await runtime.host.restart();
  assert.equal(reads, 2);
  assert.deepEqual(written(), []);
});

test("a home that cannot be compiled starts nothing and reports failed", async (t) => {
  const fake = hermesFakeRuntime(t);
  const { supervisor, runtime } = hermes(t, fake, {
    desired: () => {
      throw Object.assign(Error("unsafe"), { code: "HERMES_HOME_UNSAFE" });
    },
  });
  await assert.rejects(runtime.host.start(), { code: "HERMES_HOME_UNSAFE" });
  assert.deepEqual(runtime.host.status().availability, "failed");
  assert.equal(runtime.host.status().diagnostic, "HERMES_HOME_UNSAFE");
  assert.deepEqual(fake.starts("agent-1"), []);
  assert.deepEqual(supervisor.pids(), []);
});

test("the runtime composes host, sessions, events, approvals and the compiler", async (t) => {
  const fake = hermesFakeRuntime(t);
  const { runtime } = hermes(t, fake);
  assert.equal(runtime.id, "hermes");
  assert.equal(typeof runtime.config.compiler.compileHome, "function");
  const capabilities = runtime.capabilities();
  assert.deepEqual(Object.keys(capabilities).sort(), [...RUNTIME_CAPABILITIES].sort());
  for (const name of [
    "host",
    "sessions",
    "events",
    "approvals",
    "config",
    "agents",
    "everyCommandApproval",
  ])
    assert.equal(capabilities[name].available, true, name);
  for (const name of [
    "agentFiles",
    "routines",
    "skills",
    "browser",
    "models",
    "channels",
  ])
    assert.deepEqual(capabilities[name], {
      available: false,
      reason: "hermesNotYetSupported",
    });
  // Unreachable while stopped, as every runtime's sub-ports are.
  await assert.rejects(
    runtime.sessions.create({ agentId: "agent-1" }),
    (e) => e.code === "UNAVAILABLE",
  );
  assert.deepEqual(runtime.events.subscribe(() => {}).call(), undefined);
  // Without a desired agent the home is started as it is.
  await runtime.host.start();
  assert.equal(runtime.host.ready(), true);
});
