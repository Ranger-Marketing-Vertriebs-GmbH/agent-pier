// The memory wiki of an OpenClaw agent (Capabilities tab and its read page, ADR 0007
// step 7b): the runtime's own surfaces (web/features/assistants/runtimes/openclaw/).
export const assistantMemoryWikiCopy = {
  title: "Memory wiki",
  switch: "Keep a memory wiki",
  hint: "The agent keeps a wiki of pages with sources and claims beside its memory notes.",
  description:
    "The agent writes its wiki itself during its turns, with five wiki tools, and its memory notes (MEMORY.md, its daily notes and dream reports) are imported as source pages. No extra model calls: the wiki is compiled without a model. Switching on the first wiki restarts the agent service.",
  locked: {
    shared:
      "Only your own agents can keep a memory wiki, not an agent shared with users.",
    userAgent: "Only your own agents can keep a memory wiki, not a user's own agent.",
    taskMember:
      "Only your own agents can keep a memory wiki, not a temporary team member.",
    channelBot:
      "An agent whose own Telegram bot serves other people cannot keep a memory wiki: their messages would write lasting pages.",
  },
  open: "Read the wiki",
  openHint: "Its pages, read only",
  page: {
    pages: "Pages",
    empty: "No pages yet. The agent files pages with its wiki tools during its turns.",
    building: "The wiki is being compiled. It is shown in a moment.",
    count: (shown, total) => `${shown} of ${total} pages listed`,
    truncated: "Only the newest pages are listed.",
    updated: (time) => `Updated ${time}`,
    back: "All pages",
    cut: "This page is long; only its beginning is shown.",
    loading: "Loading the wiki …",
    unavailable: "The wiki cannot be read right now.",
    kinds: {
      synthesis: "Synthesis",
      entity: "Entity",
      concept: "Concept",
      source: "Source",
      report: "Report",
    },
  },
  search: {
    wiki: "Wiki",
    knowledge: "Knowledge wiki",
  },
};
