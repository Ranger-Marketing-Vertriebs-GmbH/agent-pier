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

test("a replaced run spec is audited with its stage, revision and hash only", () => {
  const sha256 = "a".repeat(64);
  const event = (details) =>
    auditEvent({
      action: "pipeline.updated",
      resourceType: "pipeline",
      resourceId: "run-1",
      source: "user",
      outcome: "success",
      details,
    }).details;
  assert.deepEqual(
    event({ kind: "spec", stageId: "spec", revision: 3, sha256, text: "never" }),
    { kind: "spec", stageId: "spec", revision: 3, sha256 },
  );
  assert.deepEqual(event({ kind: "spec", sha256: "not-a-hash" }), { kind: "spec" });
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

test("agent grant changes after a project merge keep the older project id", () => {
  const event = (details) =>
    auditEvent({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: "agent-1",
      projectId: "b".repeat(64),
      source: "system",
      outcome: "success",
      details,
    });
  const older = "a".repeat(64);
  const kept = event({
    kind: "project-rebind",
    fromProjectId: older,
    revision: 3,
    count: 1,
  });
  assert.equal(kept.projectId, "b".repeat(64));
  assert.deepEqual(kept.details, {
    kind: "project-rebind",
    fromProjectId: older,
    revision: 3,
    count: 1,
  });
  // Other agent events never carry it.
  assert.deepEqual(event({ kind: "shell", fromProjectId: older }).details, {
    kind: "shell",
  });
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
test("agent skill assignments keep valid skill names only", () => {
  const audited = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "a",
    source: "user",
    outcome: "success",
    details: { fields: ["skills"], skills: ["github", "../x", 3, "weather"] },
  });
  assert.deepEqual(audited.details.skills, ["github", "weather"]);
  const tooMany = Array.from({ length: 65 }, (_, i) => `s${i}`);
  assert.equal(
    auditEvent({ ...audited, details: { skills: tooMany } }).details.skills,
    undefined,
  );
});
test("MCP package audits keep registry, name, version, allowScripts and constraints", () => {
  const packageEvent = (action, details) =>
    auditEvent({
      action,
      resourceType: "mcp",
      resourceId: "s1",
      source: "user",
      outcome: "success",
      details,
    });
  for (const action of [
    "package.installed",
    "package.updated",
    "package.reinstalled",
    "package.detached",
  ])
    assert.equal(packageEvent(action, {}).action, action);
  assert.deepEqual(
    packageEvent("package.installed", {
      registry: "pypi",
      name: "mcp-pandoc",
      version: "0.8.1.post1",
      allowScripts: true,
      constraints: ["fastmcp<4", "httpx>=0.27,<1"],
      env: { TOKEN: "secret" },
    }).details,
    {
      registry: "pypi",
      name: "mcp-pandoc",
      version: "0.8.1.post1",
      allowScripts: true,
      constraints: ["fastmcp<4", "httpx>=0.27,<1"],
    },
  );
  assert.deepEqual(
    packageEvent("package.installed", {
      registry: "npm",
      name: "@scope/server-x",
      version: "1.0.0-rc.1",
      allowScripts: false,
      constraints: [],
    }).details,
    {
      registry: "npm",
      name: "@scope/server-x",
      version: "1.0.0-rc.1",
      allowScripts: false,
      constraints: [],
    },
  );
  // Anything that is not a package reference stays out.
  assert.deepEqual(
    packageEvent("package.installed", {
      registry: "git",
      name: "x y",
      version: "1.0; rm -rf",
      allowScripts: "yes",
      constraints: ["a<1", "TOKEN=secret", 3, "x".repeat(101)],
    }).details,
    { constraints: ["a<1"] },
  );
  // Outside an MCP server the package fields are not recorded.
  assert.deepEqual(
    auditEvent({
      action: "setting.updated",
      resourceType: "setting",
      source: "user",
      outcome: "success",
      details: { registry: "npm", name: "x", allowScripts: true, constraints: ["a<1"] },
    }).details,
    {},
  );
});

test("advanced setting audits keep the setting and only its own scalar values", () => {
  const setting = (details) =>
    auditEvent({
      action: "setting.updated",
      resourceType: "setting",
      resourceId: "runTimeout",
      source: "user",
      outcome: "success",
      details,
    }).details;
  assert.deepEqual(setting({ setting: "runTimeout", from: null, to: 3600 }), {
    setting: "runTimeout",
    from: null,
    to: 3600,
  });
  assert.deepEqual(
    setting({ setting: "userTimezone", from: "Europe/Berlin", to: null }),
    {
      setting: "userTimezone",
      from: "Europe/Berlin",
      to: null,
    },
  );
  // A value outside the setting's type, an unknown setting or a path never enters.
  assert.deepEqual(
    setting({ setting: "thinkingDefault", from: "sk-secret", to: "high" }),
    {
      setting: "thinkingDefault",
      to: "high",
    },
  );
  assert.deepEqual(setting({ setting: "runTimeout", from: "3600", to: 1.5 }), {
    setting: "runTimeout",
  });
  assert.deepEqual(setting({ setting: "gateway.auth.token", from: null, to: "x" }), {});
  assert.deepEqual(setting({ path: "agents.defaults.timeoutSeconds", to: 1 }), {});
  assert.throws(() =>
    auditEvent({
      action: "assistant.advancedSettingChanged",
      resourceType: "setting",
      source: "user",
      outcome: "success",
    }),
  );
});

test("MCP package audits keep the longest constraint and version the service accepts", () => {
  const packageEvent = (details) =>
    auditEvent({
      action: "package.installed",
      resourceType: "mcp",
      resourceId: "s1",
      source: "user",
      outcome: "success",
      details,
    });
  // 100 characters: the constraint limit of package-spec.js.
  const line = `helper-x>=${"1.".repeat(43)}1,<2`;
  assert.equal(line.length, 100);
  const npmVersion = `1.0.0-${"a".repeat(200)}`;
  assert.deepEqual(
    packageEvent({ registry: "pypi", name: "srv", version: "1.0", constraints: [line] })
      .details.constraints,
    [line],
  );
  assert.equal(
    packageEvent({ registry: "npm", name: "srv", version: npmVersion }).details.version,
    npmVersion,
  );
  // One character more is dropped: a 101-character line, a 257-character version.
  const longLine = `helper-x>=${"1.".repeat(43)}11,<2`;
  assert.equal(longLine.length, 101);
  assert.deepEqual(
    packageEvent({
      registry: "pypi",
      name: "srv",
      version: "1.0",
      constraints: [longLine],
    }).details.constraints,
    [],
  );
  const longVersion = `1.0.0-${"a".repeat(251)}`;
  assert.equal(longVersion.length, 257);
  assert.equal(
    packageEvent({ registry: "npm", name: "srv", version: longVersion }).details.version,
    undefined,
  );
});

test("MCP create audits keep a known origin only", () => {
  const event = (origin) =>
    auditEvent({
      action: "mcp.created",
      resourceType: "mcp",
      resourceId: "server-1",
      source: "user",
      outcome: "success",
      details: { transport: "http", origin },
    }).details;
  assert.deepEqual(event("paste"), { transport: "http", origin: "paste" });
  assert.deepEqual(event("directory"), { transport: "http", origin: "directory" });
  assert.deepEqual(event("https://evil"), { transport: "http" });
});
