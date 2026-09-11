import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chatTuiScreen, renderChatTuiScreen } from "./chat-tui-fixture.js";

// Disposable native-history fixture: keep the real composer guard and tmux transport.
const [file, sessionId, counter] = process.argv.slice(2);
const screen = await chatTuiScreen("claude");
const composer = screen.raw.split("\n")[screen.pane.cursorY];
const footer = screen.raw.split("\n")[screen.pane.cursorY + 2];
const output = [];
let count = 0;
let pending = "";
let text = "";
let pasting = false;

function message(type, content) {
  fs.appendFileSync(
    file,
    JSON.stringify({
      type,
      uuid: randomUUID(),
      sessionId,
      cwd: process.cwd(),
      message: { role: type, content },
    }) + "\n",
  );
}

function render() {
  const width = process.stdout.columns || screen.pane.width;
  const height = process.stdout.rows || screen.pane.height;
  const cursorY = height - 3;
  const rows = Array.from({ length: height }, () => "");
  rows[0] = "\x1b[32mREAL_PTY_READY\x1b[0m";
  rows[1] = "Änderungen · ❯ ● ▐▛███▜▌";
  rows[2] = "TUI_STATUS_ONLY";
  output.slice(-(cursorY - 4)).forEach((line, index) => (rows[index + 3] = line));
  rows[cursorY - 1] = rows[cursorY + 1] = "─".repeat(width);
  rows[cursorY] = composer;
  rows[cursorY + 2] = footer;
  process.stdout.write(
    renderChatTuiScreen({
      raw: rows.join("\n"),
      pane: { width, height, cursorX: 2, cursorY },
    }),
  );
}

const beginPaste = "\x1b[200~";
const endPaste = "\x1b[201~";
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  pending += data;
  while (pending) {
    if (pending.startsWith(beginPaste) || pending.startsWith(endPaste)) {
      pasting = pending.startsWith(beginPaste);
      pending = pending.slice(beginPaste.length);
    } else if (beginPaste.startsWith(pending) || endPaste.startsWith(pending)) break;
    else {
      const character = pending[0];
      pending = pending.slice(1);
      if (character === "\r" && !pasting) {
        message("user", text);
        const reply = counter === "true" ? `COUNTER:${++count}` : `RECEIVED:${text}`;
        message("assistant", reply);
        output.push(...reply.split("\n"));
        text = "";
        render();
      } else text += character;
    }
  }
});
process.stdout.on("resize", render);
message("assistant", "REAL_PTY_READY");
process.stdout.write("\x1b[?2004h");
render();
