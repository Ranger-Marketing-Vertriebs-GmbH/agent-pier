// How AgentPier reads the Codex terminal: activity, composer, model picker and
// limit warnings. Pure screen parsing; the shared callers dispatch here.
import { currentCodexModel, codexModelFooter } from "../../models/codex-model-parser.js";
import { hookTrustScreen } from "../../requests/codex-hook-trust.js";
import {
  clean,
  nativePromptRow,
  numberedOptions,
  pickerFooter,
  pickerMenu,
  pickerTitle,
  plain,
  promptBlocking,
  promptFooterHints,
  promptRow,
  styledLines,
  unknownComposer,
} from "../tui-screen.js";

/** `{ lines, original }`: the last screen rows, plain and styled. */
export function activity({ lines, original }) {
  const prompt = nativePromptRow(lines, { near: 10 });
  if (prompt < 0) return { state: "unknown" };
  let index = prompt - 1;
  while (index >= 0 && !lines[index].trim()) index--;
  const status = lines[index]?.trim() || "";
  const styled = /\x1b\[(?:\d+;)*2(?:;\d+)*m/.test(original[index] || "");
  if (
    /^(?:[•●◦◉◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+[^\n]{1,140}|(?:Working|Thinking|Running|Reconnecting|Waiting for background terminal)[^\n]{0,100})\(\d+(?:h\s+\d+m\s+\d+s|m\s+\d+s|s)\s+[•·]\s+esc to interrupt\)/.test(
      status,
    ) &&
    styled
  )
    return { state: "working", evidence: status };
  if (/esc to interrupt/.test(status)) return { state: "unknown" };
  return { state: "idle" };
}

/** `{ lines, row, line, plain, pane }`: the screen around the cursor row. */
export function composer({ lines, row, line, plain: text, pane }) {
  if (
    !line.startsWith("\x1b[1m›\x1b[0m ") ||
    clean(lines[row + 1] || "").trim() ||
    !/^  .+ · .+/.test(clean(lines[row + 2] || ""))
  )
    return unknownComposer();
  if (/^\x1b\[1m›\x1b\[0m \x1b\[2m[^\x1b]+\x1b\[0m$/.test(line))
    return pane.cursorX === 2 ? { state: "empty", text: "" } : unknownComposer();
  const draft = text.slice(2);
  if (
    !draft ||
    /\[Pasted|[\x00-\x1f\x7f-\x9f]/.test(draft) ||
    text.length >= pane.width - 1 ||
    pane.cursorX !== text.length
  )
    return unknownComposer();
  return { state: "text", text: draft };
}

function parsePicker(raw) {
  const lines = styledLines(raw);
  const found = pickerTitle(lines, (title) =>
    /^Select (?:Model(?: and Effort)?|Reasoning Level for .+)$/.test(title),
  );
  if (!found) return null;
  const { start, kind } = found;
  // The native dialog footer must be the last content on screen. A model menu
  // quoted in an assistant response still has the real composer below it.
  if (!pickerFooter(lines, start)) return null;
  const { options, selected, current } = numberedOptions(lines, start, kind);
  return pickerMenu(raw, {
    title: lines[start].text.trim(),
    kind,
    options,
    selected,
    current,
  });
}

function promptReady(raw) {
  const text = plain(raw);
  const lines = styledLines(raw);
  const { index, footerText } = promptRow(lines);
  const codexFooter = codexModelFooter(text);
  const hasFooter = !!codexFooter || promptFooterHints.test(footerText);
  if (index < 0 || index < lines.length - 10 || !hasFooter) return false;
  // Codex keeps prior command output above the composer. Only its current
  // status row and composer/footer can block opening the native picker.
  // /model is available during Codex tasks; an interrupt hint is not a blocker.
  let status = index - 1;
  while (status >= 0 && !lines[status].text.trim()) status--;
  const current = [
    lines[status]?.text || "",
    ...lines.slice(index).map((line) => line.text),
  ].join("\n");
  if (promptBlocking.test(current)) return false;
  const prompt = lines[index];
  const offset = prompt.text.indexOf("›") + 1;
  // A newline at the start of a draft leaves the prompt row empty. Preserve
  // every continuation row up to the native footer before typing /model.
  const footer =
    codexFooter?.index > index
      ? codexFooter.index
      : lines.findLastIndex(
          (line, position) => position > index && promptFooterHints.test(line.text),
        );
  const chars = [
    ...prompt.cells.slice(offset),
    ...lines.slice(index + 1, footer).flatMap((line) => line.cells),
  ].filter((x) => x.ch.trim());
  return chars.length === 0 || chars.every((x) => x.dim);
}

/**
 * The model behind the name the picker displays, for a reload: a listed label or id
 * (`models` from history.models), else "<name> <effort>" with a reasoning effort.
 * Without a list only an exact id that `observed` or `fallback` confirms counts.
 */
function resolveDisplayed(
  displayedModel,
  { observed, fallback: fallbackModel, models: codexModels, identifier, unavailable },
) {
  const lookup = (name) => {
    const matches = new Set(
      (codexModels || [])
        .filter((model) => model.label === name || model.modelId === name)
        .map((model) => identifier(model.modelId))
        .filter(Boolean),
    );
    if (matches.size > 1) throw unavailable();
    if (matches.size) return [...matches][0];
    const exact = identifier(name);
    if (exact && (!codexModels || exact === observed || exact === fallbackModel))
      return exact;
    return undefined;
  };
  const exact = lookup(displayedModel);
  if (exact) return { modelId: exact };
  const codex = /^(.*?) (none|minimal|low|medium|high|xhigh|max|ultra)(?: effort)?$/.exec(
    displayedModel,
  );
  const modelId = codex && lookup(codex[1]);
  if (modelId) return { modelId, reasoningEffort: codex[2] };
  return undefined;
}

export const modelPicker = {
  // Codex coalesces rapid keystrokes as a paste burst, including a following Enter.
  openKeys: [{ type: "/model" }, { pauseMs: 250 }, { keys: ["Enter"] }],
  parse: parsePicker,
  current: (raw) => currentCodexModel(plain(raw)),
  promptReady,
  unsupported: () => false,
  resolveDisplayed,
};

// Native Codex warning cell (0.157.x). Require its bold/color styling and glyph,
// never search ordinary transcript prose or a typed prompt for keywords.
const codexHead = /^(?:\x1b\[[0-9;]*m)*\x1b\[(?:1|33|93|38;5;3|38;5;11)m⚠ /;
const codexWarning =
  /^⚠ (Heads up, you have less than (?:[1-9]|[1-9][0-9])% of your [a-zA-Z0-9 ()-]{1,60} limit left\. Run \/status for a breakdown\.)$/;

/** `{ styled, lines }`: the visible rows, styled and plain. */
export function limitWarning({ styled, lines }) {
  const warnings = new Set();
  for (let row = 0; row < lines.length; row++) {
    if (!codexHead.test(styled[row])) continue;
    let value = "";
    for (let end = row; end < Math.min(row + 6, lines.length); end++) {
      if (!lines[end].trim()) break;
      value += (value ? " " : "") + lines[end].trim();
      const match = codexWarning.exec(value);
      if (match) {
        warnings.add(match[1]);
        break;
      }
      if (value.length > 240) break;
    }
  }
  return warnings;
}

/**
 * `{ styled, lines, row, pane, hashes }`: the hashes of the inputs Codex queued
 * after the next tool call; incomplete, wrapped or restyled rows read as none.
 */
export function queuedInputs({ styled, lines, row, pane, hashes }) {
  const values = [];
  let end = row - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  let start = end;
  while (start >= 0 && /^  ↳ .+/.test(lines[start])) start--;
  let header = start;
  while (header >= Math.max(0, start - 3) && !styled[header].startsWith("\x1b[2m• "))
    header--;
  if (
    header < 0 ||
    !/^• Messages to be submitted after next tool call \(press esc to interrupt and send immediately\)$/.test(
      lines
        .slice(header, start + 1)
        .map((line) => line.trim())
        .join(" "),
    ) ||
    !styled[header]?.startsWith("\x1b[2m• ")
  )
    return [];
  for (let i = start + 1; i <= end; i++) {
    if (!/^\x1b\[2m  ↳ [^\x1b]+\x1b\[0m$/.test(styled[i])) return [];
    values.push(lines[i].slice(4));
  }
  return hashes(values, pane);
}

/**
 * `{ raw, pane }`: the native prompt box Codex draws (`empty` or `draft` with its
 * `rows`), `dialog` for a native selector, or undefined when neither shows.
 */
export function promptState({ raw, pane }) {
  const rows = raw.split("\n").slice(0, pane.height);
  const lines = rows.map(clean);
  const cursor = pane.cursorY;
  const start = rows.findLastIndex(
    (row, i) => i <= cursor && /^\x1b\[1m›\x1b\[0m /.test(row),
  );
  if (start >= 0) {
    const footer = lines.findLastIndex(
      (row, i) => i > start && /^  .+ · .+/.test(row) && !lines[i - 1]?.trim(),
    );
    const end = footer - 2;
    if (
      cursor >= start &&
      cursor <= end &&
      lines
        .slice(start + 1, end + 1)
        .every((row) => !row.trim() || row.startsWith("  ")) &&
      !lines[end + 1]?.trim() &&
      /^  .+ · .+/.test(lines[end + 2] || "")
    ) {
      const content = lines.slice(start, end + 1).map((row) => row.slice(2));
      const placeholder =
        start === end &&
        pane.cursorX === 2 &&
        /^\x1b\[1m›\x1b\[0m \x1b\[2m[^\x1b]+\x1b\[0m$/.test(rows[start]);
      return { state: placeholder ? "empty" : "draft", rows: content };
    }
  }
  // Native selectors end with this footer; a normal composer above wins.
  const bottom = lines
    .filter((row) => row.trim())
    .slice(-4)
    .join("\n");
  if (
    /\b(?:enter|esc)\b.*(?:select|confirm|continue|cancel|back|quit|deny|reject)/i.test(
      bottom,
    )
  )
    return { state: "dialog" };
  return undefined;
}

/** Codex wraps a pasted line without a newline: the rows joined end with the text. */
export const promptProof = (rows, text) =>
  rows.join("").endsWith(text.replaceAll("\n", ""));

/** The hook review screen holds input until AgentPier answers it. */
export const blockingScreen = (raw) => hookTrustScreen(raw);

/** Codex tokenizes bare paths on spaces; a quoted path remains one image. */
export const images = { pathText: (file) => JSON.stringify(file) };
