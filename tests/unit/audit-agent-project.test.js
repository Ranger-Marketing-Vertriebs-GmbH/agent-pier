import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { auditAgentProject } from "../../server/features/assistants/assistant-access-audit.js";
import { namedAuditEvents } from "../../server/http/routes/audit.js";
import { auditActor } from "../../web/features/operations/audit-actor.js";
import { withLanguage } from "../../web/lib/i18n/index.js";

test("an agent's project creation is recorded with the agent as actor", () => {
  const e = auditEvent({
    action: "project.created",
    resourceType: "assistant",
    resourceId: "agent-1",
    projectId: "p-1",
    source: "agent",
    outcome: "success",
    details: {
      kind: "agent-project",
      change: "create",
      coding: true,
      git: true,
      path: "/home/x/secret",
      name: "Shop",
    },
  });
  assert.equal(e.source, "agent");
  assert.deepEqual(e.details, {
    kind: "agent-project",
    change: "create",
    coding: true,
    git: true,
  });
  assert.equal(e.projectId, "p-1");
  assert.equal(e.resourceId, "agent-1");
});

test("an agent-project record keeps only known changes and boolean flags", () => {
  const e = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "agent-1",
    projectId: "p-1",
    source: "agent",
    outcome: "success",
    details: { kind: "agent-project", change: "delete", coding: "yes", git: 1 },
  });
  assert.deepEqual(e.details, { kind: "agent-project" });
  // The fields are this kind's own: another kind never carries them.
  const other = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "agent-1",
    source: "user",
    outcome: "success",
    details: { kind: "github-access", change: "create", coding: true, git: true },
  });
  assert.deepEqual(other.details, { kind: "github-access" });
});

test("only the known sources are accepted", () => {
  for (const source of ["user", "system", "mcp", "agent"])
    assert.equal(
      auditEvent({
        action: "assistant.updated",
        resourceType: "assistant",
        source,
        outcome: "success",
      }).source,
      source,
    );
  for (const source of ["owner", "proposal", undefined])
    assert.throws(() =>
      auditEvent({
        action: "assistant.updated",
        resourceType: "assistant",
        source,
        outcome: "success",
      }),
    );
});

test("auditAgentProject records creation and the coding switch with the agent as actor", () => {
  const events = [];
  const services = { audit: { append: (event) => events.push(auditEvent(event)) } };
  auditAgentProject(services, {
    assistantId: "agent-1",
    projectId: "p-1",
    change: "create",
    coding: false,
    git: true,
  });
  auditAgentProject(services, {
    assistantId: "agent-1",
    projectId: "p-1",
    change: "coding",
    coding: true,
  });
  assert.deepEqual(events, [
    {
      action: "project.created",
      resourceType: "assistant",
      resourceId: "agent-1",
      projectId: "p-1",
      source: "agent",
      outcome: "success",
      details: { kind: "agent-project", change: "create", coding: false, git: true },
    },
    {
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: "agent-1",
      projectId: "p-1",
      source: "agent",
      outcome: "success",
      details: { kind: "agent-project", change: "coding", coding: true },
    },
  ]);
});

test("a failing audit store never fails the agent's project change", (t) => {
  const error = t.mock.method(console, "error", () => {});
  const services = {
    audit: {
      append() {
        throw new Error("disk full");
      },
    },
  };
  auditAgentProject(services, {
    assistantId: "agent-1",
    projectId: "p-1",
    change: "create",
    coding: false,
    git: false,
  });
  auditAgentProject({}, { assistantId: "agent-1", projectId: "p-1", change: "coding" });
  assert.equal(error.mock.callCount(), 1);
});

test("the audit log names the agent behind its own entries while it exists", () => {
  const events = [
    { action: "project.created", source: "agent", resourceId: "agent-1" },
    { action: "project.created", source: "agent", resourceId: "agent-gone" },
    { action: "assistant.updated", source: "user", resourceId: "agent-1" },
    { action: "session.created", source: "user", actorUserId: "u1" },
  ];
  const named = namedAuditEvents(events, {
    users: { list: () => [{ id: "u1", displayName: "Ada" }] },
    assistants: { store: { listAssistants: () => [{ id: "agent-1", name: "Scout" }] } },
  });
  assert.deepEqual(named, [
    { ...events[0], agentName: "Scout" },
    { ...events[1], agentName: null },
    events[2],
    { ...events[3], actorName: "Ada" },
  ]);
  // No agent entry on the page: the agents are not read at all.
  const unread = {
    store: {
      listAssistants() {
        throw new Error("read");
      },
    },
  };
  assert.deepEqual(namedAuditEvents([events[2]], { assistants: unread }), [events[2]]);
  assert.deepEqual(namedAuditEvents([events[0]]), [{ ...events[0], agentName: null }]);
});

test("the audit page labels an agent's own entries in both languages", () => {
  const labels = (lang) =>
    withLanguage(lang, () => [
      auditActor({ source: "agent", agentName: "Scout" }),
      auditActor({ source: "agent", agentName: null }),
      auditActor({ source: "user" }),
      auditActor({ source: "mcp" }),
    ]);
  assert.deepEqual(labels("en"), [
    "by agent Scout",
    "by an agent",
    "by you (owner)",
    "MCP",
  ]);
  assert.deepEqual(labels("de"), [
    "vom Agenten Scout",
    "von einem Agenten",
    "von dir (Besitzer)",
    "MCP",
  ]);
});
