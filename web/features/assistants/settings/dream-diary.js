// The Dream diary as the memory pages show it. A Hermes agent's diary comes as
// structured entries, newest first (hermes-dream-store.js); each is written here in
// the reader's language, and only the model's summary keeps its own. An OpenClaw
// agent's DREAMS.md, like every other note, is shown as written.

const fileNames = ["MEMORY.md", "USER.md"];

// What the night did, from its outcome and reason.
function outcomeLine(entry, copy) {
  if (entry.outcome === "applied") return copy.nightApplied;
  if (entry.outcome === "postponed") return copy.nightPostponed(entry.file);
  const discarded = copy.nightDiscarded[entry.reason];
  if (typeof discarded === "function") return discarded(entry.file);
  return typeof discarded === "string" ? discarded : copy.nightFailed;
}

function entryText(entry, copy) {
  const lines = [String(entry.night ?? ""), outcomeLine(entry, copy)];
  // Only an applied night changed the files: its counts and summary say how.
  if (entry.outcome !== "applied") return lines.join("\n");
  for (const name of fileNames)
    if (entry.counts?.[name]) lines.push(copy.nightCounts(name, entry.counts[name]));
  if (entry.summary) lines.push(String(entry.summary));
  return lines.join("\n");
}

/** The text the memory page shows for `file` (a read note), with `copy` the dreaming catalog. */
export function diaryText(file, copy) {
  if (Array.isArray(file?.entries))
    return file.entries.map((entry) => entryText(entry, copy)).join("\n\n");
  return file?.content ?? "";
}
