import { dreamGuard } from "./hermes-dream-guard.js";
import {
  dreamInput,
  hermesDreamInstructions,
  parseDream,
} from "./hermes-dream-prompt.js";
import {
  hermesMemoryChars as memoryChars,
  hermesMemoryLimits as memoryLimits,
} from "./runtimes/runtime-for.js";

/*
 * One nightly dream of one Hermes agent: both memory files read through the agent's
 * files port, backed up, consolidated by the agent's own model in one call outside any
 * session (sessions.reviewMemory), checked by the pin guard and written back over the
 * hashes read. Nothing of the memory reaches the log; only codes do.
 */
const fileNames = Object.keys(memoryLimits);
export const dreamMaxTokens = 8000;

const result = (outcome, reason = null, file = null, parsed = null) => ({
  outcome,
  reason,
  file,
  counts: parsed?.counts ?? null,
  chars: parsed
    ? Object.fromEntries(fileNames.map((name) => [name, memoryChars(parsed.files[name])]))
    : null,
  summary: parsed?.summary ?? "",
});

const expectation = (file) =>
  file.missing ? { expectedMissing: true } : { expectedHash: file.hash };

/**
 * Runs one dream: `{ outcome, reason, file, counts, chars, summary }` (see the task's
 * Outcome). `files` and `sessions` are the agent's runtime sub-ports (agentFiles and
 * sessions, agent-runtime.js), `agentId` its runtime id, `chats` the recent chats for
 * dreamInput. `admit` wraps the read phase and the write phase each, never the model
 * call; `backup(contents)` receives what was read (null for a missing file) before
 * anything is written. Never throws.
 */
export async function dreamOnce({
  files,
  sessions,
  agentId,
  chats,
  admit = (fn) => fn(),
  backup = () => {},
}) {
  let start;
  try {
    start = await admit(async () => {
      const read = {};
      for (const name of fileNames)
        read[name] = (await files.get({ agentId, name })).file;
      await backup(
        Object.fromEntries(
          fileNames.map((name) => [name, read[name].missing ? null : read[name].content]),
        ),
      );
      return read;
    });
  } catch (error) {
    return unavailable("read", error);
  }
  // The start state the entry ids are numbered from, and the guard's `before`.
  const before = Object.fromEntries(
    fileNames.map((name) => [name, start[name].missing ? "" : start[name].content]),
  );
  const request = {
    agentId,
    instructions: hermesDreamInstructions,
    input: dreamInput({ files: before, chats }),
    maxTokens: dreamMaxTokens,
  };
  let parsed;
  try {
    const ask = async () =>
      parseDream((await sessions.reviewMemory(request))?.text, before);
    // A broken answer is asked once more.
    parsed = (await ask()) ?? (await ask());
  } catch (error) {
    return unavailable("model", error);
  }
  if (!parsed) return result("failed", "unreadable");
  const verdict = dreamGuard(before, parsed.files);
  if (!verdict.ok) return result("discarded", verdict.reason, verdict.file, parsed);
  try {
    return await admit(() => write(files, agentId, start, before, parsed));
  } catch (error) {
    return unavailable("write", error);
  }
}

// Writes each changed file in order. When a later file fails, the earlier ones go
// back to their start content over the hash just written, so a night applies whole
// or not at all. A file the night created goes back as an empty file: the port has
// no delete, and Hermes reads an empty and a missing memory file the same way (no
// entries; tools/memory_tool_store.py `_read_raw_checked` reads a missing file as "").
async function write(files, agentId, start, before, parsed) {
  const written = [];
  for (const name of fileNames) {
    if (parsed.files[name] === before[name]) continue;
    try {
      const { file } = await files.set({
        agentId,
        name,
        content: parsed.files[name],
        ...expectation(start[name]),
      });
      written.push({ name, file });
    } catch (error) {
      await restore(files, agentId, written, before);
      if (error?.code === "CONFLICT") return result("conflict", "changed", name, parsed);
      throw error;
    }
  }
  return result("applied", null, null, parsed);
}

async function restore(files, agentId, written, before) {
  for (const { name, file } of written) {
    try {
      await files.set({ agentId, name, content: before[name], expectedHash: file.hash });
    } catch (error) {
      // Changed again meanwhile: the newer content stays.
      console.warn(
        "Hermes dream could not restore a memory file:",
        error?.code || "UNAVAILABLE",
      );
    }
  }
}

function unavailable(phase, error) {
  console.warn(`Hermes dream failed (${phase}):`, error?.code || "UNAVAILABLE");
  return result("failed", "unavailable");
}
