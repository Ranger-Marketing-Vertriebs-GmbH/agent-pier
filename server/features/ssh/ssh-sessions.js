import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, readJSON, writePrivate, problem } from "../../lib/storage.js";
import { shellQuote } from "../../lib/launch-serialization.js";

import { validateSshProjectBinding } from "./ssh-project-scope.js";

const client = fileURLToPath(new URL("../../ssh.mjs", import.meta.url));
function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value))
    throw problem(serverMessages.ssh.invalidBinding);
  return value;
}
function identity(session) {
  return [session.id, session.accountId, session.tool, session.createdAt];
}
function isEligible(session) {
  return Boolean(
    session &&
    session.status === "running" &&
    session.purpose !== "login" &&
    !session.pipeline?.headless &&
    ["codex", "claude", "opencode", "shell"].includes(session.tool),
  );
}
function eligible(session) {
  if (!isEligible(session))
    throw problem(
      "SSH-Zugänge können nur laufenden interaktiven Sitzungen zugeordnet werden.",
      409,
    );
}

/** Convenience scoping under one OS user, not a sandbox boundary. */
export class SshSessions {
  constructor({ dataDir, store }) {
    this.dataDir = path.resolve(dataDir);
    this.store = store;
    this.directory = privateDirectory(path.join(this.dataDir, "ssh", "grants"));
  }
  file(id) {
    return path.join(this.directory, `${identifier(id)}.json`);
  }
  validate(ids = []) {
    if (!Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length)
      throw problem(serverMessages.ssh.invalidBinding);
    for (const id of ids) this.store.get(identifier(id));
    return [...ids];
  }
  assigned(session) {
    const saved = readJSON(this.file(session.id), null);
    if (!saved || JSON.stringify(saved.identity) !== JSON.stringify(identity(session)))
      return [];
    const available = new Set(this.store.list().map((item) => item.id));
    return this.validateShape(saved.accessIds).filter((id) => available.has(id));
  }
  validateShape(ids) {
    if (!Array.isArray(ids) || ids.length > 30)
      throw problem(serverMessages.ssh.invalidStoredBinding);
    return ids.map(identifier);
  }
  async inherited(session) {
    eligible(session);
    if (!session.sshTools?.project) return [];
    const project = await validateSshProjectBinding(session.sshTools.project);
    return this.store
      .list()
      .filter((item) => item.projectId === project.projectId)
      .map((item) => item.id);
  }
  async effective(session) {
    const inherited = await this.inherited(session);
    return [...new Set([...this.assigned(session), ...inherited])];
  }
  async get(session) {
    const inheritedIds = isEligible(session) ? await this.inherited(session) : [];
    const assignedIds = this.assigned(session);
    return {
      accesses: this.store.list(),
      assignedIds,
      inheritedIds,
      commands: [...new Set([...assignedIds, ...inheritedIds])].map((id) => ({
        id,
        command: [
          process.execPath,
          client,
          "--data-dir",
          this.dataDir,
          "--session",
          session.id,
          "--access",
          id,
        ]
          .map(shellQuote)
          .join(" "),
      })),
    };
  }
  set(session, ids) {
    eligible(session);
    const accessIds = this.validate(ids);
    if (accessIds.length)
      writePrivate(this.file(session.id), {
        identity: identity(session),
        accessIds,
      });
    else this.discard(session.id);
    return this.get(session);
  }
  discard(id) {
    fs.rmSync(this.file(id), { force: true });
  }
  revokeAccess(id) {
    identifier(id);
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name),
        saved = readJSON(file, null);
      if (!saved) continue;
      const accessIds = this.validateShape(saved.accessIds).filter(
        (value) => value !== id,
      );
      if (accessIds.length) writePrivate(file, { ...saved, accessIds });
      else fs.rmSync(file, { force: true });
    }
  }
  async resolve(sessionId, accessId) {
    identifier(sessionId);
    identifier(accessId);
    const session = readJSON(
      path.join(this.dataDir, "sessions", `${sessionId}.json`),
      null,
    );
    eligible(session);
    if (session.id !== sessionId || !(await this.effective(session)).includes(accessId))
      throw problem(serverMessages.ssh.accessNotBound, 403);
    // Discovery may run Git asynchronously. Recheck live identity and grants before
    // materializing a connection so a stop/reload/revocation during it wins.
    const current = readJSON(
      path.join(this.dataDir, "sessions", `${sessionId}.json`),
      null,
    );
    eligible(current);
    const sameSession =
      JSON.stringify(identity(current)) === JSON.stringify(identity(session)) &&
      JSON.stringify(current.sshTools) === JSON.stringify(session.sshTools);
    const projectId = session.sshTools?.project?.projectId;
    const inherited = projectId && this.store.get(accessId).projectId === projectId;
    if (!sameSession || (!inherited && !this.assigned(current).includes(accessId)))
      throw problem(serverMessages.ssh.accessNotBound, 403);
    return this.store.connection(accessId);
  }
}
