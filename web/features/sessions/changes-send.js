import {
  formatReviewBatch,
  reviewEntries,
} from "../../../server/features/changes/review-batch.js";
import { deliveryScope } from "../chat/chat-draft.js";
import { appendToComposer } from "../chat/composer-registry.js";
import { writeClipboard } from "../../lib/clipboard.js";

/** @typedef {import("../../../server/features/changes/review-anchor.js").Comment} Comment */
/** @typedef {import("../../../server/features/changes/diff-parse.js").DiffFile} DiffFile */

/**
 * The batch text of a session's open comments, relocated against `diffs` (keyed by
 * workspace id), and the ids of the comments it holds.
 * @param {Comment[]} comments
 * @param {Map<string, DiffFile[]>} diffs
 */
export function sessionBatch(comments, diffs) {
  const entries = reviewEntries(comments, diffs);
  return { text: formatReviewBatch(entries), ids: entries.map((entry) => entry.id) };
}

// Terminal-only and login sessions have no chat composer.
const hasChat = (session) => session.tool !== "shell" && session.purpose !== "login";

const isPromise = (value) => typeof value?.then === "function";

/**
 * Reads the diff of every workspace that holds open comments. `readDiff` may answer a
 * loaded diff directly; only when one is pending is there anything to await, so a
 * batch from the shown workspace alone keeps the click's clipboard permission.
 */
async function diffsOf(workspaces, readDiff) {
  const values = workspaces.map((workspace) => readDiff(workspace));
  const files = values.some(isPromise)
    ? await Promise.all(values.map((value) => Promise.resolve(value).catch(() => null)))
    : values;
  return new Map(
    workspaces.flatMap((workspace, index) =>
      files[index] ? [[workspace, files[index]]] : [],
    ),
  );
}

/**
 * Sends a session's open comments to its agent: appended to the chat composer (nothing
 * is sent until the owner sends), else copied to the clipboard, else returned to show.
 * Comments are marked sent only when the batch landed in the composer or clipboard.
 * @returns {Promise<{
 *   outcome: "appended" | "copied" | "shown" | "too-long" | "empty",
 *   batch?: number, text?: string, reason?: "locked" | "no-chat", error?: string,
 * }>}
 */
export async function sendBatch({
  session,
  comments,
  readDiff,
  markSent,
  clipboard = writeClipboard,
}) {
  const open = comments.filter((comment) => comment.status === "open");
  if (open.length === 0) return { outcome: "empty" };
  const workspaces = [...new Set(open.map((comment) => comment.workspace ?? ""))];
  const { text, ids } = sessionBatch(open, await diffsOf(workspaces, readDiff));
  const mark = async (result) => {
    try {
      const answer = await markSent(ids);
      return { ...result, batch: answer?.batch };
    } catch (error) {
      return { ...result, error: error?.message || String(error) };
    }
  };
  let reason = "no-chat";
  if (hasChat(session)) {
    const appended = await appendToComposer(deliveryScope(session), text);
    if (appended === "appended") return mark({ outcome: "appended" });
    if (appended === "too-long") return { outcome: "too-long" };
    if (appended === "locked") reason = "locked";
  }
  if (await clipboard(text)) return mark({ outcome: "copied", reason });
  return { outcome: "shown", reason, text };
}
