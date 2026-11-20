import path from "node:path";
import { readJSON, writePrivate } from "../../../../lib/storage.js";

// Chats that follow the agent's settings (AGENTPIER-438; docs/hermes-runtime.md,
// "Chats follow the agent's settings"). Hermes freezes a session's route, keys and
// most settings when it creates it (gateway/session_policy.py `build_policy`); a
// resume refreshes only toolsets, MCP servers, the terminal and the reasoning default,
// never the model route (gateway/session_policy_refresh.py). A session created with
// `follow_profile_config` instead re-reads the model, its providers and their keys
// from config.yaml at every turn (FOLLOW_SECTIONS, `LocalSessionPolicy.effective`),
// and its frozen keys of those sections are never checked again
// (session_policy_credentials.py `recover_config_secrets`), so a model, connection,
// advisor or key change reaches it at its next turn. AgentPier creates every session
// so (hermes-sessions.js create).
//
// A session an older AgentPier created stays frozen, and Hermes offers no edit that
// makes it follow (only a chat titled "Bot Chat" is adopted). So before its next turn
// AgentPier moves it to a new following session, its **successor**: the chat's key
// stays (it names the first session), the transcript is the earlier sessions' rows
// followed by the successor's, and the successor starts with a note of the
// conversation so far (`agentpier.note`, an internal row the agent reads and no client
// shows). The chain is kept in `agentpier-session-successors.json` in the agent's
// HERMES_HOME: `{ <first stored id>: { chain: [<successor id>, …], noted } }`.

/** Whether a session snapshot (session.create, session.resume) is a frozen one. */
export function frozenSession(snapshot) {
  const request = snapshot?.info?.launch_request;
  return (
    !!request &&
    typeof request === "object" &&
    request.follow_profile_config !== true &&
    // A launch that never reads the profile stays as it was chosen.
    request.ignore_user_config !== true &&
    request.safe_mode !== true
  );
}

// How much of the conversation the successor's note carries, newest kept.
export const recapChars = 24000;
const recapHeader =
  "[AgentPier: this chat continues in a new Hermes session, because the agent's " +
  "settings changed. The conversation so far, oldest first:]";

/**
 * The note that carries a frozen session's conversation into its successor: the
 * owner's and the agent's text of `rows` (session.history rows), newest kept within
 * `limit` characters; null without any.
 */
export function recapOf(rows, limit = recapChars) {
  const lines = [];
  let used = recapHeader.length;
  for (const row of [...(Array.isArray(rows) ? rows : [])].reverse()) {
    if (!["user", "assistant"].includes(row?.role) || typeof row.text !== "string")
      continue;
    if (row.role === "user" && row.display_kind && row.display_kind !== "user") continue;
    const text = row.text.trim();
    if (!text) continue;
    const line = `${row.role === "user" ? "Owner" : "You"}: ${text}`;
    if (used + line.length + 2 > limit) {
      const room = limit - used - 2;
      if (room > 200) lines.push(`${line.slice(0, room - 1)}…`);
      break;
    }
    lines.push(line);
    used += line.length + 2;
  }
  return lines.length ? [recapHeader, ...lines.reverse()].join("\n\n") : null;
}

/**
 * The successor chains of one agent, kept in `file` (in memory without one). `of`
 * answers the chain of a chat's first stored session id: that id first, the session
 * its turns run in last. Only this process writes `file`, so it is read once.
 */
export function sessionSuccessors(file = null) {
  // Only this process writes the file: it is read once.
  let memory = null;
  const read = () => {
    if (memory) return memory;
    const saved = file ? readJSON(file, {}) : {};
    memory = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    return memory;
  };
  const write = (records) => {
    if (file) writePrivate(file, records);
    memory = records;
  };
  return {
    of(first) {
      const chain = read()[first]?.chain;
      return [first, ...(Array.isArray(chain) ? chain.filter(ok) : [])];
    },
    current(first) {
      return this.of(first).at(-1);
    },
    noted(first) {
      return read()[first]?.noted === true;
    },
    /** Records `next` as the session the chat of `first` continues in. */
    add(first, next) {
      const records = read();
      const chain = this.of(first).slice(1);
      if (!chain.includes(next)) chain.push(next);
      records[first] = { chain, noted: false };
      write(records);
    },
    markNoted(first) {
      const records = read();
      if (!records[first]) return;
      records[first] = { ...records[first], noted: true };
      write(records);
    },
    forget(first) {
      const records = read();
      if (!(first in records)) return;
      delete records[first];
      write(records);
    },
  };
}

const ok = (id) => typeof id === "string" && id.length > 0 && id.length <= 200;

/** The successor chains of the agent `supervisor` runs, beside its home. */
export function agentSessionSuccessors(supervisor) {
  try {
    return sessionSuccessors(
      path.join(supervisor.agentPaths().hermesHome, "agentpier-session-successors.json"),
    );
  } catch {
    // A supervisor without folders (a test double) keeps them in memory.
    return sessionSuccessors();
  }
}
