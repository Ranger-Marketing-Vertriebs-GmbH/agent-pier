import { answerFolderTrust } from "./claude-folder-trust.js";
import { refreshStartupPrompts, answerStartupPrompt } from "./claude-startup-prompts.js";
import { answerHookTrust, hookLaunchIdentity } from "./codex-hook-trust.js";
import fs from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { prepareRequests } from "./request-launch.js";
import { refreshClaudeRuntime, confirmClaudeRuntime } from "./claude-runtime.js";
import { validSession, requestValue, answerValue } from "./request-validation.js";
import { messages, send } from "./wire.js";
import { nativePushValue } from "./native-push.js";
import { listenClaudeMod } from "../claude-mod/claude-mod-socket.js";
// A prompt already answered, changed or gone; names who claimed it when known.
const stale = (entry) =>
  Object.assign(problem(copy.stale, 409), {
    stale: true,
    ...(entry?.claimedBy ? { answeredBy: entry.claimedBy } : {}),
  });
// Who answers: the owner (HTTP, the default), an agent of its session or Telegram.
const actorOf = (actor) =>
  actor?.kind === "agent" && typeof actor.assistantId === "string"
    ? { actor: "agent", assistantId: actor.assistantId }
    : { actor: actor?.kind === "telegram" ? "telegram" : "owner" };
// A terminal notice describes a moment, not a state; it fades on its own.
export const terminalNoticeMs = 10 * 60 * 1000;
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class RequestBroker {
  /**
   * `onNative(sessionId, push)` receives the authenticated owner's push hints
   * (native-push.js): activity, streamed reply text and its end.
   */
  constructor({
    dataDir,
    sessions,
    onEvent = () => {},
    onNative = () => {},
    onLaunch = () => {},
  }) {
    this.directory = path.join(dataDir, "requests");
    this.sessions = sessions;
    this.onEvent = onEvent;
    this.onNative = onNative;
    // A new launch or a discarded session: what its last CLI reported is over.
    this.onLaunch = onLaunch;
    this.entries = new Map();
    this.clients = new Set();
    this.deliveries = new Map();
    this.created = new Set();
    this.claudeReloadRequired = new Set();
    // Latest Claude approval per session that left chat for the terminal.
    this.notices = new Map();
    const hash = createHash("sha256")
      .update(path.resolve(dataDir))
      .digest("hex")
      .slice(0, 20);
    this.socketPath = `/tmp/agentpier-requests-${process.getuid?.() ?? "user"}-${hash}/bridge.sock`;
    // The Claude Code bridge mod speaks HTTP; it gets a socket of its own beside it.
    this.modSocketPath = path.join(path.dirname(this.socketPath), "claude-mod.sock");
    this.modOwners = new Map();
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
    this.claudeReloadRequired = await refreshClaudeRuntime(this.directory);
    await fs.rm(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this.connection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    await fs.chmod(this.socketPath, 0o600);
    this.modServer = await listenClaudeMod({
      socketPath: this.modSocketPath,
      authenticate: (id, token) => this.modOwner(id, token),
      deliver: (owner, events) => this.notify(owner.id, { type: "claude-mod", events }),
    });
  }
  /**
   * The Claude Code launch a bridge mod request belongs to, checked like a native
   * channel's hello and the pushes after it; remembered for a second, as the mod
   * reports about ten times a second.
   */
  async modOwner(id, token) {
    if (!validSession(id)) return null;
    const cached = this.modOwners.get(id);
    if (cached && Date.now() - cached.at < 1000 && equal(token, cached.owner.token))
      return cached.owner;
    let launch;
    try {
      launch = JSON.parse(await fs.readFile(this.file(id), "utf8"));
    } catch {
      return null;
    }
    if (launch.tool !== "claude" || !equal(token, launch.token)) return null;
    const session = await this.sessions.get(id).catch(() => null);
    if (
      session?.status !== "running" ||
      session.accountId !== launch.accountId ||
      session.tool !== launch.tool
    )
      return { status: 410 };
    if (this.modOwners.size > 256) this.modOwners.clear();
    this.modOwners.set(id, { owner: launch, at: Date.now() });
    return launch;
  }
  file(id) {
    if (!validSession(id)) throw problem(copy.session);
    return path.join(this.directory, `${id}.launch.json`);
  }
  prepare(input) {
    return this.ready.then(() => {
      // Whatever the last launch's CLI reported in memory is over.
      if (validSession(input?.id)) this.launched(input.id);
      return prepareRequests(this, input);
    });
  }
  emit(entry, action, source = "system", outcome = "success", decision, actor) {
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
          details: { kind: entry.kind, ...(decision ? { decision } : {}), ...actor },
        }),
      ).catch(() => {});
    } catch {}
  }
  /** Claude now shows its own approval dialog; chat must not just go blank. */
  terminalNotice(entry) {
    if (
      entry.source === "claude" &&
      entry.kind === "permission" &&
      !entry.presentation &&
      !entry.local
    )
      this.notices.set(entry.sessionId, {
        id: entry.id,
        reason: "terminal",
        at: Date.now(),
      });
  }
  /** Chat moved on (a message reached the terminal): the notice is history. */
  clearNotice(sessionId) {
    this.notices.delete(sessionId);
  }
  notice(sessionId) {
    const notice = this.notices.get(sessionId);
    if (!notice) return undefined;
    if (Date.now() - notice.at >= terminalNoticeMs) {
      this.notices.delete(sessionId);
      return undefined;
    }
    return { id: notice.id, reason: notice.reason };
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
          await confirmClaudeRuntime(this, owner, message.adapterVersion);
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
        const push = nativePushValue(message);
        if (push) return this.push(socket, owner, push);
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
            if (old.presentation === "codexHookTrust" && message.outcome === "trusted")
              old.nativeOutcome = "trusted";
            this.entries.delete(id);
            if (message.outcome === "timeout") this.terminalNotice(old);
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
          accountId: owner.accountId,
          launchIdentity: hookLaunchIdentity(owner),
          revision: 1,
          status: "pending",
          source: owner.tool,
          createdAt: new Date().toISOString(),
          key: message.key,
          socket,
        };
        if (
          owner.tool === "claude" &&
          entry.kind === "permission" &&
          entry.subject?.tool === "AskUserQuestion"
        )
          entry.presentation = "claudeLegacyQuestion";
        if (
          [...this.entries.values()].filter((e) => e.sessionId === owner.id).length >= 100
        )
          throw Error("Too many native requests");
        this.entries.set(id, entry);
        this.notices.delete(owner.id);
        this.emit(entry, "request.created");
      });
      return queue;
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(authenticationTimeout);
      this.clients.delete(socket);
      // A native owner that went away streams nothing any more.
      for (const runId of socket.runs || [])
        this.notify(owner.id, { type: "stream-end", runId });
      for (const [id, entry] of this.entries)
        if (entry.socket === socket) {
          this.entries.delete(id);
          this.emit(entry, "request.expired");
        }
      for (const delivery of this.deliveries.values())
        if (delivery.socket === socket) delivery.finish("unknown");
    });
  }
  /**
   * A push names no session of its own: it always belongs to the owner this socket
   * authenticated as, and only while that session runs on the same profile.
   */
  async push(socket, owner, push) {
    socket.verified ??= this.sessions.get(owner.id).then(
      (session) =>
        session.status === "running" &&
        session.accountId === owner.accountId &&
        session.tool === owner.tool,
      () => false,
    );
    if (!(await socket.verified)) throw Error("Native owner unavailable");
    // Only a Claude Code owner reports MessageDisplay batches.
    if (push.type === "claude-display" && owner.tool !== "claude") return;
    if (push.type === "stream") {
      socket.runs ??= new Set();
      socket.runs.add(push.runId);
      if (socket.runs.size > 64) socket.runs.delete(socket.runs.values().next().value);
    }
    if (push.type === "stream-end" && push.runId) socket.runs?.delete(push.runId);
    this.notify(owner.id, push);
  }
  launched(sessionId) {
    try {
      this.onLaunch(sessionId);
    } catch {
      /* Advisory, like a push. */
    }
  }
  notify(sessionId, push) {
    try {
      return this.onNative(sessionId, push);
    } catch {
      /* A hint is advisory; the watcher and the probe still see the change. */
    }
  }
  hasPending(sessionId) {
    return [...this.entries.values()].some((entry) => entry.sessionId === sessionId);
  }
  /**
   * Every open request of every session, for the owner's inbox. Unlike list() it has
   * no side effects: nothing is discarded, refreshed or announced, and the entries
   * carry only what the session's own request list shows.
   */
  listAll() {
    return [...this.entries.values()].map(
      ({
        socket: _socket,
        key: _key,
        accountId: _account,
        launchIdentity: _launch,
        local: _local,
        interaction: _interaction,
        nativeOutcome: _outcome,
        claimedBy: _claimed,
        ...entry
      }) => entry,
    );
  }
  async launchIdentity(id) {
    return hookLaunchIdentity(JSON.parse(await fs.readFile(this.file(id), "utf8")));
  }
  async list(sessionId) {
    const session = await this.sessions.get(sessionId);
    if (session.status !== "running")
      await this.discard(sessionId, { removeLaunch: false });
    await refreshStartupPrompts(this, session);
    const now = Date.now();
    return {
      ...(session.status === "running" && this.claudeReloadRequired.has(sessionId)
        ? { integration: { reloadRequired: true } }
        : {}),
      ...(this.notice(sessionId) ? { notice: this.notice(sessionId) } : {}),
      requests: [...this.entries.values()]
        .filter((e) => e.sessionId === sessionId)
        .map(
          ({
            socket: _socket,
            key: _key,
            accountId: _account,
            launchIdentity: _launch,
            local: _local,
            interaction,
            claimedBy: _claimed,
            ...entry
          }) => ({
            ...entry,
            // Relative age avoids depending on browser clocks.
            ...(interaction
              ? { interaction: { client: interaction.client, age: now - interaction.at } }
              : {}),
          }),
        ),
    };
  }
  /**
   * The first answer wins: the claim (status `responding`) is taken synchronously,
   * so every later answer, the owner's or an agent's, is stale. `actor`: null for
   * the owner, `{ kind: "agent", assistantId }` or `{ kind: "telegram" }`.
   */
  async answer(sessionId, id, input, handoff = false, actor = null) {
    const by = actorOf(actor);
    const source = by.actor === "agent" ? "system" : "user";
    const session = await this.sessions.get(sessionId);
    const entry = this.entries.get(id);
    if (
      session.status !== "running" ||
      !entry ||
      entry.sessionId !== sessionId ||
      // An uncertain delivery can still be released to the terminal; the
      // native side reports stale if it already consumed the answer.
      !(
        entry.status === "pending" ||
        (handoff && entry.status === "unknown" && entry.source === "claude")
      ) ||
      entry.revision !== input?.expectedRevision ||
      (!entry.local && entry.socket.destroyed)
    )
      throw stale(entry?.sessionId === sessionId ? entry : null);
    if (entry.presentation === "claudeLegacyQuestion" && !handoff)
      throw problem(copy.invalid, 400);
    const answer = handoff ? { handoff: true } : answerValue(entry, input);
    if (entry.local && entry.presentation !== "codexHookTrust" && handoff)
      return this.list(sessionId);
    const local = {
      codexHookTrust: answerHookTrust,
      claudeFolderTrust: answerFolderTrust,
      claudeStartupPrompt: answerStartupPrompt,
    }[entry.presentation];
    entry.claimedBy = by.actor;
    if (local && !handoff) {
      entry.status = "responding";
      entry.revision++;
      try {
        await local(this, entry, answer.choice);
        this.entries.delete(id);
        this.emit(
          entry,
          "request.answered",
          source,
          "success",
          ["exit", "no", "skip", "decline", "cancel"].includes(answer.choice)
            ? "deny"
            : "allow",
          by,
        );
        return this.list(sessionId);
      } catch (error) {
        // Keep a retryable, visible request after native config-write failures.
        entry.status = "pending";
        delete entry.claimedBy;
        throw error;
      }
    }
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
      if (handoff) this.terminalNotice(entry);
      this.emit(
        entry,
        handoff ? "request.handed-off" : "request.answered",
        source,
        "success",
        handoff
          ? "handoff"
          : entry.kind === "question"
            ? answer.decline
              ? "deny"
              : "answer"
            : ["deny", "decline", "reject", "cancel"].includes(input.choice)
              ? "deny"
              : "allow",
        by,
      );
    } else if (status === "stale") {
      this.entries.delete(id);
      throw stale();
    } else {
      entry.status = "unknown";
      this.emit(entry, "request.answered", source, "failure", undefined, by);
      throw problem(copy.unknown, 409);
    }
    return this.list(sessionId);
  }
  /** Records that a dialog is in use so other devices do not take it over. */
  async touch(sessionId, id, input) {
    const session = await this.sessions.get(sessionId);
    const entry = this.entries.get(id);
    if (session.status !== "running" || !entry || entry.sessionId !== sessionId)
      throw stale();
    if (typeof input?.client !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.client))
      throw problem(copy.invalid, 400);
    entry.interaction = { client: input.client, at: Date.now() };
    return {};
  }
  handoff(sessionId, id, input) {
    return this.answer(sessionId, id, input, true);
  }
  /** A file of this broker's directory named after a session, never outside it. */
  sessionPath(sessionId, suffix) {
    if (!validSession(sessionId)) throw problem(copy.session);
    const file = path.resolve(this.directory, `${sessionId}${suffix}`);
    if (!file.startsWith(path.resolve(this.directory) + path.sep))
      throw problem(copy.session);
    return file;
  }
  async discard(sessionId, { removeLaunch = true } = {}) {
    // Only a session id can name launch files; anything else removes nothing.
    if (!validSession(sessionId)) return;
    this.notices.delete(sessionId);
    this.modOwners.delete(sessionId);
    this.launched(sessionId);
    for (const socket of this.clients)
      if (socket.owner?.id === sessionId) socket.destroy();
    for (const [id, entry] of this.entries)
      if (entry.sessionId === sessionId) {
        this.entries.delete(id);
        this.emit(entry, "request.expired");
      }
    if (removeLaunch) {
      this.claudeReloadRequired.delete(sessionId);
      await fs.rm(this.sessionPath(sessionId, ".launch.json"), { force: true });
      for (const plugin of [".claude", ".claude-bridge"])
        await fs.rm(this.sessionPath(sessionId, plugin), {
          force: true,
          recursive: true,
        });
      await fs.rm(this.sessionPath(sessionId, ".tui.json"), { force: true });
    }
  }
  async close() {
    await this.ready;
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.clients) socket.destroy();
    await this.modServer?.close();
    await new Promise((resolve) => this.server.close(resolve));
    await fs.rm(this.socketPath, { force: true });
  }
}
