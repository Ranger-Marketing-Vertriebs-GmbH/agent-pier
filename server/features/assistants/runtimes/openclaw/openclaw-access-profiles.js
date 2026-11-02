import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// AgentPier-held ChatGPT logins as OpenClaw sees them: an access-only `openai` OAuth
// profile in OpenClaw's own auth profile store, the same shape OpenClaw writes
// (openai-chatgpt-provider buildOpenAICodexAuthResult) without `refresh` and
// `authFlow`. Verified against OpenClaw 2026.10.9 (docs/assistant-model-connections.md):
// - With a usable access token (more than 5 minutes left) OpenClaw never refreshes;
//   without a refresh token its refresh claim gives up before it writes a fence
//   (oauth.ts claim: `refresh === undefined` → "unavailable"), nothing is deleted.
// - Every ChatGPT feature (chat, image_generate, transcription, realtime, usage,
//   embeddings) gates on the credential type `oauth`, never on a refresh token.
// - No RPC writes an OAuth credential: the row is written here, inside one
//   `BEGIN IMMEDIATE` transaction that changes only this profile, then
//   `models.authRefresh { operation, agentId: "main" }` reloads the Gateway's
//   snapshot, as OpenClaw's own CLI does after an out-of-process write.
// The store's layout is OpenClaw's internal one: an unknown layout or profile shape
// is refused (fail closed), never guessed; a contract test pins it per version.

const busyMs = 5000;
const fence = "openclaw-oauth-refresh-fence:";
const sharedOwnerKey = "auth.sharedStore";
const sharedStoreKey = "authProfiles.store";

/** A refusal with a stable code, never a token. */
const refused = (code) =>
  Object.assign(new Error(`OpenClaw auth store: ${code}`), { code });
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

const stateDb = (stateDir) => path.join(stateDir, "state", "openclaw.sqlite");
const mainAgentDb = (stateDir) =>
  path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");

function open(file) {
  if (!fs.existsSync(file)) throw refused("STORE_MISSING");
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${busyMs}`);
  return db;
}
const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

// The cell that holds the shared auth store (path-resolve resolveSharedAuthStorePath):
// the state database's machine state when its owner says "state-db", else the main
// agent's database (OpenClaw's "legacy-main").
function storeCell(stateDir) {
  const shared = open(stateDb(stateDir));
  try {
    if (!hasTable(shared, "config_machine_state")) throw refused("STORE_MISSING");
    const row = shared
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      .get(sharedOwnerKey);
    let owner;
    try {
      owner = row ? JSON.parse(row.value_json) : { location: unowned(stateDir) };
    } catch {
      throw refused("UNKNOWN_LAYOUT");
    }
    if (!record(owner) || Object.keys(owner).length !== 1)
      throw refused("UNKNOWN_LAYOUT");
    if (owner.location === "state-db" || owner.location === "unowned")
      return {
        // No auth write yet: the first one records the state database as owner, as
        // OpenClaw's own bootstrap does when no legacy store exists.
        claim: owner.location === "unowned",
        file: stateDb(stateDir),
        read: "SELECT value_json AS json FROM config_machine_state WHERE state_key = ?",
        write:
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        key: sharedStoreKey,
        table: "config_machine_state",
      };
    if (owner.location === "legacy-main")
      return {
        file: mainAgentDb(stateDir),
        read: "SELECT store_json AS json FROM auth_profile_store WHERE store_key = ?",
        write:
          "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(store_key) DO UPDATE SET store_json = excluded.store_json, updated_at = excluded.updated_at",
        key: "primary",
        table: "auth_profile_store",
      };
    throw refused("UNKNOWN_LAYOUT");
  } finally {
    shared.close();
  }
}

// A store nobody wrote yet (no `auth.sharedStore`): "legacy-main" while the main
// agent's database or a legacy auth file exists, else "unowned" (shared-store
// bootstrap: an empty or missing legacy source relocates to the state database).
function unowned(stateDir) {
  const legacy = [
    mainAgentDb(stateDir),
    ...["auth-profiles.json", "auth.json"].map((name) =>
      path.join(path.dirname(mainAgentDb(stateDir)), name),
    ),
  ];
  return legacy.some((file) => fs.existsSync(file)) ? "legacy-main" : "unowned";
}

// Runs `change(store)` on the parsed store inside one immediate transaction; a
// returned store is written back, `undefined` leaves the row as it was. `write`:
// whether the change may claim an unowned store.
function transact(stateDir, change, { write = false } = {}) {
  const cell = storeCell(stateDir);
  // Reads and removals change nothing in a store nobody wrote yet.
  if (cell.claim && !write) {
    change({ version: 1, profiles: {} });
    return undefined;
  }
  const db = open(cell.file);
  try {
    if (!hasTable(db, cell.table)) throw refused("STORE_MISSING");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (cell.claim) {
        const owner = db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get(sharedOwnerKey);
        if (owner) throw refused("OWNER_CHANGED");
        db.prepare(cell.write).run(
          sharedOwnerKey,
          JSON.stringify({ location: "state-db" }),
          Date.now(),
        );
      }
      const row = db.prepare(cell.read).get(cell.key);
      let store;
      try {
        store = row ? JSON.parse(row.json) : { version: 1, profiles: {} };
      } catch {
        throw refused("UNKNOWN_SHAPE");
      }
      if (!record(store) || store.version !== 1 || !record(store.profiles))
        throw refused("UNKNOWN_SHAPE");
      const next = change(store);
      if (next !== undefined)
        db.prepare(cell.write).run(cell.key, JSON.stringify(next), Date.now());
      db.exec("COMMIT");
      return next;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

// An existing profile AgentPier may replace: OpenClaw's own ChatGPT OAuth shape, not
// in the middle of an OpenClaw refresh.
function replaceable(profile) {
  if (profile === undefined) return true;
  if (!record(profile) || profile.type !== "oauth" || profile.provider !== "openai")
    throw refused("UNKNOWN_PROFILE");
  if (typeof profile.access === "string" && profile.access.startsWith(fence))
    throw refused("REFRESH_IN_PROGRESS");
  return true;
}

/** The access-only profile of `credential` (chatgpt-vault.js accessOf). */
export function accessProfile(credential) {
  return {
    type: "oauth",
    provider: "openai",
    access: credential.access,
    expires: credential.expires,
    ...(credential.accountId && { accountId: credential.accountId }),
    ...(credential.email && { email: credential.email }),
    ...(credential.displayName && { displayName: credential.displayName }),
    ...(credential.plan && { chatgptPlanType: credential.plan }),
  };
}

/** Writes `profileId` access-only, replacing what OpenClaw held there. */
export function writeAccessProfile(stateDir, profileId, credential) {
  if (typeof credential?.access !== "string" || !Number.isFinite(credential.expires))
    throw refused("INVALID_CREDENTIAL");
  transact(
    stateDir,
    (store) => {
      replaceable(store.profiles[profileId]);
      return {
        ...store,
        profiles: { ...store.profiles, [profileId]: accessProfile(credential) },
      };
    },
    { write: true },
  );
}

/** Removes `profileId` from OpenClaw's store; a missing one is no change. */
export function removeAccessProfile(stateDir, profileId) {
  transact(stateDir, (store) => {
    if (!Object.hasOwn(store.profiles, profileId)) return undefined;
    replaceable(store.profiles[profileId]);
    const profiles = { ...store.profiles };
    delete profiles[profileId];
    return { ...store, profiles };
  });
}

/**
 * OpenClaw's stored ChatGPT credential of `profileId` (with its refresh token, for
 * the one move to AgentPier), or null. Read inside the same kind of transaction.
 */
export function readStoredProfile(stateDir, profileId) {
  let found = null;
  transact(stateDir, (store) => {
    const profile = store.profiles[profileId];
    if (profile !== undefined && replaceable(profile)) found = { ...profile };
    return undefined;
  });
  return found;
}
