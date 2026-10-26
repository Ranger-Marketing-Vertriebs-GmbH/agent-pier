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

test("an agent check-in push names only the agent", () => {
  check(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (untrusted) => {
      assert.deepEqual(
        pushPayload({
          ...untrusted,
          kind: "agent-checkin",
          assistantId: "agent-one",
          eventId: "event-one",
        }),
        { kind: "agent-checkin", assistantId: "agent-one", eventId: "event-one" },
      );
    }),
  );
});

test("a routine push names only the agent and the chat it opens", () => {
  check(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (untrusted) => {
      assert.deepEqual(
        pushPayload({
          ...untrusted,
          kind: "agent-routine",
          assistantId: "agent-one",
          conversationId: "chat-one",
          eventId: "event-one",
        }),
        {
          kind: "agent-routine",
          assistantId: "agent-one",
          conversationId: "chat-one",
          eventId: "event-one",
        },
      );
    }),
  );
  assert.throws(() =>
    pushPayload({
      kind: "agent-routine",
      assistantId: "agent-one",
      conversationId: "../settings",
      eventId: "event-one",
    }),
  );
});

test("a hook throttle push names only the agent and the chat it opens", () => {
  check(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (untrusted) => {
      assert.deepEqual(
        pushPayload({
          ...untrusted,
          kind: "agent-hook-throttled",
          assistantId: "agent-one",
          conversationId: "chat-one",
          eventId: "hook-throttled-one",
        }),
        {
          kind: "agent-hook-throttled",
          assistantId: "agent-one",
          conversationId: "chat-one",
          eventId: "hook-throttled-one",
        },
      );
    }),
  );
  assert.throws(() =>
    pushPayload({ kind: "agent-hook-throttled", eventId: "hook-throttled-one" }),
  );
});

test("a Telegram revocation alert carries only its kind, event and agent", () => {
  check(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (untrusted) => {
      const payload = pushPayload({
        ...untrusted,
        kind: "telegram-revocation",
        eventId: "event-one",
        assistantId: "agent-one",
      });
      assert.deepEqual(payload, {
        kind: "telegram-revocation",
        eventId: "event-one",
        assistantId: "agent-one",
      });
    }),
  );
  assert.deepEqual(pushPayload({ kind: "telegram-revocation", eventId: "e1" }), {
    kind: "telegram-revocation",
    eventId: "e1",
  });
  assert.throws(() =>
    pushPayload({ kind: "telegram-revocation", eventId: "e1", assistantId: "../x" }),
  );
});

test("GitHub token notices carry only their kind and event id", () => {
  assert.deepEqual(
    pushPayload({ kind: "github-token", eventId: "e1", sessionId: "s1" }),
    { kind: "github-token", eventId: "e1" },
  );
});

test("low disk notices carry only their kind and event id", () => {
  assert.deepEqual(pushPayload({ kind: "disk-space", eventId: "e1", sessionId: "s1" }), {
    kind: "disk-space",
    eventId: "e1",
  });
});
