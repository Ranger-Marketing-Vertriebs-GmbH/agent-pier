// An agent's pinboard in the owner app: the files the agent pinned for the owner,
// grouped in lists (web/features/assistants/pinboard/).
export const agentPinboardCopy = {
  title: "Pinboard",
  chat: "Chat",
  tabWithCount: (n) => (n > 0 ? `Pinboard (${n})` : "Pinboard"),
  switchLabel: "Chat or pinboard",
  open: "Open pinboard",
  close: "Close pinboard",
  empty: "Nothing pinned yet. Files your agent pins for you show up here.",
  from: (chat) => `from ${chat}`,
  archived: (title) => `${title} · done`,
  archivedGroup: "Done",
  fresh: "NEW",
  unavailable: "No longer available",
  kinds: {
    text: "Text",
    video: "Video",
    image: "Image",
    audio: "Audio",
    file: "File",
  },
  // The compact agent chat header: the work goal's sheet, the events button.
  header: {
    workSheet: "Work goal",
    events: (n) => `Events: ${n}`,
  },
  loadFailed: "The pinboard could not be loaded.",
  card: {
    counts: {
      updated: (n) => (n === 1 ? "1 file updated" : `${n} files updated`),
      added: (n) => `${n} added`,
      removed: (n) => `${n} removed`,
    },
    namesJoin: ", ",
  },
};
