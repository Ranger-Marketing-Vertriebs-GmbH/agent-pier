import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDirectory, problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";
import {
  requireChatInput,
  requireCurrentChatInput,
} from "../../application/request-input-guard.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set(["pending", "handed-off", "rejected", "uncertain"]);
function sessionScope(session) {
  return JSON.stringify([
    session.id,
    session.deliveryAccountId || session.accountId,
    session.tool,
    session.createdAt || null,
  ]);
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Durable at-most-once native input for one owner of the data directory. */
export class ChatDelivery {
  constructor({ dataDir, sessions, requests, models }) {
    this.directory = path.join(dataDir, "chat-delivery");
    this.sessions = sessions;
    this.requests = requests;
    this.models = models;
    this.active = new Set();
  }

  folder(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))
      throw problem(copy.invalid);
    return path.join(this.directory, id);
  }

  file(id, deliveryId) {
    if (typeof deliveryId !== "string" || !uuid.test(deliveryId))
      throw problem(copy.invalid);
    return path.join(this.folder(id), `${deliveryId.toLowerCase()}.json`);
  }

  checkScope(session, scope) {
    if (typeof scope !== "string" || scope !== sessionScope(session))
      throw problem(copy.scope, 409);
  }

  read(file) {
    try {
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        !receipt ||
        receipt.version !== 1 ||
        !uuid.test(receipt.deliveryId) ||
        typeof receipt.scope !== "string" ||
        !/^[0-9a-f]{64}$/.test(receipt.hash) ||
        !statuses.has(receipt.status) ||
        path.basename(file) !== `${receipt.deliveryId}.json`
      )
        throw new Error("Invalid receipt");
      return receipt;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw problem(copy.storage, 503);
    }
  }

  write(file, receipt) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      privateDirectory(this.directory);
      syncDirectory(path.dirname(this.directory));
      privateDirectory(path.dirname(file));
      syncDirectory(this.directory);
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(receipt) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      syncDirectory(path.dirname(file));
    } catch {
      throw problem(copy.storage, 503);
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* Keep original error. */
      }
    }
  }

  result(receipt, file) {
    const status = this.active.has(file)
      ? "pending"
      : receipt.status === "pending"
        ? "uncertain"
        : receipt.status;
    return {
      deliveryId: receipt.deliveryId,
      status,
      ...(status === "rejected" ? { error: copy.rejected } : {}),
      ...(status === "uncertain" ? { error: copy.uncertain } : {}),
    };
  }

  async status(id, deliveryId, scope) {
    const file = this.file(id, deliveryId);
    this.checkScope(await this.sessions.get(id), scope);
    const receipt = this.read(file);
    if (!receipt) return { deliveryId: deliveryId.toLowerCase(), status: "absent" };
    if (receipt.scope !== scope) throw problem(copy.scope, 409);
    return this.result(receipt, file);
  }

  async send(id, body) {
    const { deliveryId, deliveryScope, text, submit } = body;
    const file = this.file(id, deliveryId);
    if (typeof text !== "string" || text.length > 32000 || submit !== true)
      throw problem(copy.invalid);
    this.checkScope(await this.sessions.get(id), deliveryScope);
    const hash = createHash("sha256")
      .update(JSON.stringify([text, submit]))
      .digest("hex");
    const previous = this.read(file);
    if (previous) {
      if (previous.scope !== deliveryScope || previous.hash !== hash)
        throw problem(copy.conflict, 409);
      return this.result(previous, file);
    }
    const receipt = {
      version: 1,
      deliveryId: deliveryId.toLowerCase(),
      scope: deliveryScope,
      hash,
      status: "pending",
    };
    // No await between lookup, durable reservation and in-process ownership.
    this.write(file, receipt);
    this.active.add(file);
    let mayHaveWritten = false;
    try {
      await requireChatInput(this.requests, id);
      await this.sessions.input(id, text, submit, async (session, raw) => {
        this.checkScope(session, deliveryScope);
        requireCurrentChatInput(this.requests, id);
        await this.models.guardInput(id, session, raw, { requireReady: true });
        receipt.status = "uncertain";
        this.write(file, receipt);
        mayHaveWritten = true;
      });
      receipt.status = "handed-off";
      this.write(file, receipt);
    } catch {
      receipt.status = mayHaveWritten ? "uncertain" : "rejected";
      this.write(file, receipt);
    } finally {
      this.active.delete(file);
    }
    return this.result(receipt, file);
  }

  async discard(id) {
    fs.rmSync(this.folder(id), { recursive: true, force: true });
  }
}
