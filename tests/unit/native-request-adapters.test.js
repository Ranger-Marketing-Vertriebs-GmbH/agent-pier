import test from "node:test";
import assert from "node:assert/strict";
import { codexRequest } from "../../server/features/requests/codex-protocol.js";
import { claudeRequest } from "../../server/features/requests/claude-hook.js";
import { observeOpenCode } from "../../server/features/requests/opencode-plugin.js";

test("Codex complete questions preserve typed RPC IDs and map every native question ID", () => {
  const request = codexRequest({
    id: "004#rpc",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      questions: [
        {
          id: "q#native",
          header: "Framework",
          question: "Which?",
          isOther: true,
          isSecret: false,
          options: [{ label: "React", description: "UI library" }],
        },
        {
          id: "notes",
          header: "Notes",
          question: "Notes?",
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    },
  });
  assert.equal(request.view.questions.length, 2);
  assert.equal(request.view.questions[1].secret, true);
  assert.deepEqual(request.answer({ answers: { q0: ["React"], q1: ["Some notes"] } }), {
    id: "004#rpc",
    result: {
      answers: { "q#native": { answers: ["React"] }, notes: { answers: ["Some notes"] } },
    },
  });
});
test("Codex permission grants use permissions/scope rather than command decision", () => {
  const permission = codexRequest({
    id: 3,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread",
      permissions: { network: { enabled: true }, fileSystem: null },
    },
  });
  assert.deepEqual(permission.answer({ choice: "allow" }), {
    id: 3,
    result: { permissions: { network: { enabled: true } }, scope: "turn" },
  });
  assert.deepEqual(permission.answer({ choice: "deny" }), {
    id: 3,
    result: { permissions: {}, scope: "turn" },
  });
});
test("Codex ordinary command decision stays within native offered decisions", () => {
  const permission = codexRequest({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      command: "ls",
      availableDecisions: ["decline", "accept"],
    },
  });
  assert.deepEqual(
    permission.view.options.map((o) => o.id),
    ["decline", "accept"],
  );
  assert.deepEqual(permission.answer({ choice: "accept" }), {
    id: 7,
    result: { decision: "accept" },
  });
});
test("Claude question replies return original questions and multi-select labels in updatedInput", () => {
  const questions = [
    {
      question: "Checks?",
      header: "Checks",
      multiSelect: true,
      options: [
        { label: "Unit", description: "Fast" },
        { label: "Browser", description: "Complete" },
      ],
    },
  ];
  const request = claudeRequest({
    session_id: "session",
    tool_use_id: "native-call",
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions },
  });
  assert.deepEqual(request.answer({ answers: { q0: ["Unit", "Browser"] } }), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "Checks?": "Unit, Browser" } },
    },
  });
  assert.equal(request.answer({ handoff: true }), null);
});
test("Claude permission is an actual native hook response, not PTY input", () => {
  const request = claudeRequest({
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  assert.deepEqual(request.answer({ choice: "deny" }), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny" },
    },
  });
});
test("OpenCode plugin uses current native pending IDs and rejects a Terminal-won race", async () => {
  let route = "session-a";
  let pending = [
    {
      id: "native-q",
      sessionID: "session-a",
      questions: [
        {
          question: "Which?",
          header: "Choice",
          options: [{ label: "One", description: "First" }],
          custom: true,
        },
      ],
    },
  ];
  const published = new Map(),
    replies = [];
  const channel = {
    publish: (id, view, deliver) => published.set(id, { view, deliver }),
    resolve: (id) => published.delete(id),
    close() {},
  };
  const api = {
    route: {
      get current() {
        return { name: "session", params: { sessionID: route } };
      },
    },
    state: { session: { permission: () => [], question: () => pending } },
    client: { question: { reply: async (value) => replies.push(value) } },
  };
  const observer = observeOpenCode(api, channel);
  observer.update();
  const request = [...published.values()][0];
  await request.deliver({ answers: { q0: ["One"] } });
  assert.deepEqual(replies, [{ requestID: "native-q", answers: [["One"]] }]);
  pending = [];
  await assert.rejects(request.deliver({ answers: { q0: ["o0"] } }), { stale: true });
  route = "session-b";
  observer.update();
  assert.equal(published.size, 0);
});

test("free text which resembles an option ID is never rewritten into a choice", () => {
  const request = codexRequest({
    id: 1,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "t",
      questions: [
        {
          id: "native",
          question: "Choose?",
          isOther: true,
          options: [{ label: "React", description: "" }],
        },
      ],
    },
  });
  assert.deepEqual(
    request.answer({ answers: { q0: ["o0"] } }).result.answers.native.answers,
    ["o0"],
  );
});

test("OpenCode remembered approval discloses the session-scoped future patterns", () => {
  const published = [];
  const request = {
    id: "permission",
    sessionID: "session",
    permission: "bash",
    patterns: ["git status"],
    always: ["git *"],
    metadata: { command: "git status" },
  };
  const api = {
    route: { current: { name: "session", params: { sessionID: "session" } } },
    state: { session: { permission: () => [request], question: () => [] } },
    client: {},
  };
  observeOpenCode(api, {
    publish: (_id, view) => published.push(view),
    resolve() {},
    close() {},
  }).update();
  assert.equal(published[0].options.find((o) => o.id === "always").scope, "session");
  assert.ok(published[0].subject.description.includes("git *"));
});

test("OpenCode module exposes the default export required by the actual TUI loader", async () => {
  const module = await import("../../server/features/requests/opencode-plugin.js");
  assert.equal(module.default?.id, "agentpier-requests");
  assert.equal(module.default?.tui, module.tui);
  assert.equal(module.default?.server, undefined);
});

test("Codex additional permissions disclose the full native turn scope", async () => {
  const { requestValue } =
    await import("../../server/features/requests/request-validation.js");
  const request = codexRequest({
    id: 1,
    method: "item/permissions/requestApproval",
    params: { threadId: "thread", permissions: { network: { enabled: true } } },
  });
  const option = requestValue(request.view).options.find(
    (option) => option.id === "allow",
  );
  assert.equal(option.scope, "turn");
  assert.equal(option.label, "Für diesen Turn erlauben");
});
