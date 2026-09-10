import { createHash, randomUUID } from "node:crypto";
import { finalizeObservability } from "./chat-observability.js";
import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { privateDirectory, readJSON, writePrivate, problem } from "../../lib/storage.js";
import { providerId } from "./provider-history.js";

const LIVE_HISTORY_TIMEOUT = 1500;

export class ChatStore {
  constructor({
    dataDir,
    sessions,
    history,
    bindings,
    events,
    liveHistoryTimeout = LIVE_HISTORY_TIMEOUT,
    maxCursorBytes = 64 * 1024 * 1024,
    maxCursorEntries = 512,
  }) {
    this.directory = privateDirectory(path.join(dataDir, "chat"));
    this.sessions = sessions;
    this.history = history;
    this.bindings = bindings;
    this.events = events;
    this.liveHistoryTimeout = liveHistoryTimeout;
    this.cache = new Map();
    this.inflight = new Map();
    this.generations = new Map();
    this.cursors = new Map();
    this.cursorBytes = 0;
    this.maxCursorBytes = maxCursorBytes;
    this.maxCursorEntries = Math.max(1, maxCursorEntries);
  }
  file(id, suffix = "binding") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))
      throw problem(serverMessages.common.invalidSessionId);
    return path.join(this.directory, `${id}.${suffix}.json`);
  }
  invalidate(id) {
    this.cache.delete(id);
  }
  reset(id) {
    this.invalidate(id);
    this.generations.set(id, randomUUID());
    fs.rmSync(this.file(id, "snapshot"), { force: true });
    for (const [key, entry] of this.cursors) if (entry.id === id) this.discardCursor(key);
  }
  page(session, nativeId, state) {
    return this.history.readPage
      ? this.history.readPage(session, nativeId, state)
      : this.history.read(session, nativeId);
  }
  discardCursor(cursor) {
    const entry = this.cursors.get(cursor);
    if (!entry) return;
    this.cursorBytes -= entry.bytes;
    this.cursors.delete(cursor);
  }
  cursor(session, nativeId, state) {
    if (!state) return null;
    const generation = this.generations.get(session.id);
    const serialized = JSON.stringify([
      session.id,
      session.accountId,
      session.tool,
      nativeId,
      generation,
      state,
    ]);
    const signature = createHash("sha256").update(serialized).digest("hex");
    for (const [cursor, entry] of this.cursors)
      if (entry.signature === signature) return cursor;
    const bytes = Buffer.byteLength(serialized) + 256;
    if (bytes > this.maxCursorBytes)
      throw problem(serverMessages.chat.historyTooLarge, 413);
    while (
      this.cursors.size >= this.maxCursorEntries ||
      this.cursorBytes + bytes > this.maxCursorBytes
    )
      this.discardCursor(this.cursors.keys().next().value);
    const cursor = randomUUID();
    this.cursors.set(cursor, {
      id: session.id,
      accountId: session.accountId,
      tool: session.tool,
      nativeId,
      generation,
      state,
      signature,
      bytes,
    });
    this.cursorBytes += bytes;
    return cursor;
  }
  async current(session, nativeId, generation) {
    const latest = await this.sessions.get(session.id);
    const binding = readJSON(this.file(session.id), null);
    if (
      latest.accountId !== session.accountId ||
      latest.tool !== session.tool ||
      binding?.providerSessionId !== nativeId ||
      binding.accountId !== session.accountId ||
      this.generations.get(session.id) !== generation
    )
      throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
  }
  async currentNative(session, nativeId, generation) {
    await this.current(session, nativeId, generation);
    const native = await this.bindings?.resolve(session);
    await this.current(session, nativeId, generation);
    const binding = readJSON(this.file(session.id), null);
    const authoritative =
      session.nativeBinding?.enabled ||
      native?.source === "native-process" ||
      binding?.source === "automatic";
    if (authoritative && native && native.id !== nativeId) {
      this.reset(session.id);
      throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
    }
  }
  async older(id, cursor) {
    const entry = typeof cursor === "string" ? this.cursors.get(cursor) : null;
    if (!entry || entry.id !== id)
      throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
    const session = { ...(await this.sessions.get(id)) };
    if (session.accountId !== entry.accountId || session.tool !== entry.tool)
      throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
    await this.currentNative(session, entry.nativeId, entry.generation);
    const content = await this.page(session, entry.nativeId, entry.state);
    await this.currentNative(session, entry.nativeId, entry.generation);
    return {
      providerSessionId: entry.nativeId,
      messages: content.messages,
      history: {
        cursor: this.cursor(session, entry.nativeId, content.next),
        generation: entry.generation,
      },
    };
  }
  initialize(session, nativeId, source = "manual") {
    this.reset(session.id);
    if (nativeId)
      writePrivate(this.file(session.id), {
        providerSessionId: providerId(nativeId),
        accountId: session.accountId,
        tool: session.tool,
        source,
      });
    if (nativeId)
      this.events?.publish(session.id, "binding-changed", {
        providerSessionId: nativeId,
      });
  }
  async bind(id, nativeId) {
    const session = { ...(await this.sessions.get(id)) };
    const initialGeneration = this.generations.get(id);
    providerId(nativeId);
    if (session.tool === "shell" || session.purpose === "login")
      throw problem(serverMessages.chat.linkUnavailable, 409);
    const choices = await this.history.list(session);
    if (!choices.some((choice) => choice.id === nativeId))
      throw problem(serverMessages.chat.historySelectionRequired);
    const generation = initialGeneration;
    const content = await this.page(session, nativeId);
    const latest = await this.sessions.get(id);
    if (
      this.generations.get(id) !== generation ||
      latest.accountId !== session.accountId ||
      latest.tool !== session.tool
    )
      throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
    this.initialize(session, nativeId);
    this.cache.delete(id);
    return this.snapshot(session, nativeId, content);
  }
  snapshot(session, nativeId, content) {
    const result = {
      availability: "ready",
      providerSessionId: nativeId,
      messages: content.messages,
      history: {
        cursor: this.cursor(session, nativeId, content.next),
        generation: this.generations.get(session.id),
      },
      tasks: content.tasks,
      observability: finalizeObservability(content.observability, session),
    };
    writePrivate(this.file(session.id, "snapshot"), {
      ...result,
      scope: { accountId: session.accountId, tool: session.tool },
    });
    return result;
  }
  async choices(id) {
    const session = await this.sessions.get(id);
    if (session.tool === "shell" || session.purpose === "login")
      throw problem(serverMessages.chat.historyUnavailable, 409);
    return this.history.list(session);
  }
  async read(id) {
    const session = { ...(await this.sessions.get(id)) };
    if (!this.generations.has(id)) this.generations.set(id, randomUUID());
    const initialGeneration = this.generations.get(id);
    if (session.purpose === "login")
      return {
        availability: "unsupported",
        messages: [],
        tasks: [],
        notice: serverMessages.chat.loginInTerminal,
      };
    if (session.tool === "shell")
      return {
        availability: "unsupported",
        messages: [],
        tasks: [],
        notice: serverMessages.chat.shellInTerminal,
      };
    let binding = readJSON(this.file(id), null);
    const native = await this.bindings?.resolve(session);
    const latest = await this.sessions.get(id);
    if (
      this.generations.get(id) !== initialGeneration ||
      latest.accountId !== session.accountId ||
      latest.tool !== session.tool
    )
      throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
    if (native && native.id === null && session.nativeBinding?.enabled)
      return {
        availability: "waiting",
        observability: finalizeObservability(null, session),
        providerSessionId: null,
        messages: [],
        tasks: [],
        notice: serverMessages.chat.startNativeConversation,
      };
    if (
      native?.id &&
      (!binding ||
        native.source === "native-process" ||
        binding.source === "automatic" ||
        session.nativeBinding?.enabled)
    ) {
      if (binding?.providerSessionId !== native.id) {
        this.initialize(session, native.id, "automatic");
        this.cache.delete(id);
        binding = readJSON(this.file(id), null);
      }
    }
    if (!binding && session.nativeBinding?.enabled)
      return {
        availability: "waiting",
        observability: finalizeObservability(null, session),
        providerSessionId: null,
        messages: [],
        tasks: [],
        notice:
          session.tool === "codex"
            ? serverMessages.chat.codexBindingPending
            : serverMessages.chat.nativeBindingPending,
      };
    if (!binding)
      return {
        availability: "unbound",
        providerSessionId: null,
        messages: [],
        tasks: [],
      };
    if (binding.accountId !== session.accountId || binding.tool !== session.tool)
      throw problem(serverMessages.chat.linkedAccountMismatch);
    const stored = readJSON(this.file(id, "snapshot"), null);
    const { scope, ...saved } = stored || {};
    const hasSaved =
      saved.providerSessionId === binding.providerSessionId &&
      (!scope || (scope.accountId === session.accountId && scope.tool === session.tool));
    const stale = () => ({
      ...saved,
      messages: (saved.messages || []).slice(-50),
      history: {
        cursor:
          this.cursors.has(saved.history?.cursor) &&
          saved.history?.generation === this.generations.get(id)
            ? saved.history.cursor
            : null,
        generation: this.generations.get(id),
      },
      observability: finalizeObservability(saved.observability, session, {
        stale: true,
      }),
      notice: serverMessages.chat.savedHistoryNotice,
    });
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.time < 1000) return cached.promise;
    const generation = this.generations.get(id);
    const key = JSON.stringify([
      id,
      session.accountId,
      session.tool,
      binding.providerSessionId,
      generation,
    ]);
    let timedOut = false;
    let live = this.inflight.get(key);
    if (!live) {
      live = Promise.resolve()
        .then(() => this.page(session, binding.providerSessionId))
        .then(async (content) => {
          await this.current(session, binding.providerSessionId, generation);
          const result = this.snapshot(session, binding.providerSessionId, content);
          this.cache.set(id, { time: Date.now(), promise: Promise.resolve(result) });
          if (timedOut)
            this.events?.publish(id, "snapshot-changed", {
              providerSessionId: binding.providerSessionId,
            });
          return result;
        })
        .finally(() => {
          if (this.inflight.get(key) === live) this.inflight.delete(key);
        });
      this.inflight.set(key, live);
    }
    const promise = (async () => {
      try {
        if (hasSaved && session.status === "running") {
          let timer;
          const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve(null);
            }, this.liveHistoryTimeout);
          });
          try {
            const result = await Promise.race([live, timeout]);
            await this.current(session, binding.providerSessionId, generation);
            return result || stale();
          } finally {
            clearTimeout(timer);
          }
        }
        return await live;
      } catch (error) {
        await this.current(session, binding.providerSessionId, generation);
        if (hasSaved) return stale();
        if (error.status === 404)
          return {
            availability: "waiting",
            observability: finalizeObservability(null, session),
            providerSessionId: binding.providerSessionId,
            messages: [],
            tasks: [],
            notice: serverMessages.chat.emptyHistoryNotice,
          };
        throw error;
      }
    })();
    this.cache.set(id, { time: Date.now(), promise });
    try {
      return await promise;
    } catch (error) {
      this.cache.delete(id);
      throw error;
    }
  }
  remove(id) {
    this.reset(id);
    for (const suffix of ["binding", "snapshot"])
      fs.rmSync(this.file(id, suffix), { force: true });
    this.cache.delete(id);
  }
}
