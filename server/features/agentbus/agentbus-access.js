import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  privateFile,
  privateFolder,
  writePrivateJson,
} from "../memory/memory-validation.js";
import { loadLaunch } from "../../../vendor/agentbus/agentpier/runtime.js";

import { AGENTBUS_VERSION } from "./agentbus-runtime.js";

export const busId = (id) => {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))
    throw Error("AgentBus access unavailable.");
  return id;
};
const hash = (token) => createHash("sha256").update(token).digest("hex");
const unavailable = () => Error("AgentBus access unavailable.");
/**
 * What the server later runs, reads a secret from or proves a process with. The
 * launch record under `projects/<id>/launches` lies in the folder a sandboxed
 * session may write, so these come from the server-only copy in `active.json`.
 */
const PINNED = [
  "cwd",
  "projectCwd",
  "command",
  "runtimeInterpreter",
  "node",
  "codexHome",
  "claudeSessionsDir",
];
const text = (value) => typeof value === "string" && value !== "";
function pinned(launch) {
  const copy = {};
  for (const key of PINNED) if (launch[key] != null) copy[key] = launch[key];
  if (
    !text(copy.cwd) ||
    !path.isAbsolute(copy.cwd) ||
    Object.values(copy).some((value) => !text(value))
  )
    throw unavailable();
  return copy;
}
export class AgentBusAccess {
  constructor(bus) {
    this.bus = bus;
    this.revoked = new Set();
  }
  folder(id, create = false) {
    const root = path.join(this.bus.root, "sessions"),
      folder = path.join(root, busId(id));
    if (create) {
      privateFolder(this.bus.root);
      privateFolder(root);
      privateFolder(folder);
    } else if (fs.existsSync(folder)) {
      for (const part of [this.bus.root, root, folder]) {
        const info = fs.lstatSync(part);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.mode & 0o077 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw Error("AgentBus access unavailable.");
      }
    }
    return folder;
  }
  issue(launch) {
    const folder = this.folder(launch.id, true),
      token = randomBytes(32).toString("hex");
    const record = {
      id: launch.id,
      projectId: launch.projectId,
      accountId: launch.accountId,
      tool: launch.tool,
      generation: randomUUID(),
      tokenHash: hash(token),
      launch: pinned(launch),
    };
    writePrivateJson(path.join(folder, "active.json"), record);
    writePrivateJson(path.join(folder, "capability.json"), {
      version: 1,
      sessionId: launch.id,
      token,
    });
    this.revoked.delete(launch.id);
    return folder;
  }
  record(id) {
    if (this.revoked.has(id)) throw Error("AgentBus access unavailable.");
    const folder = this.folder(id);
    const record = JSON.parse(
      privateFile(path.join(folder, "active.json"), { max: 65536 }),
    );
    if (
      record.id !== id ||
      !/^[a-f0-9]{64}$/.test(record.projectId) ||
      typeof record.generation !== "string"
    )
      throw Error("AgentBus access unavailable.");
    const h = path.join(this.bus.root, "projects", record.projectId);
    const written = loadLaunch(h, id);
    if (written.accountId !== record.accountId || written.tool !== record.tool)
      throw unavailable();
    // A session launched before the server kept its own copy: take the record as it
    // is now, once, and keep it; later changes to the record no longer count.
    if (!record.launch) {
      record.launch = pinned(written);
      writePrivateJson(path.join(folder, "active.json"), record);
    }
    const trusted = pinned(record.launch);
    // Peers are matched against the written folder; a record that names another one
    // no longer describes this session.
    if (written.cwd !== trusted.cwd) throw unavailable();
    const launch = {
      id: record.id,
      projectId: record.projectId,
      accountId: record.accountId,
      tool: record.tool,
      ...(written.createdAt ? { createdAt: written.createdAt } : {}),
      ...trusted,
    };
    return { record, launch, h };
  }
  check(credential) {
    try {
      if (
        typeof credential?.token !== "string" ||
        !/^[a-f0-9]{64}$/.test(credential.token)
      )
        throw Error();
      const ctx = this.record(busId(credential.sessionId));
      if (hash(credential.token) !== ctx.record.tokenHash) throw Error();
      return ctx;
    } catch {
      throw Error("AgentBus access expired or unavailable. Reload this session.");
    }
  }
  matches(session, ctx) {
    return (
      session?.id === ctx.launch.id &&
      session.status === "running" &&
      session.tool === ctx.launch.tool &&
      session.accountId === ctx.launch.accountId &&
      session.agentbus?.enabled === true &&
      session.agentbus.version === AGENTBUS_VERSION &&
      session.agentbus.projectId === ctx.launch.projectId &&
      !session.imported &&
      session.purpose !== "login" &&
      fs.realpathSync(session.cwd) === ctx.launch.cwd
    );
  }
  async authorize(credential) {
    const before = this.check(credential);
    const session = await this.bus.sessions.get(before.launch.id);
    const ctx = this.check(credential);
    if (!this.matches(session, ctx)) throw Error("AgentBus session is not active.");
    return { ...ctx, session };
  }
  revoke(id) {
    try {
      busId(id);
      this.revoked.add(id);
      const root = path.join(this.bus.root, "sessions");
      const folder = path.join(root, id);
      // Cleanup may repair permission drift, but must never follow foreign paths.
      for (const part of [this.bus.root, root, folder]) {
        const info = fs.lstatSync(part);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (process.getuid && info.uid !== process.getuid())
        )
          return false;
      }
      fs.rmSync(folder, { recursive: true, force: true });
      return true;
    } catch {
      // Session shutdown must continue even when disk cleanup is unavailable.
      return false;
    }
  }
}
