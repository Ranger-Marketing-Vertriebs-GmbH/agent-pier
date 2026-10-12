import test from "node:test";
import assert from "node:assert/strict";
import { ownerPath, shellService } from "../helpers/assistant-shell-service.js";
import { SHELL_CONFIRMATION_REQUIRED } from "../../server/features/assistants/shell-changes.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { capabilityKeys } from "../../server/features/assistants/native-capabilities.js";

const messages = serverMessages.assistants;
const confirm = { confirmShell: true, confirmFull: true };
const revision = (f, agent) => f.store.getAssistant(agent.id).revision;
const level = (f, agent, shell, extra = {}) =>
  f.service.update(agent.id, { shell, ...extra }, revision(f, agent));
const hasShellTools = (allow) => ["exec", "process"].some((t) => allow?.includes(t));

test("raising the shell level needs the owner's confirmations; nothing is saved without", async (t) => {
  const f = shellService(t);
  const [home] = f.agents;
  const refused = async (patch, required, message) => {
    await assert.rejects(f.service.update(home.id, patch, revision(f, home)), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, SHELL_CONFIRMATION_REQUIRED);
      assert.deepEqual(error.required, required);
      assert.equal(error.message, message);
      return true;
    });
  };
  await refused(
    { shell: "approval" },
    ["confirmShell"],
    messages.shellConfirmationRequired,
  );
  await refused(
    { shell: "full", confirmShell: true },
    ["confirmFull"],
    messages.shellFullConfirmationRequired,
  );
  await refused(
    { shell: "full", confirmFull: true },
    ["confirmShell"],
    messages.shellConfirmationRequired,
  );
  // A refused save changes nothing: not the record, not the Gateway.
  assert.equal(f.store.getAssistant(home.id).revision, 1);
  assert.equal(f.store.getAssistant(home.id).shell, undefined);
  assert.deepEqual(f.client.patches, []);
  assert.deepEqual(f.audit, []);

  const approval = await level(f, home, "approval", { confirmShell: true });
  assert.equal(approval.shell, "approval");
  assert.equal(approval.pending, undefined);
  assert.equal(f.live(home).tools.exec.mode, "ask");
  // From approval to full still needs both confirmations.
  await refused(
    { shell: "full" },
    ["confirmShell", "confirmFull"],
    messages.shellConfirmationRequired,
  );
  await refused(
    { shell: "full", confirmShell: true },
    ["confirmFull"],
    messages.shellFullConfirmationRequired,
  );
  assert.equal(f.store.getAssistant(home.id).shell, "approval");
  const full = await level(f, home, "full", confirm);
  assert.equal(full.shell, "full");
  assert.deepEqual(f.live(home).tools.exec, { mode: "full", pathPrepend: ownerPath });
  // The same level again is no change and needs nothing.
  await level(f, home, "full");
  assert.deepEqual(
    f.audit.map((e) => [e.action, e.details]),
    [
      [
        "assistant.updated",
        { kind: "shell", shellFrom: "off", shellTo: "approval", pending: false },
      ],
      [
        "assistant.updated",
        { kind: "shell", shellFrom: "approval", shellTo: "full", pending: false },
      ],
    ],
  );
});

test("lowering applies at once, even during a turn, and takes exec from the Gateway", async (t) => {
  const f = shellService(t);
  const [home, other] = f.agents;
  await level(f, home, "full", confirm);
  await level(f, other, "approval", { confirmShell: true });
  assert.equal(f.live(home).tools.exec.mode, "full");
  assert.ok(f.client.effective().tools.allow.includes("exec"));
  // A running turn of the agent: other changes wait for it, lowering does not.
  const conversation = f.store.saveConversation({
    assistantId: home.id,
    runtimeSessionKey: "home-session",
  });
  const request = f.service.ledger.accept(conversation.id, {
    clientRequestId: "busy",
    text: "work",
  });
  const attempt = f.service.ledger.recordAttempt(request.id);
  f.service.ledger.transition(attempt.id, "accepted", { runtimeRunId: "busy-run" });
  const aborts = [];
  f.client.answers["sessions.abort"] = (params) => aborts.push(params) && {};
  f.client.answers["sessions.messages.subscribe"] = {};
  await assert.rejects(level(f, home, "approval", { name: "Renamed" }), {
    status: 409,
    key: "active",
  });
  await assert.rejects(
    f.service.update(home.id, { name: "Renamed" }, revision(f, home)),
    {
      status: 409,
      key: "active",
    },
  );

  // The settings form sends every field, unchanged ones included.
  const stored = f.store.getAssistant(home.id);
  const off = await f.service.update(
    home.id,
    {
      name: stored.name,
      instructions: stored.instructions,
      model: stored.model,
      capabilities: Object.fromEntries(capabilityKeys.map((key) => [key, false])),
      shell: "off",
    },
    stored.revision,
  );
  // Off ends what the running turn still executes, even though the apply worked.
  assert.deepEqual(aborts, [{ key: "home-session", runId: "busy-run" }]);
  assert.equal(off.shell, "off");
  assert.equal(off.pending, undefined);
  assert.equal(off.shellPending, undefined);
  // The agent entry lost its exec mode and both shell tools; the global list keeps
  // them while another agent still has shell.
  assert.equal(f.live(home).tools.exec, undefined);
  assert.equal(hasShellTools(f.live(home).tools.allow), false);
  assert.ok(f.client.effective().tools.allow.includes("exec"));
  assert.equal(f.store.getAssistant(home.id).effectiveRevision, off.revision);

  // The last agent with shell: exec and process leave the global list too.
  await level(f, other, "off");
  assert.equal(f.live(other).tools.exec, undefined);
  assert.equal(hasShellTools(f.client.effective().tools.allow), false);
  assert.deepEqual(f.client.effective().tools.exec, { mode: "deny" });
  assert.deepEqual(
    f.audit.slice(-2).map((e) => [e.resourceId, e.details.shellFrom, e.details.shellTo]),
    [
      [home.id, "full", "off"],
      [other.id, "approval", "off"],
    ],
  );
});

// A turn of `agent` the ledger still counts as running, with its Gateway run id.
function runningTurn(f, agent) {
  const conversation = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `${agent.id}-session`,
  });
  const request = f.service.ledger.accept(conversation.id, {
    clientRequestId: `${agent.id}-turn`,
    text: "work",
  });
  const attempt = f.service.ledger.recordAttempt(request.id);
  f.service.ledger.transition(attempt.id, "accepted", { runtimeRunId: "run-1" });
  return conversation;
}
const failing = () => Object.assign(Error("UNAVAILABLE"), { code: "UNAVAILABLE" });

test("a lowering whose apply keeps failing aborts the running turn and stays pending", async (t) => {
  const f = shellService(t);
  const [home] = f.agents;
  await level(f, home, "full", confirm);
  const conversation = runningTurn(f, home);
  const aborts = [];
  f.client.answers["sessions.abort"] = (params) => aborts.push(params) && {};
  f.client.answers["sessions.messages.subscribe"] = {};
  f.client.answers["config.patch"] = failing();
  const saved = await level(f, home, "off");
  // Saved, but the Gateway still runs the old level: the response says so, and
  // the turn that could still run commands at that level is aborted.
  assert.equal(saved.shell, "off");
  assert.equal(saved.pending, true);
  assert.equal(saved.shellPending, true);
  assert.equal(f.live(home).tools.exec.mode, "full");
  assert.deepEqual(aborts, [{ key: conversation.runtimeSessionKey, runId: "run-1" }]);
  // One synchronous retry before giving up.
  assert.equal(f.service.shellChanges.pending.get(home.id).failures, 2);
  assert.equal(f.service.list().assistants[0].shellPending, true);
  assert.equal(f.audit.at(-1).details.pending, true);
  assert.equal(f.warnings.length, 1);
  assert.ok(!f.warnings[0].includes(home.id));
  // A due retry that fails again backs off and stays pending; one at a Gateway
  // ready aborts again, since a reconnect may find the turn still running.
  await f.service.shellChanges.retry();
  assert.equal(f.service.shellChanges.pending.get(home.id).failures, 2, "not due");
  await f.service.shellChanges.retry({ force: true });
  assert.equal(f.service.shellChanges.pending.get(home.id).failures, 3);
  assert.equal(aborts.length, 2);
  assert.equal(f.warnings.length, 1);

  delete f.client.answers["config.patch"];
  await f.service.shellChanges.retry({ force: true });
  assert.equal(f.live(home).tools.exec, undefined);
  assert.equal(hasShellTools(f.client.effective().tools.allow), false);
  assert.equal(f.service.list().assistants[0].shellPending, undefined);
  assert.equal(aborts.length, 2);
});

test("a lowering that succeeds on the synchronous retry is live and aborts nothing", async (t) => {
  const f = shellService(t);
  const [home] = f.agents;
  await level(f, home, "full", confirm);
  runningTurn(f, home);
  const aborts = [];
  f.client.answers["sessions.abort"] = (params) => aborts.push(params) && {};
  let failures = 1;
  const patch = f.client.call;
  f.client.call = async (method, params) => {
    if (method === "config.patch" && failures-- > 0) throw failing();
    return patch.call(f.client, method, params);
  };
  const saved = await level(f, home, "approval");
  assert.equal(saved.pending, undefined);
  assert.equal(saved.shellPending, undefined);
  assert.equal(f.live(home).tools.exec.mode, "ask");
  assert.deepEqual(aborts, []);
});

test("pending clears on any successful apply, and a ready applies a stopped Gateway's change", async (t) => {
  const f = shellService(t);
  const [home] = f.agents;
  f.client.answers["config.patch"] = failing();
  const raised = await level(f, home, "approval", { confirmShell: true });
  assert.equal(raised.pending, true);
  delete f.client.answers["config.patch"];
  // A turn's own apply (send/openConversation) makes the level live.
  await f.config.apply(home.id);
  assert.equal(f.service.shellChanges.pending.size, 0);
  assert.equal(f.service.list().assistants[0].shellPending, undefined);

  f.client.ready = false;
  const full = await level(f, home, "full", confirm);
  assert.equal(full.pending, true);
  f.client.ready = true;
  f.runtime.emit("status", { availability: "ready" });
  await f.service.shellChanges.retrying;
  assert.equal(f.live(home).tools.exec.mode, "full");
  assert.equal(f.service.shellChanges.pending.size, 0);
});

test("temporary members never get shell; the check precedes the confirmation", async (t) => {
  const f = shellService(t, ["Lead"]);
  const member = f.store.reserveMember({
    id: "member-1",
    parent: f.agents[0].id,
    assignment: { name: "Helper" },
    snapshot: { model: { connectionId: "c", modelId: "m" }, instructions: "" },
    teamId: "team",
    lifetime: "temporary",
  });
  for (const patch of [{ shell: "approval" }, { shell: "full", ...confirm }])
    await assert.rejects(f.service.update(member.id, patch, member.revision), {
      status: 400,
    });
  // Restating "off" (a client sending the whole form) changes nothing.
  const same = await f.service.update(member.id, { shell: "off" }, member.revision);
  assert.equal(same.shell, undefined);
  assert.equal(same.revision, member.revision + 1);
  await assert.rejects(f.service.allowlist.list(member.id), { status: 400 });
  await assert.rejects(f.service.allowlist.remove(member.id, "entry"), { status: 400 });
  assert.deepEqual(f.client.patches, []);
});

test("turning shell off through a restart also denies pending exec requests", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  await level(f, home, "approval", { confirmShell: true });
  const restarts = [];
  f.service.webTools = {
    differs: () => true,
    profilesWith: () => f.store.listAssistants(),
    confirm(confirmed) {
      assert.equal(confirmed, true);
    },
    restart: async (operation) => {
      restarts.push(operation);
      return operation();
    },
  };
  const denied = [];
  f.service.shellChanges.denyPending = async (id) => denied.push(id) && 0;
  const saved = await f.service.update(
    home.id,
    { shell: "off", capabilities: { memory: false, reminders: false, browser: true } },
    revision(f, home),
    { confirmed: true },
  );
  assert.equal(restarts.length, 1);
  assert.equal(saved.shell, "off");
  assert.deepEqual(denied, [home.id]);
  assert.equal(f.live(home).tools.exec, undefined);
  assert.deepEqual(
    [f.audit.at(-1).details.shellFrom, f.audit.at(-1).details.shellTo],
    ["approval", "off"],
  );
});

test("changes stacked while the Gateway is down abort only when the last one lowers", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  const conversation = f.store.saveConversation({
    assistantId: home.id,
    runtimeSessionKey: "home-session",
  });
  const aborts = [];
  f.client.answers["sessions.abort"] = (params) => aborts.push(params) && {};
  f.client.answers["sessions.messages.subscribe"] = {};
  let turns = 0;
  const stack = async (changes) => {
    f.client.ready = false;
    for (const [shell, extra] of changes) await level(f, home, shell, extra);
    // A turn still running at the old level once the Gateway answers again.
    const request = f.service.ledger.accept(conversation.id, {
      clientRequestId: `turn-${++turns}`,
      text: "work",
    });
    const attempt = f.service.ledger.recordAttempt(request.id);
    f.service.ledger.transition(attempt.id, "accepted", { runtimeRunId: "run" });
    f.client.ready = true;
    f.client.answers["config.patch"] = failing();
    await f.service.shellChanges.retry({ force: true });
    delete f.client.answers["config.patch"];
    const lowered = f.service.shellChanges.pending.get(home.id).lowered;
    await f.service.shellChanges.retry({ force: true });
    f.service.ledger.transition(attempt.id, "completed");
    return lowered;
  };
  // A raise, then a lowering: the pending change lowers, so the turn is aborted.
  assert.equal(
    await stack([
      ["approval", { confirmShell: true }],
      ["off", {}],
    ]),
    true,
  );
  assert.equal(aborts.length, 1);
  // A lowering, then a raise: the pending change raises; nothing is aborted.
  assert.equal(
    await stack([
      ["full", confirm],
      ["approval", {}],
      ["full", confirm],
    ]),
    false,
  );
  assert.equal(aborts.length, 1);
  assert.equal(f.live(home).tools.exec.mode, "full");
});
