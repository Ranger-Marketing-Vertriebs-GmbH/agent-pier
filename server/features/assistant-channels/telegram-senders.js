import { assistantProblem } from "../assistants/assistant-validation.js";
import { personalEligible, personalShell } from "../assistants/native-capabilities.js";
import { restartRequired } from "../assistants/assistant-provider-synchronization.js";
import { temporaryMember } from "../assistants/team-presentation.js";
import { destroyBackupKeys } from "../assistants/backup-credentials.js";
import { randomUUID } from "node:crypto";
import { readJSON } from "../../lib/storage.js";
import {
  configuredAgents,
  readTelegramInputs,
  telegramEligible,
  telegramLiveChanges,
  telegramRevoked,
  telegramSections,
  telegramSnapshot,
} from "../assistants/openclaw-config/telegram-senders.js";
import { TelegramClient } from "./telegram-client.js";
import { patchTelegramAllowlists } from "./telegram-live.js";
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
 * the token and the allowed people, and compiles them at each Gateway start. A save
 * that only changes allowed people is patched into the running Gateway at once
 * (telegram-live.js); any other change to what the running Gateway was started with
 * (a bot, a token, the speech key) restarts it once the owner confirmed, like the web
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
    // Assistant ids with an SSH grant (assistant-access.js sshAgents).
    sshAgents = () => new Set(),
    // The agent ids the next start finds in openclaw.json: the start compiles bots
    // only for these (configuredAgents), so every comparison uses the same set.
    configured = null,
    retryMs = 30000,
    maxAttempts = 5,
    warn = console.warn,
    // The owner's push notifications (notification-service.js), when available.
    notifications = null,
    // How long a live allowlist patch waits for the Gateway's adoption event.
    adoptionTimeoutMs,
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
      sshAgents,
      retryMs,
      maxAttempts,
      warn,
      notifications,
    });
    this.configured = configured || this.configuredFromFile;
    this.adoption = { warn, timeoutMs: adoptionTimeoutMs };
    // Live allowlist patches run one at a time.
    this.live = Promise.resolve();
    this.retry = null;
    // The automatic restart for one revocation: { signature, attempts, restarted,
    // failed }. One restart per revocation; refusals back off, then the owner decides.
    this.revocation = null;
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
    if (this.sshAgents().has(assistantId))
      throw assistantProblem("telegramSendersSsh", 409);
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
  /** The agent ids in openclaw.json; throws when the file cannot be read or parsed. */
  configuredFromFile() {
    return configuredAgents(readJSON(this.assistants.runtime.paths?.config, null));
  }
  /** The snapshot a start would compile from `inputs` now. */
  desired(inputs = this.inputs()) {
    const profiles = this.assistants.store.listAssistants();
    return telegramSnapshot(
      telegramSections({
        profiles,
        telegram: inputs,
        agents: this.configured(),
        stdio: this.stdioAgents(),
        ssh: this.sshAgents(),
      }),
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
   * The allowlists the running or starting Gateway can take live, when they are all
   * that differs from `inputs` (telegramLiveChanges); null otherwise.
   */
  liveChanges(inputs = this.inputs()) {
    return telegramLiveChanges(this.running(), this.desired(inputs));
  }
  /**
   * Patches the stored allowlists into the ready Gateway when they are all that
   * differs. One at a time and, when available, under admission like every other
   * live configuration write. Resolves true once the Gateway runs what the store
   * compiles; false when there was nothing to patch or no ready Gateway (its start
   * compiles the store, ready() converges a start that read it too early). Rejects
   * when the patch failed.
   */
  applyLive() {
    const patch = async () => {
      const runtime = this.assistants.runtime;
      const started = runtime.telegram;
      if (!runtime.client?.ready || !started) return false;
      const desired = this.desired();
      const changes = telegramLiveChanges(started, desired);
      if (!changes) return false;
      await patchTelegramAllowlists(runtime.client, changes, this.adoption);
      // A restart meanwhile compiled the store itself and keeps its own snapshot.
      if (runtime.telegram === started) {
        if (runtime.telegramStarting === started) runtime.telegramStarting = desired;
        runtime.telegram = desired;
      }
      return true;
    };
    const admit = this.assistants.admit?.bind(this.assistants);
    const run = this.live.then(() => (admit ? admit(patch) : patch()));
    this.live = run.catch(() => {});
    return run;
  }
  /**
   * Called once a Gateway start answers. Allowed people saved while it started (or
   * just before its start read the store) are patched in live. Any other revocation
   * restarts it again at once; other additions wait for the owner ("pending"). A
   * refused restart (busy agents) is retried.
   */
  ready() {
    this.schedule(0);
  }
  // converge() never rejects; the catch only guards a timer against the impossible.
  schedule(ms) {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.converge().catch(() => {}), ms);
    this.retry.unref?.();
  }
  /**
   * Patches changed allowlists live; restarts the Gateway once for a revocation it
   * still runs otherwise, also when the live patch failed. Never rejects: a check
   * that cannot read openclaw.json or the store is logged by code and reported to the
   * owner like a revocation the restart could not remove.
   */
  async converge() {
    clearTimeout(this.retry);
    this.retry = null;
    try {
      return await this.convergeOnce();
    } catch (error) {
      this.warn(
        `The Telegram revocation check failed (${error?.code || error?.name || "ERROR"}).`,
      );
      if (!this.revocation?.failed) {
        this.revocation = { signature: null, attempts: 0, failed: true, error: true };
        this.alert(null);
      }
      return false;
    }
  }
  /** Tells the owner once per failed revocation, outside the agent's settings too. */
  alert(assistantId) {
    try {
      Promise.resolve(
        this.notifications?.notify({
          kind: "telegram-revocation",
          eventId: randomUUID(),
          ...(assistantId && { assistantId }),
        }),
      ).catch(() => {});
    } catch {
      // A notification never decides the outcome.
    }
  }
  /** The first agent whose bot the Gateway runs other than the store says, or null. */
  revokedAgent(running, desired) {
    const id = running.accounts.find(
      (account) =>
        !desired.accounts.includes(account) ||
        running.tokens[account] !== desired.tokens[account] ||
        running.people[account].some((p) => !desired.people[account].includes(p)),
    );
    const profile =
      id && this.assistants.store.listAssistants().find((p) => p.runtimeAgentId === id);
    return profile?.id || null;
  }
  async convergeOnce() {
    if (this.liveChanges()) {
      try {
        if (await this.applyLive()) {
          this.revocation = null;
          return true;
        }
      } catch (error) {
        this.warn(
          `Allowed Telegram people could not be applied live (${error?.code || error?.key || "ERROR"}).`,
        );
      }
    }
    const desired = this.desired();
    if (!telegramRevoked(this.running(), desired)) {
      this.revocation = null;
      return false;
    }
    if (this.revocation?.signature !== desired.signature)
      this.revocation = { signature: desired.signature, attempts: 0, restarted: false };
    const revocation = this.revocation;
    // A restart that did not remove it will not do so the next time either.
    if (revocation.restarted || revocation.failed) {
      if (!revocation.failed) {
        this.warn("A revoked Telegram bot is still running after a restart.");
        revocation.failed = true;
        this.alert(this.revokedAgent(this.running(), desired));
      }
      return false;
    }
    revocation.attempts++;
    try {
      await this.synchronization.restartGateway(() => null);
      revocation.restarted = true;
      return true;
    } catch (error) {
      const code = error?.code || error?.key || "ERROR";
      if (revocation.attempts >= this.maxAttempts) {
        this.warn(`A revoked Telegram bot is still running (${code}); restart needed.`);
        revocation.failed = true;
        this.alert(this.revokedAgent(this.running(), desired));
        return false;
      }
      this.warn(`A revoked Telegram bot is still running (${code}); retrying.`);
      this.schedule(this.retryMs * 2 ** (revocation.attempts - 1));
      return false;
    }
  }
  /**
   * Whether the Gateway runs this agent's bot other than stored: added, removed, other
   * people or token, or (with a bot) another speech key.
   */
  agentPending(assistantId) {
    const running = this.running();
    if (!running) return false;
    const desired = this.desired();
    const id = this.assistants.store.getAssistant(assistantId).runtimeAgentId;
    const was = running.accounts.includes(id),
      is = desired.accounts.includes(id);
    if (was !== is) return true;
    if (!is) return false;
    const same = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
    return (
      running.tokens[id] !== desired.tokens[id] ||
      !same(running.people[id], desired.people[id]) ||
      running.voiceKey !== desired.voiceKey
    );
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
   * Runs `operation` at once when the running Gateway is unaffected or only its
   * allowlists change (patched in live right after), otherwise after the owner's
   * confirmation inside a Gateway restart.
   */
  async commit(inputs, operation, confirmed) {
    const live = this.liveChanges(inputs);
    if (!this.differs(inputs) || live) {
      const result = operation();
      this.assistants.changed?.();
      // A starting Gateway gets the lists once it answers (ready()). A failed patch
      // of a removed person falls back to the revocation restart (converge).
      if (live && this.assistants.runtime.client?.ready) await this.converge();
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
    // A check that cannot read openclaw.json reports the owner alert, never a 503.
    const checked = (check, fallback) => {
      try {
        return check();
      } catch {
        return fallback;
      }
    };
    return {
      assistantId,
      bot,
      status: bot ? await this.status(bot).catch(() => ({ state: "error" })) : null,
      pending: checked(() => this.agentPending(assistantId), false),
      // The pending change applies without a restart ("Apply now" patches it in).
      pendingLive: checked(
        () => this.agentPending(assistantId) && !!this.liveChanges(),
        false,
      ),
      // The automatic restart could not remove a revoked bot (or the check failed):
      // the owner restarts.
      revocationFailed:
        !!this.revocation?.failed &&
        (!!this.revocation.error || checked(() => this.revoked(), true)),
      voice: this.voiceAvailable(),
      shell: personalShell(profile),
      stdio: this.stdioAgents().has(assistantId),
      ssh: this.sshAgents().has(assistantId),
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
   * or the agent cannot own a bot: archived, shell, a stdio MCP server or SSH grants).
   */
  async status(bot) {
    const runtime = this.assistants.runtime;
    const profile = this.assistants.store.getAssistant(bot.assistantId);
    if (
      !bot.people.length ||
      !telegramEligible(profile, this.stdioAgents(), this.sshAgents())
    )
      return { state: "inactive" };
    if (!runtime.client?.ready || !runtime.telegram) return { state: "stopped" };
    if (this.agentPending(bot.assistantId)) return { state: "pending" };
    // Neither running nor compiled by a restart: the agent has no Gateway entry yet
    // (its first apply creates it; then the bot is pending).
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
      // A new token is the next revision; the token itself is never compared.
      tokenRevision: identity ? (stored?.tokenRevision ?? 0) + 1 : stored?.tokenRevision,
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
            keyRevision: keyChanged ? this.speech.keyRevision() + 1 : current.keyRevision,
            model: input.model ?? current.model ?? this.speech.get().model,
            language: input.language ?? current.language ?? this.speech.get().language,
          }
        : null;
    }
    return this.commit(
      inputs,
      () => {
        if (keyChanged && (this.store.list().length || this.running()?.voice))
          destroyBackupKeys(this.store.root);
        return this.speech.save(input);
      },
      confirmed,
    );
  }
  /**
   * Brings the Gateway up to the stored bots: live for allowlists, otherwise by a
   * restart (a new speech key, a bot waiting for its agent's Gateway entry).
   */
  async apply({ confirmed = false } = {}) {
    if (confirmed) this.revocation = null;
    if (!this.differs()) return { applied: false };
    const live = !!this.liveChanges();
    await this.commit(this.inputs(), () => null, confirmed);
    return { applied: live ? !this.differs() : true };
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
