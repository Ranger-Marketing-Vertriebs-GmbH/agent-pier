import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";

// Claude shows its own permission dialog while a PermissionRequest hook waits.
// Deny or Esc there aborts the hook, but an approval does not: the hook would
// keep the chat request (and held chat messages) alive. Claude records the
// tool call and later its result in the session transcript, so the waiting
// hook watches that file to learn about a decision made in the terminal.
const tailBytes = 4 * 1024 * 1024;
const lineChars = 1024 * 1024;
// Claude appends a few bookkeeping lines after the tool call before it asks.
// Only that many trailing lines of the initial read may hold this hook's call;
// an older identical call without a result is an orphan of an earlier run.
export const recentLines = 10;

export function watchNativeDecision({
  transcriptPath,
  toolName,
  toolInput,
  onMatched = () => {},
  onSettled,
  interval = 500,
}) {
  if (
    typeof transcriptPath !== "string" ||
    !path.isAbsolute(transcriptPath) ||
    !transcriptPath.endsWith(".jsonl") ||
    typeof toolName !== "string"
  )
    return () => {};
  let offset = null,
    decoder,
    partial,
    candidates,
    resolved,
    target = null,
    matched = false,
    stopped = false,
    timer;
  // Starts (or restarts) reading at the tail window of the current file.
  const restart = (size) => {
    offset = Math.max(0, size - tailBytes);
    decoder = new StringDecoder("utf8");
    partial = "";
    candidates = [];
    resolved = new Set();
    target = null;
  };
  const consider = (line, eligible) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (
        entry.type === "assistant" &&
        part?.type === "tool_use" &&
        typeof part.id === "string" &&
        part.name === toolName &&
        isDeepStrictEqual(part.input, toolInput)
      )
        candidates.push({ id: part.id, eligible });
      if (entry.type === "user" && part?.type === "tool_result")
        resolved.add(part.tool_use_id);
    }
  };
  const read = async () => {
    const handle = await fs.open(transcriptPath, "r");
    let initial = false;
    try {
      const { size } = await handle.stat();
      if (offset === null || size < offset) {
        // First read, or a rewritten (shorter) transcript: forget what was
        // seen and judge only the tail of the current file.
        restart(size);
        initial = true;
      }
      if (size > offset) {
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        offset = size;
        // The decoder keeps a multibyte character split across reads intact.
        const lines = (partial + decoder.write(buffer)).split("\n");
        partial = lines.pop();
        if (partial.length > lineChars) partial = "";
        lines.forEach((line, index) => {
          if (line) consider(line, !initial || index >= lines.length - recentLines);
        });
      }
    } finally {
      await handle.close();
    }
    if (target && resolved.has(target)) return true;
    // The call this hook guards is the latest eligible one still unanswered.
    // Re-evaluated on every read: a later append can supersede a guess.
    target = candidates.findLast((c) => c.eligible && !resolved.has(c.id))?.id ?? null;
    if (target && !matched) {
      matched = true;
      onMatched(target);
    }
    return false;
  };
  const tick = async () => {
    let settled = false;
    try {
      settled = await read();
    } catch {
      // A missing or unreadable transcript only disables this shortcut.
    }
    if (stopped) return;
    if (settled) {
      stopped = true;
      onSettled();
      return;
    }
    timer = setTimeout(tick, interval);
    timer.unref?.();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
