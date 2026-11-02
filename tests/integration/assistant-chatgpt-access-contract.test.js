import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { runtimeFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createUpdateSnapshot,
  restoreUpdateSnapshot,
} from "../../server/features/assistants/runtime-update-snapshot.js";
import { fakeAccess, startFakeChatgptOAuth } from "../helpers/fake-chatgpt.js";
import { locateOpenClawExports } from "../helpers/openclaw-dist-exports.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
import { ChatGptAuth } from "../../server/features/model-logins/chatgpt-auth.js";
import { ChatGptVault } from "../../server/features/model-logins/chatgpt-vault.js";

// An AgentPier-held ChatGPT login as the pinned OpenClaw sees it: an access-only
// OAuth profile (openclaw-access-profiles.js). Synthetic tokens only, and nothing
// leaves the host: the Gateway's proxy variables point at a local stub that answers
// every CONNECT with 401 and records where OpenClaw wanted to go, so a refresh
// attempt would show as a CONNECT to auth.openai.com.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
const profileId = "openai:access-contract@example.invalid";

async function blockingProxy(t) {
  const tunnels = [];
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => {
      tunnels.push(chunk.toString("latin1").split("\r\n")[0]);
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const names = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const name of names) delete process.env[name];
  process.env.HTTPS_PROXY =
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  t.after(async () => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  });
  return tunnels;
}

// The shared store row exactly as OpenClaw keeps it (state-db layout of 2026.10.x).
function storedProfile(paths) {
  const db = new DatabaseSync(path.join(paths.state, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const owner = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      .get("auth.sharedStore");
    assert.deepEqual(JSON.parse(owner.value_json), { location: "state-db" });
    const row = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      .get("authProfiles.store");
    return JSON.parse(row.value_json).profiles[profileId];
  } finally {
    db.close();
  }
}

const statusOf = async (client) => {
  const result = await client.call("models.authStatus", { agentId: "main" });
  return result.providers
    ?.find((p) => p.provider === "openai")
    ?.profiles?.find((p) => p.profileId === profileId);
};

test(
  "the pinned Gateway accepts an access-only ChatGPT profile, never refreshes it and adopts a new one without restart",
  { skip: !installed, timeout: contractTimeout(240000) },
  async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-access-contract-"));
    const app = path.join(installed, "app/node_modules/openclaw");
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(app, "openclaw.mjs"),
      }),
    });
    const tunnels = await blockingProxy(t);
    t.after(async () => {
      try {
        await runtime.stop();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    await runtime.start();
    const { models } = runtimeFor(null, runtime);
    const identity = {
      accountId: "acct-contract",
      email: "access-contract@example.invalid",
      plan: "plus",
    };
    const credential = (expires) => ({
      access: fakeAccess({ ...identity, expires }),
      expires,
      ...identity,
    });

    // 1. Written while the Gateway runs, reloaded without a restart.
    const first = credential(Date.now() + 2 * 3600_000);
    assert.deepEqual(await models.writeAccess({ profileId, credential: first }), {
      reloaded: true,
    });
    const stored = storedProfile(runtime.paths);
    assert.equal(stored.refresh, undefined);
    assert.equal(stored.authFlow, undefined);
    assert.equal(stored.access, first.access);
    const accepted = await statusOf(runtime.client);
    t.diagnostic(`authStatus=${JSON.stringify({ ...accepted, access: undefined })}`);
    assert.equal(accepted.type, "oauth");
    assert.ok(["ok", "expiring"].includes(accepted.status), accepted.status);

    // 2. Within OpenClaw's five-minute margin: a use of the profile finds no refresh
    // token and gives up quietly. No refresh request, no fence, nothing deleted.
    const near = credential(Date.now() + 4 * 60_000);
    await models.writeAccess({ profileId, credential: near });
    // A model discovery and a probe both resolve the profile's credential.
    const probe = await runtime.client
      .call(
        "models.probe",
        { provider: "openai", agentId: "main", profileId, timeoutMs: 15000 },
        { timeoutMs: 30000 },
      )
      .catch((error) => ({ error: error.code }));
    await runtime.client
      .call(
        "models.list",
        { agentId: "main", provider: "openai", view: "all", refresh: true },
        { timeoutMs: 60000 },
      )
      .catch(() => {});
    t.diagnostic(`probe=${JSON.stringify(probe)} tunnels=${JSON.stringify(tunnels)}`);
    assert.ok(
      !tunnels.some((line) => line.includes("auth.openai.com")),
      "OpenClaw never tried to refresh",
    );
    const after = storedProfile(runtime.paths);
    assert.equal(after.access, near.access, "no refresh fence replaced the token");
    assert.equal(after.refresh, undefined);

    // 3. A renewed token reaches the running Gateway at once.
    const renewed = credential(Date.now() + 3 * 3600_000);
    await models.writeAccess({ profileId, credential: renewed });
    const adopted = await statusOf(runtime.client);
    t.diagnostic(`renewed expiry=${JSON.stringify(adopted?.expiry)}`);
    assert.ok(["ok", "expiring"].includes(adopted.status), adopted.status);
    assert.ok(
      Math.abs(
        (adopted.expiry?.at ?? Date.now() + adopted.expiry.remainingMs) - renewed.expires,
      ) < 60_000,
      "the Gateway reports the renewed expiry",
    );

    // 4. Removed by AgentPier's logout: OpenClaw lists the profile no more.
    await models.removeAccess({ profileId });
    assert.equal(await statusOf(runtime.client), undefined);
  },
);

test(
  "a login the pinned OpenClaw made itself moves to AgentPier once, on request, and stays usable",
  { skip: !installed, timeout: contractTimeout(240000) },
  async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-move-contract-"));
    const app = path.join(installed, "app/node_modules/openclaw");
    const nodePath = path.join(installed, "node/bin/node");
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath,
        entryPath: path.join(app, "openclaw.mjs"),
      }),
    });
    const tunnels = await blockingProxy(t);
    const issuer = await startFakeChatgptOAuth();
    const vault = new ChatGptVault({
      dataDir,
      auth: new ChatGptAuth({ issuer: issuer.url }),
      schedule: false,
      warn: () => {},
    });
    const accounts = new AssistantModelAccounts({ dataDir, runtime, vault });
    t.after(async () => {
      try {
        accounts.close();
        vault.close();
        await issuer.close();
        await runtime.stop();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    await runtime.start();
    await runtime.stop();
    // OpenClaw's own writer, as its login would have stored the profile.
    const access = fakeAccess({ email: "access-contract@example.invalid" });
    const writer = locateOpenClawExports(app, ["upsertAuthProfile"]).upsertAuthProfile;
    const code = `import {${writer.alias} as upsert} from ${JSON.stringify(writer.path)};
      upsert({ profileId: ${JSON.stringify(profileId)}, credential: {type:'oauth',
        provider:'openai', access:${JSON.stringify(access)}, refresh:'SYNTHETIC_REFRESH',
        expires:Date.now()+86400000, email:'access-contract@example.invalid'} });`;
    execFileSync(nodePath, ["--input-type=module", "-e", code], {
      env: runtimeEnvironment(runtime.paths, nodePath),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: contractTimeout(30000),
    });
    // An update snapshot of the pinned runtime's state, taken before the move.
    const snapshotDir = path.join(runtime.paths.root, "backups", randomUUID());
    fs.mkdirSync(path.dirname(snapshotDir), { recursive: true, mode: 0o700 });
    await createUpdateSnapshot(runtime.paths, snapshotDir, { version: "contract" });
    await runtime.start();
    const [account] = await accounts.list();
    assert.equal(account.holder, "openclaw");
    assert.equal(storedProfile(runtime.paths).refresh, "SYNTHETIC_REFRESH");

    await accounts.move(account.id);
    const stored = storedProfile(runtime.paths);
    assert.equal(stored.refresh, undefined, "OpenClaw keeps no refresh token");
    assert.equal(stored.access, access);
    assert.equal(vault.records.get(profileId).refresh, "SYNTHETIC_REFRESH");
    const [moved] = await accounts.list();
    assert.equal(moved.id, account.id);
    assert.equal(moved.holder, "agentpier");
    assert.ok(["ok", "expiring"].includes((await statusOf(runtime.client)).status));
    assert.ok(!tunnels.some((line) => line.includes("auth.openai.com")));
    assert.equal(issuer.state.refreshes, 0);

    // A rollback to the pre-move snapshot keeps its credentials but brings back no
    // second refresher; OpenClaw starts and still lists the profile.
    await runtime.stop();
    const restored = await restoreUpdateSnapshot(runtime.paths, snapshotDir);
    assert.equal(restored.credentialsWithheld, false);
    assert.equal(storedProfile(runtime.paths).refresh, undefined);
    assert.equal(storedProfile(runtime.paths).access, access);
    await runtime.start();
    assert.ok(["ok", "expiring"].includes((await statusOf(runtime.client)).status));
    assert.equal(vault.records.get(profileId).refresh, "SYNTHETIC_REFRESH");
  },
);
