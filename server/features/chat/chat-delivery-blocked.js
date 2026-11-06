import { normalizeChatText } from "../sessions/session-chat-input.js";
import { claudeComposerBox, claudeComposerState } from "../sessions/claude-composer.js";
import { nativePromptState } from "../sessions/native-prompt.js";
import {
  claudeComposerImages,
  claudeImageMessage,
} from "../sessions/claude-image-paste.js";
import { nativeComposerImages } from "../sessions/native-image-paste.js";
import { cliDefinition } from "../clis/catalog.js";

const HOOK_REASON_LIMIT = 500;

// Trailing blanks and the cursor cell never tell two prompts apart.
const comparable = (text) =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();

const chip = /\[Image\s+#?\s*\d+\]/g;

/**
 * Whether prompt `content` showing `chips` image chips is exactly the delivery:
 * one chip per image path of `message` and, around them, its remaining text.
 * `joined` is the same box with wrapped rows joined (Codex), or null.
 */
function sameDelivery(content, joined, chips, text, message) {
  if (chips === null || /\[Pasted/.test(content)) return false;
  if (chips !== (message?.images.length ?? 0)) return false;
  // Chips are attachment tokens; their separators are not user text.
  const rest = (value) =>
    comparable(message ? value.replace(chip, "").replace(/^\s+/, "") : value);
  const expected = comparable(message ? message.text : text);
  return (
    rest(content) === expected ||
    (joined !== null && !expected.includes("\n") && rest(joined) === expected)
  );
}

/**
 * What the native prompt box of `tool` holds: "empty", "ours" (exactly the
 * delivered `text`, its image paths shown as chips) or "foreign" (anything else,
 * also an unreadable box or a dialog). `message` is claudeImageMessage(text).
 */
function promptContent(tool, fresh, text, message) {
  const verdict = (same) => (same ? "ours" : "foreign");
  // Claude (image chips) has its own prompt box reader; the others share one.
  if (cliDefinition(tool).capabilities.imagePaste) {
    const state = claudeComposerState(fresh.raw, fresh.pane, fresh.composer);
    if (state.state === "empty") return "empty";
    const chips = claudeComposerImages(fresh.raw, fresh.pane);
    if (state.state === "text")
      return verdict(sameDelivery(state.text, null, chips, text, message));
    if (state.state !== "draft" || state.placeholder) return "foreign";
    // Every row of the box sits behind a two-cell prompt or indent.
    const box = claudeComposerBox(fresh.raw, fresh.pane);
    if (!box || box.clipped) return "foreign";
    const content = box.rows.map((row) => row.slice(2)).join("\n");
    return verdict(sameDelivery(content, null, chips, text, message));
  }
  const state = nativePromptState(tool, fresh);
  if (state.state === "empty") return "empty";
  if (state.state !== "draft") return "foreign";
  const chips = nativeComposerImages(tool, fresh.raw, fresh.pane);
  // Codex wraps a long line without a newline: a one-line text may join rows.
  return verdict(
    sameDelivery(state.rows.join("\n"), state.rows.join(""), chips, text, message),
  );
}

/**
 * A hook blocked delivered `text` and the CLI may have put it back into its
 * prompt box. Clears the box only while it provably holds exactly that text:
 * "cleared", "empty" (nothing to clear) or "foreign" (left untouched, also when
 * the session cannot be read). An empty box is read again after a settle, since
 * the CLI may refill it only after reporting the block.
 */
export async function clearBlockedPrompt({ sessions, id, text }) {
  try {
    const expected = normalizeChatText(text);
    const message = await claudeImageMessage(expected);
    return await sessions.withChatInput(id, async (tx) => {
      let content = "foreign";
      let rechecked = false;
      const cleared = await tx.clearPrompt((fresh) => {
        content = promptContent(tx.session.tool, fresh, expected, message);
        if (content === "empty" && !rechecked) {
          rechecked = true;
          return "recheck";
        }
        return content === "ours" ? "clear" : "keep";
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
