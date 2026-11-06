import { normalizeChatText } from "../sessions/session-chat-input.js";
import { claudeComposerBox, claudeComposerState } from "../sessions/claude-composer.js";
import { nativePromptState } from "../sessions/native-prompt.js";
import { cliDefinition } from "../clis/catalog.js";

const HOOK_REASON_LIMIT = 500;

// Trailing blanks and the cursor cell never tell two prompts apart.
const comparable = (text) =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();

/**
 * What the native prompt box of `tool` holds: "empty", "ours" (exactly `text`)
 * or "foreign" (anything else, also an unreadable box or a dialog).
 */
function promptContent(tool, fresh, text) {
  const expected = comparable(text);
  // Claude (image chips) has its own prompt box reader; the others share one.
  if (cliDefinition(tool).capabilities.imagePaste) {
    const state = claudeComposerState(fresh.raw, fresh.pane, fresh.composer);
    if (state.state === "empty") return "empty";
    if (state.state === "text")
      return comparable(state.text) === expected ? "ours" : "foreign";
    if (state.state !== "draft" || state.placeholder) return "foreign";
    // Every row of the box sits behind a two-cell prompt or indent.
    const box = claudeComposerBox(fresh.raw, fresh.pane);
    if (!box || box.clipped) return "foreign";
    return comparable(box.rows.map((row) => row.slice(2)).join("\n")) === expected
      ? "ours"
      : "foreign";
  }
  const state = nativePromptState(tool, fresh);
  if (state.state === "empty") return "empty";
  if (state.state !== "draft") return "foreign";
  const shown = comparable(state.rows.join("\n"));
  // Codex wraps a long line without a newline; only a one-line text may join.
  const wrapped =
    !expected.includes("\n") && comparable(state.rows.join("")) === expected;
  return shown === expected || wrapped ? "ours" : "foreign";
}

/**
 * A hook blocked delivered `text` and the CLI may have put it back into its
 * prompt box. Clears the box only while it provably holds exactly that text:
 * "cleared", "empty" (nothing to clear) or "foreign" (left untouched, also when
 * the session cannot be read).
 */
export async function clearBlockedPrompt({ sessions, id, text }) {
  try {
    const expected = normalizeChatText(text);
    return await sessions.withChatInput(id, async (tx) => {
      let content = "foreign";
      const cleared = await tx.clearPrompt((fresh) => {
        content = promptContent(tx.session.tool, fresh, expected);
        return content === "ours";
      });
      if (content === "empty") return "empty";
      return cleared ? "cleared" : "foreign";
    });
  } catch {
    return "foreign";
  }
}

/** The hook's own reason as plain, bounded text, or undefined. */
export function hookReasonText(reason) {
  if (typeof reason !== "string") return undefined;
  const text = reason
    // Terminal styling, then any other control character.
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .trim()
    .slice(0, HOOK_REASON_LIMIT);
  return text || undefined;
}

/**
 * Turns a handed-off or uncertain receipt into a hook-blocked rejection. Its text
 * is released back to the composer only when the CLI prompt box is empty now.
 */
export function rejectBlocked(receipt, outcome, prompt) {
  const released = prompt !== "foreign";
  receipt.status = "rejected";
  receipt.reason = released ? "CHAT_HOOK_BLOCKED" : "CHAT_HOOK_BLOCKED_DRAFT";
  receipt.released = released;
  const hookReason = hookReasonText(outcome.reason);
  if (hookReason) receipt.hookReason = hookReason;
  else delete receipt.hookReason;
  delete receipt.waiting;
}
