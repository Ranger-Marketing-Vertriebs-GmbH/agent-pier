import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

// Claude shows its own permission dialog while a PermissionRequest hook waits.
// Deny or Esc there aborts the hook, but an approval does not: the hook would
// keep the chat request (and held chat messages) alive. Claude records the
// tool call and later its result in the session transcript, so the waiting
// hook watches that file to learn about a decision made in the terminal.
const tailBytes = 4 * 1024 * 1024;
const lineBytes = 1024 * 1024;

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
    partial = "",
    target = null,
    stopped = false,
    timer;
  const candidates = [],
    resolved = new Set();
  const consider = (line) => {
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
        candidates.push(part.id);
      if (entry.type === "user" && part?.type === "tool_result")
        resolved.add(part.tool_use_id);
    }
  };
  const read = async () => {
    const handle = await fs.open(transcriptPath, "r");
    try {
      const { size } = await handle.stat();
      if (offset === null) offset = Math.max(0, size - tailBytes);
      if (size < offset) {
        // A rewritten transcript starts over; never treat it as a decision.
        offset = 0;
        partial = "";
      }
      if (size === offset) return false;
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      offset = size;
      const lines = (partial + buffer.toString("utf8")).split("\n");
      partial = lines.pop();
      if (partial.length > lineBytes) partial = "";
      for (const line of lines) if (line) consider(line);
    } finally {
      await handle.close();
    }
    if (!target) {
      // The call this hook guards is the latest matching one still unanswered.
      target = candidates.findLast((id) => !resolved.has(id)) ?? null;
      if (target) onMatched(target);
    }
    return Boolean(target && resolved.has(target));
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
