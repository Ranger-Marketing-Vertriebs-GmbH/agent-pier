import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const event = (details, source = "system") =>
  auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "agent-1",
    source,
    outcome: "success",
    details,
  }).details;
const hookId = "3f1c2a9e-0000-4000-8000-000000000001";
const hookEventId = "7a2b4c6d-0000-4000-8000-000000000002";

test("a hook delivery audit never keeps payload, secret, authorization or headers", () => {
  const details = event({
    kind: "hook-delivery",
    hookId,
    hookEventId,
    eventKey: "zabbix-4711",
    outcome: "accepted",
    branch: "tailscale",
    size: 812,
    payload: { alert: "disk full" },
    secret: "aph_secret",
    authorization: "Bearer aph_secret",
    headers: { authorization: "Bearer aph_secret" },
  });
  assert.deepEqual(details, {
    kind: "hook-delivery",
    hookId,
    hookEventId,
    eventKey: "zabbix-4711",
    outcome: "accepted",
    branch: "tailscale",
    size: 812,
  });
  assert.equal(JSON.stringify(details).includes("aph_secret"), false);
});

test("a delivery audit drops unknown outcomes, branches and unsafe event keys", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(
    event({ kind: "hook-delivery", hookId, eventKey: hash, outcome: "x", branch: "y" }),
    { kind: "hook-delivery", hookId, eventKey: hash },
  );
  for (const eventKey of ["", "a\nb", "x".repeat(201), 42])
    assert.equal(event({ kind: "hook-delivery", hookId, eventKey }).eventKey, undefined);
  for (const size of [-1, 1.5, "12", Number.MAX_SAFE_INTEGER + 2])
    assert.equal(event({ kind: "hook-delivery", hookId, size }).size, undefined);
  for (const outcome of [
    "accepted",
    "duplicate",
    "throttled",
    "unauthorized",
    "not-found",
    "too-large",
    "invalid",
    "unavailable",
  ])
    assert.equal(event({ kind: "hook-delivery", hookId, outcome }).outcome, outcome);
});

test("a hook change audit keeps the change, the raised right names and the actor", () => {
  assert.deepEqual(
    event(
      {
        kind: "hook",
        hookId,
        change: "update",
        rights: ["shell", "folders", "secret", 3],
        actor: "assistant",
        name: "Zabbix",
        instruction: "never stored",
      },
      "user",
    ),
    {
      kind: "hook",
      hookId,
      change: "update",
      rights: ["shell", "folders"],
      actor: "assistant",
    },
  );
  assert.equal(event({ kind: "hook", hookId, change: "rename" }).change, undefined);
});

test("a hook run's native write keeps via, hook and event ids", () => {
  assert.deepEqual(
    event({ kind: "native-write", via: "hook", hookId, hookEventId, path: "x" }),
    { kind: "native-write", via: "hook", hookId, hookEventId },
  );
  assert.deepEqual(event({ kind: "project-file", via: "hook", hookId, hookEventId }), {
    kind: "project-file",
    via: "hook",
    hookId,
    hookEventId,
  });
});
