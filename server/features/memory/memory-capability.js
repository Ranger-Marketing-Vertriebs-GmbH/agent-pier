import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  failure,
  identifier,
  privateFolder,
  privateFile,
  writePrivateJson,
} from "./memory-validation.js";
const digest = (token) => createHash("sha256").update(token).digest("hex");
export function capabilityFolder(memory, id, { create = false } = {}) {
  identifier(id);
  const sessions = path.join(memory.root, "sessions");
  if (create) privateFolder(sessions);
  else {
    const stat = fs.lstatSync(sessions);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw failure("Memory access is unavailable.", 403);
  }
  const folder = path.join(sessions, id);
  if (create) privateFolder(folder);
  else {
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw failure("Memory access is unavailable.", 403);
  }
  return folder;
}
export function issueCapability(memory, { id, account, projectId }) {
  if (
    memory.db
      .prepare("SELECT 1 FROM capabilities WHERE session_id=? AND active=1")
      .get(id)
  )
    throw failure("Memory session access already exists.", 409);
  const folder = capabilityFolder(memory, id, { create: true });
  const token = randomBytes(32).toString("hex");
  writePrivateJson(path.join(folder, "capability.json"), {
    version: 1,
    sessionId: id,
    token,
  });
  memory.db
    .prepare("INSERT OR REPLACE INTO capabilities VALUES (?,?,?,?,?,1)")
    .run(id, projectId, identifier(account.id), account.tool, digest(token));
  return folder;
}
export function authorizeCapability(memory, id) {
  try {
    const file = path.join(capabilityFolder(memory, id), "capability.json");
    const capability = JSON.parse(privateFile(file));
    if (
      capability.version !== 1 ||
      capability.sessionId !== id ||
      typeof capability.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(capability.token)
    )
      throw Error();
    const row = memory.db
      .prepare(
        "SELECT * FROM capabilities WHERE session_id=? AND token_hash=? AND active=1",
      )
      .get(id, digest(capability.token));
    if (!row) throw Error();
    return {
      projectId: row.project_id,
      provenance: {
        kind: "session",
        sessionId: row.session_id,
        accountId: row.account_id,
        tool: row.tool,
      },
    };
  } catch {
    throw failure("Memory access was revoked or is unavailable.", 403);
  }
}
export function revokeCapability(memory, id) {
  identifier(id);
  memory.db.prepare("UPDATE capabilities SET active=0 WHERE session_id=?").run(id);
  let folder;
  try {
    folder = capabilityFolder(memory, id);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(folder, { recursive: true, force: true });
}
