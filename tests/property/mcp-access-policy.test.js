import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { requireRun } from "../../server/features/mcp/tool-policy.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

test("every frozen stage and its central connection must remain in the grant", () => {
  check(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (projectAllowed, firstAllowed, secondAllowed, connectionAllowed) => {
        const grant = {
          projectIds: projectAllowed ? ["project"] : [],
          accountIds: [
            ...(firstAllowed ? ["first"] : []),
            ...(secondAllowed ? ["second"] : []),
          ],
          connectionIds: connectionAllowed ? ["provider"] : [],
        };
        const run = {
          projectId: "project",
          nodes: [
            { profileSnapshot: { config: { accountId: "first" } } },
            {
              profileSnapshot: {
                config: { accountId: "second", providerConnectionId: "provider" },
              },
            },
          ],
        };
        if (projectAllowed && firstAllowed && secondAllowed && connectionAllowed)
          assert.doesNotThrow(() => requireRun(grant, run));
        else
          assert.throws(
            () => requireRun(grant, run),
            (error) => error.status === 403,
          );
      },
    ),
  );
});

test("MCP audit events retain actor identities but cannot persist arbitrary request details", () => {
  check(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (details) => {
      const event = auditEvent({
        action: "pipeline.started",
        resourceType: "pipeline",
        source: "mcp",
        outcome: "success",
        details: { ...details, grantId: "grant-one", clientId: "client-one" },
      });
      assert.equal(event.details.grantId, "grant-one");
      assert.equal(event.details.clientId, "client-one");
      const permitted = new Set([
        "grantId",
        "clientId",
        "tool",
        "kind",
        "decision",
        "statusCode",
        "count",
        "revision",
        "version",
      ]);
      assert.ok(Object.keys(event.details).every((key) => permitted.has(key)));
      assert.equal(Object.hasOwn(event, "token"), false);
    }),
  );
});
