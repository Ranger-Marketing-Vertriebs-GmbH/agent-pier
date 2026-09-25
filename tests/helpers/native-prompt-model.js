/** Disposable responsive composers for transport tests, using native geometry. */
export function nativePromptRenderer(tool) {
  return `
  const tool = ${JSON.stringify(tool)};
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 35;
  const lines = state.draft.split("\\n");
  const top = height - lines.length - 6;
  const rows = Array.from({length: height}, () => "");
  let cursorX;
  if (tool === "codex") {
    lines.forEach((line, i) => rows[top + i] = (i ? "  " : "\\x1b[1m›\\x1b[0m ") + (state.draft ? line : "\\x1b[2mAsk Codex to do anything\\x1b[0m"));
    rows[top + lines.length + 1] = "  probe default · ~/project";
    cursorX = 2 + lines.at(-1).length;
  } else {
    rows[top - 1] = "┃";
    lines.forEach((line, i) => rows[top + i] = "┃  " + (state.draft ? "\\x1b[38;2;238;238;238m" + line + "\\x1b[38;2;255;255;255m " : "\\x1b[38;2;128;128;128mAsk anything… test\\x1b[38;2;255;255;255m"));
    rows[top + lines.length] = "┃";
    rows[top + lines.length + 1] = "┃  Build · Probe";
    rows[top + lines.length + 2] = "╹▀▀▀▀▀▀▀▀▀▀▀▀▀";
    cursorX = 3 + lines.at(-1).length;
  }
  process.stdout.write("\\x1b[2J" + rows.map((row, i) => "\\x1b[" + (i + 1) + ";1H" + row).join("") + "\\x1b[" + (top + lines.length) + ";" + (cursorX + 1) + "H");
  return;
  `;
}
