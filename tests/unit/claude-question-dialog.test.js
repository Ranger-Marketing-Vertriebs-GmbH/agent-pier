import test from "node:test";
import assert from "node:assert/strict";
import { claudeRequest } from "../../server/features/requests/claude-hook.js";
import { codexRequest } from "../../server/features/requests/codex-protocol.js";
import {
  requestValue,
  answerValue,
} from "../../server/features/requests/request-validation.js";
import {
  previewLimit,
  questionsView,
} from "../../server/features/requests/native-questions.js";

const mockup = "+------+\n| <b>a</b> |\n+------+";
const toolInput = {
  questions: [
    {
      header: "Layout",
      question: "Which layout?\nPick one.",
      options: [
        { label: "Grid", description: "Cards", preview: mockup },
        { label: "List", preview: "- a\n- b" },
      ],
      multiSelect: false,
    },
    {
      question: "Which parts?",
      options: [{ label: "API" }, { label: "Web" }],
      multiSelect: true,
    },
  ],
};
const claude = (hook_event_name = "PreToolUse", tool_input = toolInput) =>
  claudeRequest({ hook_event_name, tool_name: "AskUserQuestion", tool_input });
const parsed = (request) => ({
  ...requestValue(request.view),
  source: "claude",
});

test("Claude option previews reach the chat request unchanged and as plain text", () => {
  const view = parsed(claude());
  assert.equal(view.declinable, true);
  assert.equal(view.questions[0].notes, true);
  assert.deepEqual(view.questions[0].options[0], {
    id: "Grid",
    label: "Grid",
    description: "Cards",
    preview: mockup,
  });
  assert.equal(view.questions[1].options[0].preview, undefined);
  assert.equal(view.questions[0].prompt, "Which layout?\nPick one.");
});

test("oversized previews are bounded instead of rejecting the whole question", () => {
  const huge = "x".repeat(previewLimit * 3);
  const request = claude("PreToolUse", {
    questions: [{ question: "Big?", options: [{ label: "A", preview: huge }] }],
  });
  const preview = parsed(request).questions[0].options[0].preview;
  assert.equal(preview.length, previewLimit);
  assert.ok(preview.endsWith("…"));
  // A native payload which exceeds the bound loses only the preview.
  const direct = requestValue({
    kind: "question",
    questions: [
      {
        id: "q0",
        prompt: "Big?",
        multiple: false,
        allowOther: true,
        options: [{ id: "A", label: "A", preview: huge }],
      },
    ],
  });
  assert.deepEqual(direct.questions[0].options[0], { id: "A", label: "A" });
});

test("answers mirror the native annotations: selected preview and trimmed notes", () => {
  const request = claude();
  const answer = answerValue(parsed(request), {
    answers: { q0: ["Grid"], q1: ["API", "Web"] },
    notes: { q0: "  keep it compact \n", q1: "   " },
  });
  const output = request.answer(answer);
  assert.deepEqual(output.hookSpecificOutput.updatedInput.answers, {
    "Which layout?\nPick one.": "Grid",
    "Which parts?": "API, Web",
  });
  assert.deepEqual(output.hookSpecificOutput.updatedInput.annotations, {
    "Which layout?\nPick one.": { preview: mockup, notes: "keep it compact" },
  });
  assert.deepEqual(output.hookSpecificOutput.updatedInput.questions, toolInput.questions);
  // Free text is no option, so no preview; nothing to annotate at all.
  const plain = request.answer(
    answerValue(parsed(request), { answers: { q0: ["Other"], q1: ["Web"] } }),
  );
  assert.equal(plain.hookSpecificOutput.updatedInput.annotations, undefined);
});

test("PermissionRequest answers carry the same annotations", () => {
  const request = claude("PermissionRequest");
  const output = request.answer(
    answerValue(parsed(request), {
      answers: { q0: ["List"], q1: ["API"] },
      notes: { q1: "only the read side" },
    }),
  );
  assert.equal(output.hookSpecificOutput.decision.behavior, "allow");
  assert.deepEqual(output.hookSpecificOutput.decision.updatedInput.annotations, {
    "Which layout?\nPick one.": { preview: "- a\n- b" },
    "Which parts?": { notes: "only the read side" },
  });
});

test("declining denies the tool on both Claude hook paths with an explanation", () => {
  const pre = claude();
  const decline = answerValue(parsed(pre), {
    decline: true,
    notes: { q1: "ask me tomorrow" },
  });
  assert.deepEqual(decline, { decline: true, notes: { q1: "ask me tomorrow" } });
  const denied = pre.answer(decline).hookSpecificOutput;
  assert.equal(denied.hookEventName, "PreToolUse");
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /declined to answer/);
  assert.match(denied.permissionDecisionReason, /"Which parts\?": ask me tomorrow/);
  assert.equal(denied.updatedInput, undefined);
  const fallback = claude("PermissionRequest");
  const result = fallback.answer(answerValue(parsed(fallback), { decline: true }));
  assert.equal(result.hookSpecificOutput.decision.behavior, "deny");
  assert.match(result.hookSpecificOutput.decision.message, /declined to answer/);
  assert.doesNotMatch(result.hookSpecificOutput.decision.message, /User notes/);
});

test("decline and notes are refused for sources which cannot deliver them", () => {
  const codex = codexRequest({
    id: 1,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread",
      questions: [
        {
          id: "one",
          question: "Which?",
          isOther: true,
          options: [{ label: "A", description: "", preview: "ignored" }],
        },
      ],
    },
  });
  const view = requestValue(codex.view);
  assert.equal(view.declinable, undefined);
  assert.equal(view.questions[0].notes, undefined);
  assert.equal(view.questions[0].options[0].preview, undefined);
  for (const input of [
    { decline: true },
    { answers: { q0: ["A"] }, notes: { q0: "note" } },
  ])
    assert.throws(() => answerValue(view, input), { status: 400 });
  const claudeView = parsed(claude());
  for (const input of [
    { decline: "yes" },
    { decline: true, answers: { q0: ["Grid"], q1: ["API"] } },
    { answers: { q0: ["Grid"], q1: ["API"] }, notes: { q9: "unknown question" } },
    { answers: { q0: ["Grid"], q1: ["API"] }, notes: { q0: "x".repeat(8001) } },
    { answers: { q0: ["Grid"], q1: ["API"] }, notes: ["q0"] },
  ])
    assert.throws(() => answerValue(claudeView, input), { status: 400 });
});

test("OpenCode questions keep their native shape without chat-only fields", () => {
  const [question] = questionsView(
    [{ question: "Which?", options: [{ label: "A", description: "", preview: "x" }] }],
    "opencode",
  );
  assert.deepEqual(question, {
    id: "q0",
    header: "",
    prompt: "Which?",
    options: [{ id: "A", label: "A", description: "" }],
    multiple: false,
    allowOther: true,
  });
});
