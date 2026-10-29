import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { waitFor } from "../helpers/agent-ssh-fixture.js";
import { cleanEnvironment } from "../../server/features/accounts/account-store.js";

const recorded = [
  "PATH",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "AGENTPIER_SSH_CONFIG",
  "AGENTPIER_SSH_AUTH_SOCK",
  "AGENTPIER_SSH_AGENT",
];

// A shell stand-in, started with the environment a real launch carries, that records
// the agent variables it was started with.
function recordingShell(f) {
  const seen = path.join(f.root, "seen-env.json");
  f.application.accounts.command = () => ({
    command: process.execPath,
    args: [
      "-e",
      `const keys = ${JSON.stringify(recorded)}; require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])))); setInterval(() => {}, 1000)`,
      "--",
    ],
    env: cleanEnvironment(),
  });
  return seen;
}

const connects = (socketPath) =>
  new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

test("a shell session's agent starts with it, survives a restart and goes with its stop", async (t) => {
  const f = await applicationFixture(t);
  if (!f.application.sshAgents.supported) {
    t.skip("no OpenSSH 8.9+ on this machine");
    return;
  }
  const seen = recordingShell(f);
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-shell", cwd: f.project },
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const session = JSON.parse(text);
  // The browser learns only that the session has an agent (R30).
  assert.deepEqual(session.sshAgent, { enabled: true });
  const details = f.application.sshAgents.launchDetails(session.id);
  const { token } = (await f.application.sessions.metadata(session.id)).sshAgent;
  const state = await (await f.request("/api/state")).text();
  assert.equal(state.includes(token), false);
  assert.deepEqual(
    JSON.parse(state).sessions.find((item) => item.id === session.id).sshAgent,
    { enabled: true },
  );
  const env = JSON.parse(
    await waitFor(() => fs.existsSync(seen) && fs.readFileSync(seen, "utf8"), 10_000),
  );
  assert.equal(env.PATH.split(path.delimiter)[0], details.binDir);
  assert.equal(env.AGENTPIER_SSH_CONFIG, details.configPath);
  assert.equal(env.AGENTPIER_SSH_AUTH_SOCK, details.socketPath);
  // The server's own agent, when it has one, stays the session's.
  assert.equal(env.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK ?? details.socketPath);
  assert.equal(env.AGENTPIER_SSH_AGENT, null);
  assert.equal(await connects(details.socketPath), true);
  const status = await (
    await f.request(`/api/sessions/${session.id}/ssh-accesses`)
  ).json();
  assert.deepEqual(status.agent, { state: "ready", aliases: {} });

  // Every catalog commit refreshes the agents' files.
  let refreshed = 0;
  f.application.sshAgents.refresh = async () => {
    refreshed += 1;
  };
  await f.application.sshManagement.catalog.run(() => {});
  assert.equal(refreshed, 1);

  await f.restart();
  // The session runs on; its agent listens again at the same path.
  await waitFor(() => f.application.sshAgents.launchDetails(session.id), 10_000);
  assert.equal(
    f.application.sshAgents.launchDetails(session.id).socketPath,
    details.socketPath,
  );
  assert.equal(await connects(details.socketPath), true);
  assert.equal(fs.existsSync(details.configPath), true);

  const stopped = await f.request(`/api/sessions/${session.id}/stop`, { method: "POST" });
  assert.equal(stopped.status, 200, await stopped.text());
  assert.equal(f.application.sshAgents.launchDetails(session.id), null);
  assert.equal(fs.existsSync(details.folder), false);
  assert.equal(fs.existsSync(path.dirname(details.socketPath)), false);
});
