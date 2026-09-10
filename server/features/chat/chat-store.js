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
    liveHistoryTimeout = LIVE_HISTORY_TIMEOUT,
  }) {
    this.directory = privateDirectory(path.join(dataDir, "chat"));
    this.sessions = sessions;
    this.history = history;
    this.bindings = bindings;
    this.liveHistoryTimeout = liveHistoryTimeout;
    this.cache = new Map();
  }
  file(id, suffix = "binding") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))
      throw problem(serverMessages.common.invalidSessionId);
    return path.join(this.directory, `${id}.${suffix}.json`);
  }
  initialize(session, nativeId, source = "manual") {
    if (nativeId)
      writePrivate(this.file(session.id), {
        providerSessionId: providerId(nativeId),
        accountId: session.accountId,
        tool: session.tool,
        source,
      });
  }
  async bind(id, nativeId) {
    const session = await this.sessions.get(id);
    providerId(nativeId);
    if (session.tool === "shell" || session.purpose === "login")
      throw problem(serverMessages.chat.linkUnavailable, 409);
    const choices = await this.history.list(session);
    if (!choices.some((choice) => choice.id === nativeId))
      throw problem(serverMessages.chat.historySelectionRequired);
    const content = await this.history.read(session, nativeId);
    this.initialize(session, nativeId);
    this.cache.delete(id);
    return this.snapshot(session, nativeId, content);
  }
  snapshot(session, nativeId, content) {
    const result = {
      availability: "ready",
      providerSessionId: nativeId,
      messages: content.messages.slice(-500),
      tasks: content.tasks,
      observability: finalizeObservability(content.observability, session),
      ...(content.messages.length > 500
        ? { notice: serverMessages.chat.recentMessageLimit }
        : {}),
    };
    writePrivate(this.file(session.id, "snapshot"), result);
    return result;
  }
  async choices(id) {
    const session = await this.sessions.get(id);
    if (session.tool === "shell" || session.purpose === "login")
      throw problem(serverMessages.chat.historyUnavailable, 409);
    return this.history.list(session);
  }
  async read(id) {
    const session = await this.sessions.get(id);
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
    const saved = readJSON(this.file(id, "snapshot"), null);
    const hasSaved = saved?.providerSessionId === binding.providerSessionId;
    const stale = () => ({
      ...saved,
      observability: finalizeObservability(saved.observability, session, {
        stale: true,
      }),
      notice: serverMessages.chat.savedHistoryNotice,
    });
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.time < 1000) return cached.promise;
    const live = this.history
      .read(session, binding.providerSessionId)
      .then((content) => this.snapshot(session, binding.providerSessionId, content));
    const promise = (async () => {
      try {
        if (hasSaved && session.status === "running") {
          let timer;
          const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), this.liveHistoryTimeout);
          });
          const result = await Promise.race([live, timeout]);
          clearTimeout(timer);
          return result || stale();
        }
        return await live;
      } catch (error) {
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
    for (const suffix of ["binding", "snapshot"])
      fs.rmSync(this.file(id, suffix), { force: true });
    this.cache.delete(id);
  }
}
