import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { itemHistory } from "../../server/features/inbox/inbox-history.js";

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-history-"));
  const clock = { time: Date.parse("2026-10-16T08:00:00.000Z"), now: () => clock.time };
  const audit = new AuditStore({ dataDir, clock });
  t.after(() => {
    audit.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { audit, clock };
}
const hours = (n) => n * 3600000;

test("a stale link shows a decision for a day, from the audit log", (t) => {
  const { audit, clock } = setup(t);
  audit.append({
    action: "request.answered",
    resourceType: "request",
    resourceId: "old-request",
    source: "user",
    outcome: "success",
    details: { kind: "permission", decision: "allow" },
  });
  // Many unrelated events in between: the window search must still find the record.
  for (let n = 0; n < 50; n++) {
    clock.time += hours(1);
    audit.append({
      action: "session.started",
      resourceType: "session",
      resourceId: `s${n}`,
      source: "user",
      outcome: "success",
    });
  }
  audit.append({
    action: "assistant.answered",
    resourceType: "assistant",
    resourceId: "agent-1",
    source: "user",
    outcome: "success",
    details: { actionId: "action-1", decision: "allow-once", channel: "telegram" },
  });
  audit.append({
    action: "request.answered",
    resourceType: "request",
    resourceId: "failed-request",
    source: "user",
    outcome: "failure",
  });
  const now = clock.time + hours(2);
  assert.deepEqual(itemHistory(audit, "action", "action-1", now), {
    state: "done",
    outcome: "answered",
    at: new Date(clock.time).toISOString(),
    decision: "allow-once",
    channel: "telegram",
  });
  // Older than a day, failed, or never audited: no longer waiting, without detail.
  assert.deepEqual(itemHistory(audit, "question", "old-request", now), { state: "gone" });
  assert.deepEqual(itemHistory(audit, "approval", "failed-request", now), {
    state: "gone",
  });
  assert.deepEqual(itemHistory(audit, "team", "action-1", now + hours(25)), {
    state: "gone",
  });
  assert.deepEqual(itemHistory(audit, "nothing", "x", now), { state: "gone" });
  assert.equal(audit.firstSince(new Date(now + hours(1)).toISOString()), null);
});

test("a gate counts as done only by the owner's decision, not by entering the wait", (t) => {
  const { audit, clock } = setup(t);
  audit.append({
    action: "pipeline.updated",
    resourceType: "pipeline",
    resourceId: "run-1",
    source: "system",
    outcome: "success",
    details: { kind: "gate" },
  });
  assert.deepEqual(itemHistory(audit, "gate", "run-1", clock.time), { state: "gone" });
  clock.time += 1000;
  audit.append({
    action: "pipeline.updated",
    resourceType: "pipeline",
    resourceId: "run-1",
    source: "user",
    outcome: "success",
    details: { statusCode: 200 },
  });
  assert.equal(itemHistory(audit, "gate", "run-1", clock.time).state, "done");
  clock.time += 1000;
  audit.append({
    action: "request.expired",
    resourceType: "request",
    resourceId: "closed-request",
    source: "system",
    outcome: "success",
  });
  assert.equal(
    itemHistory(audit, "question", "closed-request", clock.time).outcome,
    "closed",
  );
});

test("an unreadable audit log still answers that the item no longer waits", () => {
  const audit = {
    recent() {
      throw Error("locked");
    },
  };
  assert.deepEqual(itemHistory(audit, "gate", "run-1"), { state: "gone" });
  assert.deepEqual(itemHistory(null, "gate", "run-1"), { state: "gone" });
});
