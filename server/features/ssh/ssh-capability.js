import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readJSON, problem } from "../../lib/storage.js";
export function capabilityFile(dataDir, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))
    throw problem("SSH capability unavailable.", 403);
  return path.join(dataDir, "ssh", "capabilities", id, "capability.json");
}
export function authorizeSsh(dataDir, capability) {
  try {
    const current = readJSON(capabilityFile(dataDir, capability.sessionId), null);
    if (
      !current ||
      typeof capability.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(capability.token) ||
      current.generation !== capability.generation ||
      !timingSafeEqual(Buffer.from(current.token), Buffer.from(capability.token))
    )
      throw Error();
    const session = readJSON(
      path.join(dataDir, "sessions", `${capability.sessionId}.json`),
      null,
    );
    if (
      !session ||
      session.id !== capability.sessionId ||
      session.status !== "running" ||
      session.accountId !== current.accountId ||
      session.tool !== current.tool ||
      session.purpose === "login" ||
      session.pipeline?.headless ||
      session.sshTools?.generation !== current.generation
    )
      throw Error();
    return session;
  } catch {
    throw problem("SSH capability revoked or session unavailable.", 403);
  }
}
export function revokeSsh(dataDir, id) {
  fs.rmSync(path.dirname(capabilityFile(dataDir, id)), { recursive: true, force: true });
}
