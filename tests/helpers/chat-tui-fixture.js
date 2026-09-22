import fs from "node:fs/promises";

export async function chatTuiScreen(tool) {
  return JSON.parse(
    await fs.readFile(
      new URL(`../fixtures/tui-input/${tool}-idle.json`, import.meta.url),
      "utf8",
    ),
  );
}

export function renderChatTuiScreen({ raw, pane }) {
  const rows = raw.split("\n").slice(0, pane.height);
  return (
    "\x1b[2J" +
    rows.map((line, index) => `\x1b[${index + 1};1H${line}`).join("") +
    `\x1b[${pane.cursorY + 1};${pane.cursorX + 1}H`
  );
}

export function capturedChatTuiScreen({ raw, pane }) {
  return `%1|${process.pid}|1|${pane.cursorX}|${pane.cursorY}|${pane.width}|${pane.height}|0\n${raw}`;
}

/** The captured Claude idle frame with a single-line draft in its prompt box. */
export function claudeDraftScreen({ raw, pane }, text) {
  if (!text) return { raw, pane };
  const rows = raw.split("\n");
  rows[pane.cursorY] = `\x1b[39m❯\u00a0${text}\x1b[7m \x1b[0m`;
  return { raw: rows.join("\n"), pane: { ...pane, cursorX: 2 + text.length } };
}
