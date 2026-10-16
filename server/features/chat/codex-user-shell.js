import { codexInputTime } from "./native-input-time.js";
import { shellOutput } from "./shell-output.js";

// Codex runs a TUI `!cmd` as its own turn (thread/shellCommand) and records no user
// message, only a commandExecution with source "userShell". Its `command` is shlex 1.3's
// join of [shell, "-lc", cmd]: words separated by one space, each built from bare runs,
// '…' chunks and "…" chunks with backslash escapes. Parse that linearly (POSIX rules).
function shellWords(text) {
  const words = [];
  let word = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === " ") {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= "";
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      word += text.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length && '$`"\\\n'.includes(text[j + 1]))
          j++;
        word += text[j];
      }
      if (j >= text.length) return null;
      i = j;
    } else if (char === "\\") {
      if (++i >= text.length) return null;
      word += text[i];
    } else word += char;
  }
  if (word !== null) words.push(word);
  return words;
}

// The live rollout tail keeps the core TurnItem argv (see codex-live-tail.js).
function userCommand(item) {
  const words = Array.isArray(item.argv)
    ? item.argv
    : typeof item.command === "string"
      ? shellWords(item.command)
      : null;
  const command = words?.length === 3 && words[1] === "-lc" ? words[2] : null;
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

/**
 * The command row as typed (`! cmd`, like Claude bash mode) and its shell output, or
 * null for agent commands and unrecognised shapes. The turn's UUIDv7 dates the command:
 * Codex creates that turn when it accepts the shell command.
 */
export function codexUserShellRows(item, id, turnId) {
  if (item?.source !== "userShell") return null;
  const command = userCommand(item);
  if (!command) return null;
  const at = ["string", "number"].includes(typeof item.timestamp)
    ? item.timestamp
    : codexInputTime(turnId);
  const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  const { content, omitted } = shellOutput({ output });
  const failed =
    (typeof item.exitCode === "number" && item.exitCode !== 0) ||
    ["failed", "declined"].includes(item.status);
  return [
    {
      id: `${id}:command`,
      role: "user",
      text: `! ${command}`,
      ...(at !== undefined && { timestamp: at }),
    },
    {
      id,
      role: "tool",
      toolName: "Command",
      shellOutput: true,
      status: failed ? "failed" : item.status === "completed" ? "completed" : "running",
      ...(Object.keys(omitted).length && { shellOmitted: omitted }),
      text: content,
    },
  ];
}
