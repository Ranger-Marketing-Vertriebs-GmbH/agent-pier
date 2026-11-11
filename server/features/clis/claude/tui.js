// How AgentPier reads the Claude Code terminal: activity, composer, model picker
// and limit warnings. Pure screen parsing; the shared callers dispatch here.
import {
  claudeComposerBox,
  claudePlaceholder,
  colorlessScreen,
} from "../../sessions/claude-composer.js";
import {
  claudeChipsOnly,
  claudeImageDraft,
  waitForClaudeImages,
} from "../../sessions/claude-image-paste.js";
import { startupScreen } from "../../requests/claude-startup-prompts.js";
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

const border = (line) => /^\s*[─━]{8,}\s*$/.test(line);
const agentRow =
  /^\s*◯\s+\S[^\n]*(?:\s{2,}\d+[hms](?:\s+\d+[ms]){0,2}|\s+\d+[hms](?:\s+\d+[ms]){0,2}\s+·\s+↓\s+[\d.]+[kKmM]?\s+tokens)\s*$/;

/** `{ lines, original }`: the last screen rows, plain and styled. */
export function activity({ lines, original }) {
  const prompt = nativePromptRow(lines);
  if (prompt < 0) return { state: "unknown" };
  // Claude keeps the composer between rules, with live task controls below it.
  const lowerBorder = lines.findIndex(
    (line, index) => index > prompt && index < prompt + 8 && border(line),
  );
  if (!border(lines[prompt - 1] || "") || lowerBorder < 0) return { state: "unknown" };
  const nativeFooter = lines.slice(lowerBorder + 1).join("\n");
  // Narrow panes clip the footer hint, so the task panel header counts too.
  const panel = lines.findIndex(
    (line, index) => index > lowerBorder && /^\s*⏺\s+main\s*$/.test(line),
  );
  // The shell counter lasts for the task's lifetime and does not animate.
  if (/(?:^|·\s+)[1-9]\d*\s+shells?(?:\s+·|$)/m.test(nativeFooter))
    return { state: "working" };
  if (panel >= 0 || /↓ to manage/.test(nativeFooter)) {
    // Narrow rows replace the description column with a token counter.
    const agents = original.filter(
      (line, index) =>
        index > lowerBorder &&
        agentRow.test(lines[index]) &&
        /\x1b\[(?:\d+;)*38;/.test(line),
    );
    if (agents.length) return { state: "working", evidence: agents.join("\n") };
    // Listed agents in a layout this parser does not know must not read as ready.
    if (panel >= 0 && lines.some((line, index) => index > panel && /^\s*◯\s/.test(line)))
      return { state: "unknown" };
  }
  // The task panel may push the composer up; measure from where the panel starts.
  if (prompt < (panel >= 0 ? panel : lines.length) - 10) return { state: "unknown" };
  // Newer Claude versions expose interruption in the footer and may omit the
  // spinner timer or place effort/queued-input rows between it and the composer.
  if (/\besc to interrupt\b/i.test(nativeFooter)) {
    const status = lines.findLastIndex(
      (line, index) =>
        index < prompt - 1 &&
        index >= prompt - 12 &&
        /^[✻✽✶✳✢·*]\s+[^\n]{1,120}…/.test(line.trim()) &&
        /\x1b\[(?:\d+;)*38;/.test(original[index] || ""),
    );
    // Preserve color animation too: tool waits can leave the visible text fixed.
    return {
      state: "working",
      evidence: status >= 0 ? original[status] : nativeFooter,
    };
  }
  // Older modes expose a timed animated row directly above the composer.
  let index = prompt - 2;
  while (index >= 0 && !lines[index].trim()) index--;
  const status = lines[index]?.trim() || "";
  if (
    /^[✻✽✶✳✢·*]\s+[^\n]{1,120}…\s*\(\d+(?:h\s+\d+m\s+\d+s|m\s+\d+s|s)\s*[·•]/.test(
      status,
    ) &&
    /\x1b\[(?:\d+;)*38;/.test(original[index] || "")
  )
    return { state: "working", evidence: status, animated: true };
  return { state: "idle" };
}

/** `{ raw, lines, row, line, plain, pane }`: the screen around the cursor row. */
export function composer({ raw, lines, row, line, plain: text, pane }) {
  const rule = "─".repeat(pane.width || 0);
  if (
    !rule ||
    clean(lines[row - 1] || "") !== rule ||
    clean(lines[row + 1] || "") !== rule ||
    !text.startsWith("❯ ")
  )
    return unknownComposer();
  if (
    pane.cursorX === 2 &&
    (text === "❯ " ||
      (text === "❯  " && /\x1b\[7m(?:\x1b\[39m)? /.test(line)) ||
      claudePlaceholder(line, pane, { footer: lines[row + 2], screen: raw }))
  )
    return { state: "empty", text: "" };
  // Claude's own cursor cell, or the native terminal cursor after plain text.
  // Colored Claude resets the prompt character's color first; NO_COLOR and
  // FORCE_COLOR=0 emit no styling besides the cursor cell.
  const reset = colorlessScreen(raw) ? "" : "\x1b[39m";
  const draft = line.startsWith(`${reset}❯`)
    ? (/^❯ ([^\x1b]+)\x1b\[7m \x1b\[0m$/.exec(line.slice(reset.length))?.[1] ??
      /^❯[ \u00a0]([^\x1b]+)$/.exec(line.slice(reset.length))?.[1])
    : undefined;
  if (
    draft &&
    !/\[Pasted|[\x00-\x1f\x7f-\x9f]/.test(draft) &&
    pane.cursorX === 2 + draft.length &&
    pane.cursorX < pane.width - 1
  )
    return { state: "text", text: draft };
  return unknownComposer();
}

function parsePicker(raw) {
  const lines = styledLines(raw);
  const found = pickerTitle(lines, (title) => title === "Select model");
  if (!found) return null;
  const { start, kind } = found;
  // The native dialog footer must be the last content on screen. A model menu
  // quoted in an assistant response still has the real composer below it.
  // Claude wraps both its controls and descriptions at mobile terminal widths.
  const footer = pickerFooter(lines, start);
  if (!footer) return null;
  let selectKey = "Enter";
  if (/s to use this session only/i.test(footer)) selectKey = "s";
  if (/set as default/i.test(footer) && selectKey !== "s") return null;
  const { options, selected, current } = numberedOptions(lines, start, kind, {
    wrapped: true,
  });
  return pickerMenu(raw, {
    title: lines[start].text.trim(),
    kind,
    options,
    selected,
    current,
    selectKey,
  });
}

/** A picker that would only change the default model, never this session's. */
function unsupportedPicker(raw) {
  const lines = styledLines(raw);
  const title = lines.findLastIndex((line) => line.text.trim() === "Select model");
  const footer = pickerFooter(lines, title);
  return (
    title >= 0 &&
    !!footer &&
    /set as default/i.test(footer) &&
    !/s to use this session only/i.test(footer)
  );
}

function currentModel(raw) {
  const text = plain(raw);
  const header = text
    .match(
      /(?:^|\n)[^\n]*?((?:Opus|Sonnet|Haiku|Fable) [^·\n]+)\s*·\s*(?:Claude|API)/,
    )?.[1]
    ?.trim();
  if (header) return header;
  const changes = [...text.matchAll(/(?:Set model to|Current model:)\s+([^\n]+)/g)];
  if (changes.length)
    return changes
      .at(-1)[1]
      .replace(
        /\s+(?:for this session only|and saved as your default\b|with .+ effort).*$/,
        "",
      )
      .trim();
  return null;
}

function promptReady(raw) {
  if (pickerFooter(styledLines(raw))) return false;
  if (promptBlocking.test(plain(raw))) return false;
  const lines = styledLines(raw);
  const { index, footerText } = promptRow(lines);
  const hasFooter =
    promptFooterHints.test(footerText) ||
    /shift\+tab|bypass permissions|Opus|Sonnet|Haiku/i.test(footerText);
  if (index < 0 || index < lines.length - 10 || !hasFooter) return false;
  return true; // Alt+P preserves even a non-empty native draft.
}

/**
 * The model behind the name Claude Code displays, for a reload: an exact id, else a
 * label such as "Fable 5.2" or "Opus 4.7 (1M context)".
 *
 * An id that names the label's model exactly is kept as it is (a dated release, an
 * extended context the label does not show): first the model of the last response
 * (`observed`), then the one the session was launched with (`fallback`). Neither
 * needs to match: right after `/model`, and in a session without a response, the
 * last response names another model or none. The label then gives the id by the rule
 * Claude models follow since generation 4, `claude-<family>-<major>-<minor>`. A label
 * without a minor version ("Opus 4") or of an older generation has no such id and
 * stays unresolved unless an id confirms it.
 */
function resolveDisplayed(displayedModel, { observed, fallback, identifier }) {
  const exact = identifier(displayedModel);
  if (exact) return { modelId: exact };
  const label =
    /^(Opus|Sonnet|Haiku|Fable) (\d+)(?:\.(\d+))?( \(1M context\))?( \(default\))?$/i.exec(
      String(displayedModel),
    );
  if (!label) return undefined;
  const [, family, major, minor, extendedLabel] = label;
  const canonical = `claude-${family.toLowerCase()}-${major}${minor ? `-${minor}` : ""}`;
  const names = (id) => {
    const extended = id.endsWith("[1m]");
    const base = extended ? id.slice(0, -4) : id;
    const date = base.startsWith(canonical + "-") ? base.slice(canonical.length + 1) : "";
    return (base === canonical || /^\d{8}$/.test(date)) && (!extendedLabel || extended);
  };
  for (const id of [observed, identifier(fallback)])
    if (id && names(id)) return { modelId: id };
  if (minor && Number(major) >= 4)
    return { modelId: `${canonical}${extendedLabel ? "[1m]" : ""}` };
  return undefined;
}

export const modelPicker = {
  openKeys: [{ keys: ["M-p"] }],
  parse: parsePicker,
  current: currentModel,
  promptReady,
  unsupported: unsupportedPicker,
  resolveDisplayed,
};

const claudeLimit =
  "(?:session limit|weekly limit|Opus limit|Sonnet limit|Fable limit|usage|usage credits|usage limit|usage credit limit)";
const claudeWarning = new RegExp(
  `^(?:You've used (?:[1-9][0-9]|100)% of your ${claudeLimit}|Approaching ${claudeLimit}|You're close to your (?:usage limit|usage credit limit))(?: · [^\\r\\n]{1,500})?$`,
);
const claudeWrapUp =
  "Approaching your 5-hour usage limit — Claude will wrap up the current step.";

/** `{ raw, pane, lines }`: the visible screen. */
export function limitWarning({ raw, pane, lines }) {
  // Claude 2.1.x notifications live below its ruled composer. Transcript
  // quotes and drafts (even multiline drafts) are outside this region.
  const box = claudeComposerBox(raw, pane);
  if (!box || box.clipped) return [];
  const warnings = new Set();
  for (let row = box.bottom + 1; row < lines.length; row++) {
    let value = "";
    for (let end = row; end < Math.min(row + 6, lines.length); end++) {
      if (!lines[end].trim()) break;
      value += (value ? " " : "") + lines[end].trim();
      if (value.length > 700) break;
      if (claudeWarning.test(value) || value === claudeWrapUp) {
        warnings.add(value);
        break;
      }
    }
  }
  return warnings;
}

/**
 * `{ raw, styled, lines, row, pane, hashes }`: the hashes of the prompts Claude Code
 * queued above its composer; multi-row and clipped entries read as none.
 */
export function queuedInputs({ raw, styled, lines, row, pane, hashes }) {
  const values = [];
  // Narrow panes truncate the placeholder ("Press up to edit queu…").
  if (
    !claudePlaceholder(styled[row], pane, {
      queued: true,
      footer: styled[row + 2],
      screen: raw,
    })
  )
    return [];
  let index = row - 2;
  // Optional right-aligned native hint (effort, Ctrl+Y, …) or a blank row
  // above the ruled composer.
  if (
    /^\s*● \w+ · \/effort\s*$/.test(lines[index] || "") ||
    /^ {20,}\S[^\n]*$/.test(lines[index] || "")
  )
    index--;
  // Claude Code 2.1.2xx+: unindented rows, blank separators, send-now hint.
  const hint = sendNowHint(lines, lines[index]?.trim() ? index : index - 1);
  if (hint >= 0)
    return hashes(claudeQueue(styled, lines, hint - 1), pane, pane.width - 2);
  for (; index >= 0; index--) {
    const match = styled[index].match(
      /^  \x1b\[38;2;80;80;80m\x1b\[48;2;55;55;55m❯ \x1b\[38;2;255;255;255m([^\x1b]+)\x1b\[39m *\x1b\[49m$/,
    );
    if (!match) break;
    values.unshift(match[1]);
  }
  return hashes(values, pane);
}

const gray = "\x1b\\[38;2;153;153;153m";
const claudeHead = new RegExp(
  `^(?:\x1b\\[[0-9;]*m)*❯[ \u00a0]${gray}([^\x1b]+)\x1b\\[39m[ ]*(?:\x1b\\[49m)?$`,
);
const claudeContinuation = new RegExp(`^(?:\x1b\\[[0-9;]*m)*  ${gray}[^\x1b]*\x1b\\[39m`);
// NO_COLOR/FORCE_COLOR=0: the same layout without any styling.
const plainHead = /^❯[ \u00a0]([^\x1b]+?) *$/;
const plainContinuation = /^  \S[^\x1b]*$/;
const sendNow = "ctrl+x ctrl+s to send now";

/** Top row of the send-now hint ending at `end`; narrow panes wrap it. */
function sendNowHint(lines, end) {
  let text = "";
  for (let index = end; index >= Math.max(0, end - 3); index--) {
    if (!/^  \S/.test(lines[index])) return -1;
    text = text ? `${lines[index].trim()} ${text}` : lines[index].trim();
    if (text === sendNow) return index;
    if (!sendNow.endsWith(` ${text}`)) return -1;
  }
  return -1;
}

/** Queue rows above the send-now hint, bottom-up; multi-row entries stay unknown. */
function claudeQueue(styled, lines, start) {
  const colorless = !styled.some((line) => /\x1b\[[34]8;/.test(line));
  const head = colorless ? plainHead : claudeHead;
  const continuation = colorless ? plainContinuation : claudeContinuation;
  const values = [];
  let continued = false;
  for (let index = start; index >= 0; index--) {
    if (!lines[index].trim()) {
      // Entries are separated by exactly one blank row; a wider gap (or a
      // blank below a headless continuation) ends the queue region, so older
      // transcript prompts above a missing spinner row are never read.
      if (continued || !lines[index - 1]?.trim()) return values;
      continue;
    }
    if (continuation.test(styled[index])) {
      continued = true;
      continue;
    }
    const match = head.exec(styled[index]);
    if (!match) break;
    // A wrapped row and an embedded newline look alike: never confirm either.
    if (!continued) values.unshift(match[1]);
    continued = false;
  }
  return values;
}

/** A startup screen (folder trust, …) holds input until AgentPier answers it. */
/** Local commands that send no submit event; delivery confirms them by screen. */
export const localCommands = [
  "cost",
  "status",
  "clear",
  "compact",
  "context",
  "help",
  "model",
  "config",
];

export const blockingScreen = (raw, { cwd, started }) =>
  startupScreen(raw, cwd, { started });

/**
 * Claude Code shows pasted image paths as chips: one paste for every image, and
 * drafts compared with the chips in place of the paths.
 */
export const images = {
  pathText: (file) => file,
  wait: waitForClaudeImages,
  draft: claudeImageDraft,
  chipsOnly: claudeChipsOnly,
};
