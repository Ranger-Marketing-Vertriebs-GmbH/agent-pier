import test from "node:test";
import assert from "node:assert/strict";
import {
  HermesRuns,
  hermesEventKind,
  hermesStep,
} from "../../server/features/assistants/runtimes/hermes/hermes-run-state.js";
import { RunSteps } from "../../server/features/assistants/run-steps.js";
import { nextSteps } from "../../web/features/assistants/run-steps.js";

// Mixture of Agents in the chat (ADR 0007, step 7a): each advisor's answer of a turn
// is one expandable step, titled with its number and model, its text as the step's
// output; a failed advisor is shown failed with at most a status or a short kind of
// error, never Hermes's raw note. Hermes sends them as `moa.reference`
// (tui_gateway/tool_progress.py: `{ label, text, index, count }`, the label
// `<provider>:<model>` of agent/moa_loop.py `_slot_label`).
const reference = (extra = {}) => ({
  label: "custom:agentpier-advisor-2:openai/gpt-x",
  text: "Check the logs first.",
  index: 1,
  count: 2,
  ...extra,
});
const failedWith = (text) =>
  hermesStep("moa.reference", reference({ text: `[failed: ${text}]` }));

test("Hermes's moa.reference is an advisor step of the running turn", () => {
  assert.deepEqual(hermesStep("moa.reference", reference()), {
    type: "advisor",
    id: "advisor:1:2",
    advisor: 2,
    model: "openai/gpt-x",
    text: "Check the logs first.",
    failed: false,
  });
  assert.equal(hermesStep("moa.reference", reference(), { fanout: 3 }).id, "advisor:3:2");
  assert.equal(hermesEventKind("moa.reference", reference(), true), "progress");
  // A reasoning suffix is not part of the model; a label of another provider keeps
  // Hermes's position.
  assert.equal(
    hermesStep(
      "moa.reference",
      reference({ label: "custom:agentpier-advisor-1:m-1[reasoning=high]" }),
    ).model,
    "m-1",
  );
  const other = hermesStep(
    "moa.reference",
    reference({ label: "openrouter:a/b", index: 3 }),
  );
  assert.equal(other.advisor, 3);
  assert.equal(other.model, "a/b");
  assert.equal(hermesStep("moa.reference", { text: "x" }), null);
  assert.equal(hermesStep("moa.progress", { refs_done: 1, refs_total: 2 }), null);
});

test("a failed advisor keeps only a status or a kind of error, never the note", () => {
  const leaky =
    "Error code: 401 - {'error': {'message': 'Incorrect API key provided: sk-proj-abc123…xyz9 at https://api.example.test/v1/chat'}}";
  const step = failedWith(leaky);
  assert.deepEqual(step, {
    type: "advisor",
    id: "advisor:1:2",
    advisor: 2,
    model: "openai/gpt-x",
    text: "",
    failed: true,
    failure: "http-401",
  });
  assert.doesNotMatch(JSON.stringify(step), /sk-|https?:|example/);
  assert.equal(failedWith("Request timed out.").failure, "timeout");
  assert.equal(failedWith("Connection error.").failure, "connection");
  assert.equal(failedWith("boom at https://x.test sk-123").failure, "error");
  const skipped = hermesStep(
    "moa.reference",
    reference({ text: " [skipped: interrupted by user]" }),
  );
  assert.equal(skipped.failure, "interrupted");
  assert.equal(skipped.text, "");
});

// A minimal Hermes client: the frames a test sends are what the gateway emits.
function runsOf() {
  let frame;
  const client = { closed: false, subscribe: (fn) => (frame = fn), once: () => {} };
  const runs = new HermesRuns(client, { agentId: "a1" });
  runs.bind("agent:a1:hermes:s1", "s1");
  const events = [];
  runs.subscribe((event) => events.push(event));
  let seq = 0;
  const send = (type, payload = {}) =>
    frame({ type, session_id: "s1", seq: ++seq, admission_id: "t1", payload });
  return { events, send };
}

test("two fan-outs in one run are two sets of steps", () => {
  const { events, send } = runsOf();
  send("message.start");
  send("moa.reference", reference({ index: 1, label: "custom:agentpier-advisor-1:m" }));
  send("moa.reference", reference({ index: 2 }));
  // A steered or queued message of the same run asks the advisors again.
  send("moa.reference", reference({ index: 1, label: "custom:agentpier-advisor-1:m" }));
  send("moa.reference", reference({ index: 2 }));
  const ids = events.filter((e) => e.step?.type === "advisor").map((e) => e.step.id);
  assert.deepEqual(ids, ["advisor:1:1", "advisor:1:2", "advisor:2:1", "advisor:2:2"]);
  const steps = new RunSteps({ now: () => 1000 });
  for (const event of events) steps.observe(event);
  const runId = events[0].runId;
  assert.equal(steps.view(runId).steps.filter((s) => s.kind === "advisor").length, 4);
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
        reference({
          label: "custom:agentpier-advisor-1:x",
          text: "[failed: Error code: 429 - see https://x.test sk-abc]",
        }),
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
    id: "advisor:1:2",
    kind: "advisor",
    advisor: 2,
    model: "openai/gpt-x",
    output: "Check the logs first.",
    state: "done",
  });
  assert.deepEqual(view.steps[1], {
    id: "advisor:1:1",
    kind: "advisor",
    advisor: 1,
    model: "x",
    output: "",
    failure: "http-429",
    state: "failed",
  });
  assert.doesNotMatch(JSON.stringify(view), /sk-|https?:/);
  assert.ok(view.steps[2].output.length <= 8000);
  assert.ok(view.steps[2].output.endsWith("…"));
  // The same advisor again (a repeated frame) changes nothing.
  assert.equal(steps.observe(event(advisor)).changed, false);
  assert.equal(steps.view("r1").steps.length, 3);
  // A failure of another shape never passes.
  steps.observe(
    event({ ...advisor, id: "advisor:9:1", failed: true, failure: "https://x.test" }),
  );
  assert.equal(steps.view("r1").steps.at(-1).failure, "error");
});

test("the web keeps an advisor step with its output or its failure", () => {
  const runs = nextSteps(
    new Map(),
    {
      type: "steps",
      runId: "r1",
      steps: [
        {
          id: "advisor:1:1",
          kind: "advisor",
          advisor: 1,
          model: "a/b",
          output: "Advice",
          state: "done",
        },
        {
          id: "advisor:1:2",
          kind: "advisor",
          advisor: "x",
          output: 3,
          failure: "http-401",
          state: "failed",
        },
        {
          id: "advisor:1:3",
          kind: "advisor",
          advisor: 3,
          failure: "<b>",
          state: "failed",
        },
      ],
      phase: "model",
      quietMs: 0,
    },
    1000,
  );
  const [done, failed, odd] = runs.get("r1").steps;
  assert.deepEqual(done, {
    id: "advisor:1:1",
    kind: "advisor",
    tool: "",
    label: "",
    advisor: 1,
    model: "a/b",
    output: "Advice",
    failure: "",
    state: "done",
  });
  assert.equal(failed.advisor, 0);
  assert.equal(failed.output, "");
  assert.equal(failed.failure, "http-401");
  assert.equal(odd.failure, "error");
});
