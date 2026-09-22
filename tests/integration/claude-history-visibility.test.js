import test from "node:test";
import assert from "node:assert/strict";
import { claudeHistoryFixture } from "../helpers/claude-history.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";

const providerInputs = (f) => [
  f.user(
    "notification",
    "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>",
    { origin: { kind: "task-notification" } },
  ),
  f.user("stdout", "<local-command-stdout>Set model</local-command-stdout>"),
  f.user("stderr", [
    { type: "text", text: "<local-command-stderr>no</local-command-stderr>" },
  ]),
  f.user("peer", "peer message", { origin: { kind: "peer" } }),
  f.user("channel", "channel message", { origin: { kind: "channel", server: "x" } }),
  f.user("continue", "/goal next", { origin: { kind: "auto-continuation" } }),
  f.user("side-user", "subagent prompt", { isSidechain: true }),
  f.assistant("side-assistant", [{ type: "text", text: "subagent answer" }], {
    isSidechain: true,
  }),
];

// Typed commands and skills stay visible as the user typed them.
const typedInputs = (f) => [
  f.user(
    "command",
    "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>",
  ),
  f.user(
    "skill",
    "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/app.js</command-args>",
    { origin: { kind: "human" } },
  ),
  f.user("future", "input from a future origin", { origin: { kind: "future-kind" } }),
];

test("Claude history shows only human input and main-chain replies", () => {
  const f = {
    user: (uuid, content, extra = {}) => ({
      uuid,
      type: "user",
      message: { role: "user", content },
      ...extra,
    }),
    assistant: (uuid, content, extra = {}) => ({
      uuid,
      type: "assistant",
      message: { role: "assistant", content },
      ...extra,
    }),
  };
  const records = [
    f.user("typed", "typed prompt", { origin: { kind: "human" } }),
    f.user("legacy", "prompt without origin"),
    ...providerInputs(f),
    ...typedInputs(f),
    f.assistant("reply", [
      { type: "tool_use", id: "call", name: "Bash", input: { command: "ls" } },
    ]),
    f.user("result", [{ type: "tool_result", tool_use_id: "call", content: "ok" }], {
      origin: { kind: "task-notification" },
    }),
  ];
  const { messages } = normalizeClaude(records);
  assert.deepEqual(
    messages.map((message) => [message.id, message.role]),
    [
      ["typed", "user"],
      ["legacy", "user"],
      ["command", "user"],
      ["skill", "user"],
      ["future", "user"],
      ["call", "tool"],
    ],
  );
  assert.deepEqual(
    messages.slice(2, 5).map((message) => message.text),
    ["/model", "/review src/app.js", "input from a future origin"],
  );
  assert.equal(messages[5].status, "completed");
});

test("live, indexed and full Claude reads agree on hidden provider input", async (t) => {
  const f = await claudeHistoryFixture(t);
  const records = [];
  for (let i = 0; i < 70; i++) {
    records.push(f.user(`u${i}`, `prompt ${i}`, { origin: { kind: "human" } }));
    if (i % 5 === 0)
      records.push(
        ...[...providerInputs(f), ...typedInputs(f)].map((r) => ({
          ...r,
          uuid: `${r.uuid}${i}`,
        })),
      );
    records.push(f.assistant(`a${i}`, [{ type: "text", text: `answer ${i}` }]));
  }
  await f.write(records);
  const full = (await f.history.read(f.session, "native")).messages;
  assert.equal(full.length, 140 + 14 * 3);
  assert.ok(
    full.every((message) =>
      /^(prompt |answer |\/model$|\/review |input )/.test(message.text),
    ),
  );
  const provisional = await f.pages();
  assert.deepEqual(provisional.messages, full);
  await f.indexed();
  const indexed = await f.pages();
  assert.ok(indexed.first.next?.indexed, "served from the index");
  assert.deepEqual(indexed.messages, full);
});
