import { assistantProblem } from "../assistants/assistant-validation.js";
import { personalEligible, personalShell } from "../assistants/native-capabilities.js";
import { restartRequired } from "../assistants/assistant-provider-synchronization.js";
import { temporaryMember } from "../assistants/team-presentation.js";
import {
  readTelegramInputs,
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
    });
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
    return profile;
  }
  /**
   * True when the running Gateway was started with other Telegram sections than
   * `inputs` compile now. A stopped Gateway compiles them at its next start.
   */
  differs(inputs = this.inputs()) {
    const runtime = this.assistants.runtime;
    const running = runtime.client?.ready && runtime.telegram;
    if (!running) return false;
    const profiles = this.assistants.store.listAssistants();
    // Applied agents have their Gateway entry, so a restart would compile their bots.
    const agents = new Set(
      profiles.filter((p) => p.effectiveRevision > 0).map((p) => p.runtimeAgentId),
    );
    const next = telegramSnapshot(
      telegramSections({ profiles, telegram: inputs, agents }),
    );
    return next.signature !== running.signature;
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
  /** The agent's bot (never its token), the people it admits and its state. */
  async get(assistantId) {
    this.assistants.store.getAssistant(assistantId);
    const bot = this.store.get(assistantId);
    return {
      assistantId,
      bot,
      status: bot ? await this.status(bot) : null,
      voice: this.voiceAvailable(),
      shell: personalShell(this.assistants.store.getAssistant(assistantId)),
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
   * `pending` (saved, not yet in the running Gateway) or `inactive` (nobody allowed).
   */
  async status(bot) {
    const runtime = this.assistants.runtime;
    const profile = this.assistants.store.getAssistant(bot.assistantId);
    if (!bot.people.length) return { state: "inactive" };
    if (!runtime.client?.ready || !runtime.telegram) return { state: "stopped" };
    if (this.differs()) return { state: "pending" };
    if (!runtime.telegram.accounts.includes(profile.runtimeAgentId))
      return { state: "inactive" };
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
      () => this.store.save(assistantId, { identity, people }, input.revision),
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
