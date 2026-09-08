import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
const module = await import("../../server/features/audit/audit-schema.js").catch(
  () => ({}),
);
test("arbitrary event detail keys cannot become durable audit content", () => {
  assert.equal(typeof module.auditEvent, "function");
  check(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (details) => {
      const row = module.auditEvent({
        action: "account.updated",
        resourceType: "account",
        resourceId: "account-1",
        source: "user",
        outcome: "success",
        details,
      });
      assert.ok(
        Object.keys(row.details).every((key) =>
          [
            "tool",
            "statusCode",
            "count",
            "revision",
            "version",
            "kind",
            "decision",
          ].includes(key),
        ),
      );
      assert.equal(Object.hasOwn(row, "body"), false);
    }),
  );
});
