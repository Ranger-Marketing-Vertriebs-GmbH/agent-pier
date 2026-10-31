import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildPayload } from "../../server/features/notifications/push-content.js";
import { defaultPreferences } from "../../server/features/notifications/push-preferences.js";
import {
  pushEvent,
  pushKinds,
  pushMessage,
} from "../../server/features/notifications/push-validation.js";
import {
  agentNotice,
  requestNotice,
  runNotice,
  sessionNotice,
} from "../../server/application/push-notices.js";
import { readRoute } from "../../web/app/routes.js";
import { readUserRoute } from "../../web/features/users/user-routes.js";

// Every push kind, built as its emitter builds it, opens the exact place it is about
// (AGENTPIER-297): the agent chat, the session chat, the pipeline run or the updates,
// where a waiting approval, question, gate or proposal shows its own card. Only an item
// without such a place opens the inbox.
const scope = {};
const context = vm.createContext({ self: scope });
for (const name of ["pwa-de.js", "pwa-en.js", "pwa-render.js"])
  vm.runInContext(
    fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8"),
    context,
  );
const worker = scope.agentPierNotificationRender;

const session = { id: "s1", name: "api-refactor", tool: "claude", cwd: "/w/shop" };
const run = { id: "run1", pipelineName: "Release", currentNodeId: "n1", nodes: [] };
const assistants = {
  store: {
    getAssistant: (id) => ({ id, name: "Mira" }),
    listConversations: () => [
      { id: "main", assistantId: "a1", main: true },
      { id: "c1", assistantId: "a1" },
    ],
  },
};
const request = (kind, id) =>
  requestNotice({ kind, sessionId: "s1", resourceId: id }, session, {
    id,
    revision: 2,
    ...(kind === "question" ? { questions: [{ prompt: "Which database?" }] } : {}),
  });

// [kind, emitter fields, opened page, the app's route there, inbox item]
const rows = [
  [
    "permission",
    request("permission", "r1"),
    "/sessions/s1/chat",
    { sessionId: "s1", mode: "reader" },
    "/inbox/approval/r1",
  ],
  [
    "question",
    request("question", "r2"),
    "/sessions/s1/chat",
    { sessionId: "s1", mode: "reader" },
    "/inbox/question/r2",
  ],
  [
    "session-completed",
    sessionNotice(session),
    "/sessions/s1/chat",
    { sessionId: "s1", mode: "reader" },
  ],
  [
    "session-waiting",
    sessionNotice(session),
    "/sessions/s1/chat",
    { sessionId: "s1", mode: "reader" },
  ],
  [
    "session-ended",
    sessionNotice(session),
    "/sessions/s1/chat",
    { sessionId: "s1", mode: "reader" },
  ],
  [
    "session-limited",
    sessionNotice(session),
    "/sessions/s1/chat",
    { sessionId: "s1", mode: "reader" },
  ],
  [
    "session-resume-failed",
    sessionNotice(session),
    "/sessions/s1/chat",
    { sessionId: "s1", mode: "reader" },
  ],
  [
    "pipeline-gate",
    runNotice(run, true),
    "/pipelines/runs/run1",
    { view: "pipelines", pipelineItem: "run1" },
    "/inbox/gate/run1",
  ],
  [
    "pipeline-completed",
    runNotice(run, false),
    "/pipelines/runs/run1",
    { view: "pipelines", pipelineItem: "run1" },
  ],
  [
    "pipeline-failed",
    runNotice(run, false),
    "/pipelines/runs/run1",
    { view: "pipelines", pipelineItem: "run1" },
  ],
  // An agent's approval opens the chat it was asked in, where its card waits.
  [
    "agent-approval",
    {
      subject: "exec",
      ...agentNotice(assistants, "a1", "c1"),
      inbox: { type: "action", id: "x1" },
      decide: "deny",
      revision: 1,
    },
    "/agents/a1/chats/c1",
    { view: "agents", assistantId: "a1", conversationId: "c1" },
    "/inbox/action/x1",
  ],
  // One whose chat is gone opens the agent's main chat.
  [
    "agent-approval",
    {
      subject: "mail",
      ...agentNotice(assistants, "a1", "gone"),
      inbox: { type: "action", id: "x2" },
    },
    "/agents/a1/chats/main",
    { view: "agents", assistantId: "a1", conversationId: "main" },
    "/inbox/action/x2",
  ],
  [
    "agent-approval",
    {
      subject: "team",
      ...agentNotice(assistants, "a1", "c1"),
      inbox: { type: "team", id: "t1" },
    },
    "/agents/a1/chats/c1",
    { view: "agents", assistantId: "a1", conversationId: "c1" },
    "/inbox/team/t1",
  ],
  // An agent without any chat of the owner's: only the inbox shows the approval.
  [
    "agent-approval",
    { subject: "exec", assistantId: "lone", inbox: { type: "action", id: "x3" } },
    "/inbox/action/x3",
    { view: "inbox", itemType: "action", itemId: "x3" },
    "/inbox/action/x3",
  ],
  [
    "agent-checkin",
    { assistantId: "a1", conversationId: "c1" },
    "/agents/a1/chats/c1",
    { view: "agents", assistantId: "a1", conversationId: "c1" },
  ],
  [
    "agent-routine",
    { assistantId: "a1", conversationId: "main" },
    "/agents/a1/chats/main",
    { view: "agents", assistantId: "a1", conversationId: "main" },
  ],
  [
    "agent-reminder",
    { assistantId: "a1", conversationId: "main" },
    "/agents/a1/chats/main",
    { view: "agents", assistantId: "a1", conversationId: "main" },
  ],
  [
    "agent-hook-throttled",
    { assistantId: "a1", conversationId: "main" },
    "/agents/a1/chats/main",
    { view: "agents", assistantId: "a1", conversationId: "main" },
  ],
  [
    "telegram-revocation",
    { assistantId: "a1" },
    "/agents/a1/settings",
    { view: "agents", assistantId: "a1", agentSettings: true },
  ],
  ["telegram-revocation", {}, "/agents", { view: "agents" }],
  [
    "github-token",
    {},
    "/connections?section=github",
    { view: "connections", section: "github" },
  ],
  ["disk-space", {}, "/", { view: "workspace", sessionId: "" }],
  [
    "update-available",
    { label: "2.15.0" },
    "/settings/updates",
    { view: "settings", settingsTab: "operations", settingsSection: "updates" },
  ],
  [
    "update-failed",
    {},
    "/settings/updates",
    { view: "settings", settingsTab: "operations", settingsSection: "updates" },
  ],
  [
    "test",
    {},
    "/settings/notifications",
    { view: "settings", settingsTab: "app", settingsSection: "notifications" },
  ],
];

const subset = (route, expected) =>
  Object.fromEntries(Object.keys(expected).map((key) => [key, route[key]]));

test("the table covers every kind the server sends", () => {
  assert.deepEqual(
    [...new Set(rows.map(([kind]) => kind))].sort(),
    [...pushKinds].sort(),
  );
});

for (const [kind, fields, link, route, item] of rows)
  test(`${kind} ${JSON.stringify(fields).slice(0, 60)} opens ${link}`, () => {
    const event = pushEvent({ kind, eventId: "event-1", ...fields });
    for (const level of ["type", "label", "preview"]) {
      const payload = buildPayload(event, { ...defaultPreferences(), level });
      assert.equal(payload.link, link);
      assert.equal(payload.item, item);
      assert.doesNotThrow(() => pushMessage(payload));
      // The worker opens the same page; the app has that page.
      const options = worker.options(payload, scope.agentPierNotificationCopyEn);
      assert.equal(options.data.link, link);
      const opened = readRoute(new URL(options.data.link, "https://pier.example"));
      assert.deepEqual(subset(opened, route), route);
      // Allow and Deny decide the inbox item, which opens when a decision fails.
      if (options.data.decision) {
        assert.equal(options.data.item, item);
        assert.equal(
          `/inbox/${options.data.decision.type}/${options.data.decision.id}`,
          item,
        );
      }
    }
  });

test("a user's approval opens the chat in the user's own app", () => {
  const payload = buildPayload(
    pushEvent({
      kind: "agent-approval",
      eventId: "e1",
      subject: "exec",
      assistantId: "a1",
      conversationId: "c1",
    }),
    defaultPreferences(),
  );
  assert.equal(payload.link, "/agents/a1/chats/c1");
  assert.equal(payload.item, undefined);
  assert.deepEqual(readUserRoute(new URL(payload.link, "https://pier.example")), {
    view: "chat",
    agentId: "a1",
    conversationId: "c1",
  });
});

test("an older payload that linked the inbox still decides its item", () => {
  const legacy = {
    v: 2,
    kind: "permission",
    eventId: "r1",
    link: "/inbox/approval/r1",
    decide: "both",
    revision: 3,
  };
  const options = worker.options(legacy, scope.agentPierNotificationCopyEn);
  assert.equal(options.data.link, "/inbox/approval/r1");
  assert.equal(options.data.item, "/inbox/approval/r1");
  assert.equal(options.data.decision.id, "r1");
  // An item outside the inbox's addresses is never decided.
  const forged = { ...legacy, link: "/sessions/s1/chat", item: "/inbox/../settings" };
  assert.equal(
    worker.options(forged, scope.agentPierNotificationCopyEn).data.decision,
    undefined,
  );
  assert.throws(() => pushMessage(forged));
});
