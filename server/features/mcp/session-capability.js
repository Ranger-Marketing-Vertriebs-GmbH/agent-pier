import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readJSON, problem } from "../../lib/storage.js";
import { safePath } from "../extensions/mcp-config.js";

export const sessionId = (id) => {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))
    throw problem("Invalid AgentPier session capability.", 403);
  return id;
};
export function capabilityDirectory(dataDir, id) {
  const root = path.resolve(dataDir, "session-mcp");
  const directory = path.resolve(root, sessionId(id));
  if (!directory.startsWith(root + path.sep))
    throw problem("Invalid AgentPier session capability.", 403);
  return directory;
}
export function privatePath(file, boundary) {
  safePath(file, boundary);
  if (fs.existsSync(file)) {
    const info = fs.lstatSync(file);
    if (
      (process.getuid && info.uid !== process.getuid()) ||
      (info.isFile() && info.nlink !== 1) ||
      info.mode & 0o077
    )
      throw problem("Unsafe AgentPier session capability storage.", 403);
  }
  return file;
}
export function revokeSessionMcp(dataDir, id) {
  const directory = capabilityDirectory(dataDir, id);
  safePath(directory, dataDir);
  fs.rmSync(directory, { recursive: true, force: true });
}
/** A session's active capability record and its running session, or throws. */
function activeRecord(dataDir, id) {
  const directory = capabilityDirectory(dataDir, id);
  privatePath(directory, dataDir);
  const record = readJSON(
    privatePath(path.join(directory, "active.json"), dataDir),
    null,
  );
  if (!record || typeof record.generation !== "string") throw Error();
  const { generation } = record;
  const session = readJSON(
    privatePath(path.join(dataDir, "sessions", `${id}.json`), dataDir),
    null,
  );
  if (
    !session ||
    session.id !== id ||
    session.status !== "running" ||
    session.accountId !== record.accountId ||
    session.tool !== record.tool ||
    session.purpose === "login" ||
    session.pipeline ||
    session.imported ||
    !session.agentpierTools?.enabled ||
    session.agentpierTools.generation !== generation
  )
    throw Error();
  return record;
}
export function checkSessionCapability(dataDir, token) {
  try {
    if (typeof token !== "string" || token.length > 200) throw Error();
    const [id, generation, secret, extra] = token.split(".");
    if (extra || !/^[a-f0-9]{64}$/.test(secret)) throw Error();
    // Older grants may carry expiresAt. Access now follows the session lifecycle,
    // so those credentials remain usable without restarting their running CLI.
    const record = activeRecord(dataDir, id);
    if (
      record.generation !== generation ||
      typeof record.token !== "string" ||
      record.token.length !== secret.length ||
      !timingSafeEqual(Buffer.from(record.token), Buffer.from(secret))
    )
      throw Error();
    return { token, extra: { grant: record.grant }, sessionId: id };
  } catch {
    throw problem("AgentPier access revoked or session unavailable.", 403);
  }
}
/** The grant of a session's live capability, or null once revoked or ended. */
export function activeSessionGrant(dataDir, id) {
  try {
    return activeRecord(dataDir, id).grant;
  } catch {
    return null;
  }
}
