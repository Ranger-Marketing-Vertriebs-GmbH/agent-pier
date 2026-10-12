import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const event = (details) =>
  auditEvent({
    action: "setting.updated",
    resourceType: "setting",
    resourceId: "network-access",
    source: "user",
    outcome: "success",
    details,
  });

test("network access details keep the mode, the wildcard bind and the host count", () => {
  assert.deepEqual(event({ enabled: true, bind: "::", count: 3 }).details, {
    enabled: true,
    bind: "::",
    count: 3,
  });
  assert.deepEqual(event({ enabled: false, bind: "0.0.0.0" }).details, {
    enabled: false,
    bind: "0.0.0.0",
  });
  assert.deepEqual(event({ enabled: "yes", bind: "192.168.1.5" }).details, {});
});
test("pipeline override audits keep the stage, overridden reason and path only", () => {
  const event = auditEvent({
    action: "pipeline.overridden",
    resourceType: "pipeline",
    resourceId: "run-1",
    source: "user",
    outcome: "success",
    details: {
      kind: "gate",
      stageId: "stage-1",
      failReason: "verify-failed",
      path: "skips-checks",
      summary: "free text never enters the audit",
    },
  });
  assert.deepEqual(event.details, {
    kind: "gate",
    stageId: "stage-1",
    failReason: "verify-failed",
    path: "skips-checks",
  });
  assert.deepEqual(
    auditEvent({
      action: "pipeline.overridden",
      resourceType: "pipeline",
      source: "user",
      outcome: "success",
      details: { failReason: "Free Text", path: "anything" },
    }).details,
    {},
  );
});

test("assistant shell events keep levels, pending and the entry id only", () => {
  const event = (details) =>
    auditEvent({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: "agent-1",
      source: "user",
      outcome: "success",
      details,
    }).details;
  assert.deepEqual(
    event({ kind: "shell", shellFrom: "full", shellTo: "off", pending: true, count: 2 }),
    { kind: "shell", shellFrom: "full", shellTo: "off", pending: true, count: 2 },
  );
  assert.deepEqual(event({ kind: "allowlist", entryId: "e-1", command: "rm -rf /" }), {
    kind: "allowlist",
    entryId: "e-1",
  });
  assert.deepEqual(event({ shellFrom: "root", shellTo: 1, pending: "yes" }), {});
  assert.throws(() => event({ entryId: "../x" }));
});

test("assistant proactivity events keep the changed names and flags, never a schedule", () => {
  const event = (details) =>
    auditEvent({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: "agent-1",
      source: "user",
      outcome: "success",
      details,
    }).details;
  assert.deepEqual(
    event({
      kind: "proactivity",
      fields: ["heartbeat", "prompt"],
      heartbeat: true,
      timeZone: "Europe/Berlin",
      interval: "1h",
    }),
    { kind: "proactivity", fields: ["heartbeat"], heartbeat: true },
  );
  assert.deepEqual(event({ heartbeat: "yes" }), {});
});

test("exec decisions keep the decision and what AgentPier wrote, never the command", () => {
  const event = (details) =>
    auditEvent({
      action: "assistant.answered",
      resourceType: "assistant",
      resourceId: "agent-1",
      source: "user",
      outcome: "success",
      details,
    }).details;
  const id = "0b9f3c62-3f43-4a8e-9d3b-1c1f5e2c7a10";
  assert.deepEqual(
    event({
      actor: "owner",
      channel: "telegram",
      actionId: "action-1",
      decision: "allow-always",
      revision: 1,
      kind: "exec",
      resolvedAs: "allow-once",
      allowlist: "written",
      allowlistEntryIds: [id, "../bad"],
      command: "rm -rf /",
    }),
    {
      actor: "owner",
      channel: "telegram",
      actionId: "action-1",
      decision: "allow-always",
      revision: 1,
      kind: "exec",
      resolvedAs: "allow-once",
      allowlist: "written",
      allowlistEntryIds: [id],
    },
  );
  assert.deepEqual(
    event({
      kind: "exec",
      decision: "allow-once",
      allowlist: "skipped",
      allowlistReason: "interpreter",
    }),
    {
      kind: "exec",
      decision: "allow-once",
      allowlist: "skipped",
      allowlistReason: "interpreter",
    },
  );
  assert.deepEqual(
    event({ decision: "deny", allowlist: "failed", allowlistError: "INVALID_REQUEST" }),
    { decision: "deny", allowlist: "failed", allowlistError: "INVALID_REQUEST" },
  );
  assert.deepEqual(
    event({
      resolvedAs: "allow-always",
      allowlist: "maybe",
      allowlistReason: "free text",
      allowlistError: "a message with spaces",
      allowlistEntryIds: "x",
    }),
    {},
  );
});

test("MCP server audits keep the transport, known field names and the confirmation only", () => {
  const event = auditEvent({
    action: "mcp.updated",
    resourceType: "mcp",
    resourceId: "server-1",
    source: "user",
    outcome: "success",
    details: {
      transport: "stdio",
      fields: ["args", "env", "secretField", "headers"],
      stdioConfirmed: true,
      url: "https://x.invalid/?token=secret",
    },
  });
  assert.deepEqual(event.details, {
    transport: "stdio",
    fields: ["args", "env", "headers"],
    stdioConfirmed: true,
  });
  assert.deepEqual(
    auditEvent({
      action: "mcp.updated",
      resourceType: "mcp",
      source: "user",
      outcome: "success",
      details: { transport: "ftp", fields: "args", stdioConfirmed: "yes" },
    }).details,
    {},
  );
});

test("MCP CLI audits keep the CLIs, the conflict choice and adoption only", () => {
  const base = {
    action: "mcp.updated",
    resourceType: "mcp",
    resourceId: "s1",
    source: "user",
    outcome: "success",
  };
  const event = auditEvent({
    ...base,
    details: {
      fields: ["clis", "secret"],
      clis: ["claude", "gemini", "codex"],
      resolution: "adopt",
      adopted: true,
      url: "https://x.example.test/mcp",
      headers: { Authorization: "Bearer value" },
    },
  });
  assert.deepEqual(event.details, {
    fields: ["clis"],
    clis: ["claude", "codex"],
    resolution: "adopt",
    adopted: true,
  });
  assert.equal(
    auditEvent({ ...base, details: { resolution: "delete" } }).details.resolution,
    undefined,
  );
  assert.equal(
    auditEvent({
      ...base,
      resourceType: "assistant",
      action: "assistant.updated",
      details: { clis: ["claude"] },
    }).details.clis,
    undefined,
  );
});
