import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { deliveryMatches, deliveryNotices } from "../../web/features/chat/chat-draft.js";
import { deliveryContentMatches } from "../../web/features/chat/delivery-content.js";
import { TOOL_TEXT_LIMIT } from "../../server/features/chat/tool-text.js";

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

test("a plain command does not match a bash-mode command and vice versa", () => {
  const row = (text) => ({ role: "user", id: "m", timestamp: now + 1, text });
  assert.equal(deliveryContentMatches(item("ls"), row("! ls")), false);
  assert.equal(deliveryContentMatches(item("ls"), row("! ls"), true), false);
  assert.equal(deliveryContentMatches(item("! ls"), row("ls")), false);
  assert.equal(deliveryContentMatches(item("!ls"), row("ls"), true), false);
});

const quick = (label, run) => {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `${label} took ${Math.round(elapsed)} ms`);
  return result;
};
const user = (content) => ({
  type: "user",
  uuid: "u",
  message: { role: "user", content },
});

test("bash-mode detection stays linear on hostile user text", () => {
  const spaces = `${" ".repeat(50000)}x`;
  const plain = quick("leading whitespace", () => normalizeClaude([user(spaces)]));
  assert.deepEqual(
    plain.messages.map((m) => [m.role, m.text]),
    [["user", spaces]],
  );
  const repeated = `<bash-stdout>${"</bash-stdout><bash-stderr>".repeat(20000)}`;
  const tags = quick("repeated tags", () => normalizeClaude([user(repeated)]));
  assert.deepEqual(
    tags.messages.map((m) => m.role),
    ["user"],
  );
  const gaps = `<bash-stdout>a</bash-stdout>${" ".repeat(50000)}x`;
  quick("whitespace after a block", () => normalizeClaude([user(gaps)]));
  const inputs = `<bash-input>${"</bash-input> ".repeat(20000)}x`;
  const input = quick("repeated input tags", () => normalizeClaude([user(inputs)]));
  assert.equal(input.messages[0].text, inputs);
  quick("matcher", () =>
    deliveryContentMatches(item(`! ${spaces}`), { role: "user", text: inputs }, true),
  );
});

test("long shell output keeps the tail of each stream within one tool payload", () => {
  const stdout = Array.from({ length: 4000 }, (_, i) => `line "${i}"`).join("\n");
  const stderr = "e".repeat(30000);
  const [output] = normalizeClaude([
    user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`),
  ]).messages;
  assert.ok(output.text.length <= TOOL_TEXT_LIMIT, `${output.text.length} chars`);
  const shown = JSON.parse(output.text);
  assert.ok(stdout.endsWith(shown.stdout) && shown.stdout.endsWith('line "3999"'));
  assert.ok(stderr.endsWith(shown.stderr) && shown.stderr.length > 0);
  assert.deepEqual(output.shellOmitted, {
    stdout: Buffer.byteLength(stdout) - Buffer.byteLength(shown.stdout),
    stderr: stderr.length - shown.stderr.length,
  });
  const [small] = normalizeClaude([user("<bash-stdout>ok</bash-stdout>")]).messages;
  assert.equal(small.shellOmitted, undefined);
  const emoji = "😀".repeat(20000);
  const [pairs] = normalizeClaude([user(`<bash-stdout>${emoji}</bash-stdout>`)]).messages;
  assert.ok(emoji.endsWith(JSON.parse(pairs.text).stdout));
  assert.ok(pairs.text.length <= TOOL_TEXT_LIMIT);
});

test("escape-heavy shell output still fills most of one tool payload", () => {
  const ansi = Array.from({ length: 3000 }, (_, i) => `\u001b[32mok ${i}\u001b[0m`).join(
    "\n",
  );
  const cases = [
    { stdout: ansi },
    { stdout: "a\n".repeat(30000) },
    { stdout: '"'.repeat(40000) },
    { stdout: '"'.repeat(40000), stderr: ansi },
    { stdout: "plain ".repeat(5000), stderr: '"'.repeat(40000) },
  ];
  for (const streams of cases) {
    const tags = Object.entries(streams)
      .map(([name, text]) => `<bash-${name}>${text}</bash-${name}>`)
      .join("");
    const [output] = normalizeClaude([user(tags)]).messages;
    const label = Object.keys(streams).join("+");
    assert.ok(output.text.length <= TOOL_TEXT_LIMIT, `${label}: ${output.text.length}`);
    assert.ok(
      output.text.length >= TOOL_TEXT_LIMIT * 0.8,
      `${label}: only ${output.text.length} of ${TOOL_TEXT_LIMIT}`,
    );
    const shown = JSON.parse(output.text);
    for (const [name, text] of Object.entries(shown)) {
      assert.ok(text.length > 0, `${label}: empty ${name}`);
      assert.ok(
        streams[name].trimEnd().endsWith(text),
        `${label}: ${name} keeps its tail`,
      );
    }
    assert.ok(Object.keys(output.shellOmitted).length > 0);
  }
});
