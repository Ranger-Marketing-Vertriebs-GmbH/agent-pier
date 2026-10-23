import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const event = (details) =>
  auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "member",
    source: "system",
    outcome: "success",
    details,
  }).details;

test("a lead routine audit keeps ids, change, actor, reason and edited fields only", () => {
  assert.deepEqual(
    event({
      kind: "lead-routine",
      routineId: "routine-1",
      leadAssistantId: "lead",
      change: "remove",
      by: "system",
      reason: "member-archived",
      edited: ["name", "prompt", "secret"],
      prompt: "never stored",
    }),
    {
      kind: "lead-routine",
      leadAssistantId: "lead",
      routineId: "routine-1",
      change: "remove",
      by: "system",
      reason: "member-archived",
      edited: ["name", "prompt"],
    },
  );
  assert.deepEqual(event({ kind: "lead-routine", change: "explode", by: "owner" }), {
    kind: "lead-routine",
  });
});

test("writes name how they were authorized: a lead share, a member result or a completion", () => {
  assert.deepEqual(
    event({
      kind: "native-write",
      tool: "write",
      filePath: "notes/plan.md",
      via: "member-result",
      leadRequestId: "request-1",
    }),
    {
      kind: "native-write",
      tool: "write",
      filePath: "notes/plan.md",
      via: "member-result",
      leadRequestId: "request-1",
    },
  );
  const file = event({
    kind: "project-file",
    fileChange: "edit",
    filePath: "a.md",
    via: "lead-share",
    leadRequestId: "request-2",
  });
  assert.equal(file.via, "lead-share");
  assert.equal(file.leadRequestId, "request-2");
  // A command's completion run names the owner turn that started the command.
  for (const kind of ["native-write", "project-file"])
    assert.deepEqual(
      event({
        kind,
        tool: "write",
        filePath: "notes/render.md",
        via: "exec-completion",
        sourceAttemptId: "attempt-1",
      }),
      {
        kind,
        ...(kind === "native-write" ? { tool: "write" } : {}),
        filePath: "notes/render.md",
        via: "exec-completion",
        sourceAttemptId: "attempt-1",
      },
    );
  assert.equal(
    event({ kind: "native-write", via: "owner", filePath: "a\nb" }).via,
    undefined,
  );
  assert.equal(event({ kind: "native-write", filePath: "a\nb" }).filePath, undefined);
});

test("an image view of a project file keeps the view, path and size, never content", () => {
  assert.deepEqual(
    event({
      kind: "project-file",
      fileView: "image",
      filePath: "shots/home.png",
      bytes: 68,
      data: "never stored",
      mimeType: "image/png",
    }),
    { kind: "project-file", fileView: "image", filePath: "shots/home.png", bytes: 68 },
  );
  assert.deepEqual(event({ kind: "project-file", fileView: "video" }), {
    kind: "project-file",
  });
});

test("a lead share keeps its change, actor, reason and shared capabilities", () => {
  assert.deepEqual(
    event({
      kind: "lead-share",
      change: "revoke",
      by: "system",
      reason: "lead-lost",
      leadAssistantId: "lead",
      capabilities: ["documents", "shell"],
    }),
    {
      kind: "lead-share",
      leadAssistantId: "lead",
      change: "revoke",
      by: "system",
      reason: "lead-lost",
      capabilities: ["documents"],
    },
  );
});

test("a lead share keeps the member, task, project levels and server ids", () => {
  assert.deepEqual(
    event({
      kind: "lead-share",
      change: "grant",
      by: "lead",
      leadAssistantId: "lead",
      memberId: "member-1",
      requestId: "request-1",
      projects: [
        { projectId: "p1", coding: true, folder: "write", name: "never stored" },
        { projectId: "p2", coding: false, folder: "none", removed: true },
        { projectId: "../bad", coding: true, folder: "write" },
        { projectId: "p3", coding: "yes", folder: "admin" },
      ],
      mcpServerIds: ["s1", "bad id"],
      capabilities: [],
    }),
    {
      kind: "lead-share",
      leadAssistantId: "lead",
      change: "grant",
      by: "lead",
      memberId: "member-1",
      requestId: "request-1",
      projects: [
        { projectId: "p1", coding: true, folder: "write" },
        { projectId: "p2", coding: false, folder: "none", removed: true },
        { projectId: "p3", coding: false, folder: "none" },
      ],
      mcpServerIds: ["s1"],
      capabilities: [],
    },
  );
});
