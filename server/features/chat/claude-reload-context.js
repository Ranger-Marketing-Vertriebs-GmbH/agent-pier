import fs from "node:fs";
import readline from "node:readline";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { text } from "./observability-values.js";

/**
 * Stream a Claude transcript of any size and keep only what a reload needs:
 * the conversation identity and the model of the latest main-thread API reply.
 */
export async function readClaudeReloadContext(file, session, id) {
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let metadata = null,
    modelId = null;
  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // The CLI may be in the middle of appending a record.
    }
    if (!record || typeof record !== "object" || record.isSidechain) continue;
    if (!metadata && record.cwd && record.sessionId) metadata = record;
    const message = record.message;
    if (
      record.type === "assistant" &&
      !record.isMeta &&
      !record.isCompactSummary &&
      message?.usage &&
      Object.hasOwn(message.usage, "input_tokens") &&
      typeof message.model === "string"
    )
      modelId = message.model;
  }
  if (!metadata) throw problem(serverMessages.chat.sessionHistoryBeingWritten, 404);
  if (metadata.cwd !== session.cwd || metadata.sessionId !== id)
    throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
  return { observability: { context: { modelId: text(modelId, 200) || null } } };
}
