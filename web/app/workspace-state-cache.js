// The owner's last workspace state on this device (sessions, accounts, tools, as
// GET /api/state sends them to this browser; it never carries credentials), so an app
// opened while AgentPier cannot be reached still lists the sessions instead of none.
// Like the agent list (agent-list-cache.js), the entry belongs to one login and one
// build: another login marker (`agentpier-auth-change`), another build, or a logout
// (LoginGate's forgetUser) drops it.
import { currentBuild } from "../lib/build-check.js";

export const WORKSPACE_STATE_KEY = "agentpier.workspace-state.v1";
const VERSION = 1;
const AUTH_KEY = "agentpier-auth-change";
// Larger states are not kept; the app then starts empty offline, as before.
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

/** Keeps `state` for this login and build; never throws. */
export function saveWorkspaceState(
  state,
  { store = storage(), build = currentBuild() } = {},
) {
  if (!store || !state || !Array.isArray(state.sessions)) return false;
  try {
    const text = JSON.stringify({
      version: VERSION,
      build,
      auth: loginMarker(store),
      savedAt: Date.now(),
      state,
    });
    if (text.length > MAX_CACHED_CHARS) {
      store.removeItem(WORKSPACE_STATE_KEY);
      return false;
    }
    store.setItem(WORKSPACE_STATE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

/** The kept state of this login and build, or null. A stale entry is removed. */
export function readWorkspaceState({ store = storage(), build = currentBuild() } = {}) {
  if (!store) return null;
  let entry;
  try {
    entry = JSON.parse(store.getItem(WORKSPACE_STATE_KEY) || "null");
  } catch {
    entry = undefined;
  }
  if (entry === null) return null;
  const valid =
    entry?.version === VERSION &&
    entry.build === build &&
    entry.auth === loginMarker(store) &&
    Array.isArray(entry.state?.sessions);
  if (valid) return entry.state;
  clearWorkspaceState({ store });
  return null;
}

/** Forgets the kept state (logout, another login). */
export function clearWorkspaceState({ store = storage() } = {}) {
  try {
    store?.removeItem(WORKSPACE_STATE_KEY);
  } catch {
    // Blocked storage holds nothing to forget.
  }
}
