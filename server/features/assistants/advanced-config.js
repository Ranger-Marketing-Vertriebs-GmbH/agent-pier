import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import {
  advancedSetting,
  advancedSettings,
  advancedSettingsRuntime,
  settingBounds,
} from "./openclaw-config/advanced-settings.js";
import { validateOverride } from "./openclaw-config/overrides.js";
import { patchConfig } from "./openclaw-config/live-patch.js";
import { restartRequired } from "./assistant-provider-synchronization.js";
import { assistantProblem } from "./assistant-validation.js";

const reloadKinds = new Set(["hot", "none", "restart"]);

function valueAt(config, target) {
  let node = config;
  for (const key of target.split(".")) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

// A merge patch for one leaf; null removes it.
const patchFor = (target, value) =>
  target
    .split(".")
    .reduceRight((inner, key) => ({ [key]: inner }), value === undefined ? null : value);

/**
 * The owner's advanced OpenClaw settings: the allow-listed paths of
 * openclaw-config/advanced-settings.js, stored as layer 3 overrides. A running
 * Gateway takes a `hot` or `none` change live through config.patch; a `restart` change
 * restarts it in maintenance once the owner confirmed, like a web tools change. A
 * stopped Gateway compiles the stored overrides at its next start.
 */
export class AdvancedConfig {
  constructor({ assistants, overrides, synchronization, usage, audit }) {
    Object.assign(this, { assistants, overrides, synchronization, usage, audit });
    // config.schema.lookup answers per runtime version, so one read per version.
    this.lookupCache = { version: null, kinds: null };
  }
  get runtime() {
    return this.assistants.runtime;
  }
  // The version the next start runs: the selected installation (runtime.json), which
  // after a rollback is not the manifest's. Null when nothing is installed yet.
  installedVersion() {
    const root = this.runtime.paths?.root;
    if (!root) return null;
    try {
      const version = readJSON(path.join(root, "runtime.json"), null)?.version;
      return typeof version === "string" ? version : null;
    } catch {
      return null;
    }
  }
  gateway() {
    const { availability, version: running } = this.runtime.status();
    const ready = availability === "ready" && !!this.runtime.client?.ready;
    // Only a ready Gateway's own version applies. Otherwise the next start runs the
    // selected installation, which after a rollback differs from the version the
    // last start reported (and a Gateway that never started reports none).
    const version = ready ? running : (this.installedVersion() ?? running);
    // A Gateway that is starting, stopping or reconnecting compiled (or will
    // compile) its configuration already; a write now would miss it.
    const settled = ready || availability === "disabled" || availability === "failed";
    return {
      ready,
      settled,
      version: version || null,
      qualified: !version || version === advancedSettingsRuntime,
    };
  }
  /**
   * The running Gateway's reload kind per allowed path, or null for a path it does
   * not know. Without a running Gateway the qualified kinds apply.
   */
  async liveKinds(gateway) {
    if (!gateway.ready) return null;
    if (this.lookupCache.version === gateway.version) return this.lookupCache.kinds;
    const kinds = {};
    for (const { path: target } of advancedSettings) {
      try {
        const found = await this.runtime.client.call("config.schema.lookup", {
          path: target,
        });
        kinds[target] = reloadKinds.has(found?.reloadKind) ? found.reloadKind : null;
      } catch (error) {
        // An unknown path is answered; anything else is not a fact about the schema.
        if (!error?.answered) return null;
        kinds[target] = null;
      }
    }
    this.lookupCache = { version: gateway.version, kinds };
    return kinds;
  }
  async effectiveConfig(gateway) {
    if (!gateway.ready) return null;
    try {
      return (await this.runtime.client.call("config.get", {})).config || {};
    } catch {
      return null;
    }
  }
  /** Every allowed setting with its stored override and the Gateway's value. */
  async get() {
    const gateway = this.gateway();
    const [kinds, live] = [
      await this.liveKinds(gateway),
      await this.effectiveConfig(gateway),
    ];
    const stored = new Map(this.overrides.list().map((row) => [row.path, row]));
    return {
      gateway: {
        running: gateway.ready,
        version: gateway.version,
        qualified: gateway.qualified,
      },
      settings: advancedSettings.map((setting) => {
        const reloadKind = kinds ? kinds[setting.path] : setting.reloadKind;
        const value = live ? valueAt(live, setting.path) : undefined;
        return {
          id: setting.id,
          path: setting.path,
          group: setting.group,
          type: setting.schema.type,
          ...(setting.schema.enum && { options: [...setting.schema.enum] }),
          ...(setting.format && { format: setting.format }),
          ...(setting.unit && { unit: setting.unit }),
          ...settingBounds(setting),
          fallback: setting.fallback,
          override: stored.get(setting.path)?.value ?? null,
          // What the running Gateway uses now; null before a start or while unset.
          current: value === undefined ? null : value,
          reloadKind: reloadKind || setting.reloadKind,
          available: gateway.qualified && reloadKind !== null,
        };
      }),
    };
  }
  /** Sets one override; `value: null` resets it to OpenClaw's default. */
  async save(target, value, { confirmed = false } = {}) {
    const setting = advancedSetting(target);
    if (!setting) throw assistantProblem("invalid");
    if (value !== null) validateOverride(setting.path, value);
    const next = value === null ? undefined : value;
    const gateway = this.gateway();
    if (!gateway.settled) throw assistantProblem("active", 409);
    if (!gateway.qualified) throw assistantProblem("advancedSettingUnavailable", 409);
    const kinds = await this.liveKinds(gateway);
    const reloadKind = kinds ? kinds[setting.path] : setting.reloadKind;
    if (!reloadKind) throw assistantProblem("advancedSettingUnavailable", 409);
    const persist = () => this.persist(setting.path, next);
    if (!gateway.ready) await this.assistants.admit(persist);
    else if (reloadKind === "restart") {
      if (!confirmed)
        throw restartRequired("advancedRestartRequired", this.usage?.() || undefined);
      await this.restart(setting.path, persist);
    } else
      await this.assistants.admit(async () => {
        // Validated by the Gateway too: a refused value is never stored.
        try {
          await patchConfig(this.runtime.client, () => ({
            patch: patchFor(setting.path, next),
          }));
        } catch (error) {
          if (error?.key) throw error;
          if (error?.answered && error.code === "INVALID_REQUEST")
            throw assistantProblem("invalid");
          throw assistantProblem("unavailable", 503);
        }
        persist();
      });
    return this.get();
  }
  persist(target, value) {
    const before = this.overrides.get(target)?.value;
    if (value === undefined) this.overrides.remove(target);
    else this.overrides.set(target, value);
    this.record(target, before, value, "success");
  }
  record(target, from, to, outcome) {
    try {
      this.audit?.append({
        action: "assistant.advancedSettingChanged",
        resourceType: "assistantRuntime",
        resourceId: target,
        source: "user",
        outcome,
        details: { path: target, from: from ?? null, to: to ?? null },
      });
    } catch (error) {
      console.error("Advanced setting audit failed:", error?.message);
    }
  }
  /**
   * Restarts the Gateway with the new value. If the restart fails after the value
   * was stored, the previous override is restored so the next start does not
   * repeat the failure.
   */
  async restart(target, persist) {
    const previous = this.overrides.get(target);
    let stored = false;
    try {
      await this.synchronization.restartGateway(() => {
        persist();
        stored = true;
      });
    } catch (error) {
      if (stored) {
        // The audit names the undone change, so it never claims a value that is
        // no longer stored.
        const attempted = this.overrides.get(target)?.value;
        if (previous) this.overrides.set(target, previous.value);
        else this.overrides.remove(target);
        this.record(target, attempted, previous?.value, "failure");
      }
      throw error;
    }
  }
}
