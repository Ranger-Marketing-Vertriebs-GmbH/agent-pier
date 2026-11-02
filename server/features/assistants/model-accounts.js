import path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { runtimePaths } from "./runtime-paths.js";
import { assistantProblem } from "./assistant-validation.js";
import { destroyBackupKeys } from "./backup-credentials.js";
import { ModelAccountCatalog, accountModelId } from "./model-account-catalog.js";
import { hostReady, runtimeFor } from "./runtimes/runtime-for.js";
import { moveAccount } from "./model-account-move.js";
import { scrubBackupProfile } from "./runtime-update-scrub.js";
import { CodexCatalog } from "../model-logins/codex-catalog.js";
// Account ids keep their first prefix: agents' saved selections name them.
export const accountIdOf = (profileId) =>
  `openclaw:${createHash("sha256").update(profileId).digest("hex")}`;
const signedIn = (status) => ["ok", "expiring"].includes(status);
// Store refusals that only mean OpenClaw has not been set up (yet): nothing to write.
const absent = new Set(["STORE_MISSING"]);

/**
 * The owner's ChatGPT accounts, one login per account, host-wide. Two holders:
 * - "agentpier": the login lives in AgentPier's vault (model-logins/chatgpt-vault.js),
 *   the only refresher. OpenClaw gets an access-only profile (models sub-port
 *   writeAccess), Hermes the model proxy; neither ever sees the refresh token.
 * - "openclaw": a login OpenClaw made before AgentPier held logins. It stays exactly
 *   as it was, refreshed by OpenClaw, until the owner moves it
 *   (model-account-move.js); Hermes agents cannot use it until then.
 */
export class AssistantModelAccounts {
  constructor({
    dataDir,
    runtime,
    vault = null,
    catalog = new ModelAccountCatalog({ runtime }),
    codex = vault && new CodexCatalog({ vault, onChange: () => this.catalog.onChange() }),
    warn = console.warn,
  }) {
    Object.assign(this, { runtime, vault, warn });
    // Model lists live in memory only; the Gateway is the source of truth. Without a
    // running Gateway, AgentPier reads a held login's list from Codex (`codex`).
    this.catalog = catalog;
    this.codex = codex || null;
    this.file = path.join(runtimePaths(dataDir).root, "model-accounts.json");
    const saved = readJSON(this.file, []);
    this.records = Array.isArray(saved)
      ? saved.filter(
          (r) => typeof r.profileId === "string" && r.id === accountIdOf(r.profileId),
        )
      : [];
    // Retain only non-secret identities after logout so pre-spawn preparation can
    // restore an explicit missing profile instead of permitting account fallback.
    this.identitiesFile = path.join(
      runtimePaths(dataDir).root,
      "model-account-identities.json",
    );
    const identities = readJSON(this.identitiesFile, []);
    this.identities = new Map(
      [...(Array.isArray(identities) ? identities : []), ...this.records]
        .filter(
          (r) => typeof r?.profileId === "string" && r.id === accountIdOf(r.profileId),
        )
        .map((r) => [r.id, r.profileId]),
    );
    this.leases = new Map();
    this.syncing = Promise.resolve();
    // Every renewal and logout of a held login reaches OpenClaw's profile.
    this.unsubscribe = vault?.onChange((profileId) => this.sync(profileId));
  }
  requireReady() {
    if (!hostReady(this.runtime)) throw assistantProblem("unavailable", 503);
  }
  // The models sub-port of the runtime, read at each call.
  port() {
    return runtimeFor(null, this.runtime).models;
  }
  // The vault's logins as account records.
  #held() {
    return (this.vault?.list() || []).map((login) => ({
      id: accountIdOf(login.profileId),
      profileId: login.profileId,
      name: String(login.name).slice(0, 200),
      status: login.status === "ok" ? "ok" : "invalid",
      holder: "agentpier",
    }));
  }
  #holder(record) {
    return this.vault?.has(record.profileId) ? "agentpier" : "openclaw";
  }
  /**
   * Starts a background model list read once the cached one is stale. Only pages
   * that show the lists call this; runs, checks and logouts never read models.
   */
  ensureModels() {
    if (!this.records.length) return;
    if (hostReady(this.runtime)) return this.catalog.ensure();
    this.codex?.ensure(this.#held().map((r) => r.profileId));
  }
  // The list a held login shows while the Gateway is away comes from Codex.
  #codexList(record, ready) {
    return !ready && this.codex && this.#holder(record) === "agentpier";
  }
  /**
   * Whether a ChatGPT account is signed in, from the last account read (kept across
   * restarts): OpenClaw then routes image_generate through it (web-tools.js).
   */
  imageReady() {
    return this.records.some((r) => signedIn(r.status));
  }
  /** Synchronous: the cached model lists, never a Gateway read. */
  capabilities() {
    const ready = hostReady(this.runtime);
    return this.records.map((r) => {
      const held = this.#holder(r) === "agentpier";
      // A held login works without OpenClaw (Hermes agents use the proxy).
      const live = held || ready;
      return {
        id: r.id,
        name: String(r.name || "ChatGPT").slice(0, 200),
        providerId: "openai-chatgpt",
        holder: held ? "agentpier" : "openclaw",
        status: live ? r.status : "offline",
        available: live && signedIn(r.status),
        // The last known sign-in, also while the Gateway is away (imageReady).
        signedIn: signedIn(r.status),
        ...(this.#codexList(r, ready)
          ? this.codex.account(r.profileId)
          : this.catalog.account(r.profileId, { accounts: this.records.length })),
      };
    });
  }
  /** Rereads the Gateway's model list now; the account must exist. */
  async refreshModels(id) {
    const record = this.record(id);
    if (this.#codexList(record, hostReady(this.runtime))) {
      await this.codex.refresh(record.profileId).catch(() => {});
      return this.codex.account(record.profileId);
    }
    this.requireReady();
    // A failed read is reported as the account's list state, never as an upstream error.
    await this.catalog.refresh({ force: true }).catch(() => {});
    const { models, modelCatalog } = this.catalog.account(record.profileId, {
      accounts: this.records.length,
    });
    return { models, modelCatalog };
  }
  async list() {
    const held = this.#held();
    const heldIds = new Set(held.map((r) => r.profileId));
    // While the Gateway is away, OpenClaw's own logins stay as last read.
    let native = this.records.filter(
      (r) => !heldIds.has(r.profileId) && r.holder !== "agentpier",
    );
    if (hostReady(this.runtime)) {
      const result = await this.port().status({ timeoutMs: 60000 });
      const profiles =
        result.providers?.find((p) => p.provider === "openai")?.profiles || [];
      native = profiles
        .filter(
          (p) =>
            p.type === "oauth" &&
            typeof p.profileId === "string" &&
            !heldIds.has(p.profileId),
        )
        .map((p) => ({
          id: accountIdOf(p.profileId),
          profileId: p.profileId,
          name: String(p.displayName || p.email || "ChatGPT").slice(0, 200),
          status: ["ok", "expiring", "expired", "missing", "invalid"].includes(p.status)
            ? p.status
            : "unknown",
          holder: "openclaw",
        }));
    }
    this.records = [...held, ...native];
    for (const record of this.records) this.identities.set(record.id, record.profileId);
    writePrivate(
      this.identitiesFile,
      [...this.identities].map(([id, profileId]) => ({ id, profileId })),
    );
    writePrivate(this.file, this.records);
    return this.capabilities();
  }
  /** "agentpier", "openclaw", or null for an account this AgentPier does not know. */
  holderOf(id) {
    if (this.#held().some((r) => r.id === id)) return "agentpier";
    return this.records.some((r) => r.id === id) ? "openclaw" : null;
  }
  record(id) {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw assistantProblem("provider");
    return record;
  }
  async resolve(id, modelId) {
    if (typeof modelId !== "string" || !accountModelId.test(modelId))
      throw assistantProblem("invalid");
    const heldRecord = this.#held().find((r) => r.id === id);
    if (!heldRecord) this.requireReady();
    await this.list();
    let record = this.record(id);
    if (record.holder === "openclaw" && record.status === "expired") {
      await this.check(id);
      record = this.record(id);
    }
    if (!signedIn(record.status)) throw assistantProblem("provider");
    this.leases.set(id, (this.leases.get(id) || 0) + 1);
    let released = false;
    return {
      modelRef: `openai/${modelId}@${record.profileId}`,
      // Keep assistant execution independent of installed native harness plugins.
      // The exact OAuth profile still owns authentication and model access.
      agentRuntime: { model: `openai/${modelId}`, id: "openclaw" },
      // What a runtime without OpenClaw's profile (Hermes) needs to reach the account
      // through AgentPier's model proxy; only a held login can be reached.
      chatgpt: { profileId: record.profileId, modelId, holder: record.holder },
      // Account names default to the owner's e-mail; agents only see the product.
      display: { connection: "ChatGPT", model: modelId },
      release: () => {
        if (released) return;
        released = true;
        const count = this.leases.get(id) - 1;
        if (count) this.leases.set(id, count);
        else this.leases.delete(id);
      },
    };
  }
  offlineSelection(id, modelId) {
    if (typeof modelId !== "string" || !accountModelId.test(modelId))
      throw assistantProblem("invalid");
    const profileId = this.identities.get(id);
    if (!profileId) throw assistantProblem("provider");
    return {
      modelRef: `openai/${modelId}@${profileId}`,
      available: this.records.some(
        (record) => record.id === id && signedIn(record.status),
      ),
    };
  }
  async check(id) {
    const record = this.record(id);
    if (this.#holder(record) === "agentpier") {
      // AgentPier's own check: the login renews (or still has a valid token).
      const status = await this.vault.credential(record.profileId).then(
        () => "ok",
        (error) =>
          ["RELOGIN", "LOGIN_MISSING"].includes(error.code) ? "auth" : "timeout",
      );
      await this.list();
      return { status };
    }
    this.requireReady();
    const result = await this.port().probe({
      provider: "openai",
      profileId: record.profileId,
      probeTimeoutMs: 15000,
      timeoutMs: 20000,
    });
    await this.list();
    return {
      status: ["ok", "auth", "rate_limit", "billing", "timeout", "no_model"].includes(
        result.status,
      )
        ? result.status
        : "unknown",
    };
  }
  async logout(id) {
    if (this.leases.has(id)) throw assistantProblem("active", 409);
    const record = this.record(id);
    if (this.#holder(record) === "agentpier") {
      // Update snapshots keep their credentials, without this profile: a rollback
      // never brings the logged-out account back (runtime-update-scrub.js).
      await scrubBackupProfile(path.dirname(this.file), record.profileId, {
        remove: true,
      });
      this.vault.remove(record.profileId);
      this.codex?.forget(record.profileId);
      await this.sync(record.profileId);
      return this.list();
    }
    this.requireReady();
    // Before revocation: an update backup must never resurrect this profile.
    destroyBackupKeys(path.dirname(this.file));
    await this.port().logout({
      provider: "openai",
      profileIds: [record.profileId],
      timeoutMs: 60000,
    });
    return this.list();
  }
  /** Moves a login OpenClaw holds to AgentPier, on the owner's request. */
  move(id) {
    return moveAccount(this, id);
  }
  /** A new sign-in was saved to the vault: OpenClaw gets its profile, the list updates. */
  async signedIn(profileId) {
    await this.sync(profileId);
    await this.list().catch(() => {});
    // The new account's model list loads in the background.
    if (hostReady(this.runtime)) this.catalog?.refresh({ force: true }).catch(() => {});
  }
  /**
   * Brings OpenClaw's profile of `profileId` in step with the vault: the current
   * access token, or no profile after a logout. Runs one at a time; a store that
   * does not exist yet (OpenClaw never started) is no change, the next Gateway start
   * writes it (syncAll).
   */
  sync(profileId) {
    const run = async () => {
      if (!this.vault) return;
      const access = this.vault.accessOf(profileId);
      const known = this.vault.has(profileId);
      if (known && !access) return; // A rejected renewal: OpenClaw's token runs out.
      const port = this.port();
      try {
        if (access) await port.writeAccess({ profileId, credential: access });
        else await port.removeAccess({ profileId });
      } catch (error) {
        if (!absent.has(error?.code))
          this.warn(
            `AgentPier could not update OpenClaw's ChatGPT profile (${
              /^[A-Z_]{1,40}$/.test(error?.code || "") ? error.code : "unexpected error"
            }).`,
          );
      }
    };
    const task = this.syncing.then(run, run);
    this.syncing = task.catch(() => {});
    return task;
  }
  /** Writes every held login into OpenClaw's store (Gateway start, runtime update). */
  async syncAll() {
    for (const login of this.vault?.list() || []) await this.sync(login.profileId);
  }
  close() {
    this.unsubscribe?.();
  }
}
