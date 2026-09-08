import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  requestValue,
  answerValue,
} from "../../server/features/requests/request-validation.js";
import { codexRequest } from "../../server/features/requests/codex-protocol.js";

test("arbitrary browser answer shapes cannot escape permission choices or question cardinality", () => {
  const permission = {
    kind: "permission",
    options: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  };
  check(
    fc.property(fc.jsonValue(), (value) => {
      try {
        const result = answerValue(permission, value);
        assert.ok(["allow", "deny"].includes(result.choice));
        assert.deepEqual(Object.keys(result), ["choice"]);
      } catch (error) {
        assert.equal(error.status, 400);
      }
    }),
  );
});
test("native RPC string IDs and arbitrary free text round-trip without coercion or question loss", () => {
  check(
    fc.property(
      fc.string({ maxLength: 100 }),
      fc.string({ maxLength: 300 }),
      (id, answer) => {
        const request = codexRequest({
          id,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread",
            questions: [
              {
                id: "native#one",
                question: "Choose?",
                isOther: true,
                options: [{ label: "One", description: "" }],
              },
              { id: "native#two", question: "Notes?", isOther: true, options: null },
            ],
          },
        });
        assert.deepEqual(request.answer({ answers: { q0: [answer], q1: ["second"] } }), {
          id,
          result: {
            answers: {
              "native#one": { answers: [answer] },
              "native#two": { answers: ["second"] },
            },
          },
        });
      },
    ),
  );
});
test("arbitrary native payloads cannot leak unknown metadata keys into public requests", () => {
  check(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (extra) => {
      const parsed = requestValue({
        ...extra,
        kind: "permission",
        options: [{ id: "deny", label: "Deny" }],
        subject: { ...extra, tool: "fixture" },
      });
      assert.ok(
        Object.keys(parsed).every((key) => ["kind", "subject", "options"].includes(key)),
      );
      assert.ok(
        Object.keys(parsed.subject).every((key) =>
          ["tool", "command", "path", "cwd", "description"].includes(key),
        ),
      );
    }),
  );
});
