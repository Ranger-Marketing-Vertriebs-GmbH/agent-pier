import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// A minimal Claude prompt box in the captured tmux style of Claude Code 2.1.x.
// It echoes bracketed pastes and literal keys, applies Ctrl-U/Backspace and
// submits on Enter, so post-paste and post-submit checks observe real changes.
// \`dialog\` ("menu" or "question") shows a rewind-style menu or a permission
// prompt; a lone Escape closes either and Enter answers the question;
// \`ignoreEditing\` ignores Ctrl-U/Backspace like a prompt that cannot be cleared.
const claudeComposer = (options) => `
const state = {
  draft: ${JSON.stringify(options.draft || "")},
  dialog: ${JSON.stringify(options.dialog || false)},
  pasting: false,
  escape: "",
};
const style = ${JSON.stringify(options.emptyStyle || "cursor")};
const ignoreEnter = ${JSON.stringify(Boolean(options.ignoreEnter))};
const ignoreEditing = ${JSON.stringify(Boolean(options.ignoreEditing))};
function render() {
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 35;
  const border = "\\x1b[38;2;136;136;136m" + "─".repeat(width);
  if (state.dialog) {
    const rows = state.dialog === "menu"
      ? ["   Rewind", "", "   Restore the code and/or conversation to the point before…", "",
        "   ❯ (current)", "", "   Enter to continue · Esc to cancel"]
      : [" Bash command", "   touch MARKER", "", " Do you want to proceed?",
        " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"];
    let out = "\x1b[2J\x1b[1;1HSynthetic Claude transcript";
    rows.forEach((row, index) => {
      out += "\x1b[" + (height - rows.length + index) + ";1H" + row;
    });
    process.stdout.write(out + "\x1b[" + (height - 3) + ";2H");
    return;
  }
  // Wrap like Claude: continuation rows are indented inside the same box.
  const lines = state.draft
    .replaceAll("\\t", " ")
    .split("\\n")
    .flatMap((line) => line.match(new RegExp(".{1," + (width - 10) + "}", "gsu")) || [""])
    .slice(-(height - 5));
  const top = height - lines.length - 3;
  let out = "\\x1b[2J\\x1b[1;1HSynthetic Claude transcript";
  out += "\\x1b[" + (top + 1) + ";1H" + border;
  lines.forEach((line, index) => {
    const last = index === lines.length - 1;
    const empty = !state.draft;
    const text = (index ? "  " : "\\x1b[39m❯\\u00a0") + line;
    out += "\\x1b[" + (top + 2 + index) + ";1H" + text +
      (last && !(empty && style === "plain") ? "\\x1b[7m \\x1b[0m" : "");
  });
  out += "\\x1b[" + (top + 2 + lines.length) + ";1H" + border;
  out += "\\x1b[" + (top + 3 + lines.length) + ";1H\\x1b[39m  ? for shortcuts";
  out += "\\x1b[" + (top + 1 + lines.length) + ";" + (3 + lines.at(-1).length) + "H";
  process.stdout.write(out);
}
function key(input) {
  for (const ch of input) {
    if (state.escape) {
      state.escape += ch;
      const csi = /^\\x1b\\[[0-9;]*[@-~]$/.exec(state.escape);
      const osc = state.escape.startsWith("\\x1b]") &&
        (ch === "\\x07" || state.escape.endsWith("\\x1b\\\\"));
      if (csi || osc || (state.escape.length === 2 && !"[]".includes(ch))) {
        if (state.escape === "\\x1b[200~") state.pasting = true;
        if (state.escape === "\\x1b[201~") state.pasting = false;
        state.escape = "";
      }
      continue;
    }
    if (ch === "\\x1b") state.escape = ch;
    else if (state.dialog) {
      if (ch === "\\r") state.dialog = false;
      continue;
    }
    else if (state.pasting) state.draft += ch === "\\r" ? "\\n" : ch;
    else if (ch === "\\r") {
      if (!ignoreEnter) state.draft = "";
    } else if (ignoreEditing && ["\\x15", "\\x7f", "\\x05"].includes(ch)) continue;
    else if (ch === "\\x15") state.draft = state.draft.replace(/[^\\n]*$/, "");
    else if (ch === "\\x7f") state.draft = state.draft.slice(0, -1);
    else if (ch >= " ") state.draft += ch;
  }
  // tmux writes a lone Escape key on its own; it closes the modal.
  if (state.escape === "\\x1b") {
    state.escape = "";
    state.dialog = false;
  }
}
render();
process.stdout.on("resize", render);
process.stdin.on("data", (data) => {
  key(data.toString());
  render();
});
`;

/** A raw TTY recorder owned and removed by an applicationFixture. */
export async function createTuiInputRecorder(fixture, { screen = "", claude } = {}) {
  const directory = path.join(fixture.root, `tui-recorder-${randomUUID()}`);
  await fs.mkdir(directory);
  const script = path.join(directory, "recorder.mjs");
  const capture = path.join(directory, "bytes");
  const timing = path.join(directory, "timing.jsonl");
  const ready = path.join(directory, "ready");
  await fs.writeFile(capture, "");
  await fs.writeFile(timing, "");
  await fs.writeFile(
    script,
    `import fs from "node:fs";
process.stdin.setRawMode(true);
let offset = 0;
process.stdin.on("data", data => {
  const at = process.hrtime.bigint().toString();
  fs.appendFileSync(${JSON.stringify(capture)}, data);
  fs.appendFileSync(${JSON.stringify(timing)}, JSON.stringify({ at, offset, length: data.length }) + "\\n");
  offset += data.length;
});
process.stdout.write("\\x1b[?2004h" + ${JSON.stringify(screen)});
${claude ? claudeComposer(claude) : ""}
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
`,
  );
  return {
    command: process.execPath,
    args: [script],
    async waitForText(text, timeout = 5000) {
      const expected = Buffer.from(text);
      const started = performance.now();
      while (performance.now() - started < timeout) {
        // Match the accumulated byte stream, including boundaries across stdin chunks.
        if (text === "ready") {
          if (
            await fs.access(ready).then(
              () => true,
              () => false,
            )
          )
            return;
        } else if ((await fs.readFile(capture)).includes(expected)) return;
        await sleep(10);
      }
      throw new Error(`Recorder did not receive expected ${expected.length} bytes`);
    },
    readBytes: () => fs.readFile(capture),
    async receivedAt() {
      const contents = await fs.readFile(timing, "utf8");
      return contents.trim() ? contents.trim().split("\n").map(JSON.parse) : [];
    },
  };
}
