import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeComposerImages,
  claudeImageDraft,
  claudeImageMessage,
  waitForClaudeImages,
} from "../../server/features/sessions/claude-image-paste.js";
import {
  claudeComposerBox,
  claudeComposerState,
} from "../../server/features/sessions/claude-composer.js";
import {
  inspectChatComposer,
  writeChatTuiInput,
} from "../../server/features/sessions/session-chat-input.js";

// Real Claude Code 2.1.280 frames with pasted image chips in short and normal
// panes: the former single paste of text and paths, and paths pasted first.
const fixture = async (name) =>
  JSON.parse(
    await fs.readFile(new URL(`../fixtures/tui-input/${name}`, import.meta.url)),
  );
const screens = await fixture("claude-2.1.280-image-screens.json");
const first = await fixture("claude-2.1.280-image-first-screens.json");

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

const inspect = ({ raw, pane }) => inspectChatComposer("claude", raw, pane);

async function realImages(t, count) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-image-paste-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = [];
  for (let n = 1; n <= count; n++) {
    files.push(path.join(directory, `img ${n}.png`));
    await fs.writeFile(files.at(-1), "synthetic transport fixture");
  }
  return files;
}

const waiting = (frames) => {
  let reads = 0;
  const manager = {
    target: () => "=synthetic",
    tmux: async (args) => {
      assert.equal(args[0], "display-message");
      return capture(frames[Math.min(reads++, frames.length - 1)], args);
    },
  };
  return { manager, reads: () => reads };
};

test("chips pasted before the text are all visible, even in short and narrow panes", () => {
  for (const name of ["chips3Only60x8", "chips3Only40x10", "chips3Wrapped30x10"])
    assert.equal(count(first[name]), 3, name);
  // The same long text after the chips scrolls them away: they must be counted first.
  for (const name of ["chips3Long60x8", "chips3Long40x10"]) {
    assert.equal(count(first[name]), 0, name);
    const { raw, pane } = first[name];
    assert.equal(claudeComposerState(raw, pane, inspect(first[name])).state, "draft");
  }
  // Labels of an earlier message above the prompt never count.
  assert.equal(count(first.chipsRenumbered120x35), 2);
});

test("waiting for chips polls until the exact count is visible", async () => {
  const ready = waiting([
    screen(""),
    screen("[Image #1]"),
    screen("[Image #1] [Image #2]"),
  ]);
  await waitForClaudeImages(ready.manager, { id: "synthetic" }, 2);
  assert.equal(ready.reads(), 3);
  // Existing chips are part of the expected total, never stand-ins for new ones.
  const more = waiting([screen("[Image #1] [Image #2]"), first.chips3Only60x8]);
  await assert.rejects(
    waitForClaudeImages(more.manager, { id: "synthetic" }, 4, { timeoutMs: 100 }),
    { status: 409, code: "CHAT_IMAGES_UNCONFIRMED" },
  );
  const stuck = waiting([screen("[Image #1]")]);
  await assert.rejects(
    waitForClaudeImages(stuck.manager, { id: "synthetic" }, 2, { timeoutMs: 0 }),
    { status: 409, code: "CHAT_IMAGES_UNCONFIRMED" },
  );
  await assert.rejects(waitForClaudeImages(stuck.manager, { id: "synthetic" }, null), {
    status: 409,
  });
});

test("scrolled chips keep waiting, then fail clearly", async () => {
  const scrolled = waiting([screens.images3Scrolled60x11]);
  await assert.rejects(
    waitForClaudeImages(scrolled.manager, { id: "synthetic" }, 3, { timeoutMs: 150 }),
    { status: 409, code: "CHAT_IMAGES_UNCONFIRMED" },
  );
  assert.ok(scrolled.reads() > 1);
});

test("a message is split into existing absolute image lines and its remaining text", async (t) => {
  const [one, two] = await realImages(t, 2);
  assert.deepEqual(await claudeImageMessage(`Look\n${one}\n${two}`), {
    images: [one, two],
    text: "Look",
  });
  // Claude 2.1.280 turns "a\n<image>\nb\n<image>" into "[Image #1] [Image #2]a\nb".
  assert.deepEqual(await claudeImageMessage(`a\n  ${one} \nb\n${two}`), {
    images: [one, two],
    text: "a\nb",
  });
  assert.deepEqual(await claudeImageMessage(`\n${one}\n \n`), {
    images: [one],
    text: "",
  });
  for (const text of [
    "ordinary text",
    `${one}.missing.png`,
    "~/image.png",
    "image.png",
    path.dirname(one),
    "/etc/hosts",
  ])
    assert.equal(await claudeImageMessage(text), null, text);
});

test("image drafts match with chips in place of paths and any chip numbers", async (t) => {
  const three = { images: ["/a.png", "/b.png", "/c.png"], text: "Look" };
  const read = (name) => inspect(first[name]);
  assert.deepEqual(read("chips3Only60x8"), {
    state: "text",
    text: "[Image #1] [Image #2] [Image #3]",
  });
  assert.equal(claudeImageDraft(read("chips3Only60x8"), three), true);
  assert.equal(claudeImageDraft(read("chips3Only40x10"), three), true);
  assert.equal(claudeImageDraft(read("chips3Only60x8"), three, { text: "Look" }), false);
  assert.equal(claudeImageDraft(read("chips3Short60x8"), three, { text: "Look" }), true);
  assert.equal(claudeImageDraft(read("chips3Short60x8"), three), false);
  const one = { images: ["/a.png"], text: "Describe this" };
  assert.equal(claudeImageDraft(read("chips1Short40x10"), one, one), true);
  assert.equal(claudeImageDraft(read("chips1Short40x10"), three, one), false);
  // Claude numbers chips per session: the second message shows #3 and #4.
  const two = { images: ["/a.png", "/b.png"], text: "Next" };
  assert.equal(claudeImageDraft(read("chipsRenumbered120x35"), two, two), true);
  // Wrapped or scrolled drafts are never matched, like wrapped text drafts.
  for (const name of ["chips3Wrapped30x10", "chips3Long60x8", "chips3Long40x10"])
    assert.equal(claudeImageDraft(read(name), three), false, name);
  assert.equal(claudeImageDraft({ state: "text", text: "Look" }, null), false);
  // Chip-like text the user typed stays literal and must match in place.
  const literal = { images: ["/a.png"], text: "compare with [Image #1]" };
  const draft = { state: "text", text: "[Image #2]compare with [Image #9]" };
  assert.equal(claudeImageDraft(draft, literal, literal), true);
  assert.equal(
    claudeImageDraft({ state: "text", text: "[Image #2]compare with" }, literal, literal),
    false,
  );
  await realImages(t, 0);
});

test("a short pane submits after chips pasted first are counted, whatever the text length", async (t) => {
  const long = "lorem ipsum dolor sit amet ".repeat(15).trim();
  for (const [name, n] of [
    ["chips3Only60x8", 3],
    ["chips3Only40x10", 3],
    ["chips3Wrapped30x10", 3],
  ]) {
    const calls = [];
    const inputs = [];
    const manager = {
      target: () => "=synthetic",
      tmux: async (args, options) => {
        calls.push(args[0]);
        if (options?.input) inputs.push(options.input);
        if (args[0] === "display-message") return capture(first[name], args);
      },
    };
    const files = await realImages(t, n);
    await writeChatTuiInput(
      manager,
      { id: "synthetic", tool: "claude" },
      [long, ...files].join("\n"),
    );
    assert.deepEqual(
      calls,
      [
        "load-buffer",
        "paste-buffer",
        "display-message",
        "load-buffer",
        "paste-buffer",
        "send-keys",
      ],
      name,
    );
    assert.deepEqual(inputs, [files.join("\n"), long], name);
  }
});
