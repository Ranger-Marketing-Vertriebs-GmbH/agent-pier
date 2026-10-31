import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildPayload } from "../../server/features/notifications/push-content.js";
import {
  defaultPreferences,
  pushLevels,
} from "../../server/features/notifications/push-preferences.js";
import {
  approvalSubjects,
  pushEvent,
  pushKinds,
  pushMessage,
} from "../../server/features/notifications/push-validation.js";

const scope = {};
const context = vm.createContext({ self: scope });
for (const name of ["pwa-de.js", "pwa-en.js", "pwa-render.js"])
  vm.runInContext(
    fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8"),
    context,
  );
const worker = scope.agentPierNotificationRender;

const names = { label: "api-refactor", tool: "claude", project: "shop", stage: "Tests" };
// One event per kind, as its emitter sends it: with and without an inbox item and a
// chat, so every link pushLink builds is covered.
const events = {
  permission: [
    {
      sessionId: "s1",
      inbox: { type: "approval", id: "r1" },
      toolName: "Bash",
      decide: "both",
      revision: 2,
    },
  ],
  question: [{ sessionId: "s1", inbox: { type: "question", id: "r1" }, preview: "Why?" }],
  "session-ended": [{ sessionId: "s1" }],
  "session-completed": [{ sessionId: "s1", preview: "Done." }],
  "session-waiting": [{ sessionId: "s1" }],
  "pipeline-gate": [{ runId: "run1", inbox: { type: "gate", id: "run1" } }],
  "pipeline-completed": [{ runId: "run1" }],
  "pipeline-failed": [{ runId: "run1" }],
  "agent-approval": approvalSubjects.flatMap((subject) => [
    {
      assistantId: "a1",
      conversationId: "c1",
      subject,
      inbox: { type: subject === "team" ? "team" : "action", id: "x1" },
      decide: "deny",
      revision: 1,
    },
    // A user's approval opens their chat, never the owner's inbox.
    { assistantId: "a1", conversationId: "c1", subject },
  ]),
  "agent-checkin": [{ assistantId: "a1", conversationId: "c1" }, { assistantId: "a1" }],
  "agent-routine": [{ assistantId: "a1", conversationId: "c1" }],
  "agent-reminder": [{ assistantId: "a1", conversationId: "c1" }],
  "agent-hook-throttled": [{ assistantId: "a1", conversationId: "c1" }],
  "telegram-revocation": [{ assistantId: "a1" }, {}],
  "github-token": [{}],
  "disk-space": [{}],
  "session-limited": [{ sessionId: "s1", preview: "You've hit your limit · resets 4pm" }],
  "session-resume-failed": [{ sessionId: "s1" }],
  "update-available": [{ label: "2.13.0" }],
  "update-failed": [{}],
  test: [{}],
};

test("every kind the server sends has an emitter-shaped fixture here", () => {
  assert.deepEqual(Object.keys(events).sort(), [...pushKinds].sort());
});

test("every kind's payload passes the final check at every level and opens its link", () => {
  for (const kind of pushKinds)
    for (const fields of events[kind]) {
      const event = pushEvent({ kind, eventId: "event-1", ...names, ...fields });
      for (const level of pushLevels)
        for (const grouping of [true, false]) {
          const payload = buildPayload(
            event,
            { ...defaultPreferences(), level, grouping },
            { count: 4 },
          );
          const message = `${kind} ${JSON.stringify(fields)} at ${level}`;
          assert.doesNotThrow(() => pushMessage(payload), message);
          // The worker opens the same page and keeps the tag the server chose.
          assert.equal(worker.target(payload), payload.link, message);
          assert.equal(worker.options(payload).tag, payload.tag, message);
          const copy = worker.render(payload, scope.agentPierNotificationCopyEn);
          assert.ok(copy.title && copy.body, message);
        }
    }
});

test("a GitHub token notice opens GitHub connections", () => {
  const payload = buildPayload(
    pushEvent({ kind: "github-token", eventId: "t1" }),
    defaultPreferences(),
  );
  assert.equal(payload.link, "/connections?section=github");
  assert.equal(worker.target({ kind: "github-token" }), "/connections?section=github");
});

test("agent chat notices collapse by their chat's tag", () => {
  const payload = buildPayload(
    pushEvent({
      kind: "agent-checkin",
      eventId: "e1",
      assistantId: "a1",
      conversationId: "c1",
    }),
    defaultPreferences(),
  );
  assert.equal(payload.tag, "chat:c1");
  const options = worker.options(payload);
  assert.equal(options.tag, "chat:c1");
  assert.equal(options.data.group, "chat:c1");
});

test("update notices open the updates and replace each other; session notices their chat", () => {
  for (const kind of ["update-available", "update-failed"]) {
    const payload = buildPayload(
      pushEvent({ kind, eventId: "u1" }),
      defaultPreferences(),
    );
    assert.equal(payload.link, "/settings/updates");
    assert.equal(payload.tag, "updates");
  }
  for (const kind of ["session-limited", "session-resume-failed"]) {
    const payload = buildPayload(
      pushEvent({ kind, eventId: "e1", sessionId: "s1" }),
      defaultPreferences(),
    );
    assert.equal(payload.link, "/sessions/s1/chat");
    assert.equal(payload.tag, "session:s1");
  }
  // The limit message (with its reset time) shows only at the preview level.
  const limited = pushEvent({
    kind: "session-limited",
    eventId: "e1",
    sessionId: "s1",
    preview: "You've hit your limit · resets 4pm",
  });
  assert.equal(
    buildPayload(limited, { ...defaultPreferences(), level: "label" }).preview,
    undefined,
  );
  assert.equal(
    buildPayload(limited, { ...defaultPreferences(), level: "preview" }).preview,
    "You've hit your limit · resets 4pm",
  );
});
