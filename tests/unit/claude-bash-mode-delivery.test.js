import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { deliveryMatches, deliveryNotices } from "../../web/features/chat/chat-draft.js";
import { deliveryContentMatches } from "../../web/features/chat/delivery-content.js";

// Shapes Claude Code writes for a bash-mode prompt typed as `! cd ~/x && ls`:
// the command keeps the space after `!`, the output is a separate user record.
const now = Date.parse("2026-10-15T08:00:00.000Z");
const cmd = "cd ~/x && ./bin/node scripts/operations.mjs release-stage 2.1.0-rc.2";
const stdout =
  "(node:43278) ExperimentalWarning: SQLite is an experimental feature\n" + '{"ok":true}';
const stderr = "\nShell cwd was reset to /Users/me/project";
const records = [
  {
    type: "user",
    uuid: "input",
    timestamp: new Date(now + 1).toISOString(),
    message: { role: "user", content: `<bash-input> ${cmd} </bash-input>` },
  },
  {
    type: "user",
    uuid: "output",
    parentUuid: "input",
    timestamp: new Date(now + 2).toISOString(),
    message: {
      role: "user",
      content: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`,
    },
  },
];
const item = (text) => ({
  id: "delivery",
  text,
  status: "handed-off",
  baselineIds: [],
  clientCreatedAt: new Date(now).toISOString(),
  observation: { startedAt: now },
});

test("Claude history shows a bash-mode command as the typed `! command`", () => {
  const { messages } = normalizeClaude(records);
  const input = messages.find((message) => message.id === "input");
  assert.equal(input.role, "user");
  assert.equal(input.text, `! ${cmd}`);
  const blocks = normalizeClaude([
    {
      ...records[0],
      message: { content: [{ type: "text", text: "<bash-input>ls</bash-input>" }] },
    },
  ]).messages;
  assert.deepEqual(
    blocks.map((message) => message.text),
    ["! ls"],
  );
});

test("Claude bash-mode output is shell output, not a user message", () => {
  const { messages } = normalizeClaude(records);
  const output = messages.find((message) => message.id === "output");
  assert.equal(output.role, "tool");
  assert.equal(output.shellOutput, true);
  assert.equal(output.status, "completed");
  assert.deepEqual(JSON.parse(output.text), { stdout, stderr: stderr.trim() });
  const empty = normalizeClaude([
    {
      ...records[1],
      message: { content: "<bash-stdout>done</bash-stdout><bash-stderr></bash-stderr>" },
    },
  ]).messages[0];
  assert.deepEqual(JSON.parse(empty.text), { stdout: "done" });
});

test("text that only mentions bash tags stays a user message as written", () => {
  const texts = [
    "Explain <bash-input>ls</bash-input> please",
    "<bash-stdout>x</bash-stdout> is what I saw",
  ];
  const { messages } = normalizeClaude(
    texts.map((content, i) => ({
      type: "user",
      uuid: `u${i}`,
      message: { role: "user", content },
    })),
  );
  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    texts.map((text) => ["user", text]),
  );
});

for (const sent of [`! ${cmd}`, `!${cmd}`, ` !  ${cmd}`]) {
  test(`bash-mode message ${JSON.stringify(sent.slice(0, 4))} is confirmed by its native row`, () => {
    const { messages } = normalizeClaude(records);
    const delivery = item(sent);
    const input = messages.find((message) => message.id === "input");
    assert.equal(deliveryContentMatches(delivery, input), true);
    assert.equal(deliveryContentMatches(delivery, input, true), true);
    assert.equal(deliveryMatches([delivery], messages).get("delivery"), "input");
    assert.deepEqual(deliveryNotices({ recent: [delivery], outbox: null }, messages), []);
  });
}

test("rows cached before the server fix still confirm a bash-mode message", () => {
  const row = {
    role: "user",
    id: "m",
    timestamp: now + 1,
    text: `<bash-input> ${cmd} </bash-input>`,
  };
  assert.equal(deliveryContentMatches(item(`!${cmd}`), row), true);
  assert.equal(deliveryContentMatches(item(`! ${cmd}`), row, true), true);
  assert.equal(deliveryContentMatches(item(cmd), row), false);
  assert.equal(
    deliveryContentMatches(item(`! ${cmd}`), {
      ...row,
      text: `x<bash-input>${cmd}</bash-input>`,
    }),
    false,
  );
});
