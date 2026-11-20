import test from "node:test";
import assert from "node:assert/strict";
import { codexRequest } from "../../server/features/requests/codex-protocol.js";
import { observeOpenCode } from "../../server/features/requests/opencode-plugin.js";
import { requestValue } from "../../server/features/requests/request-validation.js";
import {
  localizedOptionLabel,
  optionLabelKeys,
} from "../../server/features/requests/option-labels.js";
import { notifyEscalation } from "../../server/features/assistants/coding-sessions/session-escalation-notes.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import * as webDe from "../../web/lib/i18n/de/requests.js";
import * as webEn from "../../web/lib/i18n/en/requests.js";

// AGENTPIER-442: Codex and OpenCode approval buttons carry a stable label key, so
// the browser and Telegram show them in their own language.
const keyed = (options) => options.map((o) => [o.id, o.labelKey]);

test("Codex command approvals name each option by a stable label key", () => {
  const request = codexRequest({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      command: "curl -sI https://example.com",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    },
  });
  const options = requestValue(request.view).options;
  assert.deepEqual(keyed(options), [
    ["accept", "once"],
    ["acceptForSession", "sessionAllow"],
    ["decline", "deny"],
    ["cancel", "cancel"],
  ]);
  // The German label stays as the fallback for older browsers.
  assert.equal(options[0].label, "Einmal erlauben");
});

test("Codex permission grants name their options by label key", () => {
  const request = codexRequest({
    id: 1,
    method: "item/permissions/requestApproval",
    params: { threadId: "thread", permissions: { network: { enabled: true } } },
  });
  assert.deepEqual(keyed(requestValue(request.view).options), [
    ["allow", "turnAllow"],
    ["deny", "deny"],
  ]);
});

test("OpenCode approvals name their options by label key", () => {
  const published = [];
  const request = {
    id: "permission",
    sessionID: "session",
    permission: "bash",
    patterns: ["git status"],
    always: ["git *"],
    metadata: { command: "git status" },
  };
  observeOpenCode(
    {
      route: { current: { name: "session", params: { sessionID: "session" } } },
      state: { session: { permission: () => [request], question: () => [] } },
      client: {},
    },
    { publish: (_id, view) => published.push(view), resolve() {}, close() {} },
  ).update();
  assert.deepEqual(keyed(requestValue(published[0]).options), [
    ["once", "once"],
    ["always", "sessionAllow"],
    ["reject", "deny"],
  ]);
});

test("validation keeps only known label keys", () => {
  const value = requestValue({
    kind: "permission",
    options: [
      { id: "a", label: "A", labelKey: "once" },
      { id: "b", label: "B", labelKey: "toString" },
      { id: "c", label: "C", labelKey: 5 },
    ],
  });
  assert.deepEqual(
    value.options.map((o) => o.labelKey),
    ["once", undefined, undefined],
  );
});

test("every label key has a German and an English label, in the server and the browser", () => {
  for (const key of optionLabelKeys) {
    for (const catalog of [serverCatalogs.de.requests, serverCatalogs.en.requests])
      assert.equal(typeof catalog[key], "string", key);
    for (const catalog of [webDe.requestCopy, webEn.requestCopy])
      assert.equal(typeof catalog.optionLabels[key], "string", key);
  }
  assert.equal(
    localizedOptionLabel({ labelKey: "once", label: "x" }, serverCatalogs.en.requests),
    "Allow once",
  );
  assert.equal(
    localizedOptionLabel({ label: "Native" }, serverCatalogs.en.requests),
    "Native",
  );
});

test("an escalated Codex prompt's Telegram buttons follow the channel's language", () => {
  const queued = [];
  const w = {
    s: {
      assistantChannels: {
        store: { get: () => ({ language: "en" }) },
        outbox: { enqueue: (entry) => queued.push(entry) },
      },
    },
    a: { store: { getAssistant: () => ({ name: "Ops" }) } },
  };
  const request = codexRequest({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      command: "curl",
      availableDecisions: ["accept", "cancel"],
    },
  });
  const entry = requestValue(request.view);
  const action = {
    id: "action",
    revision: 1,
    assistantId: "ops",
    conversationId: "chat",
    payload: { action: "session_request", sessionId: "s", sessionName: "beta" },
  };
  notifyEscalation(w, action, "approval", "k", null, { channelId: "c" }, entry);
  assert.deepEqual(
    queued[0].actions.map((a) => a.label),
    ["Allow once", "Cancel"],
  );
});
