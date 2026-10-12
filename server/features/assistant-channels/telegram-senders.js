import { assistantProblem } from "../assistants/assistant-validation.js";
import { personalEligible, personalShell } from "../assistants/native-capabilities.js";
import { restartRequired } from "../assistants/assistant-provider-synchronization.js";
import { temporaryMember } from "../assistants/team-presentation.js";
import { destroyBackupKeys } from "../assistants/backup-credentials.js";
import {
  readTelegramInputs,
  telegramEligible,
  telegramRevoked,
  telegramSections,
  telegramSnapshot,
} from "../assistants/openclaw-config/telegram-senders.js";
import { TelegramClient } from "./telegram-client.js";
import { validPeople } from "./native-telegram-store.js";

// Telegram client failures the owner can act on; anything else is "unavailable".
const clientProblems = {
  TELEGRAM_TOKEN: ["channelToken", 400],
  TELEGRAM_REJECTED: ["channelToken", 400],
  TELEGRAM_IDENTITY: ["channelToken", 400],
  TELEGRAM_WEBHOOK: ["channelWebhook", 409],
};

/**
 * Agents' own Telegram bots for other people (one bot per agent). OpenClaw runs them
 * natively inside the Gateway (openclaw-config/telegram-senders.js); AgentPier keeps
 * the token and the allowed people, and compiles them at each Gateway start. Telegram
 * settings exist only in the startup configuration, so a save that changes what the
 * running Gateway was started with restarts it once the owner confirmed, like the web
 * search settings.
 */
export class TelegramSenders {
  constructor({
    store,
    assistants,
    speech,
    synchronization,
    audit,
    apiRoot = null,
    deepgram = null,
    clientFactory = (token) => new TelegramClient({ token, ...(apiRoot && { apiRoot }) }),
    // Assistant ids bound to a stdio MCP server (openclaw-config/telegram-senders.js).
    stdioAgents = () => new Set(),
    retryMs = 30000,
    warn = console.warn,
  }) {
    Object.assign(this, {
      assistants,
      speech,
      synchronization,
      audit,
      apiRoot,
      deepgram,
      clientFactory,
      store,
      stdioAgents,
      retryMs,
      warn,
    });
    this.retry = null;
  }
  /** What the next Gateway start compiles (see runtime-supervisor.js). */
  inputs() {
    return readTelegramInputs(this.store, this.speech, {
      apiRoot: this.apiRoot,
      deepgram: this.deepgram,
    });
  }
  connected(assistantId) {
    return !!this.store.get(assistantId);
  }
  /** Refuses agents that cannot own a bot for other people. */
  eligible(assistantId) {
    const profile = this.assistants.store.getAssistant(assistantId);
    if (!personalEligible(profile) || temporaryMember(profile))
      throw assistantProblem("invalid");
    if (personalShell(profile) !== "off")
      throw assistantProblem("telegramSendersShell", 409);
    if (this.stdioAgents().has(assistantId))
      throw assistantProblem("telegramSendersStdio", 409);
    return profile;
  }
  /**
   * What the Gateway runs or is starting with: the snapshot of its start, from the
   * moment the start compiled it. Null while no Gateway runs or starts.
   */
  running() {
    const runtime = this.assistants.runtime;
    return runtime.telegram || runtime.telegramStarting || null;
  }
  /** The snapshot a start would compile from `inputs` now. */
  desired(inputs = this.inputs()) {
    const profiles = this.assistants.store.listAssistants();
    // Applied agents have their Gateway entry, so a restart would compile their bots.
    const agents = new Set(
      profiles.filter((p) => p.effectiveRevision > 0).map((p) => p.runtimeAgentId),
    );
    return telegramSnapshot(
      telegramSections({ profiles, telegram: inputs, agents, stdio: this.stdioAgents() }),
    );
  }
  /**
   * True when the running or starting Gateway compiled other Telegram sections than
   * `inputs` compile now. A stopped Gateway compiles them at its next start.
   */
  differs(inputs = this.inputs()) {
    const running = this.running();
    return !!running && this.desired(inputs).signature !== running.signature;
  }
  /** True when the Gateway still runs a bot, person, token or key that is gone. */
  revoked(inputs = this.inputs()) {
    return telegramRevoked(this.running(), this.desired(inputs));
  }
  /**
   * Called once a Gateway start answers. A revocation saved while it started (or a
   * start that read the store just before one) restarts it again at once; additions
   * wait for the owner ("pending"). A refused restart (busy agents) is retried.
   */
  ready() {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.converge(), 0);
    this.retry.unref?.();
  }
  async converge() {
    clearTimeout(this.retry);
    this.retry = null;
    if (!this.revoked()) return false;
    try {
      await this.synchronization.restartGateway(() => null);
      return true;
    } catch (error) {
      this.warn(
        `A revoked Telegram bot is still running (${error?.code || error?.key || "ERROR"}); retrying.`,
      );
      this.retry = setTimeout(() => this.converge(), this.retryMs);
      this.retry.unref?.();
      return false;
    }
  }
  close() {
    clearTimeout(this.retry);
  }
  /** The inputs once `assistantId` holds `account` (or none, for null). */
  inputsWith(assistantId, account) {
    const inputs = this.inputs();
    const others = inputs.accounts.filter((a) => a.assistantId !== assistantId);
    inputs.accounts = account ? [...others, { assistantId, ...account }] : others;
    return inputs;
  }
  usage() {
    const profiles = this.assistants.store.listAssistants().filter((p) => !p.archivedAt);
    return {
      agents: profiles
        .filter((p) => !temporaryMember(p))
        .map(({ id, name }) => ({ id, name })),
      teamMembers: profiles.filter(temporaryMember).length,
    };
  }
  /**
   * Runs `operation` at once when the running Gateway is unaffected, otherwise after
   * the owner's confirmation inside a Gateway restart.
   */
  async commit(inputs, operation, confirmed) {
    if (!this.differs(inputs)) {
      const result = operation();
      this.assistants.changed?.();
      return result;
    }
    if (!confirmed) throw restartRequired("telegramSendersRestartRequired", this.usage());
    return this.synchronization.restartGateway(operation);
  }
  async identity(token) {
    try {
      return { ...(await this.clientFactory(token).identity()), token };
    } catch (error) {
      const [key, status] = clientProblems[error.code] || ["channelUnavailable", 503];
      throw assistantProblem(key, status);
    }
  }
  /**
   * The agent's bot (never its token), the people it admits and its state. `pending`
   * is true while the Gateway runs other bots than stored, also after a removal.
   */
  async get(assistantId) {
    const profile = this.assistants.store.getAssistant(assistantId);
    const bot = this.store.get(assistantId);
    return {
      assistantId,
      bot,
      status: bot ? await this.status(bot) : null,
      pending: this.differs(),
      voice: this.voiceAvailable(),
      shell: personalShell(profile),
      stdio: this.stdioAgents().has(assistantId),
    };
  }
  voiceAvailable() {
    try {
      return !!this.speech?.get().hasSecret;
    } catch {
      return false;
    }
  }
  /**
   * `running`, `starting`, `error` (the account failed), `stopped` (no Gateway),
   * `pending` (saved, not yet in the running Gateway) or `inactive` (nobody allowed,
   * or the agent cannot own a bot: archived, shell or a stdio MCP server).
   */
  async status(bot) {
    const runtime = this.assistants.runtime;
    const profile = this.assistants.store.getAssistant(bot.assistantId);
    if (!bot.people.length || !telegramEligible(profile, this.stdioAgents()))
      return { state: "inactive" };
    if (!runtime.client?.ready || !runtime.telegram) return { state: "stopped" };
    if (this.differs()) return { state: "pending" };
    // Saved for an agent the running Gateway did not know yet: the next start has it.
    if (!runtime.telegram.accounts.includes(profile.runtimeAgentId))
      return { state: "pending" };
    let account;
    try {
      const status = await runtime.client.call("channels.status", { probe: false });
      account = status?.channelAccounts?.telegram?.find(
        (a) => a.accountId === profile.runtimeAgentId,
      );
    } catch {
      return { state: "stopped" };
    }
    // Only the state travels: OpenClaw's error text is not shown.
    if (!account) return { state: "starting" };
    if (account.lastError) return { state: "error" };
    return { state: account.running && account.connected ? "running" : "starting" };
  }
  /**
   * Connects a bot (`token`), replaces its token or sets the people it admits.
   * `revision` is null for a new bot. A token is verified with Telegram first and
   * must not belong to the owner's AgentPier bot or another agent.
   */
  async save(assistantId, input, { confirmed = false } = {}) {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((k) => !["token", "people", "revision"].includes(k)) ||
      (input.token !== undefined && typeof input.token !== "string") ||
      (input.revision !== null && !Number.isSafeInteger(input.revision))
    )
      throw assistantProblem("invalid");
    this.eligible(assistantId);
    const current = this.store.get(assistantId);
    if (!current && !input.token) throw assistantProblem("invalid");
    const identity = input.token ? await this.identity(input.token) : undefined;
    if (identity) this.store.requireFree(identity.id, assistantId);
    // Validated before the comparison, so a malformed list never asks to restart.
    const { people } = input;
    const preview = people === undefined ? current?.people || [] : validPeople(people);
    const stored = this.store.compiled().find((a) => a.assistantId === assistantId);
    const inputs = this.inputsWith(assistantId, {
      botId: identity ? String(identity.id) : current.botId,
      token: identity?.token || stored?.token,
      people: preview.map((person) => person.id),
    });
    const saved = await this.commit(
      inputs,
      () => {
        // Checked again: a shell raise or stdio binding may have raced this save.
        this.eligible(assistantId);
        return this.store.save(assistantId, { identity, people }, input.revision);
      },
      confirmed,
    );
    this.record(assistantId, current, saved, { token: !!identity });
    return this.get(assistantId);
  }
  /** Removes the agent's bot; Telegram stops at the latest at the next start. */
  async remove(assistantId, revision, { confirmed = false } = {}) {
    this.assistants.store.getAssistant(assistantId);
    const current = this.store.requireRevision(assistantId, revision);
    await this.commit(
      this.inputsWith(assistantId, null),
      () => this.store.remove(assistantId, revision),
      confirmed,
    );
    this.record(assistantId, current, null);
    return this.get(assistantId);
  }
  /**
   * Saves the speech settings (speech-connections.js). The Deepgram key is compiled
   * into the Gateway with any bot: changing or removing it destroys every backup key
   * first and, when the running Gateway uses another key, restarts it once the owner
   * confirmed, so the old key is no longer live.
   */
  async saveSpeech(input, { confirmed = false } = {}) {
    const record = !!input && typeof input === "object" && !Array.isArray(input);
    const keyChanged = record && (input.apiKey !== undefined || !!input.removeApiKey);
    const inputs = this.inputs();
    if (record && inputs.accounts.length) {
      const current = inputs.speech || {};
      const apiKey = input.removeApiKey ? null : (input.apiKey ?? current.apiKey);
      inputs.speech = apiKey
        ? {
            apiKey,
            model: input.model ?? current.model ?? this.speech.get().model,
            language: input.language ?? current.language ?? this.speech.get().language,
          }
        : null;
    }
    return this.commit(
      inputs,
      () => {
        if (keyChanged && (this.store.list().length || this.running()?.voiceKey))
          destroyBackupKeys(this.store.root);
        return this.speech.save(input);
      },
      confirmed,
    );
  }
  /** Restarts the Gateway when it lags behind the stored bots (a new speech key). */
  async apply({ confirmed = false } = {}) {
    if (!this.differs()) return { applied: false };
    await this.commit(this.inputs(), () => null, confirmed);
    return { applied: true };
  }
  /** One audit record per change; never a token, an id or a name. */
  record(assistantId, before, after, { token = false } = {}) {
    const changes = [];
    if (!before) changes.push(["connected", after.people.length]);
    else if (!after) changes.push(["disconnected", before.people.length]);
    else {
      if (before.botId !== after.botId) changes.push(["botReplaced", 0]);
      else if (token) changes.push(["tokenReplaced", 0]);
      const ids = (list) => new Set(list.map((p) => p.id));
      const was = ids(before.people),
        now = ids(after.people);
      const added = [...now].filter((id) => !was.has(id)).length;
      const removed = [...was].filter((id) => !now.has(id)).length;
      if (added) changes.push(["peopleAdded", added]);
      if (removed) changes.push(["peopleRemoved", removed]);
      if (!changes.length) changes.push(["updated", 0]);
    }
    for (const [telegram, count] of changes)
      try {
        this.audit?.append({
          action: "assistant.updated",
          resourceType: "assistant",
          resourceId: assistantId,
          source: "user",
          outcome: "success",
          details: { kind: "telegram", telegram, count },
        });
      } catch (error) {
        console.error("Telegram sender audit failed:", error?.message);
      }
  }
}
