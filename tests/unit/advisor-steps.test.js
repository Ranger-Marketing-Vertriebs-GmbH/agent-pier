import test from "node:test";
import assert from "node:assert/strict";
import {
  hermesEventKind,
  hermesStep,
} from "../../server/features/assistants/runtimes/hermes/hermes-run-state.js";
import { RunSteps } from "../../server/features/assistants/run-steps.js";
import { nextSteps } from "../../web/features/assistants/run-steps.js";

// Mixture of Agents in the chat (ADR 0007, step 7a): each advisor's answer of a turn
// is one expandable step, titled with its number and model, its text as the step's
// output, a failed advisor shown failed. Hermes sends them as `moa.reference`
// (tui_gateway/tool_progress.py: `{ label, text, index, count }`, the label
// `<provider>:<model>` of agent/moa_loop.py `_slot_label`).
const reference = (extra = {}) => ({
  label: "custom:agentpier-advisor-2:openai/gpt-x",
  text: "Check the logs first.",
  index: 1,
  count: 2,
  ...extra,
});

test("Hermes's moa.reference is an advisor step of the running turn", () => {
  assert.deepEqual(hermesStep("moa.reference", reference()), {
    type: "advisor",
    id: "advisor:2",
    advisor: 2,
    model: "openai/gpt-x",
    text: "Check the logs first.",
    failed: false,
  });
  assert.equal(hermesEventKind("moa.reference", reference(), true), "progress");
  // A failed or skipped advisor arrives as a note in its text.
  const failed = hermesStep(
    "moa.reference",
    reference({ text: "[failed: Connection error.]" }),
  );
  assert.equal(failed.failed, true);
  assert.equal(
    hermesStep("moa.reference", reference({ text: " [skipped: interrupted by user]" }))
      .failed,
    true,
  );
  // A reasoning suffix is not part of the model; a label of another provider keeps
  // Hermes's position.
  assert.equal(
    hermesStep(
      "moa.reference",
      reference({ label: "custom:agentpier-advisor-1:m-1[reasoning=high]" }),
    ).model,
    "m-1",
  );
  assert.deepEqual(
    hermesStep("moa.reference", reference({ label: "openrouter:a/b", index: 3 })),
    {
      type: "advisor",
      id: "advisor:3",
      advisor: 3,
      model: "a/b",
      text: "Check the logs first.",
      failed: false,
    },
  );
  assert.equal(hermesStep("moa.reference", { text: "x" }), null);
  assert.equal(hermesStep("moa.progress", { refs_done: 1, refs_total: 2 }), null);
});

test("the run's steps carry the advisor's answer, capped, beside tool steps", () => {
  const steps = new RunSteps({ now: () => 1000 });
  const event = (step) => ({ kind: "progress", runId: "r1", sessionKey: "k", step });
  const advisor = hermesStep("moa.reference", reference());
  assert.equal(steps.observe(event(advisor)).changed, true);
  steps.observe(
    event(
      hermesStep(
        "moa.reference",
        reference({ label: "custom:agentpier-advisor-1:x", text: "[failed: boom]" }),
      ),
    ),
  );
  const long = "word ".repeat(4000);
  steps.observe(
    event(
      hermesStep(
        "moa.reference",
        reference({ label: "custom:agentpier-advisor-3:y", text: long }),
      ),
    ),
  );
  const view = steps.view("r1");
  assert.deepEqual(view.steps[0], {
    id: "advisor:2",
    kind: "advisor",
    advisor: 2,
    model: "openai/gpt-x",
    output: "Check the logs first.",
    state: "done",
  });
  assert.equal(view.steps[1].state, "failed");
  assert.equal(view.steps[1].output, "[failed: boom]");
  assert.ok(view.steps[2].output.length <= 8000);
  assert.ok(view.steps[2].output.endsWith("…"));
  // The same advisor again (a repeated frame) changes nothing.
  assert.equal(steps.observe(event(advisor)).changed, false);
  assert.equal(steps.view("r1").steps.length, 3);
});

test("the web keeps an advisor step with its output", () => {
  const runs = nextSteps(
    new Map(),
    {
      type: "steps",
      runId: "r1",
      steps: [
        {
          id: "advisor:1",
          kind: "advisor",
          advisor: 1,
          model: "a/b",
          output: "Advice",
          state: "done",
        },
        { id: "advisor:2", kind: "advisor", advisor: "x", output: 3, state: "failed" },
      ],
      phase: "model",
      quietMs: 0,
    },
    1000,
  );
  assert.deepEqual(runs.get("r1").steps, [
    {
      id: "advisor:1",
      kind: "advisor",
      tool: "",
      label: "",
      advisor: 1,
      model: "a/b",
      output: "Advice",
      state: "done",
    },
    {
      id: "advisor:2",
      kind: "advisor",
      tool: "",
      label: "",
      advisor: 0,
      model: "",
      output: "",
      state: "failed",
    },
  ]);
});
