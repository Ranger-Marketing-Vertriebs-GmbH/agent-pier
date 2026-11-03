import test from "node:test";
import assert from "node:assert/strict";
import { sequenceInput } from "../../server/features/tickets/ticket-start-input.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const ticket = (n) => ({ source: "github", key: `o/r#${n}` });
const base = (extra = {}) => ({
  tickets: [ticket(1), ticket(2)],
  kind: "session",
  allowMerge: false,
  ...extra,
});
const rejects = (input) =>
  assert.throws(() => sequenceInput(input), {
    message: serverMessages.tickets.invalidSequence,
    status: 400,
  });

test("sequenceInput accepts a session sequence and strips cwd and ticket", () => {
  const out = sequenceInput(
    base({ session: { tool: "claude", cwd: "/x", ticket: {} }, again: true }),
  );
  assert.deepEqual(out.tickets, [ticket(1), ticket(2)]);
  assert.deepEqual(out.session, { tool: "claude" });
  assert.equal(out.again, true);
  assert.equal(out.allowMerge, false);
});

test("sequenceInput accepts a pipeline sequence with a repair session", () => {
  const out = sequenceInput(
    base({
      kind: "pipeline",
      pipeline: { pipelineId: "p1" },
      repair: { tool: "claude", launchMode: "normal" },
    }),
  );
  assert.deepEqual(out.pipeline, { pipelineId: "p1" });
  assert.deepEqual(out.repair, { tool: "claude", launchMode: "normal" });
});

test("sequenceInput rejects", () => {
  rejects(base({ tickets: [] }));
  rejects(base({ tickets: Array.from({ length: 51 }, (_, i) => ticket(i + 1)) }));
  rejects(base({ tickets: [ticket(1), ticket(1)] }));
  rejects(base({ tickets: [ticket(1), { source: "github", key: "nope" }] }));
  rejects(base({ repair: { tool: "claude" } }));
  rejects(
    base({ kind: "pipeline", pipeline: { pipelineId: "p" }, repair: { cwd: "/x" } }),
  );
  rejects(base({ allowMerge: "yes" }));
  rejects(base({ allowMerge: undefined }));
  rejects(base({ kind: "other" }));
  rejects(null);
});

test("sequenceInput accepts 50 tickets", () => {
  const tickets = Array.from({ length: 50 }, (_, i) => ticket(i + 1));
  assert.equal(sequenceInput(base({ tickets })).tickets.length, 50);
});
