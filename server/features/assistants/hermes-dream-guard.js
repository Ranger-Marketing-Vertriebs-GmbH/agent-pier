import {
  hermesMemoryChars as memoryChars,
  hermesMemoryEntries as memoryEntries,
  hermesMemoryLimits as memoryLimits,
  hermesPinnedEntries as pinnedEntries,
} from "./runtimes/runtime-for.js";

const files = Object.keys(memoryLimits);

/**
 * The deterministic check on a night's result, before anything is written. Every
 * pinned entry of the start state (`before`) must stand word for word in the same
 * file of `after`, and each file must fit its hard limit. The 80 % target of the
 * dream prompt is not checked: pins alone may exceed it. `before` and `after` are
 * `{ "MEMORY.md": string, "USER.md": string }`.
 */
export function dreamGuard(before, after) {
  for (const file of files) {
    const kept = new Set(memoryEntries(after[file]));
    if (pinnedEntries(before[file]).some((pin) => !kept.has(pin))) {
      return { ok: false, reason: "pinLost", file };
    }
    if (memoryChars(after[file]) > memoryLimits[file]) {
      return { ok: false, reason: "tooLarge", file };
    }
  }
  return { ok: true };
}
