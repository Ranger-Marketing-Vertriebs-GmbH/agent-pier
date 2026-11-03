// How AgentPier reads the OpenCode terminal: activity, composer and model picker.
// Pure screen parsing; the shared callers dispatch here.
import {
  clean,
  pickerMenu,
  pickerTitle,
  plain,
  promptBlocking,
  styledLines,
  unknownComposer,
} from "../tui-screen.js";

/** `{ lines, last, tail }`: the last screen rows, their last row and last eight. */
export function activity({ lines, last, tail }) {
  if (/enter\s+confirm/i.test(tail) && /Allow once\s+Allow always\s+Reject/.test(tail))
    return { state: "waiting" };
  const prompt = lines.findLastIndex((line) => /┃\s+[^·\n]+·\s+\S/.test(line));
  if (prompt < 0 || prompt < lines.length - 12) return { state: "unknown" };
  if (/\S[^\n]*\S[ \t]{2,}esc\s*$/.test(tail)) return { state: "unknown" };
  if (/\besc\s+(?:again to )?interrupt\b/.test(last))
    return { state: "working", evidence: last };
  if (/\bctrl\+p\s+commands\b/.test(last)) return { state: "idle" };
  return { state: "unknown" };
}

/** `{ lines, row, line, plain, pane }`: the screen around the cursor row. */
export function composer({ lines, row, line, plain: text, pane }) {
  const prefix = /^( *)┃  /.exec(text);
  if (!prefix) return unknownComposer();
  const indent = prefix[1];
  const blank = (value) => clean(value || "").trimEnd() === `${indent}┃`;
  if (
    !blank(lines[row - 1]) ||
    !blank(lines[row + 1]) ||
    !clean(lines[row + 2] || "").startsWith(`${indent}┃  `) ||
    !/^[^·\x00-\x1f\x7f-\x9f]+ · \S/.test(
      clean(lines[row + 2] || "").slice(indent.length + 3),
    ) ||
    !clean(lines[row + 3] || "").startsWith(`${indent}╹▀▀▀`)
  )
    return unknownComposer();
  const start = indent.length + 3;
  const draft = /\x1b\[38;2;238;238;238m([^\x1b]+)\x1b\[38;2;255;255;255m/.exec(
    line,
  )?.[1];
  if (
    draft &&
    !/\[Pasted|[\x00-\x1f\x7f-\x9f]/.test(draft) &&
    pane.cursorX === start + draft.length &&
    text.slice(start, start + draft.length) === draft &&
    /^ *$/.test(text.slice(start + draft.length)) &&
    pane.cursorX < pane.width - 1
  )
    return { state: "text", text: draft };
  if (pane.cursorX !== start) return unknownComposer();
  const content = text.slice(start).trimEnd();
  if (
    !content ||
    (content.startsWith("Ask anything… ") &&
      line.includes("\x1b[38;2;128;128;128mAsk anything… "))
  )
    return { state: "empty", text: "" };
  return unknownComposer();
}

function parsePicker(raw) {
  const lines = styledLines(raw);
  const found = pickerTitle(lines, (title) =>
    /\bSelect (?:model|variant)\s+esc\b/i.test(title),
  );
  if (!found) return null;
  const { start, kind } = found;
  const title = lines[start].text.match(/\bSelect (?:model|variant)(?=\s+esc\b)/i)[0];
  const options = [];
  let selected = null,
    current = null,
    searchQuery = "",
    emptyResults = false;
  const left = lines[start].text.indexOf(title) - 2;
  const right = lines[start].text.lastIndexOf("esc") + 3;
  const titleOffset = lines[start].text.indexOf(title);
  const background = lines[start].cells[titleOffset]?.bg;
  const crop = (line) => line?.cells.slice(Math.max(0, left), right) || [];
  const search = crop(lines[start + 2])
    .map((c) => c.ch)
    .join("")
    .trim();
  if (kind === "model") searchQuery = search === "Search" ? "" : search;
  let category = "";
  for (let i = start + 4; i < lines.length; i++) {
    const content = crop(lines[i]);
    const text = content
      .map((c) => c.ch)
      .join("")
      .trim();
    if (
      background !== null &&
      lines[i].cells[Math.max(0, titleOffset - 4)]?.bg !== background
    )
      break;
    if (/^No results(?: found)?$/i.test(text)) {
      emptyResults = true;
      break;
    }
    if (
      /^(?:Connect provider|View all providers|Popular providers|Favorite\s+ctrl)/i.test(
        text,
      )
    )
      break;
    if (!text) continue;
    const bold = content.filter((c) => c.bold && c.ch.trim());
    const highlighted = bold.some((c) => c.bg !== background);
    if (bold.length && !highlighted) {
      category = /^(?:Recent|Favorites|Recommended)$/.test(text) ? "" : text;
      continue;
    }
    const marker = text.startsWith("●");
    const cleaned = text.replace(/^●\s*/, "");
    const [label, ...description] = cleaned.split(/\s{2,}/);
    if (!label || label === "Search") continue;
    const id = String(options.length);
    options.push({
      id,
      label,
      description: [category, ...description].filter(Boolean).join(" · "),
      current: marker,
    });
    if (highlighted) selected = id;
    if (marker && kind === "model") current = label;
  }
  return pickerMenu(raw, {
    title,
    kind,
    options,
    selected,
    current,
    searchQuery,
    emptyResults,
    searchable: kind === "model",
    screenSignature: true,
  });
}

function promptReady(raw) {
  const text = plain(raw);
  if (promptBlocking.test(text)) return false;
  return (
    /┃.+·/.test(text) &&
    /(?:ctrl\+p\s+commands|(?:^|\n)\s*esc\s+(?:again to )?interrupt\b)/.test(
      text.trimEnd(),
    ) &&
    !/\S[^\n]*\S[ \t]{2,}esc(?:\s|$)/m.test(text)
  );
}

export const modelPicker = {
  openKeys: [{ keys: ["C-x", "m"] }],
  parse: parsePicker,
  current: (raw) =>
    plain(raw)
      .match(/┃\s+[^·\n]+·\s+([^\n┃]+)/)?.[1]
      ?.trim() || null,
  promptReady,
  unsupported: () => false,
};

/** OpenCode shows no limit warnings AgentPier relays. */
export const limitWarning = () => [];

/** `{ styled, lines, row, pane, hashes }`: the hashes of OpenCode's QUEUED prompts. */
export function queuedInputs({ styled, lines, row, pane, hashes }) {
  const values = [];
  for (let i = 1; i < row - 3; i++) {
    if (!/^\s*┃\s+QUEUED\s*$/.test(lines[i]) || !/\x1b\[1m/.test(styled[i])) continue;
    const match = styled[i - 1].match(
      /\x1b\[38;2;238;238;238m([^\x1b]+)\x1b\[38;2;255;255;255m/,
    );
    if (
      match &&
      /^\s*┃\s*$/.test(lines[i - 2] || "") &&
      /^\s*┃\s*$/.test(lines[i + 1] || "")
    )
      values.push(match[1]);
  }
  return hashes(values, pane);
}

/**
 * `{ raw, pane }`: the prompt box at the cursor (`empty` or `draft` with its `rows`),
 * `dialog` for a permission or selection dialog, otherwise `unknown`.
 */
export function promptState({ raw, pane }) {
  const rows = raw.split("\n").slice(0, pane.height);
  const lines = rows.map(clean);
  const cursor = pane.cursorY;
  const footer = lines
    .filter((row) => row.trim())
    .slice(-5)
    .join(" ");
  const dialog =
    lines.slice(-14).some((row) => /^ *┃ +△ Permission required *$/.test(row)) ||
    (/┃/.test(footer) &&
      /enter\s+confirm/.test(footer) &&
      /Allow once|Reject|select/.test(footer)) ||
    rows.some((row) => /\x1b\[1m/.test(row) && /^ +\S.* +esc *$/.test(clean(row)));
  const unreadable = () => (dialog ? { state: "dialog" } : { state: "unknown" });
  // Prefer the active prompt to old permission output in the transcript.
  const prefix = /^( *)┃  /.exec(lines[cursor] || "");
  if (!prefix) return unreadable();
  const indent = prefix[1];
  const border = `${indent}┃`;
  let top = cursor,
    bottom = cursor;
  while (
    top > 0 &&
    lines[top - 1].startsWith(border) &&
    lines[top - 1].trimEnd() !== border
  )
    top--;
  while (
    bottom + 1 < lines.length &&
    lines[bottom + 1].startsWith(border) &&
    lines[bottom + 1].trimEnd() !== border
  )
    bottom++;
  if (
    lines[top - 1]?.trimEnd() !== border ||
    lines[bottom + 1]?.trimEnd() !== border ||
    !lines[bottom + 2]?.startsWith(`${border}  `) ||
    !/ · \S/.test(lines[bottom + 2]) ||
    !lines[bottom + 3]?.startsWith(`${indent}╹▀▀▀`)
  )
    return unreadable();
  const content = lines
    .slice(top, bottom + 1)
    .map((row) => row.slice(indent.length + 3).trimEnd());
  const placeholder =
    top === bottom &&
    pane.cursorX === indent.length + 3 &&
    (!content[0] || rows[top].includes("\x1b[38;2;128;128;128mAsk anything… "));
  return { state: placeholder ? "empty" : "draft", rows: content };
}

/** OpenCode recognizes a paste holding exactly one bare image path. */
export const images = { pathText: (file) => file };
