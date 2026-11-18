// The owner's last known agent list on this device, so a page that opens while
// AgentPier or its agents cannot be reached still lists the agents (marked as last
// known) instead of none. One entry in localStorage: the agent.list value as the
// server sent it to this browser (it never carries credentials), minus the chats of
// users' own agents, whose owner access may end while the device is offline. The
// entry belongs to one login and one build: another login marker
// (`agentpier-auth-change`, written on every login and logout), another build or
// version, or a logout (LoginGate's forgetUser) drops it, as for the chat cache.
import { currentBuild } from "../../lib/build-check.js";

export const AGENT_LIST_KEY = "agentpier.agent-list.v1";
const VERSION = 1;
const AUTH_KEY = "agentpier-auth-change";
// Larger lists are not kept; the page then starts empty, as before.
export const MAX_CACHED_CHARS = 1_500_000;

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const loginMarker = (store) => {
  try {
    return store.getItem(AUTH_KEY) ?? null;
  } catch {
    return null;
  }
};

/** What of a pushed or read list is kept: users' own agents lose their chats. */
export function cachedListOf(list) {
  const assistants = Array.isArray(list?.assistants) ? list.assistants : [];
  const theirs = new Set(
    assistants.filter((agent) => agent?.userAccess?.mode === "own").map((a) => a.id),
  );
  const conversations = Array.isArray(list?.conversations)
    ? list.conversations.filter((chat) => !theirs.has(chat?.assistantId))
    : [];
  return { ...list, assistants, conversations };
}

/** Keeps `list` (with its `runtime`) for this login; never throws. */
export function saveAgentList(list, { store = storage(), build = currentBuild() } = {}) {
  if (!store || !list || !Array.isArray(list.assistants)) return false;
  try {
    const text = JSON.stringify({
      version: VERSION,
      build,
      auth: loginMarker(store),
      savedAt: Date.now(),
      list: cachedListOf(list),
    });
    if (text.length > MAX_CACHED_CHARS) {
      store.removeItem(AGENT_LIST_KEY);
      return false;
    }
    store.setItem(AGENT_LIST_KEY, text);
    return true;
  } catch {
    // Full or blocked storage: the list stays in memory only.
    return false;
  }
}

/** The kept list of this login and build, or null. A stale entry is removed. */
export function readAgentList({ store = storage(), build = currentBuild() } = {}) {
  if (!store) return null;
  let entry;
  try {
    entry = JSON.parse(store.getItem(AGENT_LIST_KEY) || "null");
  } catch {
    entry = undefined;
  }
  if (entry === null) return null;
  const valid =
    entry?.version === VERSION &&
    entry.build === build &&
    entry.auth === loginMarker(store) &&
    Array.isArray(entry.list?.assistants);
  if (valid) return { list: entry.list, savedAt: entry.savedAt };
  clearAgentList({ store });
  return null;
}

export function hasAgentList(options) {
  return readAgentList(options) !== null;
}

/** Forgets the kept list (logout, agents switched off). */
export function clearAgentList({ store = storage() } = {}) {
  try {
    store?.removeItem(AGENT_LIST_KEY);
  } catch {
    // Blocked storage holds nothing to forget.
  }
}
