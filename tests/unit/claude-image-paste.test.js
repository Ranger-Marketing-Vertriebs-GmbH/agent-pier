import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeComposerImages,
  waitForClaudeImagePaste,
} from "../../server/features/sessions/claude-image-paste.js";
import { claudeComposerBox } from "../../server/features/sessions/claude-composer.js";
import { writeChatTuiInput } from "../../server/features/sessions/session-chat-input.js";

// Real Claude Code 2.1.280 frames with pasted image chips in short and normal panes.
const screens = JSON.parse(
  await fs.readFile(
    new URL("../fixtures/tui-input/claude-2.1.280-image-screens.json", import.meta.url),
  ),
);

function screen(content, cursorY = 2) {
  const border = "─".repeat(80);
  const raw = `Old response [Image #99]\n${border}\n❯ ${content}\n${border}\n`;
  return { raw, pane: { cursorX: 2, cursorY, width: 80, height: 24 } };
}

// Answers tmux's display-message format like tmux does, followed by the capture.
function capture({ raw, pane }, args) {
  assert.equal(args[0], "display-message");
  const fields = {
    cursor_x: pane.cursorX,
    cursor_y: pane.cursorY,
    pane_width: pane.width,
    pane_height: pane.height,
  };
  return `${args[4].replace(/#\{(\w+)\}/g, (_, key) => fields[key])}\n${raw}`;
}
const count = ({ raw, pane }) => claudeComposerImages(raw, pane);

test("image readiness is limited to the fenced current Claude composer", () => {
  assert.equal(count(screen("")), 0);
  assert.equal(count(screen("[Image #1] [Image #2]text")), 2);
  assert.equal(count(screen("[Image #1]\n  [Image #2]text", 3)), 2);
  assert.equal(count(screen("[Image #1]", 0)), null);
  assert.equal(count(screen("[Image #1]", 99)), null);
  const dialog = screen("[Image #1]");
  assert.equal(count({ ...dialog, raw: dialog.raw.replace("❯ ", "Allow? ") }), null);
  // Bash mode is a prompt box too, but never holds prompt image attachments.
  assert.equal(count({ ...dialog, raw: dialog.raw.replace("❯ ", "! ") }), null);
  assert.equal(claudeComposerImages("invalid", {}), null);
});

test("image chips are counted in real prompt boxes, including clipped short panes", () => {
  for (const [name, expected] of [
    ["images3Short60x8", 3],
    ["images3Clipped60x8", 3],
    ["image1Clipped60x9", 1],
    ["image1Wrapped60x11", 1],
    // A chip split across rows by wrapping still counts once.
    ["images3SplitClipped40x10", 3],
    ["images3Normal120x35", 3],
    // Image labels in the conversation above an empty prompt do not count.
    ["afterImageSend60x11", 0],
  ])
    assert.equal(count(screens[name]), expected, name);
  for (const name of [
    "images3Clipped60x8",
    "image1Clipped60x9",
    "images3SplitClipped40x10",
  ])
    assert.equal(claudeComposerBox(screens[name].raw, screens[name].pane).clipped, true);
});

test("chips scrolled out of a short prompt box are never counted as attached", () => {
  // Claude scrolls a tall draft inside its box: the first row shows only "#3]".
  const scrolled = screens.images3Scrolled60x11;
  assert.match(scrolled.raw.replace(/\x1b\[[0-9;]*m/g, ""), /\n❯[ \u00a0]#3\]AP_IMG/);
  assert.equal(count(scrolled), 0);
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
  const captures = [screen(""), screen("[Image #1]"), screen("[Image #1] [Image #2]")];
  const manager = {
    target: () => "=synthetic",
    tmux: async (args) => {
      calls.push(args[0]);
      if (args[0] === "display-message") return capture(captures.shift(), args);
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

test("unfinished image preparation still submits and reports missing images", async (t) => {
  const text = await images(t);
  const calls = [];
  const manager = {
    target: () => "=synthetic",
    tmux: async (args) => {
      calls.push(args.at(-1));
      if (args[0] === "display-message") return capture(screen("[Image #1]"), args);
    },
  };
  assert.equal(
    await waitForClaudeImagePaste(manager, { id: "synthetic", tool: "claude" }, text, {
      timeoutMs: 0,
    }),
    false,
  );
  // Chat never stays unsent: Enter follows, with an informational notice.
  const notices = [];
  calls.length = 0;
  await writeChatTuiInput(manager, { id: "synthetic", tool: "claude" }, text, {
    imageTimeoutMs: 0,
    onNotice: async (code) => notices.push(code),
  });
  assert.deepEqual(notices, ["CHAT_IMAGES_MAYBE_MISSING"]);
  assert.equal(calls.at(-1), "Enter");
  assert.equal(calls.filter((call) => call === "Enter").length, 1);
});

test("existing image chips cannot count as preparation of newly pasted files", async (t) => {
  const text = await images(t);
  const captures = [
    screen("[Image #1] [Image #2]"),
    screen("[Image #1] [Image #2] [Image #3] [Image #4]"),
  ];
  let reads = 0;
  const manager = {
    target: () => "=synthetic",
    tmux: async (args) => {
      reads++;
      return capture(captures.shift(), args);
    },
  };
  await waitForClaudeImagePaste(manager, { id: "synthetic", tool: "claude" }, text, {
    initialImages: 2,
  });
  assert.equal(reads, 2);
  // Without a readable baseline only a lower bound counts, never fewer chips.
  captures.push(screen("[Image #1]"));
  assert.equal(
    await waitForClaudeImagePaste(manager, { id: "synthetic", tool: "claude" }, text, {
      initialImages: null,
      timeoutMs: 0,
    }),
    false,
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

async function realImages(t, count) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-image-paste-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = [];
  for (let n = 1; n <= count; n++) {
    files.push(path.join(directory, `img${n}.png`));
    await fs.writeFile(files.at(-1), "synthetic transport fixture");
  }
  return files.join("\n");
}

test("a short pane with a clipped prompt box submits once all chips are visible", async (t) => {
  for (const [name, images] of [
    ["images3Clipped60x8", 3],
    ["image1Clipped60x9", 1],
    ["images3SplitClipped40x10", 3],
  ]) {
    const calls = [];
    const manager = {
      target: () => "=synthetic",
      tmux: async (args) => {
        calls.push(args[0]);
        if (args[0] === "display-message") return capture(screens[name], args);
      },
    };
    await writeChatTuiInput(
      manager,
      { id: "synthetic", tool: "claude" },
      `Describe\n${await realImages(t, images)}`,
    );
    assert.deepEqual(
      calls,
      ["load-buffer", "paste-buffer", "display-message", "send-keys"],
      name,
    );
  }
});

test("chips scrolled out of view keep waiting, then report missing images", async (t) => {
  let reads = 0;
  const manager = {
    target: () => "=synthetic",
    tmux: async (args) => {
      assert.equal(args[0], "display-message");
      reads++;
      return capture(screens.images3Scrolled60x11, args);
    },
  };
  assert.equal(
    await waitForClaudeImagePaste(
      manager,
      { id: "synthetic", tool: "claude" },
      `Describe\n${await realImages(t, 3)}`,
      { timeoutMs: 150 },
    ),
    false,
  );
  assert.ok(reads > 1);
});

test("chip-like text typed in the message cannot stand in for an attached image", async (t) => {
  const text = `compare with [Image #1]\n${await realImages(t, 1)}`;
  // Claude 2.1.280 keeps the typed label literal and prepends the real chip.
  const captures = [
    screen("compare with [Image #1]"),
    screen("[Image #1]compare with [Image #1]"),
  ];
  const calls = [];
  const manager = {
    target: () => "=synthetic",
    tmux: async (args) => {
      calls.push(args[0]);
      if (args[0] === "display-message") return capture(captures.shift(), args);
    },
  };
  await writeChatTuiInput(manager, { id: "synthetic", tool: "claude" }, text);
  assert.deepEqual(calls, [
    "load-buffer",
    "paste-buffer",
    "display-message",
    "display-message",
    "send-keys",
  ]);
});
