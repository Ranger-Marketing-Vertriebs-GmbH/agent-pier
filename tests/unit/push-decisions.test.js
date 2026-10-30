import test from "node:test";
import assert from "node:assert/strict";
import {
  actionDecisions,
  decideFromPush,
  decideMode,
  requestDecisions,
} from "../../server/application/push-decisions.js";
import { requestNotice, requestTool } from "../../server/application/push-notices.js";
import { buildPayload } from "../../server/features/notifications/push-content.js";
import { defaultPreferences } from "../../server/features/notifications/push-preferences.js";
import {
  pushEvent,
  pushMessage,
} from "../../server/features/notifications/push-validation.js";

// The options each CLI offers for a permission (claude-hook.js, codex-protocol.js,
// opencode-plugin.js).
const claude = {
  id: "r1",
  sessionId: "s1",
  kind: "permission",
  status: "pending",
  revision: 0,
  subject: { tool: "Bash", command: "rm -rf build" },
  options: [
    { id: "allow", scope: "once" },
    { id: "always", scope: "persistent" },
    { id: "deny" },
  ],
};
const codexCommand = {
  ...claude,
  subject: { tool: "item/commandExecution/requestApproval", command: "make" },
  options: [
    { id: "accept", scope: "once" },
    { id: "acceptForSession", scope: "session" },
    { id: "decline" },
    { id: "cancel" },
  ],
};
const codexPermissions = {
  ...claude,
  subject: { tool: "item/permissions/requestApproval" },
  options: [{ id: "allow", scope: "turn" }, { id: "deny" }],
};
const opencode = {
  ...claude,
  subject: { tool: "edit" },
  options: [
    { id: "once", scope: "once" },
    { id: "always", scope: "session" },
    { id: "reject" },
  ],
};

test("a push allows only once and denies plainly, never always or for a turn", () => {
  assert.deepEqual(requestDecisions(claude), { allow: "allow", deny: "deny" });
  assert.deepEqual(requestDecisions(codexCommand), { allow: "accept", deny: "decline" });
  assert.deepEqual(requestDecisions(codexPermissions), { deny: "deny" });
  assert.deepEqual(requestDecisions(opencode), { allow: "once", deny: "reject" });
  // Plans, trust and startup prompts, questions and answered requests: nothing.
  for (const entry of [
    { ...claude, subject: { tool: "ExitPlanMode", plan: "1. Do it" } },
    { ...claude, presentation: "claudeFolderTrust" },
    { ...claude, kind: "question" },
    { ...claude, status: "responding" },
  ])
    assert.deepEqual(requestDecisions(entry), {});
  assert.equal(decideMode(requestDecisions(claude)), "both");
  assert.equal(decideMode(requestDecisions(codexPermissions)), "deny");
  assert.equal(decideMode({}), undefined);
});

test("agent shell, SSH, SFTP and mail approvals can only be denied from a push", () => {
  const action = (kind) => ({ state: "awaiting_approval", payload: { action: kind } });
  assert.deepEqual(actionDecisions(action("exec")), { deny: "deny" });
  for (const kind of ["ssh", "sftp", "mail_send"])
    assert.deepEqual(actionDecisions(action(kind)), { deny: "decline" });
  for (const kind of ["coding_start", "session_start", "memory_write", "member_grant"])
    assert.deepEqual(actionDecisions(action(kind)), {
      allow: "approve",
      deny: "decline",
    });
  for (const kind of ["hook_proposal", "ssh_access", "session_request"])
    assert.deepEqual(actionDecisions(action(kind)), {});
  assert.deepEqual(actionDecisions({ ...action("exec"), state: "approved" }), {});
});

test("an approval push names its tool and offers the decisions with its revision", () => {
  assert.equal(requestTool(claude), "Bash");
  assert.equal(requestTool(codexCommand), "shell");
  assert.equal(requestTool(codexPermissions), undefined);
  const notice = requestNotice(
    { kind: "permission", sessionId: "s1", resourceId: "r1" },
    { id: "s1", name: "api", tool: "claude" },
    { ...claude, revision: 3 },
  );
  assert.equal(notice.toolName, "Bash");
  assert.equal(notice.decide, "both");
  assert.equal(notice.revision, 3);
  const event = pushEvent({ kind: "permission", eventId: "r1", ...notice });
  for (const level of ["type", "label", "preview"]) {
    const payload = buildPayload(event, { ...defaultPreferences(), level });
    assert.equal(payload.decide, "both");
    assert.equal(payload.revision, 3);
    assert.equal(payload.toolName, level === "type" ? undefined : "Bash");
    // The command never leaves the host, at any level.
    assert.doesNotMatch(pushMessage(payload), /rm -rf|build/);
  }
});

test("a tool name that looks like a command or path is dropped", () => {
  for (const toolName of ["rm -rf /", "/usr/bin/env", "curl http://x", "a".repeat(80)]) {
    const event = pushEvent({
      kind: "permission",
      eventId: "r1",
      sessionId: "s1",
      toolName,
    });
    assert.equal(
      buildPayload(event, { ...defaultPreferences(), level: "label" }).toolName,
      undefined,
    );
  }
});

test("Allow and Deny exist only on an approval inbox item", () => {
  const ended = pushEvent({
    kind: "session-ended",
    eventId: "e1",
    sessionId: "s1",
    decide: "both",
    revision: 1,
  });
  assert.equal(ended.decide, undefined);
  assert.throws(() =>
    pushMessage({
      v: 2,
      kind: "test",
      eventId: "e1",
      link: "/",
      decide: "both",
      revision: 1,
    }),
  );
});

function services({ entry = { ...claude, revision: 2 }, action } = {}) {
  const answered = [],
    decided = [];
  return {
    answered,
    decided,
    requests: {
      listAll: () => (entry ? [entry] : []),
      answer: async (...args) => answered.push(args),
    },
    assistants: {
      workflows: {
        store: {
          get: (id) => {
            if (!action || action.id !== id) throw Error("missing");
            return action;
          },
        },
        decide: async (...args) => decided.push(args),
      },
    },
  };
}

test("a push decides exactly the request it named, once only", async () => {
  const s = services();
  assert.deepEqual(
    await decideFromPush(s, {
      type: "approval",
      id: "r1",
      revision: 2,
      decision: "allow",
    }),
    { decided: "allow" },
  );
  assert.deepEqual(s.answered, [["s1", "r1", { expectedRevision: 2, choice: "allow" }]]);
  // A changed revision, another request or a malformed body is refused.
  for (const input of [
    { type: "approval", id: "r1", revision: 1, decision: "allow" },
    { type: "approval", id: "r9", revision: 2, decision: "deny" },
  ])
    await assert.rejects(decideFromPush(s, input), { status: 409 });
  for (const input of [
    { type: "approval", id: "r1", revision: 2, decision: "always" },
    { type: "gate", id: "r1", revision: 2, decision: "allow" },
    { type: "approval", id: "../r1", revision: 2, decision: "allow" },
    { type: "approval", id: "r1", decision: "allow" },
  ])
    await assert.rejects(decideFromPush(s, input), { status: 400 });
  // A Codex permission request is never allowed from a push.
  const codex = services({ entry: { ...codexPermissions, revision: 0 } });
  await assert.rejects(
    decideFromPush(codex, { type: "approval", id: "r1", revision: 0, decision: "allow" }),
    { status: 409 },
  );
  assert.equal(codex.answered.length, 0);
});

test("an agent action is decided as the owner through the push channel", async () => {
  const action = {
    id: "a1",
    revision: 4,
    state: "awaiting_approval",
    payload: { action: "exec" },
  };
  const s = services({ action });
  await assert.rejects(
    decideFromPush(s, { type: "action", id: "a1", revision: 4, decision: "allow" }),
    { status: 409 },
  );
  await decideFromPush(s, { type: "action", id: "a1", revision: 4, decision: "deny" });
  assert.deepEqual(s.decided, [
    ["a1", { revision: 4, decision: "deny" }, { kind: "owner", channel: "push" }],
  ]);
});
