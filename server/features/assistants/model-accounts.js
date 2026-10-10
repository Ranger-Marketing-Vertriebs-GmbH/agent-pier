import path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { runtimePaths } from "./runtime-paths.js";
import { assistantProblem } from "./assistant-validation.js";
import { destroyBackupKeys } from "./backup-credentials.js";
const identity = (profileId) =>
  `openclaw:${createHash("sha256").update(profileId).digest("hex")}`;
export class AssistantModelAccounts {
  constructor({ dataDir, runtime }) {
    this.runtime = runtime;
    this.file = path.join(runtimePaths(dataDir).root, "model-accounts.json");
    const saved = readJSON(this.file, []);
    this.records = Array.isArray(saved)
      ? saved.filter(
          (r) => typeof r.profileId === "string" && r.id === identity(r.profileId),
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
        .filter((r) => typeof r?.profileId === "string" && r.id === identity(r.profileId))
        .map((r) => [r.id, r.profileId]),
    );
    this.leases = new Map();
  }
  requireReady() {
    if (!this.runtime.client?.ready) throw assistantProblem("unavailable", 503);
  }
  capabilities() {
    return this.records.map((r) => ({
      id: r.id,
      name: String(r.name || "ChatGPT").slice(0, 200),
      providerId: "openai-chatgpt",
      status: this.runtime.client?.ready ? r.status : "offline",
      available: !!this.runtime.client?.ready && ["ok", "expiring"].includes(r.status),
    }));
  }
  async list() {
    if (!this.runtime.client?.ready) return this.capabilities();
    const result = await this.runtime.client.call(
      "models.authStatus",
      { agentId: "main" },
      { timeoutMs: 60000 },
    );
    const profiles =
      result.providers?.find((p) => p.provider === "openai")?.profiles || [];
    this.records = profiles
      .filter((p) => p.type === "oauth" && typeof p.profileId === "string")
      .map((p) => ({
        id: identity(p.profileId),
        profileId: p.profileId,
        name: String(p.displayName || p.email || "ChatGPT").slice(0, 200),
        status: ["ok", "expiring", "expired", "missing", "invalid"].includes(p.status)
          ? p.status
          : "unknown",
      }));
    for (const record of this.records) this.identities.set(record.id, record.profileId);
    writePrivate(
      this.identitiesFile,
      [...this.identities].map(([id, profileId]) => ({ id, profileId })),
    );
    writePrivate(this.file, this.records);
    return this.capabilities();
  }
  record(id) {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw assistantProblem("provider");
    return record;
  }
  async resolve(id, modelId) {
    this.requireReady();
    if (
      typeof modelId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(modelId)
    )
      throw assistantProblem("invalid");
    await this.list();
    let record = this.record(id);
    if (record.status === "expired") {
      await this.check(id);
      record = this.record(id);
    }
    if (!["ok", "expiring"].includes(record.status)) throw assistantProblem("provider");
    this.leases.set(id, (this.leases.get(id) || 0) + 1);
    let released = false;
    return {
      modelRef: `openai/${modelId}@${record.profileId}`,
      // Keep assistant execution independent of installed native harness plugins.
      // The exact OAuth profile still owns authentication and model access.
      agentRuntime: { model: `openai/${modelId}`, id: "openclaw" },
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
    if (
      typeof modelId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(modelId)
    )
      throw assistantProblem("invalid");
    const profileId = this.identities.get(id);
    if (!profileId) throw assistantProblem("provider");
    return {
      modelRef: `openai/${modelId}@${profileId}`,
      available: this.records.some(
        (record) => record.id === id && ["ok", "expiring"].includes(record.status),
      ),
    };
  }
  async check(id) {
    this.requireReady();
    const record = this.record(id);
    const result = await this.runtime.client.call(
      "models.probe",
      {
        provider: "openai",
        agentId: "main",
        profileId: record.profileId,
        timeoutMs: 15000,
      },
      { timeoutMs: 20000 },
    );
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
    this.requireReady();
    if (this.leases.has(id)) throw assistantProblem("active", 409);
    const record = this.record(id);
    // Before revocation: an update backup must never resurrect this profile.
    destroyBackupKeys(path.dirname(this.file));
    await this.runtime.client.call(
      "models.authLogout",
      { provider: "openai", agentId: "main", profileIds: [record.profileId] },
      { timeoutMs: 60000 },
    );
    return this.list();
  }
}
