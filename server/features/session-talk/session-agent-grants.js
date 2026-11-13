// Agents one session may talk to beyond its project's talk grants: one private file
// per session under session-talk/grants, bound to the session's identity. The grant
// ends with the session (stop and delete discard it) and survives Reload & resume,
// which keeps the id and createdAt. Whether an agent is still eligible is decided on
// every use (talk-reach.js), so an archived or deleted agent needs no cleanup here.
import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { privateDirectory, problem, readJSON, writePrivate } from "../../lib/storage.js";
import { isCodingCli } from "../clis/catalog.js";

const MAX_AGENTS = 20;
const agentId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const sessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

/** Whether `session` may talk to agents at all: a running interactive coding CLI. */
export const talkEligible = (session) =>
  Boolean(
    session &&
    session.status === "running" &&
    isCodingCli(session.tool) &&
    session.purpose !== "login" &&
    !session.pipeline &&
    !session.imported,
  );

const identity = (session) => [session.id, session.createdAt];
const invalid = () => problem(serverMessages.sessions.invalidAgentAccess);

export class SessionAgentGrants {
  constructor({ dataDir }) {
    this.directory = privateDirectory(
      path.join(path.resolve(dataDir), "session-talk", "grants"),
    );
    // Called with the session id after its grant changed (assigned by the wiring:
    // the live `session.agent-access` topic).
    this.onChange = null;
  }
  changed(id) {
    try {
      this.onChange?.(id);
    } catch {
      console.error("AgentPier could not announce a session's agent access.");
    }
  }
  file(id) {
    if (typeof id !== "string" || !sessionId.test(id)) throw invalid();
    return path.join(this.directory, `${id}.json`);
  }
  /** The agent ids as given, or 400: at most 20, unique, each a valid id. */
  validate(ids = []) {
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_AGENTS ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !agentId.test(id))
    )
      throw invalid();
    return [...ids];
  }
  /** The agent ids granted to this very session; none for another identity. */
  assigned(session) {
    let saved;
    try {
      saved = readJSON(this.file(session.id), null);
    } catch {
      return [];
    }
    if (!saved || JSON.stringify(saved.identity) !== JSON.stringify(identity(session)))
      return [];
    try {
      return this.validate(saved.assistantIds);
    } catch {
      return [];
    }
  }
  /** Replaces the session's grant; an empty list removes it. 409 for other sessions. */
  set(session, ids) {
    if (!talkEligible(session))
      throw problem(serverMessages.sessions.agentAccessCodingOnly, 409);
    const assistantIds = this.validate(ids);
    if (!assistantIds.length) {
      this.discard(session.id);
      return [];
    }
    writePrivate(this.file(session.id), { identity: identity(session), assistantIds });
    this.changed(session.id);
    return assistantIds;
  }
  discard(id) {
    fs.rmSync(this.file(id), { force: true });
    this.changed(id);
  }
}
