import test from "node:test";
import assert from "node:assert/strict";
import { claudeRequest } from "../../server/features/requests/claude-hook.js";
import {
  answerValue,
  requestValue,
} from "../../server/features/requests/request-validation.js";
import { persistentRules } from "../../server/features/requests/claude-permission.js";

const bash = (permission_suggestions) => ({
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  cwd: "/work/repo",
  tool_input: { command: "npm test -- --watch=false" },
  permission_suggestions,
});
// Claude proposes its "don't ask again" rule for the project's local settings.
const suggestion = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
  behavior: "allow",
  destination: "localSettings",
};
const decide = (request, choice) =>
  request.answer(answerValue(requestValue(request.view), { choice })).hookSpecificOutput;

test("Claude approvals offer Always allow with the rules Claude proposes", () => {
  const request = claudeRequest(bash([suggestion]));
  const view = requestValue(request.view);
  assert.deepEqual(
    view.options.map((option) => [option.id, option.scope]),
    [
      ["allow", "once"],
      ["always", "persistent"],
      ["deny", undefined],
    ],
  );
  assert.equal(view.options[1].label, "Dauerhaft erlauben");
  assert.equal(view.options[1].description, "Bash(npm test:*)");
  assert.deepEqual(decide(request, "always"), {
    hookEventName: "PermissionRequest",
    decision: {
      behavior: "allow",
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
          behavior: "allow",
          // The account's own CLAUDE_CONFIG_DIR, never the shared project folder.
          destination: "userSettings",
        },
      ],
    },
  });
  // Once and Deny stay exactly as before.
  assert.deepEqual(decide(request, "allow").decision, { behavior: "allow" });
  assert.deepEqual(decide(request, "deny").decision, { behavior: "deny" });
});

test("Always allow never persists into a project folder other accounts share", () => {
  for (const destination of ["localSettings", "projectSettings", "session", "cliArg"]) {
    const request = claudeRequest(bash([{ ...suggestion, destination }]));
    const persisted = decide(request, "always").decision.updatedPermissions;
    assert.deepEqual(
      persisted.map((update) => update.destination),
      ["userSettings"],
    );
  }
});

test("Always allow is offered only for allow rules Claude proposes", () => {
  const ids = (suggestions) =>
    claudeRequest(bash(suggestions)).view.options.map((option) => option.id);
  for (const suggestions of [
    undefined,
    [],
    "Bash(*)",
    [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    [{ type: "addDirectories", directories: ["/"], destination: "session" }],
    [{ ...suggestion, behavior: "deny" }],
    [{ ...suggestion, rules: [{ toolName: "Bash ( * )" }] }],
    [{ ...suggestion, rules: [{ toolName: "Bash", ruleContent: " " }] }],
    [{ ...suggestion, rules: [{ toolName: "Bash", ruleContent: 7 }] }],
  ])
    assert.deepEqual(ids(suggestions), ["allow", "deny"], JSON.stringify(suggestions));
  // Duplicate proposals collapse into one rule; a bare tool rule is kept as is.
  assert.deepEqual(
    persistentRules([
      suggestion,
      suggestion,
      { ...suggestion, rules: [{ toolName: "mcp__docs__search" }] },
    ]),
    [{ toolName: "Bash", ruleContent: "npm test:*" }, { toolName: "mcp__docs__search" }],
  );
});

test("ExitPlanMode shows the plan with approve and keep-planning answers", () => {
  const plan = "# Plan\n\n1. Add the hook\n2. Test it";
  const request = claudeRequest({
    hook_event_name: "PermissionRequest",
    tool_name: "ExitPlanMode",
    cwd: "/work/repo",
    tool_input: { plan },
    permission_suggestions: [suggestion],
  });
  const view = requestValue(request.view);
  assert.equal(view.subject.tool, "ExitPlanMode");
  assert.equal(view.subject.plan, plan);
  assert.deepEqual(
    view.options.map((option) => option.id),
    ["acceptEdits", "approve", "keep"],
  );
  assert.deepEqual(decide(request, "acceptEdits").decision, {
    behavior: "allow",
    updatedPermissions: [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
  });
  assert.deepEqual(decide(request, "approve").decision, {
    behavior: "allow",
    updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
  });
  const keep = decide(request, "keep").decision;
  assert.equal(keep.behavior, "deny");
  assert.equal(keep.interrupt, true);
  assert.match(keep.message, /keep planning/);
  assert.equal(request.answer({ handoff: true }), null);
  // A long plan survives validation instead of being dropped as an oversized field.
  const long = "x".repeat(60000);
  const longView = claudeRequest({
    hook_event_name: "PermissionRequest",
    tool_name: "ExitPlanMode",
    tool_input: { plan: long },
  }).view;
  assert.equal(requestValue(longView).subject.plan, long);
});

test("ExitPlanMode without a plan stays an ordinary approval", () => {
  const view = claudeRequest({
    hook_event_name: "PermissionRequest",
    tool_name: "ExitPlanMode",
    tool_input: {},
  }).view;
  assert.deepEqual(
    view.options.map((option) => option.id),
    ["allow", "deny"],
  );
  assert.equal(requestValue(view).subject.plan, undefined);
});
