import { stripVTControlCharacters } from "node:util";
import { inspectChatComposer } from "../sessions/session-chat-input.js";
import { claudeComposerBox } from "../sessions/claude-composer.js";

// Native Codex warning cell (0.157.x). Require its warning color and glyph,
// never search ordinary transcript prose or a typed prompt for keywords.
const codexHead = /^(?:\x1b\[[0-9;]*m)*\x1b\[(?:33|93|38;5;3|38;5;11)m⚠ /;
const codexWarning =
  /^⚠ (Heads up, you have less than (?:[1-9]|[1-9][0-9])% of your [a-zA-Z0-9 ()-]{1,60} limit left\. Run \/status for a breakdown\.)$/;
const claudeLimit =
  "(?:session limit|weekly limit|Opus limit|Sonnet limit|Fable limit|usage|usage credits|usage limit|usage credit limit)";
const claudeWarning = new RegExp(
  `^(?:You've used (?:[1-9][0-9]|100)% of your ${claudeLimit}|Approaching ${claudeLimit}|You're close to your (?:usage limit|usage credit limit))(?: · [^\\r\\n]{1,500})?$`,
);
const claudeWrapUp =
  "Approaching your 5-hour usage limit — Claude will wrap up the current step.";

/** Only currently visible native warnings; no scrollback, inferred thresholds or history writes. */
export function nativeLimitWarnings(tool, raw, pane) {
  if (
    !["codex", "claude"].includes(tool) ||
    typeof raw !== "string" ||
    raw.length > 256 * 1024 ||
    !Number.isInteger(pane?.height) ||
    pane.height < 1 ||
    !Number.isInteger(pane?.cursorY) ||
    pane.cursorY < 0 ||
    pane.cursorY >= pane.height
  )
    return [];
  const styled = raw.split("\n").slice(0, pane.height);
  const lines = styled.map(stripVTControlCharacters);
  const warnings = new Set();
  if (tool === "codex") {
    if (["unknown", "dialog"].includes(inspectChatComposer(tool, raw, pane).state))
      return [];
    for (let row = 0; row < pane.cursorY; row++) {
      if (!codexHead.test(styled[row])) continue;
      let value = "";
      for (let end = row; end < Math.min(row + 6, pane.cursorY); end++) {
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
  } else {
    // Claude 2.1.x notifications live below its ruled composer. Transcript
    // quotes and drafts (even multiline drafts) are outside this region.
    const box = claudeComposerBox(raw, pane);
    if (!box || box.clipped) return [];
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
  }
  return [...warnings].slice(0, 3);
}
