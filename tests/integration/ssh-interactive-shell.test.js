import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import { agentSshFixture, hostId, waitFor } from "../helpers/agent-ssh-fixture.js";
import { sshManagementFixture } from "../helpers/ssh-management.js";
import { SshTools } from "../../server/features/ssh/ssh-tools.js";

const device = fileURLToPath(
  new URL("../fixtures/fake-network-device.mjs", import.meta.url),
);
const owner = { kind: "owner", channel: "ui" };

/** The fixture's first host as a console-only switch behind the fake device. */
function consoleHost(f) {
  f.catalog.rows.get(hostId).interactiveShell = true;
  const connection = f.catalog.connection.bind(f.catalog);
  f.catalog.connection = (id) => ({
    ...connection(id),
    ...(id === hostId ? { args: [device], interactive: true } : {}),
  });
}

test("an approved command runs through the console of an interactive host", async (t) => {
  const f = await agentSshFixture(t);
  consoleHost(f);
  f.workflows.ssh.approvals.pollMs = 20;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  const hosts = (await f.call(f.ownTurn(), { action: "hosts" })).hosts;
  assert.equal(hosts[0].interactiveShell, true);
  const call = f.execute(f.ownTurn(), "enable\nshow version");
  const action = await waitFor(() =>
    f.workflows.store
      .list(f.id)
      .find((a) => a.payload.action === "ssh" && a.state === "awaiting_approval"),
  );
  // The card shows exactly the text that is typed.
  assert.equal(action.payload.command, "enable\nshow version");
  await f.workflows.decide(
    action.id,
    { decision: "approve", revision: action.revision },
    owner,
  );
  const result = await call;
  assert.equal(result.status, "completed");
  assert.equal(result.interactive, true);
  assert.equal(result.exitCode, null);
  assert.match(result.notice, /interactive shell/);
  assert.match(result.stdout, /Switch#\nFakeSwitch OS 1.0\nUptime: 3 days\n/);
  assert.ok(!result.stdout.includes("show version"));
  const row = f.workflows.get(action.id);
  assert.equal(row.state, "completed");
  assert.equal(row.result.interactive, true);
  assert.equal(row.result.exitCode, null);
  const executed = f.audit.find((e) => e.action === "ssh.executed");
  assert.equal(executed.details.authorizedBy, "approval");
  assert.equal(executed.details.interactive, true);
  assert.equal(JSON.stringify(f.audit).includes("FakeSwitch"), false);
});

test("a trusted console run leaves a done note without an exit code", async (t) => {
  const f = await agentSshFixture(t);
  consoleHost(f);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  const result = await f.execute(f.ownTurn(), "show version");
  assert.equal(result.interactive, true);
  const [note] = (
    await conversationHistory(f.assistants, f.channel.conversationId)
  ).messages.filter((m) => m.event === "ssh-run");
  assert.equal(note.outcome, "done");
  assert.equal(note.interactive, true);
  assert.equal("exitCode" in note, false);
});

test("only the owner switches the console mode; MCP lists it and tests sign-in", async (t) => {
  const f = await sshManagementFixture(t);
  const origin = await f.session("origin");
  const key = await origin.call("ssh_generate_key", { name: "Switch", requestId: "key" });
  const input = {
    name: "Core switch",
    host: "switch.invalid",
    port: 22,
    username: "admin",
    keyId: key.id,
    hostKey: key.publicKey,
    trustSource: { kind: "user" },
    requestId: "host",
  };
  await assert.rejects(
    origin.call("ssh_register_host", { ...input, interactiveShell: true }),
    { code: "SSH_INVALID_ARGUMENT" },
  );
  const host = await origin.call("ssh_register_host", input);
  const store = f.management.store;
  // Exit 255 is an SSH error; any other status means the sign-in worked.
  let exit = 255;
  const calls = [];
  const openSsh = store.run;
  store.run = (command, args, options) => {
    if (command !== "ssh") return openSsh(command, args, options);
    calls.push(args);
    return exit === 0
      ? Promise.resolve({ stdout: "", stderr: "" })
      : Promise.reject(Object.assign(Error("stderr"), { code: exit }));
  };
  await assert.rejects(origin.call("ssh_test_host", { accessId: host.id }), {
    code: "SSH_OPERATION_FAILED",
  });
  exit = 1;
  assert.deepEqual(await origin.call("ssh_test_host", { accessId: host.id }), {
    ok: true,
    commandRejected: true,
  });
  exit = 0;
  assert.deepEqual(await origin.call("ssh_test_host", { accessId: host.id }), {
    ok: true,
  });
  assert.equal(calls.at(-1).at(-1), "true");

  const before = store.revision(host.id);
  const updated = await f.management.ui("updateHost", {
    id: host.id,
    body: { interactiveShell: true },
  });
  assert.equal(updated.interactiveShell, true);
  assert.notEqual(store.revision(host.id), before);
  const tools = new SshTools({
    dataDir: f.dataDir,
    capability: origin.capability,
    grants: f.management.grants,
    store,
  });
  t.after(() => tools.close());
  const listed = await tools.call("ssh_list_hosts", {});
  assert.equal(listed.hosts.find((h) => h.accessId === host.id).interactiveShell, true);
  // The console test opens the shell, waits for the prompt and logs out.
  const consoles = [];
  store.runConsole = (connection, command) => {
    consoles.push({ args: connection.args, command });
    return Promise.resolve({ started: true, interactive: true });
  };
  const runs = calls.length;
  assert.deepEqual(await origin.call("ssh_test_host", { accessId: host.id }), {
    ok: true,
    interactive: true,
  });
  assert.equal(calls.length, runs);
  assert.equal(consoles[0].command, "");
  assert.ok(consoles[0].args.includes("-tt"));
});
