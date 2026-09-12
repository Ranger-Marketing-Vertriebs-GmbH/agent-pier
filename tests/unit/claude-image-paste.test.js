import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeComposerImages,
  waitForClaudeImagePaste,
} from "../../server/features/sessions/claude-image-paste.js";
import { writeChatTuiInput } from "../../server/features/sessions/session-chat-input.js";

function screen(content, cursor = 3) {
  const border = "─".repeat(80);
  return `80|${cursor}\nOld response [Image #99]\n${border}\n❯ ${content}\n${border}\n`;
}

test("image readiness is limited to the fenced current Claude composer", () => {
  assert.equal(claudeComposerImages(screen("", 2)), 0);
  assert.equal(claudeComposerImages(screen("[Image #1] [Image #2]text", 2)), 2);
  assert.equal(claudeComposerImages(screen("[Image #1]\n  [Image #2]text")), 2);
  assert.equal(claudeComposerImages(screen("[Image #1]", 0)), null);
  assert.equal(claudeComposerImages(screen("[Image #1]", 99)), null);
  assert.equal(
    claudeComposerImages(screen("[Image #1]", 2).replace("❯ ", "Allow? ")),
    null,
  );
  assert.equal(claudeComposerImages("invalid"), null);
});

async function images(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-image-paste-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = ["first image.png", "second.png"].map((name) =>
    path.join(directory, name),
  );
  for (const file of files) await fs.writeFile(file, "synthetic transport fixture");
  return files.join("\n");
}

test("Claude submits once after all pasted image paths have become native chips", async (t) => {
  const text = `Synthetic images\n${await images(t)}`;
  const calls = [];
  const captures = [
    screen("", 2),
    screen("[Image #1]", 2),
    screen("[Image #1] [Image #2]", 2),
  ];
  const manager = {
    target: () => "=synthetic",
    tmux: async (args) => {
      calls.push(args[0]);
      if (args[0] === "display-message") return captures.shift();
    },
  };
  await writeChatTuiInput(manager, { id: "synthetic", tool: "claude" }, text);
  assert.deepEqual(calls, [
    "load-buffer",
    "paste-buffer",
    "display-message",
    "display-message",
    "display-message",
    "send-keys",
  ]);
});

test("unfinished image preparation times out without injecting Enter", async (t) => {
  const text = await images(t);
  const manager = {
    target: () => "=synthetic",
    tmux: async (args) => {
      assert.equal(args[0], "display-message");
      return screen("[Image #1]", 2);
    },
  };
  await assert.rejects(
    waitForClaudeImagePaste(manager, { id: "synthetic", tool: "claude" }, text, {
      timeoutMs: 0,
    }),
    { status: 409 },
  );
});

test("ordinary text, nonexistent image paths and other CLIs do not poll", async (t) => {
  const manager = { tmux: () => assert.fail("Unexpected image readiness capture") };
  const text = await images(t);
  for (const tool of ["codex", "opencode"])
    await waitForClaudeImagePaste(manager, { tool }, text);
  await waitForClaudeImagePaste(manager, { tool: "claude" }, "ordinary text");
  await waitForClaudeImagePaste(
    manager,
    { tool: "claude" },
    `${text.split("\n")[0]}.missing.png`,
  );
});
