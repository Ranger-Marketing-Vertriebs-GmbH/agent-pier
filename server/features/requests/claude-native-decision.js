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

// A subagent's hook names the session transcript, but Claude records the
// subagent's calls in `<session>/subagents/agent-<agent_id>.jsonl`. Only a plain
// token is joined into the path, so the result stays inside the session folder.
// Claude's hook docs show the id both bare (`def456`) and as `agent-abc123`;
// the file name adds the prefix once, so an existing prefix is dropped first.
const agentIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export function subagentTranscriptPath(transcriptPath, rawId) {
  const agentId = typeof rawId === "string" ? rawId.replace(/^agent-/, "") : rawId;
  if (
    typeof transcriptPath !== "string" ||
    !path.isAbsolute(transcriptPath) ||
    !transcriptPath.endsWith(".jsonl") ||
    typeof agentId !== "string" ||
    !agentIdPattern.test(agentId)
  )
    return null;
  return path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, ".jsonl"),
    "subagents",
    `agent-${agentId}.jsonl`,
  );
}

/**
 * Watches the transcript until Claude decided this hook's call itself. `onSettled`
 * hears why: `native` once the call (or, while no exact call is known, the
 * latest open call of the same tool) has a result, which Claude also records for
 * a denial; `stale` once another assistant message makes a call after the open
 * call of the same tool that stands in for this hook's, so Claude moved on and no
 * dialog can still wait for this one. Without such a call nothing is stale: the
 * hook may start before Claude wrote its message, whose calls arrive one by one.
 */
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
    // Calls of the same tool, whatever their input: the fallback while no exact
    // match exists (Claude may record the input differently than the hook sees it).
    similar,
    // Results appended after the first read.
    resolvedLater,
    // The latest open call of the same tool and the message it belongs to. Only a
    // call of another message after it shows that Claude moved on: a message
    // streams several calls before running them, in any order around this one.
    anchor,
    moved,
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
    similar = [];
    resolved = new Set();
    resolvedLater = new Set();
    anchor = null;
    moved = false;
    target = null;
  };
  const consider = (line, eligible, initial) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return;
    const message = entry.message.id;
    for (const part of content) {
      if (entry.type === "assistant" && part?.type === "tool_use") {
        const exact =
          typeof part.id === "string" &&
          part.name === toolName &&
          isDeepStrictEqual(part.input, toolInput);
        if (exact) candidates.push({ id: part.id, eligible });
        if (typeof part.id === "string" && part.name === toolName) {
          similar.push({ id: part.id, eligible });
          if (eligible) anchor = { id: part.id, message };
        } else if (
          !initial &&
          anchor &&
          !resolved.has(anchor.id) &&
          anchor.message !== message
        )
          moved = true;
      }
      if (entry.type === "user" && part?.type === "tool_result") {
        resolved.add(part.tool_use_id);
        if (!initial) resolvedLater.add(part.tool_use_id);
      }
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
          if (line)
            consider(line, !initial || index >= lines.length - recentLines, initial);
        });
      }
    } finally {
      await handle.close();
    }
    if (target && resolved.has(target)) return "native";
    // The call this hook guards is the latest eligible one still unanswered.
    // Re-evaluated on every read: a later append can supersede a guess.
    target = candidates.findLast((c) => c.eligible && !resolved.has(c.id))?.id ?? null;
    if (target && !matched) {
      matched = true;
      onMatched(target);
    }
    if (target) return null;
    // No exact call: a later result for an open call of the same tool decided it.
    if (similar.some((c) => c.eligible && resolvedLater.has(c.id))) return "native";
    return moved ? "stale" : null;
  };
  const tick = async () => {
    let settled = null;
    try {
      settled = await read();
    } catch {
      // A missing or unreadable transcript only disables this shortcut until
      // it appears: a subagent's file may not exist yet when its hook starts.
    }
    if (stopped) return;
    if (settled) {
      stopped = true;
      onSettled(settled);
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
