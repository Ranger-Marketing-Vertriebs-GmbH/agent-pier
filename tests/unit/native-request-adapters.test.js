import test from "node:test";
import { requestValue } from "../../server/features/requests/request-validation.js";
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
for (const event of ["PreToolUse", "PermissionRequest"])
  test(`Claude ${event} question replies preserve questions and multi-select answers`, () => {
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
      {
        question: "Target?",
        header: "Target",
        multiSelect: false,
        options: [{ label: "Local", description: "This machine" }],
      },
      { question: "Notes?", options: [] },
    ];
    const request = claudeRequest({
      session_id: "session",
      tool_use_id: "native-call",
      hook_event_name: event,
      tool_name: "AskUserQuestion",
      tool_input: { questions },
    });
    assert.equal(request.view.kind, "question");
    assert.equal(request.view.questions[0].prompt, "Checks?");
    assert.deepEqual(
      request.view.questions.map((q) => q.prompt),
      ["Checks?", "Target?", "Notes?"],
    );
    const updatedInput = {
      questions,
      answers: {
        "Checks?": "Unit, Browser",
        "Target?": "Local",
        "Notes?": "Custom notes",
      },
    };
    assert.deepEqual(
      request.answer({
        answers: { q0: ["Unit", "Browser"], q1: ["Local"], q2: ["Custom notes"] },
      }),
      {
        hookSpecificOutput:
          event === "PreToolUse"
            ? { hookEventName: event, permissionDecision: "allow", updatedInput }
            : { hookEventName: event, decision: { behavior: "allow", updatedInput } },
      },
    );
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
test("Claude questions without usable questions never become bare approvals", () => {
  for (const questions of [undefined, null, [], "invalid"])
    for (const hook_event_name of ["PreToolUse", "PermissionRequest"])
      assert.equal(
        claudeRequest({
          hook_event_name,
          tool_name: "AskUserQuestion",
          tool_input: { questions },
        }),
        null,
      );
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
test("Claude EnterWorktree permissions show their target path beside the tool", () => {
  const permission = (tool_name, tool_input) =>
    claudeRequest({
      hook_event_name: "PermissionRequest",
      tool_name,
      cwd: "/work/repo",
      tool_input,
    }).view.subject;
  const subject = permission("EnterWorktree", { path: "/work/repo/.worktrees/fix" });
  assert.equal(subject.tool, "EnterWorktree");
  assert.equal(subject.path, "/work/repo/.worktrees/fix");
  assert.equal(subject.cwd, "/work/repo");
  assert.equal(subject.command, undefined);
  // For Glob/Grep `path` is only a search root, not the approval's subject.
  for (const tool of ["Glob", "Grep"])
    assert.equal(permission(tool, { pattern: "*.js", path: "/work" }).path, undefined);
});
test("Claude Workflow permissions show meta.name and meta.description separately", () => {
  const subject = (tool_input) =>
    claudeRequest({
      hook_event_name: "PermissionRequest",
      tool_name: "Workflow",
      tool_input,
    }).view.subject;
  const pick = (tool_input) => {
    const { name, description } = subject(tool_input);
    return { name, description };
  };
  assert.deepEqual(pick({ meta: { name: "nightly", description: "Review open PRs" } }), {
    name: "nightly",
    description: "Review open PRs",
  });
  assert.deepEqual(
    pick({
      script: [
        "// header",
        "export const meta = {",
        "  // name: 'commented'",
        "  phases: [{ name: 'phase-one', title: 'x' }],",
        "  name: 'nightly-review',",
        '  "description": "Review \\"open\\"\\tPRs \\\\ now\\nplease",',
        "};",
        "export default async () => agent({ name: 'later', description: 'no' });",
      ].join("\n"),
    }),
    { name: "nightly-review", description: 'Review "open" PRs \\ now please' },
  );
  // The scan ends with the meta object: later properties never leak in.
  assert.deepEqual(
    pick({ script: "export const meta = { title: 'x' };\nagent({ name: 'later' });" }),
    { name: undefined, description: undefined },
  );
  assert.equal(
    pick({ script: "export const meta = { name: `only-name` };" }).name,
    "only-name",
  );
  // Explicit descriptions win; unparseable or hostile scripts never throw or run.
  assert.equal(
    pick({ description: "Given", meta: { description: "n" } }).description,
    "Given",
  );
  for (const script of [
    "",
    "meta = { name: process.exit(1) }",
    "export const meta = { name: 'unterminated",
    "export const meta = { name: `dynamic ${process.env.HOME}` };",
    "x".repeat(300000),
    42,
  ])
    assert.deepEqual(pick({ script }), { name: undefined, description: undefined });
  assert.deepEqual(pick({ meta: { name: 7, description: ["x"] } }), {
    name: undefined,
    description: undefined,
  });
  const long = pick({ meta: { name: "n".repeat(500), description: "d".repeat(5000) } });
  assert.ok(long.name.length <= 200 && long.description.length <= 1500);
  // The validated view keeps the name for the chat.
  assert.equal(requestValue(claudeView({ meta: { name: "kept" } })).subject.name, "kept");
});
const claudeView = (tool_input) =>
  claudeRequest({
    hook_event_name: "PermissionRequest",
    tool_name: "Workflow",
    tool_input,
  }).view;
