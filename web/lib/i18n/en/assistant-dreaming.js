export const assistantDreamingCopy = {
  title: "Dreaming",
  enable: "Dream at night",
  description:
    "Once a night every permanent agent reviews its own conversations with its own model, writes dream notes and a dream diary into its memory and may tidy MEMORY.md (the last 7 versions are kept). A shared agent reviews all its users' chats into its shared memory, and its notes can quote them word for word. Temporary team members dream too.",
  hour: "Time",
  timeZone: (zone) => `Time in ${zone}.`,
  adoptZone: (zone) => `Use my time zone (${zone})`,
  confirmTitle: "Turn memory on for these agents?",
  confirmBody: (count) =>
    count === 1
      ? "Dreaming needs memory. 1 permanent agent does not remember information yet; it will be switched on for it."
      : `Dreaming needs memory. ${count} permanent agents do not remember information yet; it will be switched on for all of them.`,
  confirmAction: "Turn on memory and dreaming",
  busy: (names) =>
    `Dreaming stays off: memory could not be switched on for agents that are working right now (${names}). Save again when they are done.`,
  memoryLocked:
    "Dreaming is on: every permanent agent keeps its memory. Switch it off under Agents › Runtime › Dreaming.",
  diary: "Dream diary",
  diaryHint: "Written by the agent's nightly dreaming. Read only.",
  moreNotes: (count) => (count === 1 ? "Load 1 more note" : `Load ${count} more notes`),
};
