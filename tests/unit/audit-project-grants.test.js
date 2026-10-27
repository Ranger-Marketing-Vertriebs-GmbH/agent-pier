import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const event = (details) =>
  auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "agent",
    source: "user",
    outcome: "success",
    details: { kind: "project-grants", ...details },
  }).details;

test("project grant audits keep only valid project ids and levels", () => {
  const details = event({
    revision: 3,
    added: ["p1", "../p2", "p 3", 7, "p4"],
    removed: ["p5", " p6"],
    sessionsAdded: ["p1", "../x"],
    sessionsRemoved: "p4",
    folderChanged: [
      { projectId: "p1", from: "none", to: "write" },
      { projectId: "p1", from: "none", to: "admin" },
      { projectId: "bad id", from: "read", to: "none" },
      { projectId: "p4", from: "read", to: "none", path: "/secret" },
      "p7",
    ],
  });
  assert.deepEqual(details, {
    kind: "project-grants",
    revision: 3,
    added: ["p1", "p4"],
    removed: ["p5"],
    sessionsAdded: ["p1"],
    sessionsRemoved: [],
    folderChanged: [
      { projectId: "p1", from: "none", to: "write" },
      { projectId: "p4", from: "read", to: "none" },
    ],
  });
});

test("project grant audits drop lists above 100 entries", () => {
  const many = Array.from({ length: 101 }, (_, i) => `p${i}`);
  const details = event({
    added: many,
    folderChanged: many.map((projectId) => ({ projectId, from: "none", to: "read" })),
  });
  assert.deepEqual(details.added, []);
  assert.equal(details.folderChanged, undefined);
});
