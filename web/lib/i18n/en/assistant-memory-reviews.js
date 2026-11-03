// The owner's card after a model switch's memory review, and the archive on the
// memory page (memory-reviews.js, memory-archive.js).
export const memoryReviewCopy = {
  title: "Memory after the model switch",
  switched: (from, to) => `From ${from} to ${to}`,
  hint: "An earlier model wrote these entries about what it refused or limited itself. Archive takes an entry out of the agent's memory; you can restore it on the memory page. Until you apply, the memory stays as it is.",
  entries: (count) => (count === 1 ? "1 entry" : `${count} entries`),
  choice: (file) => `Entry in ${file}`,
  archive: "Archive",
  keep: "Keep",
  apply: "Apply",
  applied: (archived, kept, changed) =>
    [
      `${archived} archived`,
      `${kept} kept`,
      changed ? `${changed} changed meanwhile and stayed in memory` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  archiveTitle: "Archive",
  archiveHint:
    "Entries you took out of the agent's memory after a model switch. The agent does not read them. Restore puts an entry back at the end of its file.",
  archiveEmpty: "No archived entries.",
  restore: "Restore",
  archived: (date) => `Archived ${date}`,
};
