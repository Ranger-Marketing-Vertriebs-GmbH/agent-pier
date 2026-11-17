// The rules behind OpenClaw's memory wiki surfaces (tests/unit/memory-wiki-web.test.js).

/**
 * Why `assistant` cannot keep a wiki, or null: "shared" (shared with users),
 * "userAgent" (a user's own), "taskMember" (a temporary team member) or "channelBot"
 * (its own Telegram bot serves other people). The server
 * refuses the same (server runtimes/openclaw/openclaw-options.js wikiRefusal).
 */
export function wikiLock(assistant) {
  if (assistant?.userAccess?.mode === "shared") return "shared";
  if (assistant?.userAccess) return "userAgent";
  if (assistant?.teamMemberId && assistant.lifetime !== "permanent") return "taskMember";
  // Its own Telegram bot serves other people (the view's ownChannelBot).
  if (assistant?.ownChannelBot) return "channelBot";
  return null;
}

/** The draft's options with the wiki `on` or off (off stores nothing). */
export const withWiki = (options, on) => {
  const { memoryWiki: _old, ...rest } = options || {};
  return on ? { ...rest, memoryWiki: true } : rest;
};

/** Whether the saved agent has its wiki page (the server names its runtime pages). */
export const wikiOpen = (assistant) =>
  Array.isArray(assistant?.runtimePages) && assistant.runtimePages.includes("wiki");
