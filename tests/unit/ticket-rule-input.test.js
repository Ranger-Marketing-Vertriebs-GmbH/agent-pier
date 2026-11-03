import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { ruleInput } from "../../server/features/tickets/rule-input.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const base = (extra = {}) => ({
  source: "github",
  label: " agent ",
  kind: "session",
  allowMerge: false,
  session: { tool: "claude", accountId: "a1" },
  ...extra,
});
const rejects = (input) =>
  assert.throws(() => ruleInput(input), {
    message: serverMessages.tickets.invalidRule,
    status: 400,
  });

test("ruleInput accepts a session rule", () => {
  const out = ruleInput(base());
  assert.equal(out.label, "agent");
  assert.equal(out.paused, false);
  assert.equal(out.kind, "session");
  assert.equal(out.options.allowMerge, false);
  assert.deepEqual(out.options.session, { tool: "claude", accountId: "a1" });
});

test("ruleInput accepts a pipeline rule with repair and paused", () => {
  const out = ruleInput(
    base({
      source: "plane",
      kind: "pipeline",
      session: undefined,
      pipeline: { pipelineId: "p1" },
      repair: { tool: "claude" },
      paused: true,
    }),
  );
  assert.equal(out.paused, true);
  assert.deepEqual(out.options.pipeline, { pipelineId: "p1" });
  assert.deepEqual(out.options.repair, { tool: "claude" });
});

test("ruleInput requires an explicit allowMerge boolean", () => {
  rejects(base({ allowMerge: undefined }));
  rejects(base({ allowMerge: "yes" }));
});

test("ruleInput refuses repair on a session rule", () => {
  rejects(base({ repair: { tool: "claude" } }));
});

test("ruleInput refuses labels with a comma, control characters or 51 characters", () => {
  rejects(base({ label: "a,b" }));
  rejects(base({ label: "a\nb" }));
  rejects(base({ label: "x".repeat(51) }));
  rejects(base({ label: "   " }));
  assert.equal(ruleInput(base({ label: "x".repeat(50) })).label.length, 50);
});

test("ruleInput refuses an unknown source, kind or paused value", () => {
  rejects(base({ source: "jira" }));
  rejects(base({ kind: "other" }));
  rejects(base({ paused: "no" }));
  rejects(null);
});

test("ruleInput strips session cwd and ticket", () => {
  const out = ruleInput(
    base({ session: { tool: "claude", cwd: "/etc", ticket: { key: "x" } } }),
  );
  assert.ok(!("cwd" in out.options.session));
  assert.ok(!("ticket" in out.options.session));
});

test("ruleInput never returns unknown top-level keys", () => {
  fc.assert(
    fc.property(fc.dictionary(fc.string(), fc.anything()), (extra) => {
      try {
        const out = ruleInput({ ...extra, ...base() });
        assert.ok(
          Object.keys(out).every((k) =>
            ["source", "label", "kind", "paused", "options"].includes(k),
          ),
        );
      } catch (error) {
        assert.equal(error.status, 400);
      }
    }),
  );
});
