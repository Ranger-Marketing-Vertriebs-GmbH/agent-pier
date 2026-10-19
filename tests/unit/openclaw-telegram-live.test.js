import test from "node:test";
import assert from "node:assert/strict";
import {
  telegramLiveChanges,
  telegramLivePatch,
  telegramSections,
  telegramSnapshot,
} from "../../server/features/assistants/openclaw-config/telegram-senders.js";

const profile = (id) => ({
  id,
  runtimeAgentId: `ap-${id}`,
  capabilities: { memory: false, reminders: false },
});
const profiles = [profile("a"), profile("b")];
const account = (assistantId, people, extra = {}) => ({
  assistantId,
  botId: `9${assistantId}`,
  token: `12345:${assistantId}-token-abcdefghijklmnopqrstuvwxyz`,
  tokenRevision: 1,
  people,
  ...extra,
});
const snapshot = (accounts, speech = null) =>
  telegramSnapshot(telegramSections({ profiles, telegram: { accounts, speech } }));
const speech = { apiKey: "dg", keyRevision: 1, model: "nova-3", language: "de" };

test("allowlist changes alone are applied live, account by account", () => {
  const running = snapshot([account("a", ["111", "222"]), account("b", ["333"])]);
  assert.equal(telegramLiveChanges(running, running), null, "nothing differs");
  // A removed person on one bot, an added person on the other.
  const desired = snapshot([account("a", ["222"]), account("b", ["333", "444"])]);
  assert.deepEqual(telegramLiveChanges(running, desired), {
    "ap-a": ["222"],
    "ap-b": ["333", "444"],
  });
  // With voice notes on both sides, the key's revision unchanged.
  assert.deepEqual(
    telegramLiveChanges(
      snapshot([account("a", ["111"])], speech),
      snapshot([account("a", ["111", "222"])], speech),
    ),
    { "ap-a": ["111", "222"] },
  );
});

test("anything beyond allowlists needs a Gateway restart", () => {
  const running = snapshot([account("a", ["111", "222"])]);
  for (const [label, desired] of [
    ["a new bot", snapshot([account("a", ["111"]), account("b", ["333"])])],
    ["a removed bot", snapshot([])],
    ["the last person removed", snapshot([account("a", [])])],
    ["a new token", snapshot([account("a", ["111"], { tokenRevision: 2 })])],
    ["a new speech key", snapshot([account("a", ["111"])], speech)],
  ])
    assert.equal(telegramLiveChanges(running, desired), null, label);
  assert.equal(telegramLiveChanges(null, running), null, "no Gateway");
});

test("the live patch replaces each allowlist whole and touches nothing else", () => {
  assert.deepEqual(telegramLivePatch({ "ap-a": ["222"], "ap-b": ["333", "444"] }), {
    patch: {
      channels: {
        telegram: {
          accounts: {
            "ap-a": { allowFrom: ["222"] },
            "ap-b": { allowFrom: ["333", "444"] },
          },
        },
      },
    },
    // A merge patch cannot shorten an array: without these, a removed person stays.
    replacePaths: [
      "channels.telegram.accounts.ap-a.allowFrom",
      "channels.telegram.accounts.ap-b.allowFrom",
    ],
  });
});
