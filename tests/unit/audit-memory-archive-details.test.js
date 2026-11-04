import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const event = (verb, details) =>
  auditEvent({
    action: `assistant.${verb}`,
    resourceType: "assistant",
    resourceId: "agent-1",
    outcome: "success",
    source: "user",
    details,
  });

test("an archive and a restore keep their count and file names", () => {
  for (const verb of ["memory-archived", "memory-restored"])
    assert.deepEqual(
      event(verb, { count: 2, files: ["MEMORY.md", "memory/2026-11-01.md"] }).details,
      { count: 2, files: ["MEMORY.md", "memory/2026-11-01.md"] },
    );
});

test("writes no entry text into the audit", () => {
  const details = event("memory-archived", {
    count: 1,
    files: ["MEMORY.md"],
    text: "No keyloggers, not even for the own Mac.",
    entries: [{ file: "MEMORY.md", entry: "No keyloggers" }],
  }).details;
  assert.deepEqual(details, { count: 1, files: ["MEMORY.md"] });
  assert.doesNotMatch(JSON.stringify(details), /keylogger/i);
});

test("drops malformed counts and file names that are no memory file", () => {
  assert.deepEqual(
    event("memory-archived", { count: -1, files: ["No keyloggers, ever."] }).details,
    {},
  );
  assert.deepEqual(
    event("memory-restored", { count: "1", files: ["memory/../secret.md"] }).details,
    {},
  );
});

test("a saved or deleted note keeps its file name, never its text", () => {
  for (const verb of ["memory-saved", "memory-deleted"]) {
    assert.deepEqual(
      event(verb, { files: ["memory/2026-11-01.md"], content: "No keyloggers." }).details,
      { files: ["memory/2026-11-01.md"] },
    );
    assert.deepEqual(event(verb, { files: ["memory/../MEMORY.md"] }).details, {});
  }
});
