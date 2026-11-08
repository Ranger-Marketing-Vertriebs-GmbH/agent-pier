export const assistantDreamingCopy = {
  title: "Dreaming",
  enable: "Dream at night",
  description:
    "Once a night every permanent agent reviews its own conversations with its own model. An OpenClaw agent writes dream notes and a dream diary into its memory and may tidy MEMORY.md; a Hermes agent consolidates MEMORY.md and USER.md, keeps pinned entries word for word and notes each night in its dream diary. The last 7 versions are kept. A shared agent reviews all its users' chats into its shared memory, and its notes can quote them word for word. Temporary team members dream too.",
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
  diaryTruncated: (size) =>
    `The dream diary is ${size}. Only its newest entries are shown here; older ones are cut off.`,
  entries: "Entries",
  pinned: "Pinned",
  pin: (n) => `Pin entry ${n}`,
  unpin: (n) => `Unpin entry ${n}`,
  room: (chars, limit, pinnedChars) =>
    `${chars} of ${limit} characters, ${pinnedChars} pinned`,
  pinsHint: "Pinned entries are kept word for word when the agent dreams.",
  nightApplied: "Memory consolidated.",
  nightDiscarded: {
    pinLost: (file) =>
      `Discarded: a pinned entry in ${file} would have been lost. Nothing was changed.`,
    tooLarge: (file) =>
      `Discarded: ${file} would have been over its limit. Nothing was changed.`,
    unreadable: "Discarded: the agent's answer could not be read. Nothing was changed.",
  },
  nightPostponed: (file) =>
    `Postponed: ${file} changed during the dream. The next night tries again.`,
  nightFailed:
    "Not dreamed: the agent or its model was not available. The next night tries again.",
  nightCounts: (file, { added, merged, replaced, dropped }) =>
    `${file}: ${added} added, ${merged} merged, ${replaced} replaced, ${dropped} dropped`,
};
