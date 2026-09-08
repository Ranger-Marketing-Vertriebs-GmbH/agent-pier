import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { pushPayload } from "../../server/features/notifications/push-validation.js";
test("arbitrary native event content never enters the push payload", () => {
  check(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (untrusted) => {
      const payload = pushPayload({
        ...untrusted,
        kind: "question",
        sessionId: "session-one",
        eventId: "event-one",
      });
      assert.deepEqual(payload, {
        kind: "question",
        sessionId: "session-one",
        eventId: "event-one",
      });
    }),
  );
});
