import test from "node:test";
import assert from "node:assert/strict";
import {
  Compactions,
  nextCompaction,
} from "../../server/features/assistants/compactions.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
import { headerStatus } from "../../web/features/assistants/assistant-status.js";
import { compactionNoteText } from "../../web/features/assistants/compaction-note.js";
import { assistantCopy as de } from "../../web/lib/i18n/de/assistants.js";
import { assistantCopy as en } from "../../web/lib/i18n/en/assistants.js";

// Gateway `agent` events as OpenClaw 2026.10.3 sends them (the gated contract in
// tests/integration/assistant-compaction-contract.test.js records the real ones).
const key = "agent:ap-home:dashboard:chat";
const status = (phase, runId = "run-1", sessionKey = key) => ({
  stream: "run_status",
  runId,
  sessionKey,
  data: { phase },
});
const compaction = (data, runId = "run-1") => ({
  stream: "compaction",
  runId,
  sessionKey: key,
  data,
});
const lifecycle = (phase, runId = "run-1") => ({
  stream: "lifecycle",
  runId,
  sessionKey: key,
  data: { phase },
});

test("run phases map to the compaction status of the session", () => {
  const flushing = nextCompaction(null, status("memory_flushing"));
  assert.deepEqual(flushing, { runId: "run-1", stage: "flushing" });
  // The flush ends with preparing_context right before the compaction model call.
  const compacting = nextCompaction(flushing, status("preparing_context"));
  assert.deepEqual(compacting, { runId: "run-1", stage: "compacting" });
  // The run itself starts preparing its workspace once the history is short again.
  assert.equal(nextCompaction(compacting, status("preparing_workspace")), null);
  assert.equal(nextCompaction(compacting, status("starting_model")), null);
  // preparing_context on its own is an ordinary run start.
  assert.equal(nextCompaction(null, status("preparing_context")), null);
  assert.equal(
    nextCompaction(flushing, status("preparing_context", "run-2")),
    null,
    "another run's context step ends the flush of the first",
  );
  // In a run: the `compaction` stream.
  const started = nextCompaction(null, compaction({ phase: "start" }));
  assert.deepEqual(started, { runId: "run-1", stage: "compacting" });
  assert.deepEqual(
    nextCompaction(
      started,
      compaction({ phase: "end", completed: true, willRetry: true }),
    ),
    started,
    "a retried compaction keeps going",
  );
  assert.equal(
    nextCompaction(started, compaction({ phase: "end", completed: true })),
    null,
  );
  assert.equal(
    nextCompaction(started, compaction({ phase: "end", completed: false })),
    null,
  );
  // A run that ends or fails ends its compaction too; other events change nothing.
  assert.equal(nextCompaction(started, lifecycle("end")), null);
  assert.equal(nextCompaction(started, lifecycle("error")), null);
  assert.equal(nextCompaction(started, lifecycle("start")), started);
  assert.equal(nextCompaction(started, { stream: "assistant", data: {} }), started);
  assert.equal(nextCompaction(null, status("memory_flushing", 42)), null, "no run id");
});

test("the tracker reports a change only when a session starts or stops compacting", () => {
  let now = 1000;
  const tracker = new Compactions({ now: () => now });
  assert.equal(tracker.observe(status("memory_flushing")), true);
  assert.equal(tracker.active(key), true);
  assert.equal(tracker.observe(status("preparing_context")), false, "still summarising");
  assert.equal(tracker.active(key), true);
  assert.equal(tracker.observe({ stream: "tool", sessionKey: key, data: {} }), false);
  assert.equal(tracker.active("agent:other:main"), false);
  assert.equal(tracker.observe(status("preparing_workspace")), true);
  assert.equal(tracker.active(key), false);
  assert.equal(tracker.observe(status("starting_model")), false);
  assert.equal(tracker.observe({ stream: "run_status", data: {} }), false, "no session");
  assert.equal(tracker.observe(null), false);
  // A status whose end never arrived expires.
  tracker.observe(compaction({ phase: "start" }));
  now += 61 * 60000;
  assert.equal(tracker.active(key), false);
  tracker.observe(compaction({ phase: "start" }));
  tracker.clear();
  assert.equal(tracker.active(key), false);
});

test("compaction markers of the history become chat notes in their place", () => {
  const history = [
    { role: "user", content: "Hi", timestamp: 1, __openclaw: { id: "u1" } },
    {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      timestamp: 2,
      __openclaw: {
        kind: "compaction",
        id: "c1",
        tokensBefore: 251400,
        tokensAfter: 18200,
      },
    },
    {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      timestamp: 3,
      __openclaw: { kind: "compaction", id: "c2", tokensBefore: "many" },
    },
    { role: "system", content: "Reset", timestamp: 4, __openclaw: { kind: "reset" } },
    { role: "assistant", content: "Hello", timestamp: 5, __openclaw: { id: "a1" } },
  ];
  assert.deepEqual(
    publicMessages(history).map((m) => m.id),
    ["u1", "a1"],
    "other readers keep only the turns",
  );
  const shown = publicMessages(history, { compactions: true });
  assert.deepEqual(
    shown.map((m) => m.id),
    ["u1", "compaction:c1", "compaction:c2", "a1"],
  );
  assert.deepEqual(shown[1], {
    id: "compaction:c1",
    role: "event",
    event: "compaction",
    tokensBefore: 251400,
    tokensAfter: 18200,
    timestamp: 2,
    runId: null,
  });
  assert.deepEqual(shown[2], {
    id: "compaction:c2",
    role: "event",
    event: "compaction",
    tokensBefore: null,
    tokensAfter: null,
    timestamp: 3,
    runId: null,
  });
});

test("the compaction note rounds to thousands and has a plain form", () => {
  const note = (tokensBefore, tokensAfter) => ({ tokensBefore, tokensAfter });
  assert.equal(
    compactionNoteText(en, note(251400, 18200)),
    "Earlier messages were summarised (about 251k → 18k tokens).",
  );
  assert.equal(
    compactionNoteText(de, note(251400, 18200)),
    "Ältere Nachrichten wurden zusammengefasst (etwa 251k → 18k Tokens).",
  );
  assert.equal(
    compactionNoteText(en, note(31050, 867)),
    "Earlier messages were summarised (about 31k → 1k tokens).",
  );
  assert.equal(
    compactionNoteText(en, note(31050, null)),
    "Earlier messages were summarised.",
  );
  assert.equal(
    compactionNoteText(de, note()),
    "Ältere Nachrichten wurden zusammengefasst.",
  );
});

test("the header says the agent is summarising while its run compacts", () => {
  const input = {
    assistant: { id: "home", model: { connectionId: "router", modelId: "gpt-x" } },
    models: [{ id: "router" }],
    runtime: { availability: "ready" },
    attempt: { state: "running" },
    entry: null,
    member: null,
  };
  assert.deepEqual(headerStatus({ ...input, copy: en, compacting: true }), {
    tone: "working",
    label: "Summarising conversation",
  });
  assert.deepEqual(headerStatus({ ...input, copy: de, compacting: true }), {
    tone: "working",
    label: "Fasst Verlauf zusammen",
  });
  assert.equal(headerStatus({ ...input, copy: en }).label, "Working");
  // An unclear outcome is not hidden behind a summary that may be over.
  assert.equal(
    headerStatus({
      ...input,
      attempt: { state: "uncertain" },
      copy: en,
      compacting: true,
    }).label,
    "Outcome unknown",
  );
  assert.equal(
    en.compaction.running,
    "Summarising the conversation so far — this can take a few minutes for long chats.",
  );
  assert.equal(
    de.compaction.running,
    "Fasst den bisherigen Verlauf zusammen – bei langen Chats kann das ein paar Minuten dauern.",
  );
});

test("the tracker names the run and forgets a status another run replaced", () => {
  let now = 1000;
  const tracker = new Compactions({ now: () => now });
  tracker.observe(status("memory_flushing"));
  assert.equal(tracker.run(key), "run-1");
  assert.equal(tracker.run("agent:other:main"), null);
  // The flush's end was lost (cancelled run); the next run's first event ends it.
  assert.equal(tracker.observe(lifecycle("start", "run-2")), true);
  assert.equal(tracker.run(key), null);
  // A different run that flushes replaces the old one at once.
  tracker.observe(status("memory_flushing"));
  assert.equal(tracker.observe(status("memory_flushing", "run-3")), false);
  assert.equal(tracker.run(key), "run-3");
  // Expired entries leave on any event, also those of sessions nobody reads.
  tracker.observe(
    status("memory_flushing", "run-4", "agent:x:internal-session-effects:a"),
  );
  now += 61 * 60000;
  tracker.observe({ stream: "tool", sessionKey: "agent:elsewhere:main", data: {} });
  assert.equal(tracker.running.size, 0);
});
