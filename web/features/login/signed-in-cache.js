// Whether this device was last signed in as the owner, so the app can open in offline
// mode when AgentPier cannot be reached instead of showing only an error. One entry in
// localStorage with no secret in it: the login-change marker (`agentpier-auth-change`,
// written on every login and logout) it was written under. Another marker, a logout,
// an expired session or a status that is not signed in drops it (LoginGate's
// forgetUser). Restricted users never get one: their app needs the live status.
export const SIGNED_IN_KEY = "agentpier.signed-in.v1";
const AUTH_KEY = "agentpier-auth-change";

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Remembers a signed-in owner status; any other status forgets. Never throws. */
export function rememberSignedIn(status, { store = storage() } = {}) {
  if (!store) return;
  try {
    if (status?.authenticated === true && status.role !== "user")
      store.setItem(
        SIGNED_IN_KEY,
        JSON.stringify({ version: 1, auth: store.getItem(AUTH_KEY) ?? null }),
      );
    else store.removeItem(SIGNED_IN_KEY);
  } catch {
    // Full or blocked storage: the device just has no offline start.
  }
}

/** True when this device was last signed in as the owner under the current login. */
export function wasSignedIn({ store = storage() } = {}) {
  if (!store) return false;
  try {
    const entry = JSON.parse(store.getItem(SIGNED_IN_KEY) || "null");
    return entry?.version === 1 && entry.auth === (store.getItem(AUTH_KEY) ?? null);
  } catch {
    return false;
  }
}

export function forgetSignedIn({ store = storage() } = {}) {
  try {
    store?.removeItem(SIGNED_IN_KEY);
  } catch {
    // Blocked storage holds nothing to forget.
  }
}
