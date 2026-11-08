import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import { restartRequired } from "./assistant-provider-synchronization.js";
import { assistantProblem } from "./assistant-validation.js";
import {
  compilerFor,
  hermesAvailable,
  hermesFleetOf,
  hostOf,
  hostReady,
  runtimeFor,
} from "./runtimes/runtime-for.js";
import { applyHermesAgents } from "./web-tools-changes.js";

const reloadKinds = new Set(["hot", "none", "restart"]);
// What a runtime without advanced settings offers: nothing to list or change.
const noSettings = Object.freeze({
  runtime: null,
  list: Object.freeze([]),
  byPath: () => undefined,
});

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

// The Hermes compiler's advanced settings: those Hermes has an equivalent of, by id.
const hermesSettings = () => compilerFor({ runtime: "hermes" }).advancedSettings;

/**
 * The owner's stored advanced settings by setting id (`{ [id]: value }`), as a
 * runtime that maps them by id compiles them (Hermes, hermes-config/advanced.js);
 * undefined when the store cannot be read, which leaves their keys as they are.
 */
export function advancedValues(overrides) {
  try {
    const settings = compilerFor(null).advancedSettings;
    return Object.fromEntries(
      overrides.list().flatMap(({ path: target, value }) => {
        const setting = settings?.byPath(target);
        return setting ? [[setting.id, value]] : [];
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * The owner's advanced settings for all agents: the allow-listed OpenClaw paths the
 * runtime's compiler offers (config sub-port `compiler.advancedSettings`, from
 * runtimes/openclaw/openclaw-config/advanced-settings.js), stored as layer 3 overrides. A running
 * Gateway takes a `hot` or `none` change live through config.patch; a `restart` change
 * restarts it in maintenance once the owner confirmed, like a web tools change. A
 * stopped Gateway compiles the stored overrides at its next start. Hermes agents take
 * the settings Hermes has an equivalent of (`hermes` per setting) at each start and
 * apply; a save of one applies them, and each whose home changed restarts.
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
  // The config sub-port of the runtime port (runtime-for.js).
  get runtimeConfig() {
    return runtimeFor(null, this.runtime).config;
  }
  // Whether the runtime offers advanced settings at all (its `advancedSettings`
  // capability); one without lists none and refuses every save.
  get offered() {
    return runtimeFor(null, this.runtime).capabilities().advancedSettings.available;
  }
  // The allow list and its checks (the config sub-port's compiler).
  get settings() {
    return this.offered ? compilerFor(null).advancedSettings : noSettings;
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
    const { availability, version: running } = hostOf(this.runtime).status();
    const ready = availability === "ready" && hostReady(this.runtime);
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
      qualified: !version || version === this.settings.runtime,
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
    for (const { path: target } of this.settings.list) {
      try {
        const found = await this.runtimeConfig.lookup({ path: target });
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
      return (await this.runtimeConfig.get()).config || {};
    } catch {
      return null;
    }
  }
  /**
   * Hermes as these settings reach it: whether Hermes agents run, the installed
   * version and whether the mapping is approved for it (hermes-config/advanced.js).
   */
  hermes() {
    const version = hermesFleetOf(this.runtime).installedVersion();
    return {
      enabled: hermesAvailable(this.runtime),
      version,
      qualified: !version || version === hermesSettings().runtime,
    };
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
      hermes: this.hermes(),
      settings: this.settings.list.map((setting) => {
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
          ...this.settings.bounds(setting),
          fallback: setting.fallback,
          override: stored.get(setting.path)?.value ?? null,
          // What the running Gateway uses now; null before a start or while unset.
          current: value === undefined ? null : value,
          reloadKind: reloadKind || setting.reloadKind,
          available: gateway.qualified && reloadKind !== null,
          // Whether Hermes agents take it too; otherwise it is OpenClaw's alone.
          hermes: !!hermesSettings().byId(setting.id),
        };
      }),
    };
  }
  /** Sets one override; `value: null` resets it to OpenClaw's default. */
  async save(target, value, { confirmed = false } = {}) {
    if (!this.offered) throw assistantProblem("advancedSettingUnavailable", 409);
    const setting = this.settings.byPath(target);
    if (!setting) throw assistantProblem("invalid");
    if (value !== null) this.settings.validate(setting.path, value);
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
          await this.runtimeConfig.patch({
            build: () => ({ patch: patchFor(setting.path, next) }),
          });
        } catch (error) {
          if (error?.key) throw error;
          if (error?.answered && error.code === "INVALID_REQUEST")
            throw assistantProblem("invalid");
          throw assistantProblem("unavailable", 503);
        }
        persist();
      });
    // Hermes agents compile the stored value at their apply.
    if (hermesSettings().byId(setting.id)) applyHermesAgents(this.assistants);
    return this.get();
  }
  persist(target, value) {
    const before = this.overrides.get(target)?.value;
    if (value === undefined) this.overrides.remove(target);
    else this.overrides.set(target, value);
    this.record("setting.updated", target, before, value, "success");
  }
  // The setting's id names it (a path is no audit identifier); the schema keeps the
  // old and new value only as the setting's own scalar type.
  record(action, target, from, to, outcome) {
    try {
      const { id } = this.settings.byPath(target);
      this.audit?.append({
        action,
        resourceType: "setting",
        resourceId: id,
        source: "user",
        outcome,
        details: { setting: id, from: from ?? null, to: to ?? null },
      });
    } catch (error) {
      console.error(`Advanced setting audit ${action} failed:`, error?.message);
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
        this.record("setting.rolled-back", target, attempted, previous?.value, "failure");
      }
      throw error;
    }
  }
}
