import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPayload,
  looksSensitive,
  payloadBudget,
  safeLabel,
  safePreview,
} from "../../server/features/notifications/push-content.js";
import { defaultPreferences } from "../../server/features/notifications/push-preferences.js";
import {
  pushEvent,
  pushMessage,
} from "../../server/features/notifications/push-validation.js";

const at = (level, changes = {}) => ({ ...defaultPreferences(), level, ...changes });
const question = pushEvent({
  kind: "question",
  eventId: "request-one",
  sessionId: "session-one",
  inbox: { type: "question", id: "request-one" },
  label: "api-refactor",
  tool: "claude",
  project: "shop-backend",
  preview: "Which database should the integration tests use?",
});

test("each detail level adds exactly its own fields", () => {
  assert.deepEqual(buildPayload(question, at("type"), { count: 3 }), {
    v: 2,
    kind: "question",
    eventId: "request-one",
    link: "/inbox/question/request-one",
    tag: "session:session-one",
    renotify: true,
    count: 3,
  });
  const label = buildPayload(question, at("label"));
  assert.equal(label.label, "api-refactor");
  assert.equal(label.tool, "claude");
  assert.equal(label.project, "shop-backend");
  assert.equal(label.preview, undefined);
  const preview = buildPayload(question, at("preview"));
  assert.equal(preview.preview, "Which database should the integration tests use?");
});

test("approvals never carry a preview; a team proposal shows its goal", () => {
  for (const event of [
    pushEvent({
      kind: "permission",
      eventId: "r1",
      sessionId: "s1",
      preview: "Run the build",
    }),
    pushEvent({
      kind: "agent-approval",
      eventId: "a1",
      assistantId: "agent-one",
      subject: "exec",
      preview: "Run the build",
    }),
    pushEvent({
      kind: "session-ended",
      eventId: "e1",
      sessionId: "s1",
      preview: "Run the build",
    }),
  ])
    assert.equal(buildPayload(event, at("preview")).preview, undefined, event.kind);
  const team = pushEvent({
    kind: "agent-approval",
    eventId: "t1",
    assistantId: "lead",
    subject: "team",
    inbox: { type: "team", id: "team-one" },
    label: "Mira",
    preview: "Prepare the changelog for release 2.1",
  });
  const payload = buildPayload(team, at("preview"));
  assert.equal(payload.preview, "Prepare the changelog for release 2.1");
  assert.equal(payload.subject, "team");
  assert.equal(payload.link, "/inbox/team/team-one");
  assert.equal(buildPayload(team, at("type")).subject, undefined);
});

test("previews and labels never show commands, paths, URLs or secrets", () => {
  for (const text of [
    "Run rm -rf build and try again",
    "Edit /Users/owner/project/server.js first",
    "See ~/notes.md for details",
    "Open src/app/main.js and check it",
    "Look at https://example.com/build/42",
    "Visit www.example.com",
    "Write to owner@example.com",
    "$ npm test",
    "npm install fails",
    "Use make && make install",
    "Set API_KEY=abc123 in the environment",
    "password: hunter2",
    "Token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "Key sk-abcdefghijk1234567890",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx",
    "Hash 0123456789abcdef0123456789abcdef01234567",
    "Pass --force to overwrite",
    "C:\\Users\\owner\\file.txt",
  ]) {
    assert.equal(looksSensitive(text), true, text);
    assert.equal(safePreview(text), null, text);
    assert.equal(safeLabel(text), null, text);
  }
  // Code goes entirely; the prose around it stays.
  assert.equal(
    safePreview(
      "Three tests still fail.\n```\nnpm test -- --watch\n```\nShall I fix them?",
    ),
    "Three tests still fail. Shall I fix them?",
  );
  assert.equal(safePreview("Use `git push` now"), "Use now");
  assert.equal(
    safePreview("**Done**: the and/or case works; ready"),
    "Done: the and/or case works; ready",
  );
  const long = "A".repeat(10) + " word".repeat(60);
  const clipped = safePreview(long);
  assert.equal([...clipped].length, 140);
  assert.ok(clipped.endsWith("…"));
});

test("a payload stays within 1 KB of plaintext JSON", () => {
  const wide = "😀".repeat(300);
  const event = pushEvent({
    kind: "question",
    eventId: "e".repeat(120),
    sessionId: "s".repeat(120),
    inbox: { type: "question", id: "q".repeat(120) },
    label: wide,
    tool: "claude",
    project: wide,
    stage: wide,
    preview: wide,
  });
  const payload = buildPayload(event, at("preview"), { count: 5 });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= payloadBudget);
  assert.equal(typeof pushMessage(payload), "string");
  assert.throws(() => pushMessage({ ...payload, preview: "x".repeat(2000) }));
  // Only known fields leave the host.
  assert.equal(JSON.parse(pushMessage({ ...payload, secret: "x" })).secret, undefined);
  assert.throws(() => pushMessage({ ...payload, link: "https://evil.example/" }));
});

test("without grouping each notice has its own tag and never renotifies", () => {
  const payload = buildPayload(question, at("label", { grouping: false }));
  assert.equal(payload.tag, "request-one");
  assert.equal(payload.renotify, undefined);
  const completed = buildPayload(
    pushEvent({ kind: "session-completed", eventId: "c1", sessionId: "s1" }),
    at("type"),
  );
  assert.equal(completed.tag, "session:s1");
  assert.equal(completed.renotify, undefined);
  assert.equal(completed.link, "/sessions/s1/chat");
});

test("each event links to its inbox item or its exact view", () => {
  const link = (input) =>
    buildPayload(pushEvent({ eventId: "e1", ...input }), at("type")).link;
  assert.equal(
    link({ kind: "pipeline-failed", runId: "run-1" }),
    "/pipelines/runs/run-1",
  );
  assert.equal(
    link({ kind: "pipeline-gate", runId: "run-1", inbox: { type: "gate", id: "run-1" } }),
    "/inbox/gate/run-1",
  );
  assert.equal(
    link({ kind: "agent-checkin", assistantId: "a1", conversationId: "c1" }),
    "/agents/a1/chats/c1",
  );
  assert.equal(link({ kind: "agent-checkin", assistantId: "a1" }), "/agents");
  assert.equal(link({ kind: "disk-space" }), "/");
  assert.equal(link({ kind: "github-token" }), "/connections?section=github");
  assert.equal(
    link({ kind: "telegram-revocation", assistantId: "a1" }),
    "/agents/a1/settings",
  );
});
