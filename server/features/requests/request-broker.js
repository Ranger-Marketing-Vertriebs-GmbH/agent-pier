import fs from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { prepareRequests } from "./request-launch.js";
import { validSession, requestValue, answerValue } from "./request-validation.js";
import { messages, send } from "./wire.js";
const stale = () => problem(copy.stale, 409);
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class RequestBroker {
  constructor({ dataDir, sessions, onEvent = () => {} }) {
    this.directory = path.join(dataDir, "requests");
    this.sessions = sessions;
    this.onEvent = onEvent;
    this.entries = new Map();
    this.clients = new Set();
    this.deliveries = new Map();
    this.created = new Set();
    const hash = createHash("sha256")
      .update(path.resolve(dataDir))
      .digest("hex")
      .slice(0, 20);
    this.socketPath = `/tmp/agentpier-requests-${process.getuid?.() ?? "user"}-${hash}/bridge.sock`;
    this.ready = this.start();
  }
  async start() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const storageInfo = await fs.lstat(this.directory);
    if (
      !storageInfo.isDirectory() ||
      (process.getuid && storageInfo.uid !== process.getuid())
    )
      throw Error("Unsafe native request storage");
    await fs.chmod(this.directory, 0o700);
    try {
      const created = JSON.parse(
        await fs.readFile(path.join(this.directory, "created.json"), "utf8"),
      );
      if (Array.isArray(created))
        this.created = new Set(
          created
            .filter((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id))
            .slice(-10000),
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const directory = path.dirname(this.socketPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
      throw Error("Unsafe native request socket directory");
    await fs.chmod(directory, 0o700);
    const active = await new Promise((resolve) => {
      const probe = net.createConnection(this.socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (error) =>
        resolve(!["ENOENT", "ECONNREFUSED"].includes(error.code)),
      );
    });
    if (active) throw Error("Native request broker already running");
    await fs.rm(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this.connection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    await fs.chmod(this.socketPath, 0o600);
  }
  file(id) {
    if (!validSession(id)) throw problem(copy.session);
    return path.join(this.directory, `${id}.launch.json`);
  }
  prepare(input) {
    return this.ready.then(() => prepareRequests(this, input));
  }
  emit(entry, action, source = "system", outcome = "success", decision) {
    if (action === "request.created") {
      if (this.created.has(entry.id)) return;
      this.created.add(entry.id);
      if (this.created.size > 10000)
        this.created.delete(this.created.values().next().value);
      const file = path.join(this.directory, "created.json");
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify([...this.created]), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, file);
    }
    try {
      Promise.resolve(
        this.onEvent({
          action,
          resourceType: "request",
          resourceId: entry.id,
          sessionId: entry.sessionId,
          kind: entry.kind,
          outcome,
          source,
          details: { kind: entry.kind, ...(decision ? { decision } : {}) },
        }),
      ).catch(() => {});
    } catch {}
  }
  connection(socket) {
    if (this.clients.size >= 128) {
      socket.destroy();
      return;
    }
    this.clients.add(socket);
    const authenticationTimeout = setTimeout(() => socket.destroy(), 2000);
    authenticationTimeout.unref();
    let owner;
    let queue = Promise.resolve();
    messages(socket, (message) => {
      queue = queue.then(async () => {
        if (!owner) {
          if (
            message.type !== "hello" ||
            !validSession(message.sessionId) ||
            typeof message.epoch !== "string" ||
            message.epoch.length > 100
          )
            throw Error("Invalid native channel");
          const launch = JSON.parse(
            await fs.readFile(this.file(message.sessionId), "utf8"),
          );
          if (!equal(message.token, launch.token)) throw Error("Invalid native channel");
          owner = { ...launch, epoch: message.epoch };
          if (socket.destroyed) return;
          clearTimeout(authenticationTimeout);
          socket.owner = owner;
          for (const client of this.clients)
            if (
              client !== socket &&
              client.owner?.id === owner.id &&
              client.owner?.epoch === owner.epoch
            )
              client.destroy();
          send(socket, { type: "ready" });
          return;
        }
        if (message.type === "result") {
          const delivery = this.deliveries.get(message.delivery);
          if (delivery?.socket === socket) delivery.finish(message.status);
          return;
        }
        if (typeof message.key !== "string" || !message.key || message.key.length > 1000)
          throw Error("Invalid native occurrence");
        const id = createHmac("sha256", owner.token)
          .update(JSON.stringify([owner.epoch, message.key]))
          .digest("hex");
        if (message.type === "resolved") {
          const old = this.entries.get(id);
          if (old?.socket === socket) {
            this.entries.delete(id);
            this.emit(old, "request.expired");
          }
          return;
        }
        if (message.type !== "publish" || this.entries.has(id)) return;
        const session = await this.sessions.get(owner.id);
        if (socket.destroyed) return;
        if (
          session.status !== "running" ||
          session.accountId !== owner.accountId ||
          session.tool !== owner.tool ||
          !session.nativeRequests?.enabled
        )
          throw Error("Native owner unavailable");
        const entry = {
          ...requestValue(message.request),
          id,
          sessionId: owner.id,
          revision: 1,
          status: "pending",
          source: owner.tool,
          createdAt: new Date().toISOString(),
          key: message.key,
          socket,
        };
        if (
          [...this.entries.values()].filter((e) => e.sessionId === owner.id).length >= 100
        )
          throw Error("Too many native requests");
        this.entries.set(id, entry);
        this.emit(entry, "request.created");
      });
      return queue;
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(authenticationTimeout);
      this.clients.delete(socket);
      for (const [id, entry] of this.entries)
        if (entry.socket === socket) {
          this.entries.delete(id);
          this.emit(entry, "request.expired");
        }
      for (const delivery of this.deliveries.values())
        if (delivery.socket === socket) delivery.finish("unknown");
    });
  }
  hasPending(sessionId) {
    return [...this.entries.values()].some((entry) => entry.sessionId === sessionId);
  }
  async list(sessionId) {
    const session = await this.sessions.get(sessionId);
    if (session.status !== "running")
      await this.discard(sessionId, { removeLaunch: false });
    return {
      requests: [...this.entries.values()]
        .filter((e) => e.sessionId === sessionId)
        .map(({ socket: _socket, key: _key, ...entry }) => entry),
    };
  }
  async answer(sessionId, id, input, handoff = false) {
    const session = await this.sessions.get(sessionId);
    const entry = this.entries.get(id);
    if (
      session.status !== "running" ||
      !entry ||
      entry.sessionId !== sessionId ||
      entry.status !== "pending" ||
      entry.revision !== input?.expectedRevision ||
      entry.socket.destroyed
    )
      throw stale();
    const answer = handoff ? { handoff: true } : answerValue(entry, input);
    entry.status = "responding";
    entry.revision++;
    const status = await new Promise((resolve) => {
      const delivery = randomUUID();
      const finish = (value) => {
        clearTimeout(timer);
        this.deliveries.delete(delivery);
        resolve(value);
      };
      const timer = setTimeout(() => finish("unknown"), 10000);
      this.deliveries.set(delivery, { socket: entry.socket, finish });
      if (!send(entry.socket, { type: "answer", delivery, key: entry.key, answer }))
        finish("unknown");
    });
    if (status === "answered") {
      this.entries.delete(id);
      this.emit(
        entry,
        handoff ? "request.handed-off" : "request.answered",
        "user",
        "success",
        handoff
          ? "handoff"
          : entry.kind === "question"
            ? "answer"
            : ["deny", "decline", "reject", "cancel"].includes(input.choice)
              ? "deny"
              : "allow",
      );
    } else if (status === "stale") {
      this.entries.delete(id);
      throw stale();
    } else {
      entry.status = "unknown";
      this.emit(entry, "request.answered", "user", "failure");
      throw problem(copy.unknown, 409);
    }
    return this.list(sessionId);
  }
  handoff(sessionId, id, input) {
    return this.answer(sessionId, id, input, true);
  }
  async discard(sessionId, { removeLaunch = true } = {}) {
    for (const socket of this.clients)
      if (socket.owner?.id === sessionId) socket.destroy();
    for (const [id, entry] of this.entries)
      if (entry.sessionId === sessionId) {
        this.entries.delete(id);
        this.emit(entry, "request.expired");
      }
    if (removeLaunch) {
      await fs.rm(this.file(sessionId), { force: true });
      await fs.rm(path.join(this.directory, `${sessionId}.claude`), {
        force: true,
        recursive: true,
      });
      await fs.rm(path.join(this.directory, `${sessionId}.tui.json`), { force: true });
    }
  }
  async close() {
    await this.ready;
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.clients) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    await fs.rm(this.socketPath, { force: true });
  }
}
