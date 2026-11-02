// Screen helpers the CLI drivers' terminal readers share (see `<id>/tui.js`).
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export const plain = (value) => stripVTControlCharacters(value).replaceAll("\u00a0", " ");
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
/** Strips SGR styling only, keeping every other control sequence. */
export const clean = (text) => text.replace(/\x1b\[[0-9;:]*m/g, "");
export const unknownComposer = () => ({ state: "unknown", text: null });

// Preserve SGR emphasis: OpenCode marks the cursor with bold, not a text glyph.
export function styledLines(raw) {
  let bold = false,
    dim = false,
    bg = null,
    fg = null;
  const lines = [{ text: "", cells: [] }];
  for (const token of raw.matchAll(/\x1b\[([\d;]*)m|([^\x1b])/gu)) {
    if (token[1] !== undefined) {
      const codes = token[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const n = codes[i];
        if (n === 38 || n === 48) {
          const length = codes[i + 1] === 2 ? 4 : 2;
          const color = codes.slice(i + 1, i + length + 1).join(";");
          if (n === 48) bg = color;
          else fg = color;
          i += length;
          continue;
        }
        if (n === 0) {
          bold = false;
          dim = false;
          bg = null;
          fg = null;
        }
        if (n === 1) bold = true;
        if (n === 2) dim = true;
        if (n === 22) {
          bold = false;
          dim = false;
        }
        if (n === 39) fg = null;
        if (n === 49) bg = null;
        if (n >= 40 && n <= 47) bg = String(n);
        if (n >= 100 && n <= 107) bg = String(n);
      }
    } else if (token[2] === "\n") lines.push({ text: "", cells: [] });
    else {
      const ch = token[2] === "\u00a0" ? " " : token[2];
      lines.at(-1).text += ch;
      lines.at(-1).cells.push({ ch, bold, dim, bg, fg });
    }
  }
  return lines;
}

export function pickerFooter(lines, start = -1) {
  const index = lines.findLastIndex(
    (line, position) =>
      position > start &&
      /^\s*(?:(?:press )?enter to (?:confirm|set as default)|enter (?:select|confirm|default) · )/i.test(
        line.text,
      ),
  );
  if (index < 0) return null;
  const footer = lines
    .slice(index)
    .map((line) => line.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  // Codex 0.160 renders short key hints: "enter select · esc back" while a model
  // still needs an effort, "enter default · s session · esc back" on the last step.
  return /^(?:press )?enter to (?:confirm|set as default)(?: or | · (?:s to use this session only · )?)esc to (?:cancel|go back)$/i.test(
    footer,
  ) || /^enter (?:select|confirm|default) · (?:s session · )?esc back$/i.test(footer)
    ? footer
    : null;
}

/** The last line whose title `matches`: where the picker starts and what it selects. */
export function pickerTitle(lines, matches) {
  let start = -1,
    kind = "model";
  for (let i = 0; i < lines.length; i++) {
    const title = lines[i].text.trim();
    if (matches(title)) {
      start = i;
      kind = /Reasoning|variant/i.test(title) ? "effort" : "model";
    }
  }
  return start < 0 ? null : { start, kind };
}

/**
 * The numbered options of a Claude or Codex picker. `wrapped`: descriptions
 * continue on indented rows (Claude wraps them at mobile terminal widths).
 */
export function numberedOptions(lines, start, kind, { wrapped = false } = {}) {
  const options = [];
  let selected = null,
    current = null;
  let descriptionColumn = Infinity;
  for (let i = start + 1; i < lines.length; i++) {
    const row = lines[i].text.match(/^\s*([❯›>]?)\s*(\d+)\.\s+(.+)$/);
    if (!row) {
      const continuation = lines[i].text.match(/^(\s+)\S/);
      if (wrapped && continuation?.[1].length >= descriptionColumn)
        options.at(-1).description += " " + lines[i].text.trim();
      else descriptionColumn = Infinity;
      continue;
    }
    const [head, ...description] = row[3].split(/\s{2,}/);
    const separator = /\s{2,}\S/.exec(row[3]);
    descriptionColumn = separator
      ? lines[i].text.length - row[3].length + separator.index + separator[0].length - 1
      : Infinity;
    const marker = /✔|\(current\)/.test(head);
    const label = head
      .replace(/\s*[✔✓]/g, "")
      .replace(/\s*\(current\)/g, "")
      .trim();
    const id = String(options.length);
    options.push({
      id,
      label,
      description: description.join(" ").trim(),
      current: marker,
    });
    if (row[1]) selected = id;
  }
  const active = options.find((option) => option.current);
  if (active && kind === "model")
    current =
      active.description
        .match(/currently (.+?)\)\s*·/)?.[1]
        ?.replace(/\(1M context$/, "(1M context)") ||
      active.label.replace(/\s*\((?:default|recommended)\)/g, "");
  return { options, selected, current };
}

/** The parsed picker, or null when its options cannot be trusted. */
export function pickerMenu(
  raw,
  {
    title,
    kind,
    options,
    selected,
    current,
    selectKey = "Enter",
    searchQuery = "",
    emptyResults = false,
    searchable = false,
    screenSignature = false,
  },
) {
  if ((!emptyResults && (!options.length || selected === null)) || options.length > 100)
    return null;
  return {
    title,
    kind,
    options,
    selected,
    currentModel: current,
    searchable,
    searchQuery,
    selectKey,
    signature: digest(
      JSON.stringify({
        title,
        kind,
        options,
        selected,
        searchQuery,
        selectKey,
        raw: screenSignature ? plain(raw).slice(0, 16000) : undefined,
      }),
    ),
  };
}

export const promptBlocking =
  /Input disabled\.|Viewing sub-agent|waiting for approval|Do you (?:want|approve)|Enter to confirm/i;
export const promptFooterHints =
  /(?:for shortcuts|context left|context window|gpt-|codex-|auto mode|manual mode)/i;

/** Drops trailing blank rows from `lines`; the last `❯`/`›` prompt and the text below. */
export function promptRow(lines) {
  while (lines.length && !lines.at(-1).text.trim()) lines.pop();
  const index = lines.findLastIndex((line) => /^\s*[❯›](?:\s|$)/.test(line.text));
  const footerText = lines
    .slice(index + 1)
    .map((line) => line.text)
    .join("\n");
  return { index, footerText };
}

/**
 * Claude and Codex share one composer shape: a `❯`/`›` prompt row with the native
 * footer below it. The prompt row, or -1 while it is not the live composer.
 * `near`: how close to the bottom the prompt must be.
 */
export function nativePromptRow(lines, { near = Infinity } = {}) {
  const prompt = lines.findLastIndex((line) => /^\s*[❯›](?:\s|$)/.test(line));
  if (prompt < 0 || prompt < lines.length - near) return -1;
  const footer = lines.slice(prompt + 1).join("\n");
  if (
    !/(?:for shortcuts|context left|context window|gpt-|codex-|auto mode|manual mode|shift\+tab|bypass permissions|Opus|Sonnet|Haiku)/i.test(
      footer,
    )
  )
    return -1;
  if (/Input disabled\.|Viewing sub-agent/i.test(lines.slice(prompt).join("\n")))
    return -1;
  return prompt;
}
